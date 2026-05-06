#!/usr/bin/env node
'use strict';

/**
 * Read a structured manifest spec from stdin and emit a summary on stdout.
 *
 * The structured spec is the same shape `mcp__manifest-fred__deploy_app` and
 * `mcp__manifest-fred__build_manifest_preview` accept:
 *   - Single-service: { image, port, env?, labels?, command?, args?, ... }
 *   - Multi-service:  { services: { <name>: { image, ports, env?, ... } } }
 *
 * Output (JSON, single line):
 *   {
 *     format:        "single" | "stack",
 *     service_count: number,
 *     port_count:    number,
 *     env_count:     number,
 *     env_keys:      string[],     // keys ONLY — never values
 *     images:        string[]      // one entry per service
 *   }
 *
 * Used by render-deployment-plan.cjs to populate the `Manifest:` summary
 * line and to seed the readiness JSON envelope without forcing the agent
 * to count or extract fields itself. The `Custom domain:` line is
 * populated by render-deployment-plan from its own --custom-domain CLI
 * flag (passed by the orchestrator from SPEC.customDomain), not from
 * this summary — keeping the fee-line and domain-line state in one
 * place.
 */

const { readFileSync } = require('node:fs');
const { isStack, normalizeServices } = require('./_spec.cjs');

(async () => {
  const raw = readFileSync(0, 'utf8'); // stdin
  let spec;
  try {
    spec = JSON.parse(raw);
  } catch (err) {
    console.error(`stdin is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    console.error('stdin must be a JSON object');
    process.exit(1);
  }

  const format = isStack(spec) ? 'stack' : 'single';
  const services = normalizeServices(spec);

  let port_count = 0;
  let env_keys = new Set();
  const images = [];

  for (const { raw: svc } of services) {
    if (svc.image) images.push(svc.image);
    // Legacy single-service uses `port` (number); services-map uses `ports` (object).
    if (typeof svc.port === 'number') port_count += 1;
    if (svc.ports && typeof svc.ports === 'object') port_count += Object.keys(svc.ports).length;
    if (svc.env && typeof svc.env === 'object') {
      for (const k of Object.keys(svc.env)) env_keys.add(k);
    }
  }

  const out = {
    format,
    service_count: services.length,
    port_count,
    env_count: env_keys.size,
    env_keys: Array.from(env_keys).sort(),
    images,
  };
  console.log(JSON.stringify(out));
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
