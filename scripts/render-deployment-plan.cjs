#!/usr/bin/env node
'use strict';

/**
 * Render the canonical `DeploymentPlan` block for /deploy-app's confirmation
 * step. This script is the single source of truth for the format — the
 * SessionStart-injected runtime policy text references this script rather
 * than embedding the template, so there's no drift risk.
 *
 * Args:
 *   --meta-hash <hex>   from build_manifest_preview.meta_hash_hex
 *   --image     <ref>   primary image reference (first service's image for stacks)
 *   --size      <sku>   SKU tier name
 *
 * Stdin (JSON object):
 *   {
 *     summary: { format, service_count, port_count, env_count },  // from manifest-summary.cjs
 *     readiness: <check_deployment_readiness response>            // for sku.price + balances
 *   }
 *
 * Stdout: plain text — the canonical block, e.g.:
 *
 *   DeploymentPlan
 *     Image:      docker.io/library/nginx:1.27
 *     Size:       docker-micro
 *     Manifest:   single, services=1, ports=1, env=2
 *     meta_hash:  <hex>
 *     Est. cost:  37 upwr / hour
 *     Wallet:     1000000 umfx, 5000000 upwr
 *     Credits:    250000 upwr (~24.0h remaining)
 *
 * Provider field is intentionally absent (chain selects internally; printed
 * post-deploy by format-success.cjs).
 */

const { readFileSync } = require('node:fs');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--meta-hash' && next) { args.metaHash = next; i++; }
    else if (flag === '--image' && next) { args.image = next; i++; }
    else if (flag === '--size' && next) { args.size = next; i++; }
  }
  return args;
}

function fmtBalances(balances) {
  if (!Array.isArray(balances) || balances.length === 0) return '(empty)';
  return balances.map((b) => `${b.amount || '0'} ${b.denom || '?'}`).join(', ');
}

function fmtCredits(readiness) {
  const c = readiness && readiness.credits;
  if (!c) return 'none';
  const balances = readiness.current_balance;
  let head;
  if (Array.isArray(balances) && balances.length > 0) {
    head = balances.map((b) => `${b.amount || '0'} ${b.denom || '?'}`).join(', ');
  } else {
    head = '(unknown balance)';
  }
  if (readiness.hours_remaining !== undefined) {
    const hrs = Number(readiness.hours_remaining);
    if (Number.isFinite(hrs)) head += ` (~${hrs.toFixed(1)}h remaining)`;
  }
  return head;
}

function fmtCost(readiness) {
  const sku = readiness && readiness.sku;
  if (!sku || !sku.price) return '(unknown — SKU has no listed price)';
  const a = sku.price.amount || '0';
  const d = sku.price.denom || '?';
  return `${a} ${d} / hour`;
}

(async () => {
  const args = parseArgs(process.argv);
  const missing = ['metaHash', 'image', 'size'].filter((k) => !args[k]);
  if (missing.length > 0) {
    console.error(`Missing required flag(s): ${missing.map((k) => '--' + k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())).join(', ')}`);
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
  const summary = payload && payload.summary;
  const readiness = payload && payload.readiness;
  if (!summary || typeof summary !== 'object') {
    console.error('stdin.summary is required (from manifest-summary.cjs)');
    process.exit(1);
  }
  if (!readiness || typeof readiness !== 'object') {
    console.error('stdin.readiness is required (from check_deployment_readiness)');
    process.exit(1);
  }

  const manifestLine = `${summary.format || 'single'}, services=${summary.service_count ?? '?'}, ports=${summary.port_count ?? '?'}, env=${summary.env_count ?? '?'}`;

  const lines = [
    'DeploymentPlan',
    `  Image:      ${args.image}`,
    `  Size:       ${args.size}`,
    `  Manifest:   ${manifestLine}`,
    `  meta_hash:  ${args.metaHash}`,
    `  Est. cost:  ${fmtCost(readiness)}`,
    `  Wallet:     ${fmtBalances(readiness.wallet_balances)}`,
    `  Credits:    ${fmtCredits(readiness)}`,
  ];
  console.log(lines.join('\n'));
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
