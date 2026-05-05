#!/usr/bin/env node
'use strict';

/**
 * Render the canonical `DeploymentPlan` block for /deploy-app's confirmation
 * step. This script is the single source of truth for the format — the
 * SessionStart-injected runtime policy text references this script rather
 * than embedding the template, so there's no drift risk.
 *
 * Args:
 *   --meta-hash <hex>             from build_manifest_preview.meta_hash_hex
 *   --image <ref>                 primary image reference (first service's image for stacks)
 *   --size <sku>                  SKU tier name
 *   --tx-gas <int>                (optional) gasEstimate from cosmos_estimate_fee for create-lease
 *   --tx-fee <amount>             (optional) human-readable fee for create-lease (e.g. "0.0023 MFX")
 *   --custom-domain <fqdn>        (optional) when set, render a `Custom domain:` line and
 *                                 expect a second tx fee for set-item-custom-domain
 *   --custom-domain-service <name>(optional) for stacks, the service the domain attaches to
 *   --set-domain-tx-gas <int>     (optional) gasEstimate for the set-item-custom-domain tx
 *   --set-domain-tx-fee <amount>  (optional) human-readable fee for the set-item-custom-domain
 *                                 tx. Special value "skipped" renders a "(not estimated — no
 *                                 representative lease)" line per approach-3 fallback. The
 *                                 script owns the "Tx fee (set-domain):" label — no
 *                                 caller-supplied label flag.
 *
 * When `--tx-fee` is omitted, the fee line shows "(not estimated)" so the
 * runtime-policy violation is visible. When `--set-domain-tx-fee` is set
 * alongside `--tx-fee`, two labeled fee lines are emitted plus a `Total fee:`
 * line summing the human-readable amounts (same-denom: numeric sum;
 * different-denom: `<a> + <b>`).
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
 *     Image:                     docker.io/library/nginx:1.27
 *     Size:                      docker-micro
 *     Manifest:                  single, services=1, ports=1, env=2
 *     meta_hash:                 <hex>
 *     Custom domain:             wp-test.testnet.manifest.app -> service wordpress
 *     SKU price:                 37 upwr / hour
 *     Tx fee (create-lease):     0.0023 MFX (gas 142000)
 *     Tx fee (set-domain):       0.0011 MFX (gas 60000)
 *     Total fee:                 0.0034 MFX
 *     Wallet:                    1000000 umfx, 5000000 upwr
 *     Credits:                   250000 upwr (~24.0h remaining)
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
    else if (flag === '--tx-gas' && next) { args.txGas = next; i++; }
    else if (flag === '--tx-fee' && next) { args.txFee = next; i++; }
    else if (flag === '--custom-domain' && next) { args.customDomain = next; i++; }
    else if (flag === '--custom-domain-service' && next) { args.customDomainService = next; i++; }
    else if (flag === '--set-domain-tx-gas' && next) { args.setDomainTxGas = next; i++; }
    else if (flag === '--set-domain-tx-fee' && next) { args.setDomainTxFee = next; i++; }
  }
  return args;
}

// Parse a "<amount> <denom>" human-readable fee string into [number, denom].
// Returns null if the format isn't recognized — caller falls back to
// concatenated rendering with a "+" between amounts.
function parseHumanFee(s) {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s+(\S+)$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return [n, m[2]];
}

function decimalDigits(amountStr) {
  // Count decimals in the amount portion only (strip the unit suffix).
  const m = amountStr.trim().match(/^[0-9]+(?:\.([0-9]+))?/);
  return m && m[1] ? m[1].length : 0;
}

function sumHumanFees(a, b) {
  // Same-denom: numeric sum, formatted with the max input precision so we
  // don't gain or lose decimals. Different denom: "<a> + <b>".
  const pa = parseHumanFee(a);
  const pb = parseHumanFee(b);
  if (pa && pb && pa[1] === pb[1]) {
    const maxDec = Math.max(decimalDigits(a), decimalDigits(b));
    return `${(pa[0] + pb[0]).toFixed(maxDec)} ${pa[1]}`;
  }
  return `${a} + ${b}`;
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

  // Whether the user is also setting a custom domain (and therefore
  // broadcasting a second billing tx). Affects fee-line labeling.
  const hasDomain = typeof args.customDomain === 'string' && args.customDomain.length > 0;

  function fmtFeeLine(fee, gas) {
    // Explicit "(not estimated)" when the caller omitted both flags so the
    // runtime-policy violation is visible. Special "skipped" value renders
    // the approach-3 fallback message (no representative lease available
    // for set-domain pre-broadcast estimate).
    if (fee === 'skipped') {
      return '(not estimated — no representative lease available for pre-broadcast simulation)';
    }
    if (fee && gas) return `${fee} (gas ${gas})`;
    if (fee) return fee;
    return '(not estimated — agent skipped cosmos_estimate_fee, policy violation)';
  }

  const createFeeLine = fmtFeeLine(args.txFee, args.txGas);

  const lines = [
    'DeploymentPlan',
    `  Image:                     ${args.image}`,
    `  Size:                      ${args.size}`,
    `  Manifest:                  ${manifestLine}`,
    `  meta_hash:                 ${args.metaHash}`,
  ];
  if (hasDomain) {
    const target = args.customDomainService
      ? `-> service ${args.customDomainService}`
      : '-> single-service lease';
    lines.push(`  Custom domain:             ${args.customDomain} ${target}`);
  }
  lines.push(`  SKU price:                 ${fmtCost(readiness)}`);

  if (hasDomain) {
    // Two-tx layout: labeled lines + Total fee.
    // When the caller omits --set-domain-tx-fee entirely (rather than
    // passing the explicit "skipped" sentinel), treat it as the
    // approach-3 fallback — for the set-domain tx, "no representative
    // lease available" is a legitimate skip path. Reserve the
    // "policy violation" wording for the create-lease line, which is
    // never optional under the runtime policy.
    const effectiveSetDomainFee = args.setDomainTxFee || 'skipped';
    const setDomainFeeLine = fmtFeeLine(effectiveSetDomainFee, args.setDomainTxGas);
    lines.push(`  Tx fee (create-lease):     ${createFeeLine}`);
    lines.push(`  Tx fee (set-domain):       ${setDomainFeeLine}`);
    // Total only when both fees are real numbers (not "skipped" / "not
    // estimated"). Otherwise show a placeholder so the user sees the
    // missing-component honestly.
    const bothNumeric =
      args.txFee && args.txFee !== 'skipped' &&
      args.setDomainTxFee && args.setDomainTxFee !== 'skipped';
    const totalLine = bothNumeric
      ? sumHumanFees(args.txFee, args.setDomainTxFee)
      : '(partial — see fee lines above)';
    lines.push(`  Total fee:                 ${totalLine}`);
  } else {
    lines.push(`  Tx fee:                    ${createFeeLine}`);
  }

  lines.push(`  Wallet:                    ${fmtBalances(readiness.wallet_balances)}`);
  lines.push(`  Credits:                   ${fmtCredits(readiness)}`);
  console.log(lines.join('\n'));
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
