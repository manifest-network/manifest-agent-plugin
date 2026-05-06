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
 *   - render-intent-recap.cjs (normalizeServices)
 *   - summarize-spec.cjs (isStack, normalizeServices)
 *   - extract-primary-image.cjs (firstImage) — used by deploy-app orchestrator
 *   - save-manifest-draft.cjs (firstImage)
 *   - merge-env.cjs (isStack)
 * Without this module the isStack check was inlined 5 places.
 *
 * Underscore prefix marks this as a sibling-only helper. Skills MUST NOT
 * shell out to it; consume `extract-primary-image.cjs` instead.
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

module.exports = { isStack, firstImage, normalizeServices };
