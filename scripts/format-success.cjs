#!/usr/bin/env node
'use strict';

/**
 * Render the user-facing "Deployed." block for a successful /deploy-app run.
 *
 * Input (stdin, JSON object):
 *   { deploy_response: <raw deploy_app response> }
 *
 * Args:
 *   --lease-uuid <uuid>   strict-validated; used to populate the Lease UUID line
 *
 * Output (stdout): plain text suitable for direct chat output. Designed
 * to be printed VERBATIM by the orchestrator skill — no paraphrasing or
 * surrounding prose. Example:
 *
 *   Deployed.
 *     Provider:      <provider_uuid>
 *     Lease UUID:    <uuid>
 *     Lease Status:  ACTIVE
 *     Ingress:       <fqdn>
 *
 *   For logs / status:  /manifest-agent:troubleshoot-deployment <uuid>
 *
 * Multi-instance / multi-service stacks emit "Ingresses:" followed by
 * one bare FQDN per running instance. When no externally-reachable
 * ingress is reported (internal-only services, or the provider hasn't
 * surfaced an FQDN yet), the line reads
 * "Ingress: (none — service is internal or no FQDN reported)".
 *
 * When the deploy_app response carries a `custom_domain` (the set-domain
 * tx confirmed alongside create-lease), an additional line is emitted
 * BEFORE the Ingress block:
 *
 *   Custom domain (provisioning):  https://<fqdn>/  — TLS may take a few
 *     minutes; the Ingress URL below works immediately.
 *
 * The "(provisioning)" qualifier is honest — the chain tx confirmed but
 * the provider hasn't necessarily issued the cert yet. The provider FQDN
 * Ingress line stays so the user has an immediately-working endpoint
 * during DNS cutover and TLS provisioning.
 *
 * Lease state is decoded from the integer / "LEASE_STATE_*" string in
 * the deploy_response and rendered with the LEASE_STATE_ prefix
 * stripped (so "LEASE_STATE_ACTIVE" -> "ACTIVE"). Internal scaffolding
 * the user shouldn't have to read.
 *
 * Provider name: the script renders `Provider: <provider_uuid>` directly.
 * An earlier version attempted to resolve a friendly name via
 * `browse_catalog`, but the upstream `manifest-mcp-fred` catalog shape
 * (`providers[{uuid, address, apiUrl, active, healthy, providerUuid?,
 * healthError?}]`) carries no `name` field, so the lookup never resolved.
 * The catalog input is no longer accepted; if upstream adds a `name`
 * field later, restore the lookup as a thin helper using the now-shared
 * `extractRunningEndpoints` pattern.
 */

const { readFileSync } = require('node:fs');
const { decode: decodeLeaseState } = require('./_lease-state.cjs');
const { UUID_RE } = require('./_uuid.cjs');
const { extractRunningEndpoints, formatEndpointAsIngress } = require('./_connection.cjs');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--lease-uuid' && argv[i + 1]) { args.leaseUuid = argv[++i]; }
  }
  return args;
}

function buildIngresses(connection) {
  // Returns bare FQDNs (modern subdomain-routing shape) or "ip:port"
  // strings (legacy host+ports shape). Walks the typed `connection`
  // payload — see _connection.cjs for the full shape contract.
  return extractRunningEndpoints(connection)
    .map(formatEndpointAsIngress)
    .filter((s) => s !== null);
}

function decodeStateName(state) {
  // Return the user-facing form ("ACTIVE", "PENDING", etc.) — the
  // LEASE_STATE_ prefix is stripped for display. Unknown states render
  // as "UNKNOWN(<raw>)" so the raw value remains visible.
  if (state === undefined) return '(unknown)';
  const canonical = decodeLeaseState(state);
  if (canonical) return canonical.slice('LEASE_STATE_'.length);
  return `UNKNOWN(${String(state)})`;
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

  const dr = payload && payload.deploy_response;
  if (!dr || typeof dr !== 'object') {
    console.error('stdin.deploy_response is required');
    process.exit(1);
  }

  const ingresses = buildIngresses(dr.connection);
  const providerName = dr.provider_uuid || '(unknown)';
  const stateName = decodeStateName(dr.state);

  const lines = [
    'Deployed.',
    `  Provider:      ${providerName}`,
    `  Lease UUID:    ${args.leaseUuid}`,
    `  Lease Status:  ${stateName}`,
  ];
  // Custom domain line — chain tx confirmed but provider may still be
  // provisioning the cert. Present BEFORE the Ingress block so the user
  // sees the requested endpoint first, alongside the immediately-working
  // provider FQDN.
  if (typeof dr.custom_domain === 'string' && dr.custom_domain.length > 0) {
    lines.push(`  Custom domain (provisioning):  https://${dr.custom_domain}/`);
    lines.push('    — TLS may take a few minutes; the Ingress URL below works immediately.');
  }
  if (ingresses.length === 0) {
    lines.push('  Ingress:       (none — service is internal or no FQDN reported)');
  } else if (ingresses.length === 1) {
    lines.push(`  Ingress:       ${ingresses[0]}`);
  } else {
    lines.push('  Ingresses:');
    for (const fqdn of ingresses) lines.push(`    - ${fqdn}`);
  }
  lines.push('');
  lines.push(`For logs / status:  /manifest-agent:troubleshoot-deployment ${args.leaseUuid}`);

  console.log(lines.join('\n'));
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
