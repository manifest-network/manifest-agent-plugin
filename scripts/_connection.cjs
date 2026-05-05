'use strict';

/**
 * Extract running-instance ingress data from the provider's `connection`
 * payload. Shared by format-success.cjs, classify-deploy-response.cjs, and
 * summarize-app-status.cjs (any consumer that needs to surface user-facing
 * URLs from app_status / deploy_response).
 *
 * The provider's ConnectionDetails schema (manifest-mcp-fred 0.8.0) carries
 * instance lists in one or both of:
 *   - top-level `connection.instances[]` (single-service / non-services-map
 *     shape)
 *   - per-service `connection.services.<name>.instances[]` (stack /
 *     services-map shape — emitted whenever the spec uses the services-map
 *     form, which author-manifest now always does even for single-service
 *     deploys to enable per-port `ingress: bool`)
 *
 * Returns a deduped list of running instances; each entry has `fqdn`.
 * Subdomain-based routing on the provider means the port is NOT part of
 * the URL: one user-facing URL per FQDN regardless of how many container
 * ports the instance exposes.
 *
 * Unrecognized shape: if `connection` is non-null but has neither
 * `instances` nor `services` keys, the helper returns `[]` AND emits a
 * stderr warning so a future provider-shape divergence is loud rather
 * than silent. (Older shapes with top-level `connection.host` +
 * `connection.ports` were supported historically; they have not been
 * observed in any manifest-mcp-fred 0.8.0+ response and are no longer
 * handled. If a caller needs them again, restore as a documented branch.)
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

  // Diagnose unrecognized shapes loudly. The empty-but-present case
  // (instances/services keys exist but no instance is `status: "running"`)
  // legitimately returns [] — the lease is pending, wait_for_app_ready
  // hasn't returned, etc. — so we only warn when neither key is present.
  const hasModernShape =
    Object.prototype.hasOwnProperty.call(connection, 'instances') ||
    Object.prototype.hasOwnProperty.call(connection, 'services');
  if (!hasModernShape) {
    const keys = Object.keys(connection).slice(0, 8).join(', ') || '(empty)';
    process.stderr.write(
      `_connection: unrecognized connection shape (no \`instances\` or \`services\` key found; keys present: ${keys}). ` +
      `Returning empty endpoints — the orchestrator will report no ingresses for this lease. ` +
      `Provider may have shipped a new shape; check manifest-mcp-fred ConnectionDetails.\n`
    );
  }

  return endpoints;
}

// Render an endpoint as a bare FQDN string (for ingress lists). Returns
// null if the endpoint shape is unsupported.
function formatEndpointAsIngress(ep) {
  if (ep && ep.fqdn) return ep.fqdn;
  return null;
}

// Render an endpoint as a full https:// URL.
function formatEndpointAsUrl(ep) {
  if (ep && ep.fqdn) return `https://${ep.fqdn}/`;
  return null;
}

module.exports = { extractRunningEndpoints, formatEndpointAsIngress, formatEndpointAsUrl };
