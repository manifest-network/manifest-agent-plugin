#!/usr/bin/env node
'use strict';

/**
 * Render the AskUserQuestion prompt body + option list for the partial-
 * success recovery branch in deploy-app Step 11.
 *
 * The prompt has conditional inserts (different wording for "custom domain
 * was requested" vs "no custom domain", and option 1 is omitted entirely
 * when no domain was requested in the first place). Pinning this in a
 * script keeps the wording consistent across runs and lets the skill drop
 * the conditional template from prose.
 *
 * Args (all required except --requested-custom-domain):
 *   --lease-uuid <uuid>              the lease that was created on-chain
 *   --decoded-state <name>           e.g. "LEASE_STATE_PENDING"
 *   --reason <text>                  the failure reason from the MCP
 *                                    error envelope (or
 *                                    classify-deploy-error.cjs output)
 *   --requested-custom-domain <fqdn> optional; presence of this flag
 *                                    drives both the wording AND whether
 *                                    option 1 ("Retry set-domain") is
 *                                    included
 *
 * Output (stdout, single-line JSON):
 *   {
 *     "prompt":  "<multi-line prompt body to pass to AskUserQuestion>",
 *     "options": ["Retry set-domain + upload", "Salvage without domain", "Cancel or close the lease"]
 *               // option 1 omitted when --requested-custom-domain is absent
 *   }
 *
 * Exit codes: 0 success; 1 missing args.
 */

const { UUID_RE } = require('./_uuid.cjs');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--lease-uuid' && argv[i + 1]) { args.leaseUuid = argv[++i]; }
    else if (argv[i] === '--decoded-state' && argv[i + 1]) { args.decodedState = argv[++i]; }
    else if (argv[i] === '--reason' && argv[i + 1]) { args.reason = argv[++i]; }
    else if (argv[i] === '--requested-custom-domain' && argv[i + 1]) { args.requestedCustomDomain = argv[++i]; }
  }
  return args;
}

(async () => {
  const args = parseArgs(process.argv);
  const missing = [];
  if (!args.leaseUuid) missing.push('--lease-uuid');
  if (!args.decodedState) missing.push('--decoded-state');
  if (!args.reason) missing.push('--reason');
  if (missing.length > 0) {
    console.error(`Missing required flag(s): ${missing.join(', ')}`);
    process.exit(1);
  }
  if (!UUID_RE.test(args.leaseUuid)) {
    console.error(`--lease-uuid must be a UUID; got "${args.leaseUuid}"`);
    process.exit(1);
  }

  const hasDomain = typeof args.requestedCustomDomain === 'string' && args.requestedCustomDomain.length > 0;

  const lines = [
    'Deploy partially succeeded:',
    `  - Lease ${args.leaseUuid} was created on-chain (state: ${args.decodedState}).`,
  ];
  if (hasDomain) {
    lines.push(
      `  - The set-domain step for ${args.requestedCustomDomain} did NOT complete: ${args.reason}.`,
      '    The manifest was therefore NEVER uploaded to the provider — no app is running on this lease.',
    );
  } else {
    lines.push(
      `  - The manifest upload or readiness poll failed: ${args.reason}.`,
      '    The provider may or may not have started the app.',
    );
  }
  lines.push('', 'What do you want to do?');

  const options = [];
  if (hasDomain) {
    options.push('Retry set-domain + upload');
  }
  options.push('Salvage without domain');
  options.push('Cancel or close the lease');

  console.log(JSON.stringify({ prompt: lines.join('\n'), options }));
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
