'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');

function fixture(t, behavior = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'fetch-chain-registry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, 'scripts');
  const data = join(root, 'data');
  const chains = join(data, 'chains');
  fs.mkdirSync(scripts);
  fs.mkdirSync(chains, { recursive: true });
  for (const name of ['fetch-chain-registry.cjs', '_io.cjs']) {
    fs.copyFileSync(join(__dirname, '../scripts', name), join(scripts, name));
  }
  fs.writeFileSync(join(scripts, 'behavior.json'), JSON.stringify(behavior));
  // Replace only the network boundary. Chain extraction and atomic writes run unchanged.
  fs.writeFileSync(join(scripts, '_https-json.cjs'), `
    const fs = require('node:fs');
    const behavior = require('./behavior.json');
    exports.httpsGet = async options => {
      const network = options.path.includes('/testnets/') ? 'testnet' : 'mainnet';
      const asset = options.path.endsWith('/assetlist.json');
      fs.appendFileSync(${JSON.stringify(join(root, 'requests'))}, network + ':' + (asset ? 'assets' : 'chain') + '\\n');
      if ((asset ? behavior.failedAssets : behavior.failedNetworks)?.includes(network)) return { status: 503, body: '' };
      return { status: 200, body: JSON.stringify(asset ? { assets: [{ base: 'umfx', symbol: 'MFX' }] } : {
        chain_id: 'manifest-ledger-' + network,
        apis: { rpc: [{ address: 'https://' + network + '.example.invalid/rpc' }], rest: [{ address: 'https://' + network + '.example.invalid/rest' }] },
        fees: { fee_tokens: [{ denom: 'umfx', fixed_min_gas_price: 1 }] },
      }) };
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
    return { ...result, json: JSON.parse(result.stdout) };
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
