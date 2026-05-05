'use strict';

/**
 * Convert chain-side coin amounts (always in the smallest unit) into the
 * human-readable display the user actually wants to see — e.g.
 * `1800000 factory/.../upwr` -> `1.8 PWR`, `0.057738 PWR (gas 104031)`
 * built from `57738 factory/.../upwr`, etc.
 *
 * The denom -> symbol mapping is sourced from the chain registry data in
 * `$MANIFEST_PLUGIN_DATA/chains/<chain>.json` (the `feeTokens[]` array,
 * which carries `{ denom, symbol, ... }` for every token the chain
 * accepts as gas — by convention this list is the canonical denom -> symbol
 * map for the chain). Pass the chain-data file path via `--chain-data-file`
 * to whichever script is rendering balances; the script `require`s this
 * module and forwards the data.
 *
 * Conversion factor: cosmos convention is 6 decimals for `u`-prefixed
 * tokens (umfx, upwr — including factory-wrapped variants). Anything else
 * is rendered untouched (denom kept as-is, amount printed as integer)
 * because we can't safely guess its exponent.
 *
 * Exports:
 *   loadChainDenomMap(chainDataFilePath)
 *     Returns { lookup(denom): { symbol, exponent } | null, raw: <chain JSON> }.
 *     Returns a no-op map (lookup always returns null) when the path is
 *     missing / unreadable — the caller falls back to printing raw
 *     denom + amount.
 *
 *   humanizeCoin(amount, denom, denomMap)
 *     Returns a human-readable "<amount> <symbol>" string. When the
 *     denom isn't in the map and isn't a recognizable u-prefixed
 *     pattern, returns "<amount> <denom>" verbatim.
 *
 *   humanizeBalances(balances, denomMap)
 *     Joins multiple coins with ", ".
 *
 *   denomToSymbol(denom, denomMap)
 *     Returns the friendly symbol ("MFX") for a chain denom ("umfx") via
 *     the same lookup humanizeCoin uses. Falls back to the raw denom on
 *     unknown input. Use when you need ONLY the symbol (e.g. "Wallet has
 *     no MFX balance"); avoids the brittle pattern of formatting "0 MFX"
 *     and string-splitting to recover "MFX".
 */

const { readFileSync } = require('node:fs');

const KNOWN_EXPONENT = 6;

function loadChainDenomMap(chainDataFilePath) {
  const empty = { lookup: () => null, raw: null };
  if (!chainDataFilePath) return empty;
  let raw;
  try {
    raw = JSON.parse(readFileSync(chainDataFilePath, 'utf8'));
  } catch (err) {
    // The path was passed but read/parse failed. Warn loudly: a corrupted
    // chain file silently downgrades all balance/fee rendering to raw
    // chain denoms across the whole plugin, and the user only notices
    // because the DeploymentPlan looks weird ("0.000037 PWR" vs "37 upwr").
    process.stderr.write(
      `humanize-denom: failed to load ${chainDataFilePath}: ${err.message}; ` +
      `balances and fees will render with raw on-chain denoms. ` +
      `Run /manifest-agent:refresh-registry to re-fetch chain data.\n`
    );
    return empty;
  }
  // Normalize the feeTokens list into a denom -> { symbol, exponent } map.
  // Every Manifest fee token uses 6 decimals (the leading `u` is the
  // micro prefix). Tokens not in feeTokens are unknown to us; the
  // fallback branch in humanizeCoin handles them.
  const map = new Map();
  if (Array.isArray(raw.feeTokens)) {
    for (const t of raw.feeTokens) {
      if (t && typeof t.denom === 'string' && typeof t.symbol === 'string') {
        map.set(t.denom, { symbol: t.symbol, exponent: KNOWN_EXPONENT });
      }
    }
  }
  return {
    lookup: (denom) => (typeof denom === 'string' ? map.get(denom) || null : null),
    raw,
  };
}

function fmtScaledAmount(amount, exponent) {
  // Convert smallest-unit string -> human decimal string with up to
  // `exponent` decimals, trimming trailing zeros for readability.
  // Uses BigInt for the integer part so we don't lose precision on
  // large balances; only the fractional remainder is divided.
  let digits;
  try {
    digits = BigInt(amount);
  } catch {
    return String(amount);
  }
  const negative = digits < 0n;
  if (negative) digits = -digits;
  const divisor = 10n ** BigInt(exponent);
  const whole = digits / divisor;
  const frac = digits % divisor;
  let fracStr = frac.toString().padStart(exponent, '0').replace(/0+$/, '');
  let out = fracStr.length > 0 ? `${whole}.${fracStr}` : `${whole}`;
  if (negative) out = `-${out}`;
  return out;
}

function humanizeCoin(amount, denom, denomMap) {
  if (denom === undefined || denom === null) return `${amount}`;
  const lookup = denomMap && typeof denomMap.lookup === 'function' ? denomMap.lookup(denom) : null;
  if (lookup) {
    return `${fmtScaledAmount(amount, lookup.exponent)} ${lookup.symbol}`;
  }
  // Best-effort unknown-denom rendering — keep the raw denom so the
  // user can still identify it, and don't guess at scaling.
  return `${amount} ${denom}`;
}

function humanizeBalances(balances, denomMap) {
  if (!Array.isArray(balances) || balances.length === 0) return '(empty)';
  return balances
    .map((b) => humanizeCoin(b && b.amount != null ? b.amount : '0', b && b.denom, denomMap))
    .join(', ');
}

function denomToSymbol(denom, denomMap) {
  if (!denom) return String(denom ?? '');
  const lookup = denomMap && typeof denomMap.lookup === 'function' ? denomMap.lookup(denom) : null;
  return lookup && lookup.symbol ? lookup.symbol : denom;
}

module.exports = {
  loadChainDenomMap,
  humanizeCoin,
  humanizeBalances,
  denomToSymbol,
  // Exported for unit testing of the scaling logic in isolation.
  _fmtScaledAmount: fmtScaledAmount,
};
