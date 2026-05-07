'use strict';

/**
 * Shared HTTPS GET helper with SSRF guard, request timeout, and a
 * response-body byte cap.
 *
 * Pre-extraction history: `inspect-image.cjs` had `httpsJson(host, path,
 * headers)` and `fetch-chain-registry.cjs` had `fetchJson(url)`, both
 * implementing the same settled-once-promise + timeout + body-cap pattern
 * with a `RequestFilteringHttpsAgent`. The two implementations had drifted
 * slightly already (different caps, timeouts, User-Agents) and would have
 * drifted further. Centralizing here means SSRF policy and resource
 * limits stay aligned across every outbound HTTPS the plugin makes.
 *
 * Returns `{ status, headers, body }` with `body` as a UTF-8 string. The
 * caller is responsible for status checks and JSON parsing — the helper
 * is intentionally HTTP-shaped (not JSON-shaped) so consumers that need
 * to inspect 30x/40x responses (registry redirects, auth challenges) can.
 *
 * Underscore prefix marks this as a sibling-only helper. Skills MUST NOT
 * shell out to it.
 *
 * Defaults:
 *   timeout       = 15_000 ms
 *   maxBodyBytes  = 5 MiB
 *   userAgent     = "manifest-agent-plugin"
 *   headers       = { Accept: "application/json" } merged with caller's
 *
 * The SSRF agent is a module-level singleton — the dep's
 * `RequestFilteringHttpsAgent` blocks RFC 1918 / loopback / link-local
 * at connect time, with no configuration knobs the callers need today.
 * Promoting it from per-caller singleton to shared singleton means
 * SSRF policy lives in one place if it ever needs to change.
 */

const { request } = require('node:https');
const { RequestFilteringHttpsAgent } = require('request-filtering-agent');

const SSRF_AGENT = new RequestFilteringHttpsAgent();

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;

function httpsGet({ host, path, headers = {}, timeout = DEFAULT_TIMEOUT_MS, maxBodyBytes = DEFAULT_MAX_BODY_BYTES, userAgent = 'manifest-agent-plugin', label }) {
  // `label` is what we put in error messages — fetch-chain-registry uses
  // the full URL string, inspect-image uses host+path. Default falls back
  // to host+path so the caller can omit it for the common case.
  const errLabel = label || `${host}${path}`;
  return new Promise((resolveOuter, rejectOuter) => {
    // Settle-once guard. Body-cap rejection happens from inside the data
    // handler (rather than relying on req.destroy(err) → 'error' event,
    // which races with res.on('end')); that path can produce multiple
    // rejection attempts (cap reject, then 'error' from the destroy,
    // then a later 'timeout'). Coalesce them.
    let settled = false;
    const resolve = (v) => { if (!settled) { settled = true; resolveOuter(v); } };
    const reject = (e) => { if (!settled) { settled = true; rejectOuter(e); } };

    const req = request({
      host,
      path,
      method: 'GET',
      headers: { 'User-Agent': userAgent, ...headers },
      timeout,
      agent: SSRF_AGENT,
    }, (res) => {
      const chunks = [];
      let received = 0;
      let aborted = false;
      res.on('data', (c) => {
        if (aborted) return;
        received += c.length;
        if (received > maxBodyBytes) {
          aborted = true;
          req.destroy();
          reject(new Error(`response body exceeded ${maxBodyBytes} bytes (cap) on ${errLabel}`));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        if (aborted) return;
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error(`request timeout on ${errLabel}`)); });
    req.end();
  });
}

module.exports = { httpsGet };
