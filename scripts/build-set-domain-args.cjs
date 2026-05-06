#!/usr/bin/env node
'use strict';

/**
 * Build the args[] array for `cosmos_estimate_fee` / `cosmos_tx` invocations
 * targeting `billing set-item-custom-domain`.
 *
 * Single source of truth for the arg-array shape across the plugin. Used by:
 *   - manage-domain (set / clear flows; the estimate→confirm→broadcast spine)
 *   - deploy-app set-domain pre-broadcast estimate sub-step (when SPEC.customDomain
 *     is set; estimates against a representative existing lease)
 *
 * Without this script, three separate prose call-sites construct the array
 * with conditional inserts ("--service-name" for stacks, "--clear" for clear
 * action, FQDN positional only for set). A future flag added to the chain
 * msg (e.g. --ttl) would need updating in three places.
 *
 * Usage:
 *   node build-set-domain-args.cjs --lease-uuid <uuid> --fqdn <fqdn>
 *   node build-set-domain-args.cjs --lease-uuid <uuid> --fqdn <fqdn> --service-name <name>
 *   node build-set-domain-args.cjs --lease-uuid <uuid> --clear
 *   node build-set-domain-args.cjs --lease-uuid <uuid> --clear --service-name <name>
 *
 * Output (stdout, single-line JSON array):
 *   ["<lease-uuid>", "<fqdn>", "--service-name", "<name>"]   // set, stack
 *   ["<lease-uuid>", "<fqdn>"]                                // set, single
 *   ["<lease-uuid>", "--clear", "--service-name", "<name>"]   // clear, stack
 *   ["<lease-uuid>", "--clear"]                               // clear, single
 *
 * The lease UUID is validated against the strict UUID regex; service-name and
 * fqdn are NOT validated here (validate-domain.cjs handles fqdn shape; chain
 * keeper handles service existence).
 *
 * Exit codes: 0 success; 1 bad / missing args.
 */

const { UUID_RE } = require('./_uuid.cjs');

function parseArgs(argv) {
  const args = { clear: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--lease-uuid' && argv[i + 1]) { args.leaseUuid = argv[++i]; }
    else if (argv[i] === '--fqdn' && argv[i + 1]) { args.fqdn = argv[++i]; }
    else if (argv[i] === '--service-name' && argv[i + 1]) { args.serviceName = argv[++i]; }
    else if (argv[i] === '--clear') { args.clear = true; }
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

  if (args.clear && args.fqdn) {
    console.error('--clear and --fqdn are mutually exclusive (clear removes the domain; set requires the FQDN positional)');
    process.exit(1);
  }
  if (!args.clear && !args.fqdn) {
    console.error('Must pass either --fqdn (set) or --clear (clear)');
    process.exit(1);
  }

  const out = [args.leaseUuid];
  if (args.clear) {
    out.push('--clear');
  } else {
    out.push(args.fqdn);
  }
  if (args.serviceName) {
    out.push('--service-name', args.serviceName);
  }

  console.log(JSON.stringify(out));
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
