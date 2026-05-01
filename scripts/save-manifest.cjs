#!/usr/bin/env node
'use strict';

/**
 * Persist a deployed manifest to ~/.manifest-agent/manifests/<lease_uuid>.json.
 *
 * Wrapper shape (schema_version 2):
 *   {
 *     schema_version: 2,
 *     lease_uuid, deployed_at_iso, deployed_at_unix,
 *     chain_id, image, size, meta_hash_hex,
 *     format,         // "single" or "stack" (derived from manifest_json content)
 *     manifest_json   // string — the canonical Fred-rendered manifest_json
 *                     // returned by build_manifest_preview, with any
 *                     // trailing whitespace stripped (normalizes the
 *                     // newline a heredoc-fed --manifest-file always
 *                     // contains). For valid input this preserves the
 *                     // exact bytes whose SHA-256 is meta_hash_hex.
 *   }
 *
 * `manifest_json` may contain sensitive values (env values typed during the
 * authoring flow). Exposure is mitigated by file mode 0600, parent dir 0700.
 * Skills must NOT surface the file contents verbatim — use
 * `summarize-manifest.cjs` or `list-saved-manifests.cjs` for safe display.
 *
 * The string form is intentional: reproducible audit (sha256 of the stored
 * manifest_json must equal meta_hash_hex for valid input — heredoc-added
 * trailing newlines are normalized away), and round-trip identity to what
 * was uploaded.
 *
 * Usage:
 *   node save-manifest.cjs \
 *     --lease-uuid <uuid> \
 *     --image <ref> \
 *     --size <sku-name> \
 *     --meta-hash <hex>          (renamed from --meta-hash to --meta-hash-hex internally; flag stays --meta-hash for callers) \
 *     --chain-id <chain-id> \
 *     --manifest-file <path-to-tmpfile-with-manifest_json-as-string>
 *
 * --manifest-file must contain the canonical Fred-rendered manifest JSON (the
 * `manifest_json` string returned by build_manifest_preview), NOT the
 * structured spec input.
 */

const { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync, unlinkSync } = require('node:fs');
const { join, dirname, basename } = require('node:path');
const { homedir } = require('node:os');

const AGENT_DIR = join(homedir(), '.manifest-agent');
const MANIFESTS_DIR = join(AGENT_DIR, 'manifests');
// Strict UUID v1–v5 / unspecified-version pattern. Reject anything else so a
// `lease_uuid` containing path separators or `..` cannot escape MANIFESTS_DIR
// (which would let a malicious caller overwrite ~/.manifest-agent/config.json
// or other agent state). Chain-issued UUIDs always match this pattern.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--lease-uuid' && next) { args.leaseUuid = next; i++; }
    else if (flag === '--image' && next) { args.image = next; i++; }
    else if (flag === '--size' && next) { args.size = next; i++; }
    else if (flag === '--meta-hash' && next) { args.metaHash = next; i++; }
    else if (flag === '--chain-id' && next) { args.chainId = next; i++; }
    else if (flag === '--manifest-file' && next) { args.manifestFile = next; i++; }
  }
  return args;
}

function atomicWrite(targetPath, contents) {
  const dir = dirname(targetPath);
  const tmp = join(dir, `.${basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, contents, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, targetPath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

(async () => {
  const args = parseArgs(process.argv);
  const required = ['leaseUuid', 'image', 'size', 'metaHash', 'chainId', 'manifestFile'];
  const missing = required.filter((k) => !args[k]);
  if (missing.length > 0) {
    console.error(`Missing required flag(s): ${missing.map((k) => '--' + k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())).join(', ')}`);
    process.exit(1);
  }

  if (!UUID_RE.test(args.leaseUuid)) {
    console.error(`--lease-uuid must be a UUID; got "${args.leaseUuid}"`);
    process.exit(1);
  }

  if (!existsSync(args.manifestFile)) {
    console.error(`Manifest file not found: ${args.manifestFile}`);
    process.exit(1);
  }

  // Read the manifest as a STRING — preserve exact bytes for audit.
  const manifestString = readFileSync(args.manifestFile, 'utf8');

  // Validate it parses (sanity check) and derive `format`.
  let manifestObj;
  try {
    manifestObj = JSON.parse(manifestString);
  } catch (err) {
    console.error(`Manifest file is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  if (manifestObj === null || typeof manifestObj !== 'object' || Array.isArray(manifestObj)) {
    console.error('Manifest file must contain a JSON object');
    process.exit(1);
  }

  // `format` follows Fred's own convention: a manifest with a top-level
  // `services` map is a stack; otherwise it's a single-service manifest.
  const isStack = manifestObj.services
    && typeof manifestObj.services === 'object'
    && !Array.isArray(manifestObj.services);
  const format = isStack ? 'stack' : 'single';

  mkdirSync(MANIFESTS_DIR, { recursive: true, mode: 0o700 });
  chmodSync(MANIFESTS_DIR, 0o700);

  const now = new Date();
  const wrapper = {
    schema_version: 2,
    lease_uuid: args.leaseUuid,
    deployed_at_iso: now.toISOString(),
    deployed_at_unix: Math.floor(now.getTime() / 1000),
    chain_id: args.chainId,
    image: args.image,
    size: args.size,
    meta_hash_hex: args.metaHash,
    format,
    // String form is intentional — see header docstring.
    manifest_json: manifestString.trimEnd(),
  };

  const outPath = join(MANIFESTS_DIR, `${args.leaseUuid}.json`);
  atomicWrite(outPath, JSON.stringify(wrapper, null, 2) + '\n');
  console.log(outPath);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
