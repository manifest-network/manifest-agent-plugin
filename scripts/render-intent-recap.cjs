#!/usr/bin/env node
'use strict';

/**
 * Render the structural portion of the intent-recap block shown to the user
 * before any chain round-trips in the deploy-app orchestrator.
 *
 * The recap has 6 conceptual items; this script handles the 4 deterministic
 * ones (deployment surface / connectivity / redacted sensitive-key inventory /
 * custom-domain + dual-tx + mainnet warning). The 2 LLM-judgment items
 * ("what you provided vs auto-detected", "heads-up: obvious gaps") stay in
 * prose — the orchestrator appends them between the script's stdout and the
 * AskUserQuestion prompt.
 *
 * Pinning the structural rendering kills paraphrase drift across runs:
 * without this, the LLM rewrites the connectivity wording, mainnet warning,
 * and dual-tx clarification on every invocation.
 *
 * Stdin (JSON object): the full structured SPEC (same shape build_manifest_preview
 *                      and deploy_app accept).
 *
 * Args:
 *   --active-chain <testnet|mainnet>   required (drives mainnet warning)
 *
 * Output (stdout): multi-paragraph text block, ready to print verbatim.
 *
 * Sensitive-value posture: env values and label values are NEVER printed;
 * only their keys appear. Mirrors manifest-summary.cjs's contract. FQDNs
 * are not secrets so customDomain is surfaced.
 */

const { readFileSync } = require('node:fs');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--active-chain' && argv[i + 1]) { args.activeChain = argv[++i]; }
  }
  return args;
}

function normalizeServices(spec) {
  // Two spec shapes — produce a uniform `[{name, image, ports[], envKeys[], labelKeys[]}]`.
  // For single-service the name is null (the only service is implicit; the recap
  // omits per-service prefixes when name is null).
  const isStack = spec.services && typeof spec.services === 'object' && !Array.isArray(spec.services);
  if (isStack) {
    return Object.entries(spec.services).map(([name, svc]) => ({
      name,
      image: svc.image || '(unknown image)',
      ports: extractPorts(svc.ports),
      envKeys: extractKeys(svc.env),
      labelKeys: extractKeys(svc.labels),
    }));
  }
  return [{
    name: null,
    image: spec.image || '(unknown image)',
    ports: extractPortsLegacy(spec.port),
    envKeys: extractKeys(spec.env),
    labelKeys: extractKeys(spec.labels),
  }];
}

function extractPorts(portsObj) {
  // services-map shape: { "80": { ingress: true }, "9090": { ingress: false } }
  // ingress flag may be missing — default to false (cluster-private), matching
  // Fred's default.
  if (!portsObj || typeof portsObj !== 'object') return [];
  return Object.entries(portsObj).map(([port, cfg]) => ({
    port,
    ingress: !!(cfg && typeof cfg === 'object' && cfg.ingress),
  }));
}

function extractPortsLegacy(port) {
  // Legacy single-service shape: bare `port: <number>`. Fred treats this as
  // ingress=true by default — that's the whole point of the simplified shape.
  if (typeof port !== 'number') return [];
  return [{ port: String(port), ingress: true }];
}

function extractKeys(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  return Object.keys(obj).sort();
}

function renderServiceList(services, activeChain) {
  const count = services.length;
  const noun = count === 1 ? 'service' : 'services';
  const lines = [`Deploying ${count} ${noun} on ${activeChain}:`];
  for (const svc of services) {
    const prefix = svc.name === null ? '' : `${svc.name} — `;
    lines.push(`  - ${prefix}${svc.image}`);
  }
  return lines.join('\n');
}

function renderConnectivity(services) {
  const lines = ['Connectivity:'];
  let total = 0;
  for (const svc of services) {
    if (svc.ports.length === 0) continue;
    for (const p of svc.ports) {
      total += 1;
      const prefix = svc.name === null ? `port ${p.port}` : `${svc.name} port ${p.port}`;
      const reach = p.ingress
        ? 'publicly reachable via the provider\'s HTTPS subdomain'
        : 'internal only (cluster-private)';
      lines.push(`  - ${prefix}: ${reach}`);
    }
  }
  if (total === 0) {
    lines.push('  (no ports declared — the deployment will not expose any network surface)');
  }
  return lines.join('\n');
}

function renderRedactedInventory(services) {
  // Always render the section header even if everything is empty — the
  // user should know we'd have shown values if there were any. This is
  // also documentation of the redaction discipline.
  const lines = ['Sensitive values are redacted in this recap (keys only, never values):'];
  let anything = false;
  for (const svc of services) {
    const prefix = svc.name === null ? 'this service' : svc.name;
    const parts = [];
    if (svc.envKeys.length > 0) {
      anything = true;
      parts.push(`env keys [${svc.envKeys.join(', ')}]`);
    }
    if (svc.labelKeys.length > 0) {
      anything = true;
      parts.push(`label keys [${svc.labelKeys.join(', ')}]`);
    }
    if (parts.length === 0) {
      lines.push(`  - ${prefix}: no env or labels supplied`);
    } else {
      lines.push(`  - ${prefix}: ${parts.join('; ')}`);
    }
  }
  if (!anything) {
    // Single-line variant when nothing is set across any service.
    return 'No env values or labels supplied (no redaction needed).';
  }
  return lines.join('\n');
}

function renderCustomDomain(spec, activeChain) {
  if (typeof spec.customDomain !== 'string' || spec.customDomain.length === 0) {
    return null;
  }
  const target = typeof spec.serviceName === 'string' && spec.serviceName.length > 0
    ? `service ${spec.serviceName}`
    : 'single-service lease';
  const lines = [`Custom domain: ${spec.customDomain} → ${target}`];
  lines.push('');
  lines.push(
    'Note: when a custom domain is set, deploy_app broadcasts TWO billing\n' +
    'transactions atomically: create-lease AND set-item-custom-domain. The\n' +
    'single permission prompt that fires later covers BOTH; this textual\n' +
    'recap is your per-tx review.'
  );
  if (activeChain === 'mainnet') {
    lines.push('');
    lines.push(
      `Mainnet warning: this transaction permanently associates ${spec.customDomain}\n` +
      'with this lease on-chain until you --clear it via\n' +
      '/manifest-agent:manage-domain or close the lease. FQDN squatting is\n' +
      'irreversible.'
    );
  }
  return lines.join('\n');
}

(async () => {
  const args = parseArgs(process.argv);
  if (!args.activeChain) {
    console.error('Missing required flag: --active-chain');
    process.exit(1);
  }
  if (args.activeChain !== 'testnet' && args.activeChain !== 'mainnet') {
    console.error(`--active-chain must be "testnet" or "mainnet"; got "${args.activeChain}"`);
    process.exit(1);
  }

  const raw = readFileSync(0, 'utf8');
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

  const services = normalizeServices(spec);

  const blocks = [
    renderServiceList(services, args.activeChain),
    renderConnectivity(services),
    renderRedactedInventory(services),
  ];
  const domainBlock = renderCustomDomain(spec, args.activeChain);
  if (domainBlock) blocks.push(domainBlock);

  console.log(blocks.join('\n\n'));
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
