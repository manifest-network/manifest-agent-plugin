#!/usr/bin/env node
'use strict';

// Compare the installed, pinned servers' actual tools/list response with the
// Claude plugin hook matcher. This probe never sends tools/call. An isolated
// environment and a network-denying preload keep discovery off the chain.
const { spawn } = require('node:child_process');
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const PACKAGE = '@manifest-network/manifest-mcp-node';
const FAUCET = 'manifest-chain/request_faucet';
const NETWORK_GUARD = `
'use strict';
const deny = () => {
  process.stderr.write('Metadata probe attempted network access; refusing.\\n');
  process.exit(97);
};
require('node:net').Socket.prototype.connect = deny;
const dns = require('node:dns');
for (const key of Object.keys(dns)) {
  if (key === 'lookup' || key.startsWith('resolve')) dns[key] = deny;
}
for (const key of Object.keys(dns.promises)) {
  if (key === 'lookup' || key.startsWith('resolve')) dns.promises[key] = deny;
}
globalThis.fetch = deny;
`;

function scopedName(pluginName, serverName, toolName) {
  return `mcp__plugin_${pluginName}_${serverName}__${toolName}`;
}

function matcherNames(hooksJson) {
  const entries = hooksJson?.hooks?.PreToolUse;
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('No PreToolUse matchers');
  const names = [];
  for (const entry of entries) {
    if (typeof entry.matcher !== 'string') throw new Error('Missing PreToolUse matcher');
    for (const alternative of entry.matcher.split('|')) {
      // Literal, individually anchored alternatives cannot accidentally match
      // a read-only sibling, another plugin, or a new tool sharing a prefix.
      if (!/^\^mcp__[A-Za-z0-9_-]+\$$/.test(alternative)) {
        throw new Error(`Expected exact anchored tool name: ${alternative}`);
      }
      names.push(alternative.slice(1, -1));
    }
  }
  if (new Set(names).size !== names.length) throw new Error('Duplicate PreToolUse matcher names');
  return new Set(names);
}

function checkToolPolicy({ pluginName, inventory, hooksJson }) {
  const gated = matcherNames(hooksJson);
  const failures = [];
  const observed = new Set();
  let mutations = 0;
  let faucetSeen = false;
  if (!Array.isArray(inventory) || inventory.length === 0) throw new Error('Empty server inventory');
  for (const { serverName, tools } of inventory) {
    if (!Array.isArray(tools) || tools.length === 0) {
      failures.push(`${serverName}: empty tools/list response`);
      continue;
    }
    for (const tool of tools) {
      if (typeof tool.name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(tool.name)) {
        failures.push(`${serverName}: invalid tool name`);
        continue;
      }
      const name = scopedName(pluginName, serverName, tool.name);
      if (observed.has(name)) failures.push(`${name}: duplicate tool descriptor`);
      observed.add(name);
      const annotations = tool.annotations;
      const meta = tool._meta?.manifest;
      if (typeof annotations?.title !== 'string' || annotations.title.trim() === '') {
        failures.push(`${name}: missing annotation title`);
      }
      for (const field of ['readOnlyHint', 'idempotentHint', 'openWorldHint']) {
        if (typeof annotations?.[field] !== 'boolean') failures.push(`${name}: missing boolean ${field}`);
      }
      if (annotations?.readOnlyHint === false && typeof annotations.destructiveHint !== 'boolean') {
        failures.push(`${name}: mutation missing boolean destructiveHint`);
      }
      if (meta?.v !== 1 || typeof meta.broadcasts !== 'boolean' || typeof meta.estimable !== 'boolean') {
        failures.push(`${name}: missing or unsupported _meta.manifest`);
      }
      if (annotations?.readOnlyHint === true && (meta?.broadcasts === true || annotations.destructiveHint === true)) {
        failures.push(`${name}: read-only annotation contradicts mutation metadata`);
      }
      const isFaucet = `${serverName}/${tool.name}` === FAUCET;
      if (isFaucet) {
        faucetSeen = true;
        // An explicit product exception: the optional testnet faucet requests
        // operator-funded credit; it neither signs nor spends this wallet.
        if (annotations?.readOnlyHint !== false || annotations?.destructiveHint !== false
          || meta?.broadcasts !== false || meta?.estimable !== false) {
          failures.push(`${name}: faucet exception no longer matches its reviewed metadata`);
        }
      }
      const mutates = annotations?.readOnlyHint !== true || meta?.broadcasts === true;
      const shouldGate = mutates && !isFaucet;
      if (shouldGate) mutations++;
      if (gated.has(name) !== shouldGate) {
        failures.push(`${name}: ${shouldGate ? 'mutation is not gated' : 'read-only tool or faucet is unexpectedly gated'}`);
      }
    }
  }
  if (!faucetSeen) failures.push('Optional faucet was not advertised; discovery must enable MANIFEST_FAUCET_URL');
  for (const name of gated) {
    if (!observed.has(name)) failures.push(`${name}: matcher has no tool in the installed inventory`);
  }
  return { ok: failures.length === 0, failures, tools: observed.size, mutations };
}

function probeEnvironment(cwd) {
  // Deliberately do not inherit real wallet credentials, proxy settings,
  // NODE_OPTIONS, or the user's dotenv files. This standard public BIP39 test
  // vector is used only to satisfy the binaries' local wallet bootstrap.
  return {
    PATH: process.env.PATH || '',
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    COSMOS_CHAIN_ID: 'manifest-policy-test',
    COSMOS_RPC_URL: 'http://127.0.0.1:1',
    COSMOS_GAS_PRICE: '0.025umfx',
    COSMOS_ADDRESS_PREFIX: 'manifest',
    COSMOS_MNEMONIC: `${'abandon '.repeat(11)}about`,
    MANIFEST_KEY_FILE: join(cwd, 'no-wallet.json'),
    MANIFEST_FAUCET_URL: 'http://127.0.0.1:1',
    MANIFEST_CONVERTER_ADDRESS: 'manifest1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqjpzgn4',
    DOTENV_CONFIG_QUIET: 'true',
    LOG_LEVEL: 'silent',
  };
}

function listTools({ binaryPath, cwd, guardPath, timeoutMs = 20000 }) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ['--require', guardPath, binaryPath], {
      cwd, env: probeEnvironment(cwd), stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    let bytes = 0;
    let nextId = 1;
    let requestId;
    let phase = 'initialize';
    let result;
    let failure;
    let completed = false;
    const tools = [];
    const cursors = new Set();
    const deadline = setTimeout(() => stop(new Error('MCP metadata discovery timed out')), timeoutMs);
    let killTimer;
    const finish = () => {
      if (completed) return;
      completed = true;
      clearTimeout(deadline);
      clearTimeout(killTimer);
      if (failure) reject(failure);
      else if (result) resolveResult(result);
      else reject(new Error('MCP server exited before tools/list completed'));
    };
    function stop(error) {
      if (error && !failure) failure = error;
      child.stdin.end();
      child.kill('SIGTERM');
      if (!killTimer) killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
    }
    function send(method, params, notification = false) {
      const message = { jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) };
      if (!notification) message.id = requestId = nextId++;
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
    child.on('error', (error) => { failure = error; finish(); });
    child.on('close', (code) => {
      // A complete inventory triggers our SIGTERM cleanup. The server may
      // report a nonzero shutdown status without invalidating that response.
      if (code && !failure && !result) failure = new Error(`MCP metadata server exited with code ${code}`);
      finish();
    });
    child.stdin.on('error', (error) => stop(error));
    // Startup diagnostics are intentionally drained without echoing any
    // environment-derived data; errors report the server and exit status.
    child.stderr.resume();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (failure || result) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 8 * 1024 * 1024) { stop(new Error('MCP metadata output exceeds 8 MiB')); return; }
      buffer += chunk;
      while (buffer.includes('\n') && !failure && !result) {
        const end = buffer.indexOf('\n');
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.method) {
            if (message.id !== undefined) throw new Error('MCP server requested an operation during metadata discovery');
            continue;
          }
          if (message.id !== requestId) throw new Error('Unexpected MCP response identifier');
          if (message.error) throw new Error('MCP metadata request failed');
          if (phase === 'initialize') {
            if (!message.result?.capabilities?.tools) throw new Error('Server does not advertise tools capability');
            send('notifications/initialized', undefined, true);
            phase = 'list';
            send('tools/list', {});
          } else {
            if (!Array.isArray(message.result?.tools)) throw new Error('Invalid tools/list result');
            tools.push(...message.result.tools);
            const cursor = message.result.nextCursor;
            if (cursor !== undefined) {
              if (typeof cursor !== 'string' || cursors.has(cursor) || cursors.size >= 100) {
                throw new Error('Invalid or repeated tools/list pagination cursor');
              }
              cursors.add(cursor);
              send('tools/list', { cursor });
            } else {
              result = tools;
              stop();
            }
          }
        } catch (error) { stop(error); }
      }
    });
    send('initialize', {
      protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'manifest-plugin-policy-check', version: '1.0.0' },
    });
  });
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 0 && (argv.length !== 2 || argv[0] !== '--data-dir')) {
    throw new Error('Usage: node ci/mcp-tool-policy.cjs [--data-dir <dependency-install-directory>]');
  }
  const root = resolve(__dirname, '..');
  const dataDir = argv.length ? resolve(argv[1]) : root;
  const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
  const expectedVersion = readJson(join(root, 'package.json')).dependencies[PACKAGE];
  const installed = readJson(join(dataDir, 'node_modules', PACKAGE, 'package.json'));
  if (installed.version !== expectedVersion) {
    throw new Error(`Installed ${PACKAGE}@${installed.version} does not match package.json pin ${expectedVersion}`);
  }
  const pluginName = readJson(join(root, '.claude-plugin', 'plugin.json')).name;
  const servers = Object.keys(readJson(join(root, '.mcp.json')).mcpServers);
  const cwd = mkdtempSync(join(tmpdir(), 'manifest-mcp-policy-'));
  const inventory = [];
  try {
    const guardPath = join(cwd, 'deny-network.cjs');
    writeFileSync(guardPath, NETWORK_GUARD, { mode: 0o600 });
    for (const serverName of servers) {
      const match = serverName.match(/^manifest-([a-z0-9-]+)$/);
      if (!match) throw new Error(`Unrecognized server name: ${serverName}`);
      const binaryPath = join(dataDir, 'node_modules', '.bin', `manifest-mcp-${match[1]}`);
      if (!existsSync(binaryPath)) throw new Error(`Installed MCP binary missing for ${serverName}`);
      try {
        inventory.push({ serverName, tools: await listTools({ binaryPath, cwd, guardPath }) });
      } catch (error) { throw new Error(`${serverName}: ${error.message}`); }
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
  const verdict = checkToolPolicy({
    pluginName, inventory, hooksJson: readJson(join(root, 'hooks', 'hooks.json')),
  });
  if (!verdict.ok) throw new Error(verdict.failures.join('\n'));
  console.log(`mcp-tool-policy: OK — ${servers.length} installed servers, ${verdict.tools} tools, ${verdict.mutations} gated mutations (${PACKAGE}@${installed.version})`);
}

if (require.main === module) main().catch((error) => {
  console.error(`mcp-tool-policy: ${error.message}`);
  process.exitCode = 1;
});

module.exports = { checkToolPolicy, listTools, matcherNames, probeEnvironment, scopedName, NETWORK_GUARD };
