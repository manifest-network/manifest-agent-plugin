#!/usr/bin/env node
'use strict';

/**
 * Classify the MCP error envelope thrown by `mcp__manifest-fred__deploy_app`
 * when the call fails AFTER the create-lease tx already confirmed.
 *
 * Companion to `classify-deploy-response.cjs`: that script handles the
 * RETURN path (lease created + connection details available); THIS script
 * handles the THROW path. The split exists because manifest-mcp-fred 0.8.0
 * `deploy_app` throws `ManifestMCPError` with message
 * `Deploy partially succeeded: lease ${uuid} was created but subsequent
 * steps failed. Close this lease with close_lease if needed. Error: …`
 * and `details.lease_uuid` populated when create-lease succeeded but
 * something downstream (set-domain, manifest upload, readiness poll) fell
 * over. The throw path lives in `manifest-mcp-fred/dist/tools/deployApp.js`,
 * in the block that constructs the message starting `Deploy partially
 * succeeded:` (line numbers omitted intentionally — they shift on patch
 * releases; grep the message string to find it).
 *
 * Stdin (JSON object): the MCP error envelope as the orchestrator captures
 * it from the thrown error. Recognised shapes:
 *   { message, details?, code? }
 *   { error: { message, details?, code? } }
 *   { name?, message }   (plain Error fallback)
 *
 * Args:
 *   --expected-custom-domain <fqdn>   (optional) what the orchestrator
 *                                     was about to claim. Echoed back in
 *                                     the output so the prompt the user
 *                                     sees can mention it explicitly.
 *
 * Output (stdout, JSON one-liner):
 *   {
 *     outcome:                  "partially_succeeded" | "failed",
 *     lease_uuid?:              string,
 *     requested_custom_domain?: string,   // echoed from --expected-custom-domain
 *     reason:                   string    // human-readable summary
 *   }
 *
 * `outcome: "partially_succeeded"` triggers ONLY when the error message
 * starts with `Deploy partially succeeded:` — that's the upstream
 * contract; matching anything looser would risk false positives.
 *
 * Always exits 0. A malformed envelope is reported as
 * `outcome: "failed", reason: "<parse failure>"` so the orchestrator can
 * still branch deterministically.
 */

const { readFileSync } = require('node:fs');
const { UUID_PATTERN } = require('./_uuid.cjs');

const PARTIAL_PREFIX = 'Deploy partially succeeded:';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--expected-custom-domain' && argv[i + 1]) { args.expectedCustomDomain = argv[++i]; }
  }
  return args;
}

function pickEnvelope(raw) {
  // Tolerate two envelope shapes: a bare error object, or a wrapping
  // `{ error: {...} }` (which is what JSON.stringify(err) produces in some
  // SDKs).
  if (raw && typeof raw === 'object' && raw.error && typeof raw.error === 'object') return raw.error;
  return raw;
}

(async () => {
  const args = parseArgs(process.argv);

  const stdinRaw = readFileSync(0, 'utf8');
  let envelope;
  try {
    envelope = JSON.parse(stdinRaw);
  } catch (err) {
    console.log(JSON.stringify({
      outcome: 'failed',
      reason: `stdin is not valid JSON: ${err.message}`,
      ...(args.expectedCustomDomain && { requested_custom_domain: args.expectedCustomDomain }),
    }));
    return;
  }

  const e = pickEnvelope(envelope);
  if (!e || typeof e !== 'object') {
    console.log(JSON.stringify({
      outcome: 'failed',
      reason: 'stdin envelope is not an object',
      ...(args.expectedCustomDomain && { requested_custom_domain: args.expectedCustomDomain }),
    }));
    return;
  }

  const message = typeof e.message === 'string' ? e.message : '';
  const details = e.details && typeof e.details === 'object' ? e.details : {};

  // Partial-success trigger: exact upstream prefix. Looser matching would
  // risk classifying generic "lease created" errors as partial success.
  if (message.startsWith(PARTIAL_PREFIX)) {
    let leaseUuid = typeof details.lease_uuid === 'string' ? details.lease_uuid : null;
    if (!leaseUuid) {
      const m = message.match(UUID_PATTERN);
      if (m) leaseUuid = m[0];
    }
    const out = {
      outcome: 'partially_succeeded',
      reason: message,
    };
    if (leaseUuid) out.lease_uuid = leaseUuid;
    if (args.expectedCustomDomain) out.requested_custom_domain = args.expectedCustomDomain;
    console.log(JSON.stringify(out));
    return;
  }

  // Anything else: terminal failure, no lease to clean up (the create-lease
  // tx didn't confirm or the error happened before it broadcast).
  const out = {
    outcome: 'failed',
    reason: message || 'deploy_app threw an empty error',
  };
  if (args.expectedCustomDomain) out.requested_custom_domain = args.expectedCustomDomain;
  console.log(JSON.stringify(out));
})().catch((err) => {
  // Per CLAUDE.md ("All scripts use CJS — async IIFE with
  // .catch(() => process.exit(1))"), an unexpected throw is a process
  // error, not a data result. Print the diagnostic to stderr and exit
  // non-zero so the orchestrator can branch on it.
  console.error(`unexpected classifier error: ${err.message || String(err)}`);
  process.exit(1);
});
