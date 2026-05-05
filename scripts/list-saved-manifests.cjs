#!/usr/bin/env node
'use strict';

/**
 * List saved post-deploy manifest wrappers under ~/.manifest-agent/manifests/.
 *
 * Output (JSON array, pretty-printed): one entry per file, with ONLY the
 * non-sensitive wrapper fields:
 *
 *   { lease_uuid, image, size, deployed_at_iso, chain_id,
 *     format?, meta_hash_hex?, schema_version?,
 *     custom_domain?, custom_domain_service_name? }
 *
 * `manifest_json` is intentionally NEVER included — it can carry env values
 * the user supplied during authoring (DB URLs, API tokens). Skills should
 * call this script instead of reading the wrapper files directly to avoid
 * leaking sensitive data into chat. FQDNs (`custom_domain`,
 * `custom_domain_service_name`) are NOT secrets — safe to surface.
 *
 * Used by troubleshoot-deployment as a fallback lease picker when the
 * manifest://leases/active MCP resource is empty or unavailable.
 *
 * Files with malformed JSON or unexpected JSON shape (null, primitive, array
 * — anything other than a plain object) emit an entry shaped
 * { lease_uuid: <basename>, error: "..." } so the picker can still surface
 * them. The basename (filename minus `.json`) is used as `lease_uuid` when
 * the wrapper itself is unreadable or doesn't carry one.
 */

const { readdirSync, readFileSync, statSync } = require('node:fs');
const { join, basename } = require('node:path');
const { homedir } = require('node:os');

const MANIFESTS_DIR = join(homedir(), '.manifest-agent', 'manifests');

const SAFE_FIELDS = ['lease_uuid', 'image', 'size', 'deployed_at_iso', 'chain_id', 'format', 'meta_hash_hex', 'schema_version', 'custom_domain', 'custom_domain_service_name'];

(async () => {
  let entries;
  try {
    entries = readdirSync(MANIFESTS_DIR);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log('[]');
      return;
    }
    throw err;
  }

  const out = [];
  for (const name of entries.sort()) {
    if (!name.endsWith('.json')) continue;
    const path = join(MANIFESTS_DIR, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;

    const leaseUuid = basename(name, '.json');
    let wrapper;
    try {
      wrapper = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      out.push({ lease_uuid: leaseUuid, error: `parse failed: ${err.message}` });
      continue;
    }

    // Defensive shape check: a manually-created or corrupted file might
    // contain `null`, a primitive, or an array. Without this guard, the
    // SAFE_FIELDS loop below would throw on `wrapper[k]` and abort the
    // whole listing.
    if (wrapper === null || typeof wrapper !== 'object' || Array.isArray(wrapper)) {
      out.push({ lease_uuid: leaseUuid, error: 'unexpected JSON shape (expected an object)' });
      continue;
    }

    const safe = {};
    for (const k of SAFE_FIELDS) {
      if (wrapper[k] !== undefined) safe[k] = wrapper[k];
    }
    // Always surface lease_uuid even if absent from the wrapper (use filename).
    if (!safe.lease_uuid) safe.lease_uuid = leaseUuid;
    out.push(safe);
  }

  console.log(JSON.stringify(out, null, 2));
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
