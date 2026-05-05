'use strict';

/**
 * Compose a Cosmos gas-price string ("<amount><raw-denom>") by looking up a
 * fee-token symbol in the chain registry data.
 *
 * Pins the symbol-vs-denom contract: every gas-price string sent to the
 * chain must use the RAW on-chain denom (e.g. "umfx", or the long
 * factory/.../upwr form), not the friendly symbol ("MFX", "PWR"). When
 * skill prose asks the LLM to compose this string by hand it occasionally
 * substitutes the symbol — this helper makes that mistake unrepresentable.
 */

function composeGasPrice(chainData, symbol) {
  const feeTokens = Array.isArray(chainData?.feeTokens) ? chainData.feeTokens : [];
  const token = feeTokens.find((t) => t && t.symbol === symbol);
  if (!token) {
    const available = feeTokens.map((t) => t.symbol).filter(Boolean).join(', ') || '(none)';
    throw new Error(`No fee token with symbol "${symbol}" on this chain. Available: ${available}`);
  }
  if (typeof token.denom !== 'string' || token.fixedMinGasPrice === undefined) {
    throw new Error(`Fee token "${symbol}" is missing denom or fixedMinGasPrice in chain data`);
  }
  return `${token.fixedMinGasPrice}${token.denom}`;
}

module.exports = { composeGasPrice };
