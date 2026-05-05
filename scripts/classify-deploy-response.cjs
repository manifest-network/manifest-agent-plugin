#!/usr/bin/env node
'use strict';

/**
 * Classify the response from `mcp__manifest-fred__deploy_app` into one of three
 * outcomes for the orchestrator skill to branch on.
 *
 * Input (stdin, JSON object): the raw deploy_app response shape:
 *   { lease_uuid, provider_uuid, provider_url, state, url?, connection?, connectionError? }
 * Where:
 *   - state may be an integer (e.g. 2) or a string (e.g. "LEASE_STATE_ACTIVE")
 *   - connection.instances[i].fqdn is the user-facing hostname (provider
 *     does subdomain-based routing on port 80, so host_port is an internal
 *     container mapping and not part of the URL)
 *
 * Output (stdout, single-line JSON):
 *   {
 *     outcome:        "active" | "needs_wait" | "failed",
 *     lease_uuid?:    string,
 *     provider_uuid?: string,
 *     provider_url?:  string,
 *     urls:           [string, ...],   // externally-reachable URLs (may be empty)
 *     state_name?:    string,          // decoded enum name when known
 *     error_summary?: string           // present only when outcome=failed
 *   }
 *
 * "active": state is LEASE_STATE_ACTIVE AND at least one running instance with
 *           a host port. The orchestrator can skip wait_for_app_ready.
 * "needs_wait": lease created but not yet active OR connection details missing.
 *               Orchestrator should call wait_for_app_ready as a fallback.
 * "failed": no lease_uuid present, OR state is a terminal failure state
 *           (LEASE_STATE_CLOSED or LEASE_STATE_INSUFFICIENT_FUNDS).
 *           Orchestrator routes to the troubleshoot/cleanup branch.
 */

const { readFileSync } = require('node:fs');
const { decode: decodeState } = require('./_lease-state.cjs');
const { extractRunningEndpoints, formatEndpointAsUrl } = require('./_connection.cjs');

function buildUrls(connection) {
  // Returns full https:// URLs for every running instance. See
  // _connection.cjs for the typed-payload walk.
  return extractRunningEndpoints(connection)
    .map(formatEndpointAsUrl)
    .filter((u) => u !== null);
}

(async () => {
  const raw = readFileSync(0, 'utf8');
  let r;
  try {
    r = JSON.parse(raw);
  } catch (err) {
    console.error(`stdin is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  if (r === null || typeof r !== 'object') {
    console.error('stdin must be a JSON object');
    process.exit(1);
  }

  const stateName = decodeState(r.state);
  const urls = buildUrls(r.connection);
  // If the MCP server returned a top-level `url` (e.g. host:port without scheme),
  // prepend a scheme so consumers get a clickable URL.
  if (typeof r.url === 'string' && r.url.length > 0) {
    const u = /^https?:\/\//i.test(r.url) ? r.url : `https://${r.url}/`;
    if (!urls.includes(u)) urls.unshift(u);
  }

  const lease_uuid = typeof r.lease_uuid === 'string' ? r.lease_uuid : undefined;

  let outcome;
  if (!lease_uuid) {
    outcome = 'failed';
  } else if (stateName === 'LEASE_STATE_ACTIVE' && urls.length > 0) {
    outcome = 'active';
  } else if (stateName === 'LEASE_STATE_CLOSED' || stateName === 'LEASE_STATE_INSUFFICIENT_FUNDS') {
    outcome = 'failed';
  } else {
    // Pending, unspecified, active-without-running-instance, etc.
    outcome = 'needs_wait';
  }

  const out = {
    outcome,
    ...(lease_uuid && { lease_uuid }),
    ...(r.provider_uuid && { provider_uuid: r.provider_uuid }),
    ...(r.provider_url && { provider_url: r.provider_url }),
    urls,
    ...(stateName && { state_name: stateName }),
  };
  if (outcome === 'failed') {
    if (typeof r.connectionError === 'string') out.error_summary = r.connectionError;
    else if (!lease_uuid) out.error_summary = 'deploy_app returned no lease_uuid';
    else out.error_summary = `Lease ${lease_uuid} reached terminal state ${stateName || 'UNKNOWN'}`;
  }

  console.log(JSON.stringify(out));
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
