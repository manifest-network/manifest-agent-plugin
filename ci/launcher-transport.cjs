#!/usr/bin/env node
'use strict';

// Exercise the shipped start-server.cjs wrapper against the installed package.
// Like mcp-tool-policy, this sends only initialize and tools/list. Both wrapper
// and child are protected by the network-denying preload. The wallet is a
// public BIP39 test vector, encrypted with a public fixture password.
const { copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { listTools, NETWORK_GUARD } = require('./mcp-tool-policy.cjs');
const { COMPLETION_FILE } = require('../scripts/_runtime.cjs');

const PUBLIC_TEST_MNEMONIC = `${'abandon '.repeat(11)}about`;
const PUBLIC_TEST_PASSWORD = 'manifest-launcher-public-fixture';

async function probeLaunchers({ dataDir, root = resolve(__dirname, '..'), timeoutMs = 20000 }) {
  const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
  const packageName = '@manifest-network/manifest-mcp-node';
  const expectedVersion = readJson(join(root, 'package.json')).dependencies[packageName];
  const installed = readJson(join(dataDir, 'node_modules', packageName, 'package.json'));
  if (installed.version !== expectedVersion) {
    throw new Error(`Installed ${packageName}@${installed.version} does not match package.json pin ${expectedVersion}`);
  }
  const servers = Object.keys(readJson(join(root, '.mcp.json')).mcpServers);
  const cwd = mkdtempSync(join(tmpdir(), 'manifest-launcher-transport-'));
  const inventory = [];
  try {
    symlinkSync(join(dataDir, 'node_modules'), join(cwd, 'node_modules'), 'dir');
    // Preserve the setup helper's real completion record. It describes paths
    // within node_modules, which remain identical through this directory link.
    // A missing or outdated record must fail the same launcher preflight users
    // receive; this probe never pretends an unverified install is ready.
    for (const file of ['package.json', 'package-lock.json', COMPLETION_FILE]) {
      copyFileSync(join(dataDir, file), join(cwd, file));
    }
    const { DirectSecp256k1HdWallet } = require(join(dataDir, 'node_modules', '@cosmjs', 'proto-signing'));
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(PUBLIC_TEST_MNEMONIC, { prefix: 'manifest' });
    const keyFile = join(cwd, 'public-test-wallet.json');
    writeFileSync(keyFile, await wallet.serialize(PUBLIC_TEST_PASSWORD), { mode: 0o600 });
    writeFileSync(join(cwd, 'config.json'), JSON.stringify({
      activeChain: 'mainnet', gasPrice: '0.025umfx',
      chains: { mainnet: {
        chainId: 'manifest-launcher-test', rpcUrl: 'http://127.0.0.1:1',
        // CosmWasm requires a converter even for tools/list. This valid
        // placeholder is never queried because the probe denies networking.
        converterAddress: 'manifest1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqjpzgn4',
      } },
      agent: { keyFile, keyPassword: PUBLIC_TEST_PASSWORD },
    }), { mode: 0o600 });
    // With an inherited cwd, dotenv would restore these absent fields. The
    // faucet must remain unavailable when the selected config omits it, and
    // the wrong mnemonic must never replace the configured wallet.
    writeFileSync(join(cwd, '.env'), [
      'COSMOS_MNEMONIC=invalid inherited mnemonic',
      'MANIFEST_FAUCET_URL=http://127.0.0.1:1',
      'MANIFEST_CONVERTER_ADDRESS=invalid-inherited-converter',
    ].join('\n'), { mode: 0o600 });
    const guardPath = join(cwd, 'deny-network.cjs');
    writeFileSync(guardPath, NETWORK_GUARD, { mode: 0o600 });
    for (const serverName of servers) {
      const match = /^manifest-([a-z0-9-]+)$/.exec(serverName);
      if (!match) throw new Error(`Unrecognized server name: ${serverName}`);
      const wrapper = join(root, 'scripts', 'start-server.cjs');
      const runnerPath = join(cwd, `launch-${match[1]}.cjs`);
      // listTools intentionally passes a minimal environment. This runner
      // configures only fixture paths and harmless stale values, then invokes
      // the real wrapper. NODE_OPTIONS carries the guard into its MCP child.
      writeFileSync(runnerPath, [
        "'use strict';",
        `process.env.MANIFEST_PLUGIN_DATA = ${JSON.stringify(cwd)};`,
        `process.env.NODE_OPTIONS = ${JSON.stringify(`--require ${JSON.stringify(guardPath)}`)};`,
        "process.env.DOTENV_CONFIG_QUIET = 'false';",
        "process.env.COSMOS_MNEMONIC = 'invalid inherited mnemonic';",
        `process.argv = [process.execPath, ${JSON.stringify(wrapper)}, ${JSON.stringify(match[1])}];`,
        `require(${JSON.stringify(wrapper)});`,
      ].join('\n'), { mode: 0o600 });
      let tools;
      try {
        tools = await listTools({ binaryPath: runnerPath, cwd, guardPath, timeoutMs });
      } catch (error) {
        throw new Error(`${serverName} launcher: ${error.message}`);
      }
      if (serverName === 'manifest-chain' && tools.some((tool) => tool.name === 'request_faucet')) {
        throw new Error('manifest-chain launcher inherited an unconfigured faucet');
      }
      inventory.push({ serverName, tools });
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  return inventory;
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 0 && (argv.length !== 2 || argv[0] !== '--data-dir')) {
    throw new Error('Usage: node ci/launcher-transport.cjs [--data-dir <dependency-install-directory>]');
  }
  const dataDir = argv.length ? resolve(argv[1]) : resolve(__dirname, '..');
  const inventory = await probeLaunchers({ dataDir });
  console.log(`launcher-transport: OK — ${inventory.length} installed servers initialized through the shipped launcher; JSON-RPC stdout only, no network calls`);
}

if (require.main === module) main().catch((error) => {
  console.error(`launcher-transport: ${error.message}`);
  process.exitCode = 1;
});

module.exports = { probeLaunchers };
