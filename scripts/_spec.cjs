'use strict';

/**
 * Shared helpers for inspecting Fred deployment specs.
 *
 * Two spec shapes exist in the wild:
 *   - **services-map** (canonical for v3+):
 *     `{ services: { <name>: { image, ports, env?, ... } }, customDomain?, ... }`
 *   - **legacy single-service** (still accepted by build_manifest_preview):
 *     `{ image, port, env?, ... }`
 *
 * The shape branch lives here so all consumers agree on how to detect
 * and walk the two forms. Current consumers:
 *   - _journal.cjs (isStack, normalizeServices, skuIdentity)
 *   - check-storage-selection.cjs (skuIdentity)
 *   - save-manifest-draft.cjs (firstImage)
 *   - merge-env.cjs (isStack)
 *
 * Underscore prefix marks this as a sibling-only helper. Skills MUST NOT
 * shell out to it; sibling scripts consume it via require('./_spec.cjs').
 *
 * Exports:
 *   isStack(spec) — true when the services-map shape is used.
 *   firstImage(spec) — image string for the canonical service: spec.image
 *     for legacy, the first entry of spec.services for stacks. Returns
 *     null when neither shape carries an image.
 *   normalizeServices(spec) — returns `[{name, raw}]` where `name` is
 *     `null` for legacy single-service and the services-map key
 *     otherwise. `raw` is the per-service object exactly as the spec
 *     stores it (no field projection — leave that to callers).
 *   skuIdentity(spec) — projects optional top-level skuUuid/providerUuid
 *     strings using MCP 0.22.0's selector semantics: snake_case aliases
 *     apply only when camelCase is undefined; selected strings are trimmed
 *     like the upstream SKU resolver. Blank or malformed selected values
 *     are omitted without falling through to an alias. Does not resolve
 *     SKU names or infer deployment identity from per-service fields.
 */

function isStack(spec) {
  return !!(spec && spec.services && typeof spec.services === 'object' && !Array.isArray(spec.services));
}

function firstImage(spec) {
  if (!spec || typeof spec !== 'object') return null;
  if (typeof spec.image === 'string' && spec.image.length > 0) return spec.image;
  if (isStack(spec)) {
    for (const svc of Object.values(spec.services)) {
      if (svc && typeof svc.image === 'string' && svc.image.length > 0) return svc.image;
    }
  }
  return null;
}

function normalizeServices(spec) {
  if (isStack(spec)) {
    return Object.entries(spec.services).map(([name, raw]) => ({ name, raw: raw || {} }));
  }
  return [{ name: null, raw: spec || {} }];
}

function skuIdentity(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return {};
  const out = {};
  for (const [camel, snake] of [['skuUuid', 'sku_uuid'], ['providerUuid', 'provider_uuid']]) {
    const value = spec[camel] === undefined ? spec[snake] : spec[camel];
    if (typeof value === 'string' && value.trim()) out[camel] = value.trim();
  }
  return out;
}

module.exports = { isStack, firstImage, normalizeServices, skuIdentity };
