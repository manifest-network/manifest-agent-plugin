'use strict';

const { validateEndpointUrl, isValidChainId, isValidGasDenom } = require('./_chain-config.cjs');

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function endpointAddress(apis, kind, { optional = false } = {}) {
  const field = `apis.${kind}[0].address`;
  const entries = apis?.[kind];
  if (optional && (entries === undefined || (Array.isArray(entries) && entries.length === 0))) return undefined;
  const value = Array.isArray(entries) ? entries[0]?.address : undefined;
  // Unlike URL(), registry input must spell an absolute URL without repairs.
  if (typeof value !== 'string' || /[\s\\]/.test(value) || !/^[a-z][a-z0-9+.-]*:\/\/[^/]/i.test(value)) {
    throw new Error(`${field} must be an absolute URL with no whitespace or backslashes.`);
  }
  const validation = validateEndpointUrl(value, field);
  if (!validation.valid) throw new Error(validation.reason);
  // CosmJS 0.32.4 selects HTTP vs WebSocket with case-sensitive startsWith.
  // Normalize only the scheme; preserve authority, port, path and query bytes.
  return value.replace(/^[^:]+:/, scheme => scheme.toLowerCase());
}

function buildDenomSymbolMap(assetList) {
  const map = new Map();
  for (const asset of Array.isArray(assetList?.assets) ? assetList.assets : []) {
    if (isObject(asset) && typeof asset.base === 'string' && typeof asset.symbol === 'string' && asset.symbol) {
      map.set(asset.base, asset.symbol);
    }
  }
  return map;
}

function gasAmount(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite nonnegative number.`);
  }
  return value;
}

function extractChainData(chainRaw, assetList) {
  if (!isObject(chainRaw)) throw new Error('chain.json must be a JSON object.');
  if (!isValidChainId(chainRaw.chain_id)) {
    throw new Error('chain_id must be a nonblank string starting with a letter or digit and containing only letters, digits, underscores or hyphens.');
  }
  const rpcUrl = endpointAddress(chainRaw.apis, 'rpc');
  const restUrl = endpointAddress(chainRaw.apis, 'rest', { optional: true });
  const symbolMap = buildDenomSymbolMap(assetList);
  if (chainRaw.fees !== undefined && !isObject(chainRaw.fees)) throw new Error('fees must be a JSON object.');
  const tokens = chainRaw.fees?.fee_tokens ?? [];
  if (chainRaw.fees?.fee_tokens === null || !Array.isArray(tokens)) throw new Error('fees.fee_tokens must be an array.');
  const feeTokens = tokens.map((token, index) => {
    const field = `fees.fee_tokens[${index}]`;
    if (!isObject(token)) throw new Error(`${field} must be a JSON object.`);
    if (!isValidGasDenom(token.denom)) {
      throw new Error(`${field}.denom must be a valid gas denomination of 3 to 128 characters.`);
    }
    const data = {
      denom: token.denom,
      symbol: symbolMap.get(token.denom) || token.denom,
      fixedMinGasPrice: gasAmount(token.fixed_min_gas_price, `${field}.fixed_min_gas_price`),
    };
    for (const [input, output] of [['low_gas_price', 'lowGasPrice'], ['average_gas_price', 'averageGasPrice'], ['high_gas_price', 'highGasPrice']]) {
      if (token[input] !== undefined) data[output] = gasAmount(token[input], `${field}.${input}`);
    }
    return data;
  });
  return { chainId: chainRaw.chain_id, rpcUrl, restUrl, feeTokens, explorerUrl: chainRaw.explorers?.[0]?.url };
}

module.exports = { extractChainData };
