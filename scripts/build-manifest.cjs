#!/usr/bin/env node
'use strict';

/**
 * Build a Fred container manifest from a DeployAppInput-shaped spec.
 *
 * Delegates to buildManifest / buildStackManifest from
 * @manifest-network/manifest-mcp-fred so the output matches exactly what
 * deploy_app would produce internally. Never reimplement manifest
 * construction here — drift between this script and the MCP would silently
 * corrupt payloads.
 *
 * Usage:
 *   cat spec.json | node build-manifest.cjs
 *
 * Input (stdin, JSON): a DeployAppInput-shaped object. Lease-level fields
 * (size, storage, gasMultiplier) are ignored with a stderr notice — they
 * do not belong in a manifest.
 *
 * Output (stdout, JSON): the manifest object Fred expects.
 *
 * The fred package is ESM-only (type: module), so we load it via a
 * dynamic import of an absolute path under ~/.manifest-agent/node_modules.
 * This sidesteps NODE_PATH (which only affects CJS resolution) and the
 * package's exports map.
 */

const major = parseInt(process.versions.node, 10);
if (major < 18) {
  console.error(`Node 18+ required (found ${process.version}).`);
  process.exit(1);
}

const { join } = require('node:path');
const { homedir } = require('node:os');
const { pathToFileURL } = require('node:url');

const FRED_ENTRY = join(
  homedir(),
  '.manifest-agent/node_modules/@manifest-network/manifest-mcp-fred/dist/index.js'
);

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { buf += chunk; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

(async () => {
  const raw = (await readStdin()).trim();
  if (!raw) {
    console.error('build-manifest: empty stdin. Pipe a DeployAppInput JSON object.');
    process.exit(1);
  }

  let spec;
  try {
    spec = JSON.parse(raw);
  } catch (err) {
    console.error(`build-manifest: stdin is not valid JSON: ${err.message}`);
    process.exit(1);
  }

  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    console.error('build-manifest: input must be a JSON object.');
    process.exit(1);
  }

  const hasImage = typeof spec.image === 'string' && spec.image.length > 0;
  const hasServices = spec.services && typeof spec.services === 'object' && !Array.isArray(spec.services);

  if (hasImage && hasServices) {
    console.error('build-manifest: `image` and `services` are mutually exclusive.');
    process.exit(1);
  }
  if (!hasImage && !hasServices) {
    console.error('build-manifest: either `image` (+ `port`) or `services` is required.');
    process.exit(1);
  }
  if (hasImage && typeof spec.port !== 'number') {
    console.error('build-manifest: `port` (number) is required when `image` is set.');
    process.exit(1);
  }

  for (const ignored of ['size', 'storage', 'gasMultiplier']) {
    if (spec[ignored] !== undefined) {
      console.error(`build-manifest: ignoring lease-level field \`${ignored}\` (not part of the manifest).`);
    }
  }

  let fred;
  try {
    fred = await import(pathToFileURL(FRED_ENTRY).href);
  } catch (err) {
    console.error(
      `build-manifest: could not load manifest-mcp-fred from ${FRED_ENTRY}. ` +
      `Run \`/manifest-agent:init-agent\` to install dependencies. Underlying error: ${err.message}`
    );
    process.exit(1);
  }

  const { buildManifest, buildStackManifest, validateServiceName } = fred;
  if (typeof buildManifest !== 'function' || typeof buildStackManifest !== 'function') {
    console.error('build-manifest: manifest-mcp-fred did not export buildManifest/buildStackManifest. Package version mismatch?');
    process.exit(1);
  }

  let manifest;
  if (hasServices) {
    for (const name of Object.keys(spec.services)) {
      if (typeof validateServiceName === 'function' && !validateServiceName(name)) {
        console.error(`build-manifest: invalid service name "${name}". Must be 1-63 chars, lowercase alphanumeric + hyphens, no leading/trailing hyphens.`);
        process.exit(1);
      }
    }
    const services = {};
    for (const [name, svc] of Object.entries(spec.services)) {
      services[name] = {
        image: svc.image,
        ports: svc.ports ?? {},
        env: svc.env,
        command: svc.command,
        args: svc.args,
        user: svc.user,
        tmpfs: svc.tmpfs,
        health_check: svc.health_check,
        stop_grace_period: svc.stop_grace_period,
        depends_on: svc.depends_on,
        expose: svc.expose,
        labels: svc.labels,
      };
    }
    manifest = buildStackManifest({ services });
  } else {
    manifest = buildManifest({
      image: spec.image,
      ports: { [`${spec.port}/tcp`]: {} },
      env: spec.env,
      command: spec.command,
      args: spec.args,
      user: spec.user,
      tmpfs: spec.tmpfs,
      health_check: spec.health_check,
      stop_grace_period: spec.stop_grace_period,
      init: spec.init,
      expose: spec.expose,
      labels: spec.labels,
      depends_on: spec.depends_on,
    });
  }

  process.stdout.write(JSON.stringify(manifest) + '\n');
})().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
