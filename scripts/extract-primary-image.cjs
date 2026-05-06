#!/usr/bin/env node
'use strict';

/**
 * Extract the canonical "primary" image reference from a deployment spec.
 * Used by the deploy-app orchestrator's Step 5 readiness pre-flight,
 * which expects a single image string regardless of whether the spec is
 * a single-service or a multi-service stack.
 *
 * Without this script the orchestrator was doing
 *   `IMAGE = SPEC.image || Object.values(SPEC.services || {})[0]?.image`
 * inline in skill prose, which (a) duplicates the shape-detection logic
 * already in `_spec.cjs`, and (b) is exactly the kind of compact JS-y
 * fallback that drifts across model versions.
 *
 * For multi-service stacks this picks the first service's image as the
 * representative — the provider validates all of them at deploy time, so
 * the readiness pre-flight on any one is sufficient.
 *
 * Stdin (JSON object): the spec.
 * Output (stdout): the image string, with a trailing newline.
 * Exit 0: image found and printed.
 * Exit 1: spec didn't carry any image (the orchestrator should error out;
 *         build_manifest_preview will reject the spec next anyway).
 */

const { readFileSync } = require('node:fs');
const { firstImage } = require('./_spec.cjs');

(async () => {
  const raw = readFileSync(0, 'utf8');
  let spec;
  try {
    spec = JSON.parse(raw);
  } catch (err) {
    console.error(`stdin is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  const img = firstImage(spec);
  if (!img) {
    console.error('spec carries no image (neither top-level `image` nor `services[*].image` populated)');
    process.exit(1);
  }
  console.log(img);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
