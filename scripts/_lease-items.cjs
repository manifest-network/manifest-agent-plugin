'use strict';

/**
 * Shared decoding for `leases_by_tenant` responses.
 *
 * Both `extract-lease-items.cjs` (CLI entry point used by skills) and
 * `verify-domain-state.cjs` (post-broadcast equality check) decode the same
 * lease shape: walk leases[], match by UUID, normalize each item's
 * serviceName/customDomain across snake_case/camelCase variants. Centralizing
 * the decode here means the chain shape is parsed once.
 *
 * Underscore prefix marks this as a sibling-only helper — skills MUST NOT
 * shell out to it.
 *
 * Exports:
 *   pickLeasesArray(payload) — Tolerates `{leases: [...]}` (current shape)
 *     and a bare array. Throws on anything else.
 *
 *   normalizeItem(rawItem) — Returns `{serviceName, customDomain}` with
 *     empty-string defaults on missing fields. Accepts both camelCase
 *     (chain post-snake-to-camel) and snake_case keys.
 *
 *   findLease(payload, leaseUuid) — Convenience: pickLeasesArray + UUID
 *     lookup (case-insensitive, tolerates `uuid`, `lease_uuid`, `leaseUuid`
 *     keys). Returns the matched lease object or `null`.
 */

function pickLeasesArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object' && Array.isArray(payload.leases)) return payload.leases;
  throw new Error('leases_by_tenant response: expected `leases[]` array or bare array');
}

function normalizeItem(raw) {
  const serviceName = (raw && (raw.serviceName ?? raw.service_name)) || '';
  const customDomain = (raw && (raw.customDomain ?? raw.custom_domain)) || '';
  return { serviceName, customDomain };
}

function findLease(payload, leaseUuid) {
  const leases = pickLeasesArray(payload);
  const target = leaseUuid.toLowerCase();
  return leases.find((l) => {
    if (!l || typeof l !== 'object') return false;
    const u = (l.uuid ?? l.lease_uuid ?? l.leaseUuid);
    return typeof u === 'string' && u.toLowerCase() === target;
  }) || null;
}

module.exports = { pickLeasesArray, normalizeItem, findLease };
