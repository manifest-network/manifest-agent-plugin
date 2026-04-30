#!/usr/bin/env node
'use strict';

/**
 * Persist a deployed manifest to ~/.manifest-agent/manifests/<lease_uuid>.json
 *
 * Wrapper shape (schema_version 1):
 *   {
 *     schema_version: 1,
 *     lease_uuid, deployed_at_iso, deployed_at_unix,
 *     chain_id, image, size, meta_hash,
 *     manifest_json
 *   }
 *
 * No secrets. Mode 0600. Parent dir 0700, mkdir recursive.
 *
 * Usage:
 *   node save-manifest.cjs \
 *     --lease-uuid <uuid> \
 *     --image <ref> \
 *     --size <sku-name> \
 *     --meta-hash <hex> \
 *     --chain-id <chain-id> \
 *     --manifest-file <path-to-tmpfile-with-manifest_json>
 */

const { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');

const AGENT_DIR = join(homedir(), '.manifest-agent');
const MANIFESTS_DIR = join(AGENT_DIR, 'manifests');

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

(async () => {
  const args = parseArgs(process.argv);
  const required = ['leaseUuid', 'image', 'size', 'metaHash', 'chainId', 'manifestFile'];
  const missing = required.filter((k) => !args[k]);
  if (missing.length > 0) {
    console.error(`Missing required flag(s): ${missing.map((k) => '--' + k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())).join(', ')}`);
    process.exit(1);
  }

  if (!existsSync(args.manifestFile)) {
    console.error(`Manifest file not found: ${args.manifestFile}`);
    process.exit(1);
  }

  let manifestJson;
  try {
    manifestJson = JSON.parse(readFileSync(args.manifestFile, 'utf8'));
  } catch (err) {
    console.error(`Failed to parse manifest file as JSON: ${err.message}`);
    process.exit(1);
  }

  mkdirSync(MANIFESTS_DIR, { recursive: true, mode: 0o700 });
  // recursive mkdir does not chmod existing dirs — set explicitly.
  chmodSync(MANIFESTS_DIR, 0o700);

  const now = new Date();
  const wrapper = {
    schema_version: 1,
    lease_uuid: args.leaseUuid,
    deployed_at_iso: now.toISOString(),
    deployed_at_unix: Math.floor(now.getTime() / 1000),
    chain_id: args.chainId,
    image: args.image,
    size: args.size,
    meta_hash: args.metaHash,
    manifest_json: manifestJson,
  };

  const outPath = join(MANIFESTS_DIR, `${args.leaseUuid}.json`);
  writeFileSync(outPath, JSON.stringify(wrapper, null, 2) + '\n');
  chmodSync(outPath, 0o600);

  console.log(outPath);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
