'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const { storePassword, resolvePassword } = require('../scripts/_credentials.cjs');
const SCRIPTS = join(__dirname, '../scripts');
const SECRET = 'config-recovery-fixture-secret';

function fixture(t, legacy = false) {
  const data = fs.mkdtempSync(join(tmpdir(), 'update-chain-config-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  fs.mkdirSync(join(data, 'chains'));
  const chains = Object.fromEntries(['testnet', 'mainnet'].map(network => [network, {
    chainId: `manifest-ledger-${network}`, rpcUrl: `https://${network}.example.invalid`,
    feeTokens: [{ denom: 'umfx', symbol: 'MFX', fixedMinGasPrice: 1 }],
  }]));
  const configPath = join(data, 'config.json');
  const config = { activeChain: 'testnet', gasPrice: '9umfx', gasMultiplier: 2.25, chains: { testnet: chains.testnet },
    agent: { address: 'manifest1publicfixture', keyFile: 'keys/fixture.json' } };
  if (legacy) config.agent.keyPassword = SECRET;
  else config.agent.keyPasswordRef = storePassword(data, config.agent.keyFile, SECRET,
    { env: { MANIFEST_CREDENTIAL_STORE: 'file' } });
  fs.writeFileSync(configPath, JSON.stringify(config) + '\n', { mode: 0o600 });
  fs.writeFileSync(join(data, 'chains', 'testnet.json'), JSON.stringify(chains.testnet));
  function runScript(script, args = [], nodeArgs = []) {
    const result = spawnSync(process.execPath, [...nodeArgs, join(SCRIPTS, script), ...args], {
      encoding: 'utf8', timeout: 10000,
      env: { PATH: process.env.PATH, MANIFEST_PLUGIN_DATA: data, MANIFEST_CREDENTIAL_STORE: 'file' },
    });
    assert.ifError(result.error);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(SECRET));
    return result;
  }
  return { data, chains, config, configPath, run: (args, nodeArgs) => runScript('update-config.cjs', args, nodeArgs),
    fetch(failedNetworks = []) {
      // Run the real fetcher/extraction/writes, replacing only network I/O.
      const preload = join(data, 'registry-network.cjs');
      fs.writeFileSync(preload, `
        require.cache[require.resolve(${JSON.stringify(join(SCRIPTS, '_https-json.cjs'))})] = {
          loaded: true,
          exports: { httpsGet: async ({ path }) => {
            const network = path.includes('/testnets/') ? 'testnet' : 'mainnet';
            if (${JSON.stringify(failedNetworks)}.includes(network)) return { status: 503, body: '' };
            const body = path.endsWith('/assetlist.json')
              ? { assets: [{ base: 'umfx', symbol: 'MFX' }] }
              : { chain_id: 'manifest-ledger-' + network,
                  apis: { rpc: [{ address: 'https://' + network + '.example.invalid' }] },
                  fees: { fee_tokens: [{ denom: 'umfx', fixed_min_gas_price: 3 }] } };
            return { status: 200, body: JSON.stringify(body) };
          } }
        };
      `);
      return runScript('fetch-chain-registry.cjs', [], ['--require', preload]);
    },
  };
}

function refused(f, args, diagnostic) {
  const before = fs.readFileSync(f.configPath);
  const credentials = fs.existsSync(join(f.data, 'credentials')) ? fs.readdirSync(join(f.data, 'credentials')) : [];
  const result = f.run(args);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, diagnostic);
  assert.deepEqual(fs.readFileSync(f.configPath), before);
  assert.equal(fs.existsSync(join(f.data, '.config.lock')), false);
  assert.deepEqual(fs.existsSync(join(f.data, 'credentials')) ? fs.readdirSync(join(f.data, 'credentials')) : [], credentials);
  return result.stderr;
}

function recovered(f, args, network, gasPrice, gasMultiplier = f.config.gasMultiplier) {
  const result = f.run(args);
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(fs.readFileSync(f.configPath));
  assert.equal(config.activeChain, network);
  assert.equal(config.gasPrice, gasPrice);
  assert.equal(config.gasMultiplier, gasMultiplier);
  assert.equal(config.agent.address, f.config.agent.address);
  assert.equal(config.agent.keyFile, f.config.agent.keyFile);
  assert.equal(resolvePassword(config, f.data), SECRET);
  assert.equal(Object.hasOwn(config.agent, 'keyPassword'), false);
  if (f.config.agent.keyPasswordRef) assert.deepEqual(config.agent.keyPasswordRef, f.config.agent.keyPasswordRef);
  assert.equal(JSON.parse(result.stdout).activeChain, network);
  assert.equal(fs.statSync(f.configPath).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(join(f.data, '.config.lock')), false);
  return config;
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
    assert.deepEqual(fs.readFileSync(f.configPath), before);
    assert.equal(fs.existsSync(join(f.data, '.config.lock')), false);
    if (refresh) assert.match(result.stderr, /fetch-chain-registry\.cjs/);
    else {
      assert.doesNotMatch(result.stderr, /fetch-chain-registry\.cjs/);
      assert.match(result.stderr, /retry the original command with --refresh-chains/i);
      recovered(f, ['--chain', 'mainnet', '--refresh-chains'], 'mainnet', '9umfx');
    }
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

for (const explicitChain of [true, false]) {
  test(`gas-token selection with ${explicitChain ? 'an explicit' : 'the active'} chain diagnoses missing config metadata and recovers offline`, t => {
    const f = fixture(t, true);
    if (!explicitChain) {
      f.config.activeChain = 'mainnet';
      fs.writeFileSync(f.configPath, JSON.stringify(f.config));
    }
    fs.writeFileSync(join(f.data, 'chains', 'mainnet.json'), JSON.stringify(f.chains.mainnet));
    const args = [...(explicitChain ? ['--chain', 'mainnet'] : []), '--gas-token', 'MFX'];
    const diagnostic = refused(f, args, /Chain data not found for mainnet/);
    assert.doesNotMatch(diagnostic, /differs from config|fetch-chain-registry\.cjs/);
    const retry = diagnostic.match(/retry the original command with (--refresh-chains)/i);
    assert.ok(retry, diagnostic);
    const config = recovered(f, [...args, retry[1]], 'mainnet', '1umfx');
    assert.deepEqual(config.chains.mainnet, f.chains.mainnet);
  });
}

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

for (const legacy of [false, true]) {
  for (const network of ['testnet', 'mainnet']) {
    test(`${legacy ? 'legacy' : 'current'} config: refresh without an active chain recovers by explicitly selecting ${network}`, t => {
      const f = fixture(t, legacy);
      delete f.config.activeChain;
      fs.writeFileSync(f.configPath, JSON.stringify(f.config));
      fs.writeFileSync(join(f.data, 'chains', network + '.json'), JSON.stringify(f.chains[network]));
      const diagnostic = refused(f, ['--refresh-chains'], /active chain/i);
      assert.match(diagnostic, /Ask the user.*switch-chain.*mainnet confirmation/);
      assert.doesNotMatch(diagnostic, /--chain (?:testnet|mainnet)/);
      assert.match(diagnostic, /--refresh-chains/);
      recovered(f, ['--refresh-chains', '--chain', network], network, '9umfx');
    });

    test(`${legacy ? 'legacy' : 'current'} config: cached ${network} metadata cannot resolve a gas token without a disk file`, t => {
      const f = fixture(t, legacy);
      f.config.chains = f.chains;
      fs.writeFileSync(f.configPath, JSON.stringify(f.config));
      fs.rmSync(join(f.data, 'chains', 'testnet.json'));
      // Selection alone is supported from config.chains. Restore the original
      // bytes so the refused token update also exercises a legacy credential.
      const original = fs.readFileSync(f.configPath);
      recovered(f, ['--chain', network], network, '9umfx');
      fs.writeFileSync(f.configPath, original);
      const args = ['--chain', network, '--gas-token', 'MFX', '--gas-multiplier', '2.75'];
      const diagnostic = refused(f, args, /Chain data.*not found/);
      assert.match(diagnostic, /fetch-chain-registry\.cjs/);
      assert.match(diagnostic, /refresh-registry skill/);
      const retry = diagnostic.match(/update-config\.cjs (--chain (?:testnet|mainnet) --refresh-chains)/);
      assert.ok(retry, diagnostic);
      // A partial fetch that omits the selected network cannot repair the file.
      const partial = f.fetch([network]);
      assert.equal(partial.status, 0, partial.stderr);
      assert.equal(Object.hasOwn(JSON.parse(partial.stdout), network), false);
      refused(f, [...args, ...retry[1].split(' ')], /Chain data.*not found/);
      const fetched = f.fetch();
      assert.equal(fetched.status, 0, fetched.stderr);
      assert.ok(JSON.parse(fetched.stdout)[network]);
      recovered(f, retry[1].split(' '), network, '9umfx');
      const config = recovered(f, args, network, '3umfx', 2.75);
      assert.deepEqual(config.chains[network], JSON.parse(fetched.stdout)[network]);
    });
  }
}

test('missing chain selection is diagnosed before missing files for refresh and gas-token updates', t => {
  const f = fixture(t, true);
  fs.rmSync(join(f.data, 'chains'), { recursive: true });
  for (const activeChain of [undefined, null, '', 'staging']) {
    f.config.activeChain = activeChain;
    fs.writeFileSync(f.configPath, JSON.stringify(f.config));
    for (const args of [['--refresh-chains'], ['--gas-token', 'MFX']]) {
      refused(f, args, /Ask the user.*switch-chain.*mainnet confirmation/);
    }
  }
  const args = ['--chain', 'testnet', '--refresh-chains'];
  refused(f, args, /fetch-chain-registry\.cjs/);
  const fetched = f.fetch();
  assert.equal(fetched.status, 0, fetched.stderr);
  recovered(f, [...args, '--gas-token', 'MFX'], 'testnet', '3umfx');
});

test('gas-token selection requires refreshing stale metadata before a new price is applied', t => {
  const f = fixture(t);
  const disk = {
    ...f.chains.testnet, feeTokens: [{ denom: 'umfx', symbol: 'MFX', fixedMinGasPrice: 4 }],
  };
  fs.writeFileSync(join(f.data, 'chains', 'testnet.json'), JSON.stringify(disk));
  const diagnostic = refused(f, ['--gas-token', 'MFX'], /differs from config/);
  assert.doesNotMatch(diagnostic, /fetch-chain-registry\.cjs/);
  const refresh = diagnostic.match(/update-config\.cjs (--chain testnet --refresh-chains)/);
  assert.ok(refresh, diagnostic);
  const preview = recovered(f, refresh[1].split(' '), 'testnet', '9umfx');
  assert.deepEqual(preview.chains.testnet, disk);
  const applied = recovered(f, ['--gas-token', 'MFX'], 'testnet', '4umfx');
  assert.deepEqual(applied.chains.testnet, disk);
});

for (const legacy of [false, true]) {
  test(`${legacy ? 'legacy' : 'current'} config: nonobject chain maps are refused without migration or writes`, t => {
    const f = fixture(t, legacy);
    for (const chains of [null, 'x', 0, false, [], ['x']]) {
      fs.writeFileSync(f.configPath, JSON.stringify({ ...f.config, chains }));
      for (const args of [['--refresh-chains'], ['--gas-token', 'MFX'], ['--chain', 'testnet']]) {
        refused(f, args, /config.chains.*JSON object/);
      }
    }
  });

  for (const network of ['testnet', 'mainnet']) {
    test(`${legacy ? 'legacy' : 'current'} config: malformed ${network} registry files recover through fetch and refresh`, t => {
      const f = fixture(t, legacy);
      for (const content of ['{"truncated":', '[]', 'null']) {
        fs.writeFileSync(join(f.data, 'chains', network + '.json'), content);
        const args = ['--chain', network, '--gas-token', 'MFX'];
        const diagnostic = refused(f, args, /Could not read.*JSON object/);
        assert.match(diagnostic, /refresh-registry skill/);
        assert.match(diagnostic, /fetch-chain-registry\.cjs/);
        refused(f, ['--refresh-chains'], /Could not read.*JSON object/);
        const fetched = f.fetch();
        assert.equal(fetched.status, 0, fetched.stderr);
        const refresh = diagnostic.match(/update-config\.cjs (--chain (?:testnet|mainnet) --refresh-chains)/);
        assert.ok(refresh, diagnostic);
        recovered(f, refresh[1].split(' '), network, content === '{"truncated":' ? '9umfx' : '3umfx');
        recovered(f, args, network, '3umfx');
      }
    });
  }
}

test('a gas-token refresh uses one disk snapshot for both the price and persisted metadata', t => {
  const f = fixture(t);
  const registryFile = join(f.data, 'chains', 'testnet.json');
  const reads = join(f.data, 'registry-reads');
  const preload = join(f.data, 'changing-registry.cjs');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const read = fs.readFileSync;
    let count = 0;
    fs.readFileSync = (path, ...args) => {
      const result = read(path, ...args);
      if (path !== ${JSON.stringify(registryFile)}) return result;
      fs.writeFileSync(${JSON.stringify(reads)}, String(++count));
      if (count === 1) return result;
      const data = JSON.parse(result);
      data.feeTokens[0].fixedMinGasPrice = 4;
      return JSON.stringify(data);
    };
  `);
  const result = f.run(['--gas-token', 'MFX', '--refresh-chains'], ['--require', preload]);
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(fs.readFileSync(f.configPath));
  assert.equal(config.gasPrice, '1umfx');
  assert.equal(config.chains.testnet.feeTokens[0].fixedMinGasPrice, 1);
  assert.equal(fs.readFileSync(reads, 'utf8'), '1');
});

test('repairing a malformed file for the other network retains the selected active chain', t => {
  const f = fixture(t);
  fs.writeFileSync(join(f.data, 'chains', 'mainnet.json'), '{');
  const diagnostic = refused(f, ['--refresh-chains'], /Could not read.*mainnet.json/);
  assert.match(diagnostic, /verify mainnet was saved/);
  const refresh = diagnostic.match(/update-config\.cjs (--chain testnet --refresh-chains)/);
  assert.ok(refresh, diagnostic);
  assert.doesNotMatch(diagnostic, /--chain mainnet/);
  assert.equal(f.fetch().status, 0);
  recovered(f, refresh[1].split(' '), 'testnet', '9umfx');
});

test('refresh can initialize an absent chain map from existing files', t => {
  const f = fixture(t);
  delete f.config.chains;
  fs.writeFileSync(f.configPath, JSON.stringify(f.config));
  const saved = recovered(f, ['--refresh-chains'], 'testnet', '9umfx');
  assert.deepEqual(saved.chains, { testnet: f.chains.testnet });
});
