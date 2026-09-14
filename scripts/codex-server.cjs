#!/usr/bin/env node
'use strict';

// Native Codex has no Claude SessionStart/environment-file dependency.
// Every server can race through the same locked, deterministic setup command.
const { resolveHost } = require('./_host.cjs');
const { setupRuntime } = require('./setup-runtime.cjs');
const { createBridge } = require('./_mcp-bridge.cjs');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { constants: { signals } } = require('node:os');

function packagedAssets(pluginRoot, server) {
  try {
    const mutations = JSON.parse(readFileSync(join(pluginRoot, 'mcp-policy.json'), 'utf8'));
    const instructions = readFileSync(join(pluginRoot, 'references', 'runtime-policy.md'), 'utf8');
    const config = JSON.parse(readFileSync(join(pluginRoot, '.mcp.json'), 'utf8'));
    const startupMs = config.mcpServers?.[`manifest-${server}`]?.startup_timeout_sec * 1000;
    if (!Array.isArray(mutations[server]) || !mutations[server].length
      || !mutations[server].every((name) => typeof name === 'string' && /^[a-z_]+$/.test(name))
      || !instructions.trim() || !Number.isFinite(startupMs) || startupMs <= 10000) throw new Error('Invalid package');
    // Leave ten seconds of the host's startup budget for launching the server
    // after another process finishes the shared install.
    return { mutations: mutations[server], instructions: server === 'agent' ? instructions : '',
      lockOptions: { timeoutMs: startupMs - 10000 } };
  } catch {
    throw new Error('Codex package assets are missing or invalid; rebuild with npm run build:codex and launch the generated package, or reinstall the Codex plugin.');
  }
}

async function main() {
  const server = process.argv[2];
  if (process.argv.length !== 3 || !['chain', 'lease', 'fred', 'cosmwasm', 'agent'].includes(server)) {
    throw new Error('Usage: node codex-server.cjs <chain|lease|fred|cosmwasm|agent>');
  }
  const host = resolveHost('codex');
  const { mutations, instructions, lockOptions } = packagedAssets(host.pluginRoot, server);
  Object.assign(process.env, host.env);
  await setupRuntime({ ...host, lockOptions });
  const child = spawn(process.execPath, [join(__dirname, 'start-server.cjs'), server], {
    env: process.env, stdio: ['pipe', 'pipe', 'inherit'],
  });
  const send = (stream, message) => stream.write(`${JSON.stringify(message)}\n`);
  const bridge = createBridge({ serverName: server, mutations, instructions,
    sendClient: (message) => send(process.stdout, message),
    sendServer: (message) => send(child.stdin, message),
  });
  let failed = false;
  const fail = () => {
    if (failed) return;
    failed = true;
    console.error('manifest-agent (Codex): MCP transport interrupted. An in-flight operation may have an unknown outcome; diagnose its existing lease before retrying.');
    bridge.close();
    child.kill('SIGTERM');
  };
  const client = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const upstream = createInterface({ input: child.stdout, crlfDelay: Infinity });
  client.on('line', (line) => { try { bridge.fromClient(JSON.parse(line)); } catch { fail(); } });
  upstream.on('line', (line) => { try { bridge.fromServer(JSON.parse(line)); } catch { fail(); } });
  client.on('close', () => { bridge.close(); child.stdin.end(); child.kill('SIGTERM'); });
  process.stdout.on('error', fail);
  child.stdout.on('error', fail);
  child.stdin.on('error', fail);
  child.on('error', fail);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {
    bridge.close();
    child.kill(signal);
  });
  child.on('close', (code, signal) => {
    bridge.close();
    client.close();
    process.stdin.destroy();
    // Let stdout drain: an upstream server may exit immediately after writing
    // a response larger than the pipe buffer while the host is still reading.
    process.exitCode = failed ? 1 : signal ? 128 + (signals[signal] || 1) : code ?? 1;
  });
}

if (require.main === module) main().catch((error) => {
  console.error(`manifest-agent (Codex): ${error.message}`);
  process.exitCode = 1;
});
module.exports = { main, packagedAssets };
