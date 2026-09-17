'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractChainData } = require('../scripts/_chain-registry.cjs');
const { composeGasPrice } = require('../scripts/_gas-price.cjs');

function chainData(network) {
  return {
    chain_id: 'manifest-ledger-' + network,
    apis: { rpc: [{ address: 'https://rpc.example.invalid' }] },
    fees: { fee_tokens: [{ denom: 'umfx', fixed_min_gas_price: 1 }] },
  };
}

const valid = chainData('fixture');
const rpcField = 'apis.rpc[0].address';
const invalidMetadata = [
  ['empty object', {}, 'chain_id'],
  ['array body', [valid], 'chain.json'],
  ['empty array body', [], 'chain.json'],
  ['null body', null, 'chain.json'],
  ['string body', 'chain data', 'chain.json'],
  ['number body', 42, 'chain.json'],
  ['boolean body', false, 'chain.json'],
  ['missing chain ID', { apis: valid.apis }, 'chain_id'],
  ...[' manifest-ledger', 'manifest-ledger\n', 'manifest.ledger', '-manifest', '_manifest', 'manifest/ledger'].map(chain_id =>
    [`invalid chain ID ${JSON.stringify(chain_id)}`, { ...valid, chain_id }, 'chain_id']),
  ...[
    ['null', null], ['number', 42], ['boolean', false], ['object', {}],
    ['array', ['manifest-ledger-fixture']], ['empty', ''], ['blank', ' \t\n'],
  ].map(([name, chain_id]) => [`${name} chain ID`, { ...valid, chain_id }, 'chain_id']),
  ['missing APIs', { chain_id: valid.chain_id }, rpcField],
  ['null APIs', { ...valid, apis: null }, rpcField],
  ['missing RPC list', { ...valid, apis: {} }, rpcField],
  ...[
    ['null', null], ['empty', []], ['string', 'https://rpc.example.invalid'],
    ['object', { 0: { address: 'https://rpc.example.invalid' } }],
    ['null first entry', [null]], ['missing first address', [{}]],
  ].map(([name, rpc]) => [`${name} RPC list`, { ...valid, apis: { rpc } }, rpcField]),
  ...[
    ['null', null], ['number', 42], ['boolean', false], ['object', {}],
    ['array', ['https://rpc.example.invalid']], ['empty', ''], ['blank', ' \t\n'],
    ['unparseable', 'not a URL'], ['relative', '/rpc'],
    ['protocol-relative', '//rpc.example.invalid'], ['missing host', 'https://'],
    ['invalid host', 'https://[invalid]'], ['invalid port', 'https://rpc.example.invalid:65536'],
    ['unsupported FTP', 'ftp://rpc.example.invalid'], ['unsupported WebSocket', 'wss://rpc.example.invalid'],
    ['remote HTTP', 'http://rpc.example.invalid'], ['HTTP localhost lookalike', 'http://localhost.example.invalid'],
    ['missing slashes', 'https:rpc.example.invalid'], ['empty authority', 'https:///rpc.example.invalid'],
    ['whitespace', 'https://rpc.example.invalid/with space'], ['backslash', 'https://rpc.example.invalid\\path'],
  ].map(([name, address]) => [`${name} RPC URL`, { ...valid, apis: { rpc: [{ address }] } }, rpcField]),
  ['invalid first RPC with valid fallback', { ...valid, apis: { rpc: [{ address: 'wss://rpc.example.invalid' }, ...valid.apis.rpc] } }, rpcField],
  ...[null, {}, 42, [null], [{}], [{ address: null }], [{ address: 42 }],
    [{ address: '' }], [{ address: ' \n' }], [{ address: 'ftp://rest.example.invalid' }],
    [{ address: 'http://rest.example.invalid' }], [{ address: 'https:rest.example.invalid' }],
    [{ address: 'https://rest.example.invalid\\path' }],
  ].map(rest => [`invalid REST ${JSON.stringify(rest)}`, { ...valid, apis: { ...valid.apis, rest } }, 'apis.rest[0].address']),
  ...[null, [], 'fees'].map(fees => [`invalid fees ${JSON.stringify(fees)}`, { ...valid, fees }, 'fees']),
  ...[null, {}, 'tokens', [null], [[]], ['token']].map(fee_tokens =>
    [`invalid fee list ${JSON.stringify(fee_tokens)}`, { ...valid, fees: { fee_tokens } }, 'fees.fee_tokens']),
  ...[undefined, null, false, '', '1', [], {}, -1, NaN, Infinity].map(fixed_min_gas_price =>
    [`invalid minimum ${String(fixed_min_gas_price)}`, { ...valid, fees: { fee_tokens: [{ denom: 'umfx', fixed_min_gas_price }] } }, 'fees.fee_tokens[0].fixed_min_gas_price']),
  ...[undefined, null, 42, '', 'xy', '9mfx', 'umfx\n', 'u/m/f/', 'u'.repeat(129)].map(denom =>
    [`invalid denom ${JSON.stringify(denom)}`, { ...valid, fees: { fee_tokens: [{ denom, fixed_min_gas_price: 1 }] } }, 'fees.fee_tokens[0].denom']),
  ...['low_gas_price', 'average_gas_price', 'high_gas_price'].map(field =>
    [`invalid ${field}`, { ...valid, fees: { fee_tokens: [{ ...valid.fees.fee_tokens[0], [field]: null }] } }, `fees.fee_tokens[0].${field}`]),
];

for (const [name, body, field] of invalidMetadata) {
  test(`registry validation rejects ${name} with a field diagnostic`, () => {
    assert.throws(() => extractChainData(body), error => error.message.includes(field));
  });
}

test('registry endpoints normalize only the scheme for HTTP transport and preserve first-entry selection', () => {
  for (const address of ['https://RPC.example.invalid:443/a%2Fb?x=Y', 'http://localhost:26657', 'http://127.0.0.1:26657/rpc', 'http://[::1]:26657']) {
    const upper = address.replace(/^[^:]+:/, scheme => scheme.toUpperCase());
    const data = extractChainData({ ...valid, apis: {
      rpc: [{ address: upper }, { address: 'https://unused.example.invalid' }],
      rest: [{ address: upper }],
    } });
    assert.equal(data.rpcUrl, address);
    assert.equal(data.restUrl, address);
    assert.ok(data.rpcUrl.startsWith('https://') || data.rpcUrl.startsWith('http://'));
  }
});

test('REST and fee metadata can be omitted without serializing optional prices as null', () => {
  for (const rest of [undefined, []]) {
    const body = { chain_id: 'Manifest_1-test', apis: { ...valid.apis, rest } };
    const data = JSON.parse(JSON.stringify(extractChainData(body)));
    assert.equal(data.chainId, body.chain_id);
    assert.equal(Object.hasOwn(data, 'restUrl'), false);
    assert.deepEqual(data.feeTokens, []);
  }
  const data = JSON.parse(JSON.stringify(extractChainData(valid)));
  assert.deepEqual(data.feeTokens, [{ denom: 'umfx', symbol: 'umfx', fixedMinGasPrice: 1 }]);
});

test('zero, fractional and scientific-notation JSON prices survive persistence and compose as decimal gas prices', () => {
  for (const [amount, expected] of [[0, '0umfx'], [0.37, '0.37umfx'], [1e-7, '0.0000001umfx'], [1e21, '1000000000000000000000umfx']]) {
    const body = { ...valid, fees: { fee_tokens: [{ denom: 'umfx', fixed_min_gas_price: amount,
      low_gas_price: amount, average_gas_price: amount, high_gas_price: amount }] } };
    const data = JSON.parse(JSON.stringify(extractChainData(body, { assets: [{ base: 'umfx', symbol: 'MFX' }] })));
    assert.equal(composeGasPrice(data, 'MFX'), expected);
    assert.equal(data.feeTokens[0].lowGasPrice, amount);
    assert.equal(data.feeTokens[0].averageGasPrice, amount);
    assert.equal(data.feeTokens[0].highGasPrice, amount);
  }
});

test('unusable optional asset symbols fall back to raw denoms', () => {
  for (const assets of [null, {}, { assets: {} }, { assets: [null, { base: 'umfx', symbol: 42 }] }]) {
    assert.equal(extractChainData(valid, assets).feeTokens[0].symbol, 'umfx');
  }
});
