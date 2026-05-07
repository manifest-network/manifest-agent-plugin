#!/usr/bin/env node
'use strict';

/**
 * Extract a target lease's items[] from a `leases_by_tenant` response.
 *
 * Pins the typed-shape decoding that was in manage-domain's stack service
 * picker and post-broadcast custom-domain verification. Both call sites
 * previously walked `response.leases[]` → match by UUID → read
 * `items[].serviceName / customDomain` in prose. Centralizing here means
 * the chain shape is decoded once.
 *
 * Stdin (JSON object): the raw `leases_by_tenant` response. Tolerates
 * either `{leases: [...]}` (current chain shape) or a bare array — the
 * MCP wrapper has shifted shapes before.
 *
 * Args:
 *   --lease-uuid <uuid>    required. The lease to extract items for.
 *
 * Output (stdout, single-line JSON):
 *   {
 *     found:        boolean,            // false → lease UUID not in tenant's leases
 *     items: [                          // empty when found=false
 *       {
 *         serviceName:  string | "",    // "" for single-item leases
 *         customDomain: string | ""     // "" when no domain set
 *       }, ...
 *     ],
 *     single_item:  boolean             // convenience: items.length === 1 AND
 *                                       //  the one item has no serviceName
 *   }
 *
 * Exit codes: 0 success; 1 bad args / unparseable stdin / unrecognized shape.
 */

const { readFileSync } = require('node:fs');
const { UUID_RE } = require('./_uuid.cjs');
const { findLease, normalizeItem } = require('./_lease-items.cjs');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--lease-uuid' && argv[i + 1]) { args.leaseUuid = argv[++i]; }
  }
  return args;
}

(async () => {
  const args = parseArgs(process.argv);
  if (!args.leaseUuid) {
    console.error('Missing required flag: --lease-uuid');
    process.exit(1);
  }
  if (!UUID_RE.test(args.leaseUuid)) {
    console.error(`--lease-uuid must be a UUID; got "${args.leaseUuid}"`);
    process.exit(1);
  }

  const raw = readFileSync(0, 'utf8');
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    console.error(`stdin is not valid JSON: ${err.message}`);
    process.exit(1);
  }

  let lease;
  try {
    lease = findLease(payload, args.leaseUuid);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  if (!lease) {
    console.log(JSON.stringify({ found: false, items: [], single_item: false }));
    return;
  }

  const itemsRaw = Array.isArray(lease.items) ? lease.items : [];
  const items = itemsRaw.map(normalizeItem);
  const single_item = items.length === 1 && items[0].serviceName === '';

  console.log(JSON.stringify({ found: true, items, single_item }));
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
