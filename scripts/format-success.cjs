#!/usr/bin/env node
'use strict';

/**
 * Render the user-facing "Deployed." block for a successful /deploy-app run.
 *
 * Input (stdin, JSON object):
 *   {
 *     deploy_response: <raw deploy_app response>,
 *     catalog:        <raw browse_catalog response>
 *   }
 *
 * Args:
 *   --lease-uuid <uuid>   strict-validated; used to populate the Lease UUID line
 *
 * Output (stdout): plain text suitable for direct chat output. Designed
 * to be printed VERBATIM by the orchestrator skill — no paraphrasing or
 * surrounding prose. Example:
 *
 *   Deployed.
 *     Provider:      <human name or uuid>
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
 * Provider name resolution: the catalog's shape varies by version, so we
 * look for any provider entry whose `uuid` (or `provider_uuid`) matches
 * the deploy_response's provider_uuid; we surface the first `name` we
 * find. On miss, fall back to the raw UUID. The lookup is best-effort —
 * if catalog is absent or shaped unexpectedly, we still produce the
 * success block with the lease UUID + ingress.
 */

const { readFileSync } = require('node:fs');
const { decode: decodeLeaseState } = require('./_lease-state.cjs');
const { UUID_RE } = require('./_uuid.cjs');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--lease-uuid' && argv[i + 1]) { args.leaseUuid = argv[++i]; }
  }
  return args;
}

function buildIngresses(connection) {
  // Returns an array of bare FQDNs (or "ip:port" strings for the legacy
  // fallback). The provider exposes apps via subdomain-based routing on
  // standard ports — host_port in instances[].ports[] is an internal
  // container mapping, not part of the user-facing hostname. One entry
  // per running instance regardless of how many ports it exposes
  // (routing is by hostname, not port).
  //
  // The provider's ConnectionDetails schema (manifest-mcp-fred 0.8.0)
  // can carry instance lists in two places, both of which we collect:
  //   - top-level `connection.instances[]` (single-service / legacy
  //     non-services-map shape)
  //   - per-service `connection.services.<name>.instances[]` (stack /
  //     services-map shape — emitted whenever the spec uses the
  //     services-map form, which author-manifest now always does even
  //     for single-service deploys to enable per-port `ingress: bool`)
  //
  // Without the per-service branch, /deploy-app on a services-map spec
  // that the chain happily provisioned still reports
  // "Ingress: (none — service is internal or no FQDN reported)" because
  // the ingress lives one level deeper.
  if (!connection || typeof connection !== 'object') return [];
  const out = [];
  const seen = new Set();
  function pushFromInstances(instances) {
    if (!Array.isArray(instances)) return;
    for (const inst of instances) {
      if (!inst || inst.status !== 'running' || !inst.fqdn) continue;
      if (seen.has(inst.fqdn)) continue;
      seen.add(inst.fqdn);
      out.push(inst.fqdn);
    }
  }
  pushFromInstances(connection.instances);
  if (connection.services && typeof connection.services === 'object') {
    for (const svc of Object.values(connection.services)) {
      if (svc && typeof svc === 'object') pushFromInstances(svc.instances);
    }
  }
  // Legacy fallback: top-level connection.host + connection.ports. host
  // here is typically a raw IP, which has no subdomain routing — caller
  // still needs the port. Render as "ip:port".
  if (out.length === 0 && connection.host && connection.ports) {
    for (const portKey of Object.keys(connection.ports)) {
      const v = connection.ports[portKey];
      const port = typeof v === 'number' || typeof v === 'string' ? v : (v && v.host_port);
      if (port !== undefined) out.push(`${connection.host}:${port}`);
    }
  }
  return out;
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

function findProviderName(catalog, providerUuid) {
  if (!providerUuid || !catalog || typeof catalog !== 'object') return null;
  // Catalog shape may be { providers: [...] } or just an array. Walk both.
  const collections = [];
  if (Array.isArray(catalog)) collections.push(catalog);
  if (Array.isArray(catalog.providers)) collections.push(catalog.providers);
  if (Array.isArray(catalog.entries)) collections.push(catalog.entries);
  for (const list of collections) {
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const uuid = entry.uuid || entry.provider_uuid || (entry.provider && entry.provider.uuid);
      if (uuid !== providerUuid) continue;
      const name = entry.name || (entry.provider && entry.provider.name);
      if (name) return String(name);
    }
  }
  return null;
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
  const catalog = payload && payload.catalog;
  if (!dr || typeof dr !== 'object') {
    console.error('stdin.deploy_response is required');
    process.exit(1);
  }

  const ingresses = buildIngresses(dr.connection);
  const providerName = findProviderName(catalog, dr.provider_uuid) || dr.provider_uuid || '(unknown)';
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
