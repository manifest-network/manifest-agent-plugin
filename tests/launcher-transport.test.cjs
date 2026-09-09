'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { copyFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { probeLaunchers } = require('../ci/launcher-transport.cjs');
const { COMPLETION_FILE, RUNTIME_PLATFORM, readRuntimeDefinition, snapshotDependencies } = require('../scripts/_runtime.cjs');

async function withRuntime(behavior, run) {
  const fixture = mkdtempSync(join(tmpdir(), 'launcher-transport-test-'));
  try {
    const root = join(fixture, 'plugin');
    const dataDir = join(fixture, 'runtime');
    mkdirSync(root);
    mkdirSync(join(dataDir, 'node_modules', '@manifest-network', 'manifest-mcp-node'), { recursive: true });
    mkdirSync(join(dataDir, 'node_modules', '@cosmjs', 'proto-signing'), { recursive: true });
    mkdirSync(join(dataDir, 'node_modules', '.bin'));
    mkdirSync(join(root, 'scripts'));
    for (const name of ['start-server.cjs', '_runtime.cjs', '_io.cjs']) {
      copyFileSync(resolve(__dirname, '..', 'scripts', name), join(root, 'scripts', name));
    }
    const dependencies = { '@manifest-network/manifest-mcp-node': 'test-version' };
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies }));
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
      '': { dependencies }, 'node_modules/@manifest-network/manifest-mcp-node': { version: 'test-version' },
    } }));
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { 'manifest-chain': {} } }));
    writeFileSync(join(dataDir, 'node_modules', '@manifest-network', 'manifest-mcp-node', 'package.json'),
      JSON.stringify({ version: 'test-version' }));
    // The actual transport CI check uses installed CosmJS for serialization.
    // Unit fixtures skip that expensive operation while checking that only
    // public test credentials are used.
    writeFileSync(join(dataDir, 'node_modules', '@cosmjs', 'proto-signing', 'index.js'), `
      exports.DirectSecp256k1HdWallet = {
        fromMnemonic: async (mnemonic) => {
          if (mnemonic !== 'abandon '.repeat(11) + 'about') throw new Error('Non-fixture wallet');
          return { serialize: async (password) => {
            if (password !== 'manifest-launcher-public-fixture') throw new Error('Expected public fixture password');
            return '{}';
          } };
        },
      };
    `);
    writeFileSync(join(dataDir, 'node_modules', '.bin', 'manifest-mcp-chain'), `#!/usr/bin/env node
      'use strict';
      const assert = require('node:assert/strict');
      const { existsSync } = require('node:fs');
      const { createInterface } = require('node:readline');
      assert.equal(process.env.COSMOS_CHAIN_ID, 'manifest-launcher-test');
      assert.equal(process.env.COSMOS_MNEMONIC, undefined);
      assert.equal(process.env.MANIFEST_KEY_PASSWORD, 'manifest-launcher-public-fixture');
      assert.equal(process.env.DOTENV_CONFIG_QUIET, 'true');
      assert.equal(process.env.MANIFEST_FAUCET_URL, undefined);
      assert.equal(existsSync('.env'), false);
      assert.equal(existsSync(process.env.MANIFEST_KEY_FILE), true);
      const behavior = ${JSON.stringify(behavior)};
      if (behavior === 'noise') console.log('dotenv noise');
      const send = (id, result) => console.log(JSON.stringify({ jsonrpc: '2.0', id, result }));
      createInterface({ input: process.stdin }).on('line', (line) => {
        const message = JSON.parse(line);
        if (message.method === 'initialize') send(message.id, { capabilities: { tools: {} } });
        if (message.method === 'tools/list') {
          if (behavior === 'network') require('node:net').connect(1, '127.0.0.1');
          else send(message.id, { tools: [{ name: behavior === 'faucet' ? 'request_faucet' : 'read_only_tool' }] });
        }
      });
    `, { mode: 0o755 });
    // Runtime validation always checks all installed server binaries even
    // though this focused transport fixture advertises just the chain server.
    for (const server of ['lease', 'fred', 'cosmwasm', 'agent']) {
      copyFileSync(join(dataDir, 'node_modules', '.bin', 'manifest-mcp-chain'),
        join(dataDir, 'node_modules', '.bin', `manifest-mcp-${server}`));
    }
    const definition = readRuntimeDefinition(root);
    copyFileSync(join(root, 'package.json'), join(dataDir, 'package.json'));
    copyFileSync(join(root, 'package-lock.json'), join(dataDir, 'package-lock.json'));
    writeFileSync(join(dataDir, COMPLETION_FILE), JSON.stringify({
      schema: 1, fingerprint: definition.fingerprint, runtime: RUNTIME_PLATFORM,
      files: snapshotDependencies(dataDir),
    }));
    await run({ dataDir, root, timeoutMs: 5000 });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

test('launcher transport exercises the actual wrapper with stale environment and a configured fixture wallet', async () => {
  const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith('manifest-launcher-transport-')));
  await withRuntime('normal', async (options) => {
    const inventory = await probeLaunchers(options);
    assert.deepEqual(inventory, [{ serverName: 'manifest-chain', tools: [{ name: 'read_only_tool' }] }]);
  });
  const after = readdirSync(tmpdir()).filter((name) => name.startsWith('manifest-launcher-transport-') && !before.has(name));
  assert.deepEqual(after, [], 'transport fixture must remove its temporary wallet/config tree');
});

test('launcher transport rejects non-JSON stdout through the wrapper', async () => {
  await withRuntime('noise', async (options) => {
    await assert.rejects(probeLaunchers(options), /manifest-chain launcher:/);
  });
});

test('launcher transport denies attempted network access by the spawned MCP child', async () => {
  await withRuntime('network', async (options) => {
    await assert.rejects(probeLaunchers(options), /attempted network access/);
  });
});

test('launcher transport rejects a faucet leaking into the mainnet fixture inventory', async () => {
  await withRuntime('faucet', async (options) => {
    await assert.rejects(probeLaunchers(options), /inherited an unconfigured faucet/);
  });
});
