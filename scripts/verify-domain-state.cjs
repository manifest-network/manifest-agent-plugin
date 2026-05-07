#!/usr/bin/env node
'use strict';

/**
 * Verify a lease item's `customDomain` against an expected value, after
 * a `set_item_custom_domain` broadcast.
 *
 * Replaces the prose equality-check that used to live in manage-domain's
 * Step 6 verification. Shares lease-shape decoding with
 * `extract-lease-items.cjs` via the `_lease-items.cjs` sibling helper, and
 * adds the comparison against an expected value so the call site doesn't
 * have to inline the equality. Used today by `manage-domain` set/clear;
 * the deploy-app partial-success retry path uses `extract-lease-items.cjs`
 * directly without going through this wrapper.
 *
 * Stdin (JSON object): the raw `leases_by_tenant` response (same shape
 *                      `extract-lease-items.cjs` consumes).
 *
 * Args:
 *   --lease-uuid <uuid>      required. The lease to verify.
 *   --service-name <name>    optional. The service to target inside the
 *                            lease (for stack leases). Omit for
 *                            single-item leases. Empty string treated
 *                            same as omitted.
 *   --expected <value>       required. One of:
 *                              "<fqdn>"  — verify the matching item's
 *                                          customDomain equals this FQDN.
 *                              ""        — verify the matching item's
 *                                          customDomain is empty (clear).
 *                            Use --expected "" for the clear-mode check.
 *
 * Output (stdout, single-line JSON):
 *   {
 *     outcome:     "match"     // expected matches actual
 *                | "mismatch"  // expected differs from actual
 *                | "not_found",// lease UUID or service-name not found
 *     actual?:     string,     // the item's customDomain when outcome is
 *                              // match or mismatch (omitted on not_found)
 *     reason?:     string      // human-readable detail when not_found
 *   }
 *
 * Exit codes: 0 success (regardless of outcome — the caller branches on
 *             the JSON); 1 bad args / unparseable stdin.
 */

const { readFileSync } = require('node:fs');
const { UUID_RE } = require('./_uuid.cjs');
const { findLease, normalizeItem } = require('./_lease-items.cjs');

function parseArgs(argv) {
  const args = {};
  let expectedSeen = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--lease-uuid' && argv[i + 1] !== undefined) { args.leaseUuid = argv[++i]; }
    else if (argv[i] === '--service-name' && argv[i + 1] !== undefined) { args.serviceName = argv[++i]; }
    else if (argv[i] === '--expected' && argv[i + 1] !== undefined) { args.expected = argv[++i]; expectedSeen = true; }
  }
  args._expectedSeen = expectedSeen;
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
  if (!args._expectedSeen) {
    console.error('Missing required flag: --expected (use --expected "" for clear-mode)');
    process.exit(1);
  }

  const stdinRaw = readFileSync(0, 'utf8');
  let payload;
  try {
    payload = JSON.parse(stdinRaw);
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
    console.log(JSON.stringify({ outcome: 'not_found', reason: 'lease UUID not in tenant leases' }));
    return;
  }

  const itemsRaw = Array.isArray(lease.items) ? lease.items : [];
  const items = itemsRaw.map(normalizeItem);
  const single_item = items.length === 1 && items[0].serviceName === '';

  const requestedService = (args.serviceName ?? '').trim();
  let item;
  if (single_item) {
    item = items[0];
  } else if (requestedService === '') {
    console.log(JSON.stringify({ outcome: 'not_found', reason: 'lease has multiple items but --service-name was not supplied' }));
    return;
  } else {
    item = items.find((i) => i.serviceName === requestedService);
    if (!item) {
      console.log(JSON.stringify({ outcome: 'not_found', reason: `service-name "${requestedService}" not found in lease items` }));
      return;
    }
  }

  const actual = item.customDomain || '';
  const outcome = actual === args.expected ? 'match' : 'mismatch';
  console.log(JSON.stringify({ outcome, actual }));
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
