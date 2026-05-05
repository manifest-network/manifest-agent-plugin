#!/usr/bin/env node
'use strict';

/**
 * Synthesize a DEPLOY_RESPONSE-shaped object from an `app_status` payload.
 *
 * Used in the deploy-app orchestrator's recovery branches when the
 * happy-path `deploy_app` return is unavailable (partial-success retry,
 * the wait-then-status fallback). Downstream consumers — classify-deploy-
 * response.cjs, format-success.cjs, save-manifest.cjs — expect the
 * { lease_uuid, provider_uuid, state, connection, custom_domain? }
 * shape; pinning that mapping here prevents the LLM from omitting a
 * field and silently misclassifying the lease.
 *
 * Stdin (JSON object): the raw `app_status` response shape, at least:
 *   {
 *     chainState: { providerUuid, state },
 *     connection: { ... }    // typed connection payload
 *   }
 *
 * Args:
 *   --lease-uuid <uuid>     required
 *   --custom-domain <fqdn>  optional (set only when a retry-set-domain
 *                           pass succeeded for this lease)
 *
 * Output (stdout, single-line JSON):
 *   {
 *     lease_uuid:    string,
 *     provider_uuid: string | undefined,
 *     state:         string | number | undefined,
 *     connection:    object | undefined,
 *     custom_domain: string | undefined
 *   }
 *
 * Exit codes: 0 success; 1 bad args / unparseable stdin / shape error.
 */

const { readFileSync } = require('node:fs');
const { UUID_RE } = require('./_uuid.cjs');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--lease-uuid' && argv[i + 1]) { args.leaseUuid = argv[++i]; }
    else if (argv[i] === '--custom-domain' && argv[i + 1]) { args.customDomain = argv[++i]; }
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
  let appStatus;
  try {
    appStatus = JSON.parse(raw);
  } catch (err) {
    console.error(`stdin is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  if (appStatus === null || typeof appStatus !== 'object' || Array.isArray(appStatus)) {
    console.error('stdin must be a JSON object (the app_status response)');
    process.exit(1);
  }

  const chainState = appStatus.chainState && typeof appStatus.chainState === 'object'
    ? appStatus.chainState
    : {};

  const out = {
    lease_uuid: args.leaseUuid,
    ...(typeof chainState.providerUuid === 'string' && { provider_uuid: chainState.providerUuid }),
    ...(chainState.state !== undefined && { state: chainState.state }),
    ...(appStatus.connection !== undefined && { connection: appStatus.connection }),
    ...(typeof args.customDomain === 'string' && args.customDomain.length > 0 && {
      custom_domain: args.customDomain,
    }),
  };

  console.log(JSON.stringify(out));
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
