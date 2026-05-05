#!/usr/bin/env node
'use strict';

/**
 * Loose client-side FQDN sanity check before broadcasting a
 * `set-item-custom-domain` tx. Catches obvious typos so the user doesn't
 * waste a broadcast on something the chain will reject.
 *
 * The chain's `MsgSetItemCustomDomain` validator is the source of truth
 * (lowercase, reserved-suffix rules, length cap). This script enforces
 * only the well-known surface most likely to bite at the keyboard.
 *
 * Args:
 *   --domain <fqdn>   the FQDN to validate
 *
 * Output (stdout, JSON object):
 *   { valid: true,  reasons: [] }
 *   { valid: false, reasons: ["<line>", ...] }
 *
 * Always exits 0 — invalid is a data result, not a process error.
 */

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--domain' && argv[i + 1]) { args.domain = argv[++i]; }
  }
  return args;
}

function validate(domain) {
  const reasons = [];
  if (typeof domain !== 'string' || domain.length === 0) {
    reasons.push('domain is empty');
    return reasons;
  }
  if (domain.length > 253) {
    reasons.push(`domain exceeds 253 characters (got ${domain.length})`);
  }
  if (domain !== domain.toLowerCase()) {
    reasons.push('domain must be lowercase (RFC 1035; chain rejects mixed case)');
  }
  if (domain.startsWith('.') || domain.endsWith('.')) {
    reasons.push('domain must not start or end with a dot');
  }
  if (domain.startsWith('-') || domain.endsWith('-')) {
    reasons.push('domain must not start or end with a hyphen');
  }
  if (!domain.includes('.')) {
    reasons.push('domain must contain at least one dot (e.g. "app.example.com")');
  }
  if (/\s/.test(domain)) {
    reasons.push('domain must not contain whitespace');
  }
  if (/[^a-z0-9.\-]/.test(domain)) {
    reasons.push('domain must contain only lowercase letters, digits, dots, and hyphens');
  }
  // Per-label checks: each dot-separated label must be 1–63 chars and not
  // begin or end with a hyphen.
  if (domain.includes('.')) {
    const labels = domain.split('.');
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      if (label.length === 0) {
        reasons.push(`label ${i + 1} is empty (consecutive dots?)`);
        continue;
      }
      if (label.length > 63) {
        reasons.push(`label ${i + 1} ("${label}") exceeds 63 characters`);
      }
      if (label.startsWith('-') || label.endsWith('-')) {
        reasons.push(`label ${i + 1} ("${label}") must not start or end with a hyphen`);
      }
    }
    // Top-level label (the last one) must not be entirely numeric — that's
    // not a real TLD and the chain rejects it.
    const tld = labels[labels.length - 1];
    if (tld && /^[0-9]+$/.test(tld)) {
      reasons.push(`top-level label "${tld}" must not be entirely numeric`);
    }
  }
  return reasons;
}

(async () => {
  const args = parseArgs(process.argv);
  if (args.domain === undefined) {
    console.error('Missing required flag: --domain');
    process.exit(1);
  }
  const reasons = validate(args.domain);
  console.log(JSON.stringify({ valid: reasons.length === 0, reasons }));
})().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
