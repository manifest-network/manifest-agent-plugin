#!/usr/bin/env node
'use strict';

/**
 * Warn-only DNS check for an FQDN about to be claimed via
 * `set-item-custom-domain`. Helps the user catch "I forgot to point my
 * CNAME" before broadcasting; never blocks the flow.
 *
 * Issues `resolve4`, `resolve6`, and `resolveCname` CONCURRENTLY via
 * `Promise.allSettled`, each wrapped in `Promise.race` against a hard
 * 5 s timeout. libuv's getaddrinfo otherwise honors `/etc/resolv.conf`
 * `options timeout:N attempts:M` (typically 5 s × 2 attempts × 3 lookups
 * = up to 30 s of hang); the hard cutoff bounds the worst case.
 *
 * Args:
 *   --domain <fqdn>           the FQDN to check
 *   --timeout-ms <int>        (optional) per-lookup timeout, default 5000
 *
 * Output (stdout, JSON one-liner):
 *   { resolved: true,  a: [...], aaaa: [...], cname?: "..." }
 *   { resolved: false, a: [],     aaaa: [],   reason: "..." }
 *
 * Always exits 0. NXDOMAIN, SERVFAIL, network errors, and timeouts are
 * all reported as `resolved: false` with `reason` populated — never as a
 * process error.
 *
 * `resolved: true` means at least one of A, AAAA, or CNAME returned
 * something. The skill prose decides what to do with that — typically
 * surface the result and ask proceed/abort.
 */

const dns = require('node:dns').promises;

function parseArgs(argv) {
  const args = { timeoutMs: 5000 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--domain' && argv[i + 1]) { args.domain = argv[++i]; }
    else if (argv[i] === '--timeout-ms' && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) args.timeoutMs = n;
    }
  }
  return args;
}

function withTimeout(promise, ms, label) {
  // Returns a promise that resolves to the original value, or rejects with
  // an Error tagged `code: 'PRECHECK_TIMEOUT'` after `ms` milliseconds.
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms} ms`);
      err.code = 'PRECHECK_TIMEOUT';
      reject(err);
    }, ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

(async () => {
  const args = parseArgs(process.argv);
  if (!args.domain) {
    console.error('Missing required flag: --domain');
    process.exit(1);
  }

  const tasks = [
    withTimeout(dns.resolve4(args.domain), args.timeoutMs, 'resolve4').catch((err) => ({ __err: err })),
    withTimeout(dns.resolve6(args.domain), args.timeoutMs, 'resolve6').catch((err) => ({ __err: err })),
    withTimeout(dns.resolveCname(args.domain), args.timeoutMs, 'resolveCname').catch((err) => ({ __err: err })),
  ];

  const [a, aaaa, cname] = await Promise.all(tasks);

  // Each lookup either returned an array or our wrapped __err object.
  const aArr = Array.isArray(a) ? a : [];
  const aaaaArr = Array.isArray(aaaa) ? aaaa : [];
  const cnameStr = Array.isArray(cname) && cname.length > 0 ? cname[0] : null;

  const resolved = aArr.length > 0 || aaaaArr.length > 0 || cnameStr !== null;

  const out = { resolved, a: aArr, aaaa: aaaaArr };
  if (cnameStr) out.cname = cnameStr;

  if (!resolved) {
    // Pick the most informative error reason. Timeouts trump NXDOMAIN
    // (timeout is a network/resolver problem; NXDOMAIN is "domain genuinely
    // doesn't exist" and is what most tests will see).
    const errs = [a, aaaa, cname].filter((v) => v && v.__err).map((v) => v.__err);
    const timeout = errs.find((e) => e && e.code === 'PRECHECK_TIMEOUT');
    if (timeout) {
      out.reason = `timeout (>${args.timeoutMs} ms) — DNS resolver may be misconfigured or unreachable`;
    } else if (errs.length > 0) {
      const e = errs[0];
      const code = e.code || 'UNKNOWN';
      out.reason = `${code}: ${e.syscall || 'lookup'} ${args.domain} returned no records`;
    } else {
      out.reason = 'no A, AAAA, or CNAME records found';
    }
  }

  console.log(JSON.stringify(out));
})().catch((err) => {
  // Per CLAUDE.md ("All scripts use CJS — async IIFE with
  // .catch(() => process.exit(1))"), an unexpected throw is a process
  // error, not a data result. The lookup-failure paths inside the IIFE
  // already emit structured `resolved: false` JSON; reaching here means
  // an actual implementation bug.
  console.error(`unexpected dns-precheck error: ${err.message || String(err)}`);
  process.exit(1);
});
