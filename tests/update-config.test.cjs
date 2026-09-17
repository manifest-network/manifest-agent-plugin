'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');

function fixture(t) {
  const data = fs.mkdtempSync(join(tmpdir(), 'update-chain-config-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  fs.mkdirSync(join(data, 'chains'));
  const chains = Object.fromEntries(['testnet', 'mainnet'].map(network => [network, {
    chainId: `manifest-ledger-${network}`, rpcUrl: `https://${network}.example.invalid`,
    feeTokens: [{ denom: 'umfx', symbol: 'MFX', fixedMinGasPrice: 1 }],
  }]));
  const configPath = join(data, 'config.json');
  const config = { activeChain: 'testnet', gasPrice: '1umfx', chains: { testnet: chains.testnet },
    agent: { address: 'manifest1publicfixture', keyFile: 'keys/fixture.json' } };
  fs.writeFileSync(configPath, JSON.stringify(config) + '\n', { mode: 0o600 });
  fs.writeFileSync(join(data, 'chains', 'testnet.json'), JSON.stringify(chains.testnet));
  return { data, chains, config, configPath, run(args) {
    const result = spawnSync(process.execPath, [join(__dirname, '../scripts/update-config.cjs'), ...args], {
      encoding: 'utf8', timeout: 10000,
      env: { PATH: process.env.PATH, MANIFEST_PLUGIN_DATA: data, MANIFEST_CREDENTIAL_STORE: 'file' },
    });
    assert.ifError(result.error);
    return result;
  } };
}

for (const refresh of [false, true]) {
  test(`missing target chain rejects selection${refresh ? ' with refresh' : ' without refresh'} and preserves config`, t => {
    const f = fixture(t);
    // A disk file does not update config.chains until --refresh-chains is requested.
    if (!refresh) fs.writeFileSync(join(f.data, 'chains', 'mainnet.json'), JSON.stringify(f.chains.mainnet));
    const before = fs.readFileSync(f.configPath);
    const result = f.run(['--chain', 'mainnet', ...(refresh ? ['--refresh-chains'] : [])]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Chain data not found for mainnet/);
    assert.match(result.stderr, /fetch-chain-registry\.cjs/);
    assert.deepEqual(fs.readFileSync(f.configPath), before);
    assert.equal(fs.existsSync(join(f.data, '.config.lock')), false);
  });
}

test('refresh merges a newly available target before validating the chain selection', t => {
  const f = fixture(t);
  fs.writeFileSync(join(f.data, 'chains', 'mainnet.json'), JSON.stringify(f.chains.mainnet));
  const result = f.run(['--chain', 'mainnet', '--refresh-chains', '--gas-token', 'MFX']);
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(fs.readFileSync(f.configPath, 'utf8'));
  assert.equal(config.activeChain, 'mainnet');
  assert.equal(config.gasPrice, '1umfx');
  assert.deepEqual(config.chains, f.chains);
  assert.deepEqual(config.agent, f.config.agent);
  assert.equal(JSON.parse(result.stdout).activeChain, 'mainnet');
});

test('a valid cached target remains selectable when only the other chain file is available', t => {
  const f = fixture(t);
  f.config.chains.mainnet = f.chains.mainnet;
  fs.writeFileSync(f.configPath, JSON.stringify(f.config));
  for (const args of [['--chain', 'mainnet'], ['--chain', 'mainnet', '--refresh-chains']]) {
    const result = f.run(args);
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(fs.readFileSync(f.configPath, 'utf8'));
    assert.equal(config.activeChain, 'mainnet');
    assert.deepEqual(config.chains.mainnet, f.chains.mainnet);
  }
});

test('refresh alone refuses to preserve an active chain with no metadata', t => {
  const f = fixture(t);
  f.config.activeChain = 'mainnet';
  fs.writeFileSync(f.configPath, JSON.stringify(f.config));
  const before = fs.readFileSync(f.configPath);
  const result = f.run(['--refresh-chains']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Chain data not found for mainnet/);
  assert.deepEqual(fs.readFileSync(f.configPath), before);
});
