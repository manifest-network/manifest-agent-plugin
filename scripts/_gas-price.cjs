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

const { isValidGasDenom } = require('./_chain-config.cjs');

function decimalAmount(value) {
  const [mantissa, exponent] = String(value).split('e');
  if (exponent === undefined) return mantissa;
  const [whole, fraction = ''] = mantissa.split('.');
  const digits = whole + fraction;
  const point = whole.length + Number(exponent);
  if (point <= 0) return `0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return digits + '0'.repeat(point - digits.length);
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

function composeGasPrice(chainData, symbol) {
  const feeTokens = Array.isArray(chainData?.feeTokens) ? chainData.feeTokens : [];
  const token = feeTokens.find((t) => t && t.symbol === symbol);
  if (!token) {
    const available = feeTokens.map((t) => t?.symbol).filter(Boolean).join(', ') || '(none)';
    throw new Error(`No fee token with symbol "${symbol}" on this chain. Available: ${available}`);
  }
  if (typeof token.denom !== 'string' || token.fixedMinGasPrice === undefined) {
    throw new Error(`Fee token "${symbol}" is missing denom or fixedMinGasPrice in chain data`);
  }
  if (typeof token.fixedMinGasPrice !== 'number' || !Number.isFinite(token.fixedMinGasPrice) || token.fixedMinGasPrice < 0) {
    throw new Error(`Fee token "${symbol}" fixedMinGasPrice must be a finite nonnegative number`);
  }
  if (!isValidGasDenom(token.denom)) {
    throw new Error(`Fee token "${symbol}" denom must be a valid gas denomination of 3 to 128 characters`);
  }
  return `${decimalAmount(token.fixedMinGasPrice)}${token.denom}`;
}

module.exports = { composeGasPrice };
