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
 * Output (stdout): plain text suitable for direct chat output, e.g.
 *
 *   Deployed.
 *     URL:        http://<fqdn>:<port>/
 *     Lease UUID: <uuid>
 *     Provider:   <human name or uuid>
 *   For logs / status:  /manifest-agent:troubleshoot-deployment
 *
 * Multiple URLs (multi-port or multi-service) are listed one per line.
 *
 * Provider name resolution: the catalog's shape varies by version, so we look
 * for any provider entry whose `uuid` (or `provider_uuid`) matches the
 * deploy_response's provider_uuid; we surface the first `name` we find. On
 * miss, fall back to the raw UUID. The lookup is best-effort — if catalog is
 * absent or shaped unexpectedly, we still produce the success block with the
 * URL + lease UUID.
 */

const { readFileSync } = require('node:fs');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--lease-uuid' && argv[i + 1]) { args.leaseUuid = argv[++i]; }
  }
  return args;
}

function buildUrls(connection, fallbackUrl) {
  if (!connection || typeof connection !== 'object') {
    if (typeof fallbackUrl === 'string' && fallbackUrl.length > 0) {
      return [/^https?:\/\//i.test(fallbackUrl) ? fallbackUrl : `http://${fallbackUrl}/`];
    }
    return [];
  }
  const out = [];
  if (Array.isArray(connection.instances)) {
    for (const inst of connection.instances) {
      if (!inst || inst.status !== 'running' || !inst.fqdn) continue;
      const ports = inst.ports || {};
      for (const portKey of Object.keys(ports)) {
        const p = ports[portKey];
        if (p && (typeof p.host_port === 'number' || typeof p.host_port === 'string')) {
          out.push(`http://${inst.fqdn}:${p.host_port}/`);
        }
      }
    }
  }
  if (out.length === 0 && connection.host && connection.ports) {
    for (const portKey of Object.keys(connection.ports)) {
      const v = connection.ports[portKey];
      const port = typeof v === 'number' || typeof v === 'string' ? v : (v && v.host_port);
      if (port !== undefined) out.push(`http://${connection.host}:${port}/`);
    }
  }
  if (out.length === 0 && typeof fallbackUrl === 'string' && fallbackUrl.length > 0) {
    out.push(/^https?:\/\//i.test(fallbackUrl) ? fallbackUrl : `http://${fallbackUrl}/`);
  }
  return out;
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

  const urls = buildUrls(dr.connection, dr.url);
  const providerName = findProviderName(catalog, dr.provider_uuid) || dr.provider_uuid || '(unknown)';

  const lines = ['Deployed.'];
  if (urls.length === 0) {
    lines.push('  URL:        (no externally-reachable URL surfaced by the provider yet)');
  } else if (urls.length === 1) {
    lines.push(`  URL:        ${urls[0]}`);
  } else {
    lines.push('  URLs:');
    for (const u of urls) lines.push(`    - ${u}`);
  }
  lines.push(`  Lease UUID: ${args.leaseUuid}`);
  lines.push(`  Provider:   ${providerName}`);
  lines.push('For logs / status:  /manifest-agent:troubleshoot-deployment');

  console.log(lines.join('\n'));
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
