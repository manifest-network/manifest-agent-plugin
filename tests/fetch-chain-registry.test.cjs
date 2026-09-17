'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');

function chainData(network) {
  return {
    chain_id: 'manifest-ledger-' + network,
    apis: { rpc: [{ address: 'https://' + network + '.example.invalid/rpc' }], rest: [{ address: 'https://' + network + '.example.invalid/rest' }] },
    fees: { fee_tokens: [{ denom: 'umfx', fixed_min_gas_price: 1 }] },
  };
}

function fixture(t, behavior = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'fetch-chain-registry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, 'scripts');
  const data = join(root, 'data');
  const chains = join(data, 'chains');
  fs.mkdirSync(scripts);
  fs.mkdirSync(chains, { recursive: true });
  for (const name of ['fetch-chain-registry.cjs', '_io.cjs', '_chain-registry.cjs', '_chain-config.cjs']) {
    fs.copyFileSync(join(__dirname, '../scripts', name), join(scripts, name));
  }
  fs.writeFileSync(join(scripts, 'behavior.json'), JSON.stringify({
    ...behavior,
    chainBodies: { mainnet: chainData('mainnet'), testnet: chainData('testnet'), ...behavior.chainBodies },
  }));
  // Replace only the network boundary. Chain extraction and atomic writes run unchanged.
  fs.writeFileSync(join(scripts, '_https-json.cjs'), `
    const fs = require('node:fs');
    const behavior = require('./behavior.json');
    exports.httpsGet = async options => {
      const network = options.path.includes('/testnets/') ? 'testnet' : 'mainnet';
      const asset = options.path.endsWith('/assetlist.json');
      fs.appendFileSync(${JSON.stringify(join(root, 'requests'))}, network + ':' + (asset ? 'assets' : 'chain') + '\\n');
      if ((asset ? behavior.failedAssets : behavior.failedNetworks)?.includes(network)) return { status: 503, body: '' };
      return { status: 200, body: JSON.stringify(asset ? { assets: [{ base: 'umfx', symbol: 'MFX' }] } : behavior.chainBodies[network]) };
    };
  `);
  fs.writeFileSync(join(scripts, 'run.cjs'), `
    const fs = require('node:fs');
    const path = require('node:path');
    const behavior = require('./behavior.json');
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (behavior.failedWrites?.includes(path.basename(to, '.json'))) {
        const error = new Error('fixture permission denied'); error.code = 'EACCES'; throw error;
      }
      return rename(from, to);
    };
    require('./fetch-chain-registry.cjs');
  `);
  for (const network of ['mainnet', 'testnet']) fs.writeFileSync(join(chains, network + '.json'), `old-${network}\n`);
  const stamp = join(data, '.last-registry-fetch');
  fs.writeFileSync(stamp, '123');
  return { data, chains, stamp, run() {
    const result = spawnSync(process.execPath, [join(scripts, 'run.cjs'), '--data-dir', data], {
      encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH },
    });
    assert.ifError(result.error);
    assert.equal(fs.readFileSync(join(root, 'requests'), 'utf8').trim().split('\n').length, 4);
    return { ...result, json: result.stdout ? JSON.parse(result.stdout) : undefined };
  } };
}

test('a complete registry refresh reports exactly the saved networks and advances its timestamp', t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(Object.keys(result.json), ['mainnet', 'testnet']);
  for (const network of ['mainnet', 'testnet']) {
    assert.deepEqual(JSON.parse(fs.readFileSync(join(f.chains, network + '.json'), 'utf8')), result.json[network]);
    assert.equal(result.json[network].chainId, 'manifest-ledger-' + network);
    assert.equal(result.json[network].feeTokens[0].symbol, 'MFX');
    assert.ok(result.json[network].converterAddress);
    assert.equal(fs.statSync(join(f.chains, network + '.json')).mode & 0o777, 0o644);
  }
  assert.equal(result.json.mainnet.faucetUrl, undefined);
  assert.ok(result.json.testnet.faucetUrl);
  assert.ok(Number(fs.readFileSync(f.stamp, 'utf8')) > 123);
  assert.doesNotMatch(result.stderr, /Error|Partial registry refresh|No chain data/);
});

const invalidMetadata = [
  ['empty object', {}, 'chain_id'],
  ['array body', [], 'chain.json'],
  ['primitive body', 42, 'chain.json'],
  ['null body', null, 'chain.json'],
  ['padded chain ID', { ...chainData('fixture'), chain_id: ' manifest-ledger-mainnet\n' }, 'chain_id'],
  ['remote HTTP RPC', { ...chainData('fixture'), apis: { rpc: [{ address: 'http://rpc.example.invalid' }] } }, 'apis.rpc[0].address'],
  ['invalid REST', { ...chainData('fixture'), apis: { ...chainData('fixture').apis, rest: [{ address: 'ftp://rest.example.invalid' }] } }, 'apis.rest[0].address'],
  ['missing fee price', { ...chainData('fixture'), fees: { fee_tokens: [{ denom: 'umfx' }] } }, 'fees.fee_tokens[0].fixed_min_gas_price'],
  ['malformed fee list', { ...chainData('fixture'), fees: { fee_tokens: {} } }, 'fees.fee_tokens'],
];

for (const [name, body, field] of invalidMetadata) {
  for (const failed of [['mainnet'], ['testnet'], ['mainnet', 'testnet']]) {
    test(`${name}: reject ${failed.join(' and ')} metadata without overwriting its cache`, t => {
      const f = fixture(t, { chainBodies: Object.fromEntries(failed.map(network => [network, body])) });
      const result = f.run();
      const saved = ['mainnet', 'testnet'].filter(network => !failed.includes(network));
      assert.equal(result.status, saved.length ? 0 : 1, result.stderr);
      assert.deepEqual(Object.keys(result.json), saved);
      for (const network of failed) {
        assert.equal(fs.readFileSync(join(f.chains, network + '.json'), 'utf8'), `old-${network}\n`);
        const diagnostic = result.stderr.split('\n').find(line => line.includes(`Error validating ${network} chain data:`));
        assert.ok(diagnostic?.includes(field), `Expected ${network}/${field} diagnostic: ${result.stderr}`);
        assert.ok(!result.stderr.includes(`Wrote ${join(f.chains, network + '.json')}`));
      }
      for (const network of saved) {
        assert.deepEqual(JSON.parse(fs.readFileSync(join(f.chains, network + '.json'), 'utf8')), result.json[network]);
        assert.equal(result.json[network].chainId, 'manifest-ledger-' + network);
        assert.equal(result.json[network].rpcUrl, 'https://' + network + '.example.invalid/rpc');
      }
      if (saved.length) {
        assert.match(result.stderr, /Partial registry refresh/);
        assert.ok(Number(fs.readFileSync(f.stamp, 'utf8')) > 123);
      } else {
        assert.match(result.stderr, /No chain data files were refreshed/);
        assert.equal(fs.readFileSync(f.stamp, 'utf8'), '123');
      }
      assert.deepEqual(fs.readdirSync(f.chains).sort(), ['mainnet.json', 'testnet.json']);
    });
  }
}

test('valid minimal metadata normalizes endpoint schemes and keeps optional fields optional', t => {
  const chainBodies = {
    mainnet: { chain_id: 'manifest-ledger-1', apis: { rpc: [{ address: 'HTTP://127.0.0.1:26657/rpc' }] } },
    testnet: { chain_id: 'manifest-ledger-testnet', apis: { rpc: [
      { address: 'HTTPS://[2001:db8::1]:443/rpc?network=testnet' },
      { address: 'https://unused.example.invalid' },
    ] } },
  };
  const f = fixture(t, { chainBodies });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(Object.keys(result.json), ['mainnet', 'testnet']);
  for (const [network, body] of Object.entries(chainBodies)) {
    assert.equal(result.json[network].chainId, body.chain_id);
    assert.equal(result.json[network].rpcUrl, body.apis.rpc[0].address.replace(/^[^:]+:/, scheme => scheme.toLowerCase()));
    assert.deepEqual(result.json[network].feeTokens, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(join(f.chains, network + '.json'), 'utf8')), result.json[network]);
  }
  assert.ok(Number(fs.readFileSync(f.stamp, 'utf8')) > 123);
  assert.doesNotMatch(result.stderr, /Error|Partial registry refresh|No chain data/);
});

for (const [failure, diagnostic] of [['failedNetworks', /fetching mainnet/], ['failedWrites', /writing mainnet/]]) {
  test(`partial ${failure} reports only saved networks and preserves the failed network's cached bytes`, t => {
    const f = fixture(t, { [failure]: ['mainnet'] });
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(Object.keys(result.json), ['testnet']);
    assert.equal(fs.readFileSync(join(f.chains, 'mainnet.json'), 'utf8'), 'old-mainnet\n');
    assert.deepEqual(JSON.parse(fs.readFileSync(join(f.chains, 'testnet.json'), 'utf8')), result.json.testnet);
    assert.match(result.stderr, diagnostic);
    assert.match(result.stderr, /Partial registry refresh/);
    assert.ok(Number(fs.readFileSync(f.stamp, 'utf8')) > 123);
    assert.deepEqual(fs.readdirSync(f.chains).sort(), ['mainnet.json', 'testnet.json']);
  });

  test(`zero successful saves after ${failure} exits nonzero and preserves cached files and timestamp`, t => {
    const f = fixture(t, { [failure]: ['mainnet', 'testnet'] });
    const result = f.run();
    assert.equal(result.status, 1);
    assert.deepEqual(result.json, {});
    assert.match(result.stderr, /No chain data files were refreshed/);
    for (const network of ['mainnet', 'testnet']) assert.equal(fs.readFileSync(join(f.chains, network + '.json'), 'utf8'), `old-${network}\n`);
    assert.equal(fs.readFileSync(f.stamp, 'utf8'), '123');
    assert.deepEqual(fs.readdirSync(f.chains).sort(), ['mainnet.json', 'testnet.json']);
  });
}

test('optional asset failures still save both chain files using raw denom symbols', t => {
  const f = fixture(t, { failedAssets: ['mainnet', 'testnet'] });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(Object.keys(result.json), ['mainnet', 'testnet']);
  for (const network of ['mainnet', 'testnet']) assert.equal(result.json[network].feeTokens[0].symbol, 'umfx');
  assert.doesNotMatch(result.stderr, /Partial registry refresh/);
});

test('timestamp-write failure exits nonzero with empty stdout while retaining successful chain saves', t => {
  const f = fixture(t, { failedWrites: ['.last-registry-fetch'] });
  const result = f.run();
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /fixture permission denied/);
  assert.equal(fs.readFileSync(f.stamp, 'utf8'), '123');
  for (const network of ['mainnet', 'testnet']) {
    const data = JSON.parse(fs.readFileSync(join(f.chains, network + '.json'), 'utf8'));
    assert.equal(data.chainId, 'manifest-ledger-' + network);
    assert.equal(data.rpcUrl, 'https://' + network + '.example.invalid/rpc');
  }
});
