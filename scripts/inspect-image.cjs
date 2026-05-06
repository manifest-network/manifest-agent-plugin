#!/usr/bin/env node
'use strict';

/**
 * Inspect a public container image via the OCI Distribution API and emit
 * the bits the deploy-app / author-manifest skills can use to skip
 * redundant questions.
 *
 * Anonymous-only — the plugin does not support private registries today.
 * Fail-soft contract: the script prints `{}` on stdout, the reason on
 * stderr, and exits 0 in the following cases:
 *   - registry returns 401 / 403 (auth required / private registry)
 *   - Docker Hub returns 429 (rate-limited; reason includes retry hint)
 *   - --image fails OCI Distribution Spec grammar (parseRef throws)
 *   - manifest body exceeds the 10 MiB cap
 *   - request timeout (10s)
 *   - unparseable manifest / blob JSON
 * Skill prose treats `{}` as "no info, ask the user" and surfaces the
 * stderr reason verbatim — so the user sees rate-limit hints, OCI
 * validation rejections, etc.
 *
 * Args:
 *   --image <ref>   image reference. Accepts:
 *                     - "<name>:<tag>"
 *                     - "<registry>/<name>:<tag>"
 *                     - "<registry>/<name>@sha256:<digest>"
 *                   Defaults: registry=docker.io, tag=latest. Bare
 *                   "nginx" is treated as "docker.io/library/nginx:latest".
 *
 * Output (JSON object on stdout):
 *   {
 *     image:           "<canonical ref the script resolved>",
 *     digest:          "sha256:<hex>" | null, // manifest digest; null when
 *                                              // the registry didn't echo
 *                                              // docker-content-digest AND
 *                                              // no digest was passed in --image
 *     ports:           ["80/tcp", ...],       // from OCI ExposedPorts (sorted)
 *     env:             { KEY: "value", ... }, // image's default env (often
 *                                              // PATH/NODE_VERSION/etc — informational only;
 *                                              // skills should NOT auto-populate user env from this)
 *     cmd:             ["arg1", "arg2"],     // image's default Cmd (or null)
 *     entrypoint:      ["..."],              // image's default Entrypoint (or null)
 *     user:            "999:999" | "",       // image's default User
 *     workingDir:      "/var/www" | "",      // image's default WorkingDir
 *     healthcheck:     { Test, Interval, ... } | null,  // image-defined HEALTHCHECK
 *     labels:          { ... } | null,       // image labels
 *     volumes:         { "/path": {} } | null,
 *     suggestedTmpfs:  ["/var/run", ...]     // heuristic for known images that
 *                                              // need tmpfs mounts on a read-only rootfs
 *   }
 *
 * On failure the script emits `{}` (no fields) and exits 0. The skill
 * treats an empty result as "no info, ask the user."
 */

const { request } = require('node:https');
const { URL } = require('node:url');
const { RequestFilteringHttpsAgent } = require('request-filtering-agent');

// Block requests to private / loopback / link-local addresses at connect time.
// Hardens redirect-following against a malicious or compromised registry that
// returns a Location header pointing inside the local network (cloud metadata,
// RFC 1918, ::1, etc.). Default config blocks all non-unicast ranges in v4 + v6.
const SSRF_AGENT = new RequestFilteringHttpsAgent();

const ACCEPT_MANIFEST = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

// OCI Distribution Spec v1.1 grammar for the URL-interpolated fields. We
// validate these BEFORE building the URL path because the user controls
// the --image flag — preventing path-traversal-ish inputs (e.g. "%2F..")
// from reaching the registry. Any non-conforming input fails fast.
const OCI_NAME_COMPONENT = /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*$/;
const OCI_TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const OCI_DIGEST = /^sha256:[0-9a-f]{64}$/;

// Cap manifest + config blob sizes. Real-world configs are <100 KB; even
// JVM-rich images rarely exceed a few MB. Anything over 10 MiB indicates
// a hostile or buggy registry; abort rather than risk OOM.
const MAX_BODY_BYTES = 10 * 1024 * 1024;

// Heuristic table: when an image's base name OR resolved Cmd/Entrypoint
// contains one of these tokens, suggest the corresponding tmpfs paths.
// Order matters: longer/more-specific tokens first when there's ambiguity.
// Sourced from barney/src/config/exampleApps.ts (the reference list of
// known-good Fred deployments).
const TMPFS_HINTS = [
  { match: 'wordpress',  paths: ['/run/lock', '/var/run/apache2'] },
  { match: 'mariadb',    paths: ['/run/mysqld'] },
  { match: 'postgres',   paths: ['/var/run/postgresql'] },
  { match: 'mysql',      paths: ['/var/run/mysqld'] },
  { match: 'nginx',      paths: ['/var/cache/nginx', '/var/run'] },
];

function fail(reason) {
  console.error(`inspect-image: ${reason}`);
  console.log('{}');
  process.exit(0);
}

function parseRef(ref) {
  // "<reg>/<name>@sha256:<digest>" or "<reg>/<name>:<tag>" or "<name>" or "<name>:<tag>"
  let registry = 'docker.io';
  let name;
  let tag = null;
  let digest = null;

  const atIdx = ref.indexOf('@');
  if (atIdx >= 0) {
    digest = ref.slice(atIdx + 1);
    ref = ref.slice(0, atIdx);
  }

  // Split on first / to detect registry. A segment counts as a registry only
  // if it has a "." or ":" (port) or is "localhost".
  const firstSlash = ref.indexOf('/');
  if (firstSlash > 0) {
    const head = ref.slice(0, firstSlash);
    if (head === 'localhost' || head.includes('.') || head.includes(':')) {
      registry = head;
      ref = ref.slice(firstSlash + 1);
    }
  }

  if (!digest) {
    const colonIdx = ref.lastIndexOf(':');
    if (colonIdx >= 0) {
      tag = ref.slice(colonIdx + 1);
      name = ref.slice(0, colonIdx);
    } else {
      name = ref;
      tag = 'latest';
    }
  } else {
    name = ref;
  }

  // Docker Hub library prefix for single-segment names ("nginx" → "library/nginx").
  if (registry === 'docker.io' && !name.includes('/')) {
    name = `library/${name}`;
  }

  // Validate URL-interpolated fields against OCI Distribution Spec grammar
  // BEFORE the registry round-trip. The chain ref strings reach the user
  // via $ARGUMENTS, so a malformed input like "foo/bar:..%2F..%2Fconfig"
  // must be rejected here, not handed to the registry.
  for (const component of name.split('/')) {
    if (!OCI_NAME_COMPONENT.test(component)) {
      throw new Error(`invalid name component "${component}" in image ref`);
    }
  }
  if (tag !== null && !OCI_TAG.test(tag)) {
    throw new Error(`invalid tag "${tag}" in image ref`);
  }
  if (digest !== null && !OCI_DIGEST.test(digest)) {
    throw new Error(`invalid digest "${digest}" in image ref (expected sha256:<64-hex>)`);
  }

  return { registry, name, tag, digest };
}

function registryHost(registry) {
  // Docker Hub's image API lives at registry-1.docker.io even though the
  // canonical "registry" name is docker.io.
  return registry === 'docker.io' ? 'registry-1.docker.io' : registry;
}

function httpsJson(host, path, headers = {}) {
  return new Promise((resolveOuter, rejectOuter) => {
    // Settle-once guard. The body-size-cap path rejects directly from the
    // data handler (rather than relying on req.destroy(err) → req.on('error')
    // which races with res.on('end')), so we may get multiple rejection
    // attempts (cap reject, then req 'error' from the destroy, then a later
    // timeout). Coalesce them.
    let settled = false;
    const resolve = (v) => { if (!settled) { settled = true; resolveOuter(v); } };
    const reject = (e) => { if (!settled) { settled = true; rejectOuter(e); } };

    const req = request({
      host,
      path,
      method: 'GET',
      headers: { 'User-Agent': 'manifest-agent-plugin/inspect-image', ...headers },
      timeout: 10_000,
      agent: SSRF_AGENT,
    }, (res) => {
      const chunks = [];
      let received = 0;
      let aborted = false;
      res.on('data', (c) => {
        if (aborted) return;
        received += c.length;
        if (received > MAX_BODY_BYTES) {
          aborted = true;
          req.destroy();
          reject(new Error(`response body exceeded ${MAX_BODY_BYTES} bytes (cap) on ${host}${path}`));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        if (aborted) return;
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error(`request timeout on ${host}${path}`)); });
    req.end();
  });
}

async function followRedirect(url) {
  // For blob fetches the registry typically responds with 307 → CDN URL.
  const u = new URL(url);
  return httpsJson(u.host, u.pathname + u.search);
}

async function getDockerHubToken(name) {
  // Surface 429 specifically with retry guidance — anonymous Docker Hub
  // pulls are limited per-IP and a 60-min wait fixes it. Without this
  // special case the user sees the same fail-soft `{}` outcome as a hard
  // 401, with no signal that the situation is temporary.
  // Docker Hub requires anonymous access still go through a token grant.
  const res = await httpsJson('auth.docker.io', `/token?service=registry.docker.io&scope=repository:${name}:pull`);
  if (res.status === 429) {
    throw new Error('Docker Hub token: HTTP 429 (anonymous pulls rate-limited per-IP; retry after ~60 min, or authenticate)');
  }
  if (res.status !== 200) throw new Error(`Docker Hub token: HTTP ${res.status}`);
  let parsed;
  try { parsed = JSON.parse(res.body); } catch { throw new Error('Docker Hub token: invalid JSON'); }
  if (!parsed.token) throw new Error('Docker Hub token: missing `token` in response');
  return parsed.token;
}

async function fetchManifest(registry, name, ref, authHeader) {
  const host = registryHost(registry);
  const path = `/v2/${name}/manifests/${ref}`;
  const headers = { Accept: ACCEPT_MANIFEST };
  if (authHeader) headers.Authorization = authHeader;
  const res = await httpsJson(host, path, headers);
  if (res.status === 401 || res.status === 403) throw new Error(`registry returned ${res.status} on manifest fetch (auth required? private registry?)`);
  if (res.status === 404) {
    // Digest-pinned references use `@sha256:...` rather than `:tag`. ref
    // already starts with "sha256:" in that case, so naive concatenation
    // produces a misleading `registry/name:sha256:...` instead of
    // `registry/name@sha256:...`. Pick the right separator.
    const sep = ref.startsWith('sha256:') ? '@' : ':';
    throw new Error(`image not found: ${registry}/${name}${sep}${ref}`);
  }
  if (res.status !== 200) throw new Error(`registry returned ${res.status} on manifest fetch`);
  let parsed;
  try { parsed = JSON.parse(res.body); } catch { throw new Error('manifest is not valid JSON'); }
  return { manifest: parsed, contentType: res.headers['content-type'] || '', digest: res.headers['docker-content-digest'] || null };
}

async function fetchBlobJson(registry, name, digest, authHeader) {
  const host = registryHost(registry);
  const path = `/v2/${name}/blobs/${digest}`;
  const headers = {};
  if (authHeader) headers.Authorization = authHeader;
  let res = await httpsJson(host, path, headers);
  // Many registries 307-redirect blobs to a CDN.
  if ((res.status === 307 || res.status === 302) && res.headers.location) {
    res = await followRedirect(res.headers.location);
  }
  if (res.status !== 200) throw new Error(`registry returned ${res.status} on blob fetch`);
  try { return JSON.parse(res.body); } catch { throw new Error('blob is not valid JSON'); }
}

function pickPlatformManifest(index) {
  // OCI image index → pick linux/amd64 (most common). Fall back to first entry.
  if (!index || !Array.isArray(index.manifests)) return null;
  const linuxAmd64 = index.manifests.find((m) => m.platform && m.platform.os === 'linux' && m.platform.architecture === 'amd64');
  return linuxAmd64 || index.manifests[0];
}

function suggestedTmpfsFor(name, cmdAndEntrypoint) {
  const haystack = [name, ...cmdAndEntrypoint].join(' ').toLowerCase();
  for (const hint of TMPFS_HINTS) {
    if (haystack.includes(hint.match)) return hint.paths;
  }
  return [];
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--image' && argv[i + 1]) { args.image = argv[++i]; }
  }
  return args;
}

(async () => {
  const args = parseArgs(process.argv);
  if (!args.image) fail('missing required --image flag');

  const { registry, name, tag, digest } = parseRef(args.image);
  const ref = digest ? digest : tag;

  let authHeader = null;
  if (registry === 'docker.io') {
    const token = await getDockerHubToken(name);
    authHeader = `Bearer ${token}`;
  }

  // Step 1: fetch manifest (might be an index → pick a platform → refetch).
  let { manifest, contentType, digest: manifestDigest } = await fetchManifest(registry, name, ref, authHeader);
  if (contentType.includes('manifest.list') || contentType.includes('image.index') || (manifest.manifests && Array.isArray(manifest.manifests))) {
    const child = pickPlatformManifest(manifest);
    if (!child || !child.digest) fail('multi-arch index has no usable child manifest');
    ({ manifest, contentType, digest: manifestDigest } = await fetchManifest(registry, name, child.digest, authHeader));
  }

  // Step 2: fetch the config blob (the actual image config lives there).
  if (!manifest.config || !manifest.config.digest) fail('manifest has no config descriptor');
  const config = await fetchBlobJson(registry, name, manifest.config.digest, authHeader);
  const c = config.config || {};

  const out = {
    image: `${registry}/${name}${digest ? '@' + digest : ':' + tag}`,
    digest: manifestDigest || digest || null,
    ports: c.ExposedPorts ? Object.keys(c.ExposedPorts).sort() : [],
    env: Array.isArray(c.Env) ? Object.fromEntries(c.Env.map((kv) => {
      const i = kv.indexOf('=');
      return i > 0 ? [kv.slice(0, i), kv.slice(i + 1)] : [kv, ''];
    })) : {},
    cmd: Array.isArray(c.Cmd) ? c.Cmd : null,
    entrypoint: Array.isArray(c.Entrypoint) ? c.Entrypoint : null,
    user: typeof c.User === 'string' ? c.User : '',
    workingDir: typeof c.WorkingDir === 'string' ? c.WorkingDir : '',
    healthcheck: c.Healthcheck && typeof c.Healthcheck === 'object' ? c.Healthcheck : null,
    labels: c.Labels && typeof c.Labels === 'object' ? c.Labels : null,
    volumes: c.Volumes && typeof c.Volumes === 'object' ? c.Volumes : null,
  };
  out.suggestedTmpfs = suggestedTmpfsFor(name, [...(out.cmd || []), ...(out.entrypoint || [])]);

  console.log(JSON.stringify(out));
})().catch((err) => {
  fail(err.message || String(err));
});
