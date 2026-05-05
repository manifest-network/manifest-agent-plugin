#!/usr/bin/env node
'use strict';

/**
 * Merge environment variables from a dotenv-format file into a manifest spec
 * on disk, without the values transiting the chat transcript.
 *
 * Same shape of pipeline as the mnemonic-import flow: the user creates the
 * env file in a separate terminal, names the path in chat, and the agent
 * pipes the file through this script. The script mutates the spec file in
 * place; only env *keys* (never values) are echoed on stdout.
 *
 *   1. User in another terminal:
 *        $ cat > /tmp/wordpress.env
 *        WORDPRESS_DB_HOST=mysql
 *        WORDPRESS_DB_PASSWORD=hunter2
 *        ^D
 *        $ chmod 600 /tmp/wordpress.env
 *   2. Agent runs:
 *        cat /tmp/wordpress.env | node merge-env.cjs \
 *          --spec-file /tmp/.spec-NNN.json \
 *          --service-name wordpress
 *
 * Architectural limitation (read me before claiming "secrets stay private"):
 * env values still flow into the build_manifest_preview / deploy_app MCP
 * tool calls at validation + broadcast time, which means they enter the
 * agent's API context for those turns. What this script *does* eliminate
 * is the user pasting values into the chat input, and the agent later
 * echoing them back in summaries. Eliminating the values from MCP tool
 * call args entirely would need upstream MCP-side support for "load env
 * from this path" and is tracked separately.
 *
 * Args:
 *   --spec-file <abs-path>     spec JSON file to mutate in place
 *   --service-name <name>      required when the spec uses the services-map
 *                              shape ({ services: { ... } }); identifies
 *                              which service to merge env into. Omit only
 *                              for the legacy flat single-service shape
 *                              ({ image, env, ... }).
 *
 * Stdin (text): dotenv format
 *   - one KEY=VALUE per line
 *   - lines starting with `#` are comments (ignored)
 *   - blank lines ignored
 *   - VALUE may be wrapped in matching single or double quotes (stripped)
 *   - VALUE is taken literally otherwise (no shell expansion, no escapes)
 *   - whitespace around KEY trimmed
 *
 * Output (stdout, JSON one-liner):
 *   { "service": "<name|null>", "keys_merged": ["KEY1", "KEY2", ...] }
 *
 * Merge semantics: existing entries with non-overlapping keys are kept;
 * file entries overwrite spec entries with the same key. Lets the user
 * collect non-sensitive vars in chat first and layer sensitive vars in
 * from a file second.
 *
 * Exit codes:
 *   0   success
 *   1   bad args / unreadable spec / invalid JSON / invalid dotenv key /
 *       service not present in spec
 */

const { readFileSync } = require('node:fs');
const { isAbsolute, resolve, sep } = require('node:path');
const { tmpdir } = require('node:os');
const { atomicWrite, getDataDir } = require('./_io.cjs');

// merge-env.cjs writes the spec back at mode 0o600 because env values
// flowing through it can be sensitive (DB passwords, API tokens). For
// files OUTSIDE the agent's drafts dir or the system tmpdir — e.g. a
// version-controlled spec at ~/code/myapp/manifest.json — silently
// downgrading the file mode would be a footgun. Refuse the merge instead;
// the user can copy the spec into the drafts dir or /tmp first if they
// really want to merge secrets in.
const ALLOWED_DIRS = [
  resolve(getDataDir(), 'manifests-drafts') + sep,
  resolve(tmpdir()) + sep,
];

function isAllowedSpecPath(p) {
  const r = resolve(p);
  return ALLOWED_DIRS.some((d) => r.startsWith(d));
}

// POSIX-compliant env-var name. deploy_app's downstream validator uses the
// same regex; matching it here surfaces invalid keys before broadcast.
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--spec-file' && argv[i + 1]) { args.specFile = argv[++i]; }
    else if (argv[i] === '--service-name' && argv[i + 1]) { args.serviceName = argv[++i]; }
  }
  return args;
}

function parseDotenv(text) {
  const out = new Map();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i];
    const stripped = raw.replace(/^\s+|\s+$/g, '');
    if (stripped === '' || stripped.startsWith('#')) continue;
    const eq = raw.indexOf('=');
    if (eq < 0) {
      throw new Error(`line ${lineNo}: missing '=' (expected KEY=VALUE)`);
    }
    const key = raw.slice(0, eq).replace(/^\s+|\s+$/g, '');
    let value = raw.slice(eq + 1);
    // Strip whitespace around the value BEFORE checking for quotes so
    // `FOO = bar` yields FOO=bar (not FOO=" bar"). For unquoted values
    // also strip the trailing newline / spaces. Quoted values get any
    // outer whitespace stripped here, then the quote pair is unwrapped
    // below; whitespace inside the quotes is preserved.
    value = value.replace(/^\s+|\s+$/g, '');
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    if (!ENV_KEY_RE.test(key)) {
      throw new Error(`line ${lineNo}: invalid env key "${key}" (must match /^[A-Za-z_][A-Za-z0-9_]*$/)`);
    }
    out.set(key, value);
  }
  return out;
}

(async () => {
  const args = parseArgs(process.argv);
  if (!args.specFile) {
    console.error('Missing required flag: --spec-file');
    process.exit(1);
  }
  if (!isAbsolute(args.specFile)) {
    console.error(`--spec-file must be absolute; got "${args.specFile}"`);
    process.exit(1);
  }
  if (!isAllowedSpecPath(args.specFile)) {
    console.error(
      `--spec-file must live under $MANIFEST_PLUGIN_DATA/manifests-drafts/ or the system tmpdir; got "${args.specFile}". ` +
      `Refusing to merge env values into an external file because the merge writes mode 0o600, ` +
      `which would silently change a checked-in spec's permissions and bake secrets into a path outside the secret-handling boundary. ` +
      `Copy the spec into one of the allowed dirs first if you want to merge secrets in.`
    );
    process.exit(1);
  }

  let specRaw;
  try {
    specRaw = readFileSync(args.specFile, 'utf8');
  } catch (err) {
    console.error(`reading ${args.specFile}: ${err.message}`);
    process.exit(1);
  }
  let spec;
  try {
    spec = JSON.parse(specRaw);
  } catch (err) {
    console.error(`spec file is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    console.error('spec file must contain a JSON object');
    process.exit(1);
  }

  const stdinRaw = readFileSync(0, 'utf8');
  let envMap;
  try {
    envMap = parseDotenv(stdinRaw);
  } catch (err) {
    console.error(`stdin: ${err.message}`);
    process.exit(1);
  }

  // Two spec shapes:
  //   - services-map: { services: { <name>: { env, ... } }, ... }
  //   - legacy flat:  { image, env, ... }   (single-service, no services map)
  let target;
  let serviceLabel;
  if (spec.services && typeof spec.services === 'object' && !Array.isArray(spec.services)) {
    if (!args.serviceName) {
      console.error('spec is services-map shape; --service-name is required');
      process.exit(1);
    }
    const svc = spec.services[args.serviceName];
    if (!svc || typeof svc !== 'object' || Array.isArray(svc)) {
      const available = Object.keys(spec.services).join(', ') || '(none)';
      console.error(`service "${args.serviceName}" not found in spec.services (available: ${available})`);
      process.exit(1);
    }
    if (!svc.env || typeof svc.env !== 'object' || Array.isArray(svc.env)) svc.env = {};
    target = svc.env;
    serviceLabel = args.serviceName;
  } else {
    if (args.serviceName) {
      console.error('spec is flat single-service shape; do not pass --service-name');
      process.exit(1);
    }
    if (!spec.env || typeof spec.env !== 'object' || Array.isArray(spec.env)) spec.env = {};
    target = spec.env;
    serviceLabel = null;
  }

  const merged = [];
  for (const [k, v] of envMap.entries()) {
    target[k] = v;
    merged.push(k);
  }

  atomicWrite(args.specFile, JSON.stringify(spec, null, 2) + '\n');

  console.log(JSON.stringify({ service: serviceLabel, keys_merged: merged }));
})().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
