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
 *     env_keys:      string[],   // keys ONLY — never values
 *     images:        string[]    // one entry per service
 *   }
 *
 * Used by render-deployment-plan.cjs to populate the `Manifest:` summary line
 * without forcing the agent to count fields itself.
 */

const { readFileSync } = require('node:fs');

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

  const isStack = spec.services && typeof spec.services === 'object' && !Array.isArray(spec.services);
  let format, services;
  if (isStack) {
    format = 'stack';
    services = Object.entries(spec.services).map(([name, svc]) => ({ name, ...svc }));
  } else {
    format = 'single';
    services = [{ name: null, image: spec.image, port: spec.port, env: spec.env, labels: spec.labels }];
  }

  let port_count = 0;
  let env_keys = new Set();
  const images = [];

  for (const svc of services) {
    if (svc.image) images.push(svc.image);
    // Single-service uses `port` (number); multi-service uses `ports` (map).
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
