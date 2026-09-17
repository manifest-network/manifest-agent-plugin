#!/usr/bin/env node
'use strict';

// Check consumer drift against the installed package without runtime
// dependencies or network access in the ordinary unit suite.
const assert = require('node:assert/strict');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const predicates = require('../scripts/_chain-config.cjs');
const { extractChainData } = require('../scripts/_chain-registry.cjs');
const { composeGasPrice } = require('../scripts/_gas-price.cjs');

// Expected string-policy outcomes from manifest-mcp-core v0.22.0 config.ts.
// Registry spelling/shape checks are stricter than these consumer predicates;
// for example URL() repairs missing slashes.
const VECTORS = {
  endpoints: [
    ['https://rpc.example.invalid', true], ['HTTPS://RPC.example.invalid:443/a%2Fb?x=Y', true],
    ['https://[2001:db8::1]:443/rpc', true], ['https://localhost', true],
    ['http://localhost:26657', true], ['HTTP://LOCALHOST:26657', true],
    ['http://127.0.0.1:26657', true], ['http://[::1]:26657', true],
    ['http://127.1', true], ['http://[0:0:0:0:0:0:0:1]', true],
    ['http://rpc.example.invalid', false], ['http://127.0.0.2', false],
    ['http://localhost.example.invalid', false], ['http://localhost.', false],
    ['ftp://rpc.example.invalid', false], ['wss://rpc.example.invalid', false],
    ['file:///tmp/rpc', false], ['mailto:rpc@example.invalid', false],
    ['', false], ['not a URL', false], ['/rpc', false], ['//rpc.example.invalid', false],
    ['https://', false], ['https://[invalid]', false], ['https://rpc.example.invalid:65536', false],
    ['https:rpc.example.invalid', true], ['https:///rpc.example.invalid', true],
  ],
  chainIds: [
    ['manifest-ledger-mainnet', true], ['manifest-ledger-testnet', true], ['Manifest_1-test', true], ['1', true],
    ['', false], [' ', false], [' manifest-ledger', false], ['manifest ledger', false],
    ['manifest-ledger ', false], ['manifest-ledger\n', false],
    ['-manifest', false], ['_manifest', false], ['manifest.ledger', false], ['manifest/ledger', false], ['manifest-é', false],
  ],
  gasPrices: [
    ['1umfx', true], ['0umfx', true], ['0.37umfx', true], ['0.37factory/manifest1.../upwr', true], ['0.5ibc/ABC123', true],
    ['0.0000001umfx', true], ['1000000000000000000000umfx', true], ['1u._-:mfx', true],
    ['1abc', true], ['1' + 'a'.repeat(128), true], ['1' + 'a'.repeat(129), false],
    ['', false], ['nullumfx', false], ['NaNumfx', false], ['Infinityumfx', false],
    ['-1umfx', false], ['+1umfx', false], ['.5umfx', false], ['1.umfx', false],
    ['1xy', false], ['1/umfx', false], ['1u/m/f/', false], ['1u//mfx', false], ['1u mfx', false],
  ],
};

const BASE = { chainId: 'manifest-ledger-testnet', rpcUrl: 'https://rpc.example.invalid', gasPrice: '1umfx' };

function checkChainConfigParity(upstream, plugin = predicates) {
  let count = 0;
  for (const [kind, vectors] of Object.entries(VECTORS)) {
    for (const [value, expected] of vectors) {
      const label = `${kind} ${JSON.stringify(value)}`;
      const actual = kind === 'endpoints' ? upstream.validateEndpointUrl(value, 'endpoint').valid
        : upstream.validateConfig({ ...BASE, [kind === 'chainIds' ? 'chainId' : 'gasPrice']: value }).valid;
      const local = kind === 'endpoints' ? plugin.validateEndpointUrl(value, 'endpoint').valid
        : kind === 'chainIds' ? plugin.isValidChainId(value) : plugin.isValidGasPrice(value);
      assert.equal(actual, expected, `Installed runtime policy changed: ${label}`);
      assert.equal(local, actual, `Plugin differs from installed runtime: ${label}`);
      count++;
    }
  }

  // Exercise extraction -> JSON cache -> gas composition -> startup validation.
  for (const rpc of ['HTTPS://RPC.example.invalid:443/a%2Fb?x=Y', 'HTTP://localhost:26657', 'http://[::1]:26657']) {
    for (const amount of [0, 0.37, 1e-7, 1e21]) {
      const saved = JSON.parse(JSON.stringify(extractChainData({
        chain_id: BASE.chainId,
        apis: { rpc: [{ address: rpc }], rest: [{ address: 'HTTPS://REST.example.invalid' }] },
        fees: { fee_tokens: [{ denom: 'umfx', fixed_min_gas_price: amount }] },
      })));
      const gasPrice = composeGasPrice(saved, 'umfx');
      assert.ok(saved.rpcUrl.startsWith('https://') || saved.rpcUrl.startsWith('http://'), 'Saved RPC must use HTTP transport');
      assert.equal(gasPrice.slice(0, -4).includes('e'), false, 'Gas amounts must not change the raw denom through exponent notation');
      const result = upstream.validateConfig({ ...saved, gasPrice });
      assert.equal(result.valid, true, `Persisted registry data rejected at startup: ${JSON.stringify(result.errors)}`);
      count++;
    }
  }
  return count;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--data-dir' || !args[1] || args[1].startsWith('--')) {
    throw new Error('Usage: node ci/chain-config-parity.cjs --data-dir <runtime-dir>');
  }
  const configPath = join(resolve(args[1]), 'node_modules', '@manifest-network', 'manifest-mcp-core', 'dist', 'config.js');
  const upstream = await import(pathToFileURL(configPath).href);
  const count = checkChainConfigParity(upstream);
  console.log(`chain-config-parity: OK — ${count} policy and persisted-config cases match installed manifest-mcp-core`);
}

if (require.main === module) main().catch(error => { console.error(`chain-config-parity: ${error.message}`); process.exitCode = 1; });
module.exports = { VECTORS, checkChainConfigParity };
