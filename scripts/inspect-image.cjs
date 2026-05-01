#!/usr/bin/env node
'use strict';

/**
 * Inspect a public container image via the OCI Distribution API and emit
 * the bits the deploy-app / author-manifest skills can use to skip
 * redundant questions.
 *
 * Anonymous-only — the plugin does not support private registries today.
 * If a registry returns 401/403, the script prints `{}` on stdout, the
 * reason on stderr, and exits 0 (fail-soft → skill falls back to asking
 * the user for everything).
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
 *     digest:          "sha256:<hex>",        // manifest digest
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

const ACCEPT_MANIFEST = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

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

  return { registry, name, tag, digest };
}

function registryHost(registry) {
  // Docker Hub's image API lives at registry-1.docker.io even though the
  // canonical "registry" name is docker.io.
  return registry === 'docker.io' ? 'registry-1.docker.io' : registry;
}

function httpsJson(host, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({
      host,
      path,
      method: 'GET',
      headers: { 'User-Agent': 'manifest-agent-plugin/inspect-image', ...headers },
      timeout: 10_000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('request timeout')); });
    req.end();
  });
}

async function followRedirect(url) {
  // For blob fetches the registry typically responds with 307 → CDN URL.
  const u = new URL(url);
  return httpsJson(u.host, u.pathname + u.search);
}

async function getDockerHubToken(name) {
  // Docker Hub requires anonymous access still go through a token grant.
  const res = await httpsJson('auth.docker.io', `/token?service=registry.docker.io&scope=repository:${name}:pull`);
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
  if (res.status === 404) throw new Error(`image not found: ${registry}/${name}:${ref}`);
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
