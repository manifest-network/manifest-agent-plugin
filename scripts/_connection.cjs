'use strict';

/**
 * Extract running-instance ingress data from the provider's `connection`
 * payload. Shared by format-success.cjs, classify-deploy-response.cjs, and
 * summarize-app-status.cjs (any consumer that needs to surface user-facing
 * URLs from app_status / deploy_response).
 *
 * The provider's ConnectionDetails schema (manifest-mcp-fred 0.8.0) can
 * carry instance lists in two places, BOTH of which must be walked:
 *   - top-level `connection.instances[]` (single-service / legacy
 *     non-services-map shape)
 *   - per-service `connection.services.<name>.instances[]` (stack /
 *     services-map shape — emitted whenever the spec uses the services-map
 *     form, which author-manifest now always does even for single-service
 *     deploys to enable per-port `ingress: bool`)
 *
 * Returns a deduped list of running instances. Each instance has at least
 * `fqdn`. The legacy fallback (top-level `connection.host` + `connection.ports`
 * when no instances are found) returns `{host, port}` entries instead of
 * fqdn — callers must check the shape before formatting URLs.
 *
 * Subdomain-based routing on the provider means port is NOT part of the URL
 * for the modern instances form: one user-facing URL per FQDN regardless of
 * how many container ports it exposes. The legacy host:port shape predates
 * subdomain routing.
 */

function extractRunningEndpoints(connection) {
  if (!connection || typeof connection !== 'object') return [];
  const seen = new Set();
  const endpoints = [];

  function pushFromInstances(instances) {
    if (!Array.isArray(instances)) return;
    for (const inst of instances) {
      if (!inst || inst.status !== 'running' || !inst.fqdn) continue;
      if (seen.has(inst.fqdn)) continue;
      seen.add(inst.fqdn);
      endpoints.push({ fqdn: inst.fqdn });
    }
  }
  pushFromInstances(connection.instances);
  if (connection.services && typeof connection.services === 'object') {
    for (const svc of Object.values(connection.services)) {
      if (svc && typeof svc === 'object') pushFromInstances(svc.instances);
    }
  }

  if (endpoints.length === 0 && connection.host && connection.ports) {
    // Legacy: top-level host + ports map. host is typically a raw IP, no
    // subdomain routing — caller still needs the port to construct a URL.
    for (const portKey of Object.keys(connection.ports)) {
      const v = connection.ports[portKey];
      const port = typeof v === 'number' || typeof v === 'string' ? v : (v && v.host_port);
      if (port !== undefined) endpoints.push({ host: connection.host, port });
    }
  }
  return endpoints;
}

// Convenience: render an endpoint as a bare FQDN string (for ingress lists)
// or "host:port" for the legacy shape. Use formatEndpointAsUrl when you
// want a full https:// URL.
function formatEndpointAsIngress(ep) {
  if (ep.fqdn) return ep.fqdn;
  if (ep.host && ep.port !== undefined) return `${ep.host}:${ep.port}`;
  return null;
}

function formatEndpointAsUrl(ep) {
  if (ep.fqdn) return `https://${ep.fqdn}/`;
  if (ep.host && ep.port !== undefined) return `https://${ep.host}:${ep.port}/`;
  return null;
}

module.exports = { extractRunningEndpoints, formatEndpointAsIngress, formatEndpointAsUrl };
