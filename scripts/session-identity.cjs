#!/usr/bin/env node
'use strict';

// Manual diagnostics belong on stderr. The explicit --hook-report mode emits
// Claude's structured context/user message, using only validated public fields.
// Query the pinned chain server through the normal launcher so wallet selection,
// credential migration, and runtime validation stay shared.
const { readFileSync } = require('node:fs');
const { join, win32 } = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 65536;
const TERMINATION_GRACE_MS = 150;
const WINDOWS_TERMINATION_TIMEOUT_MS = 500;

function terminateProcessTree(child, signal, { platform = process.platform,
  systemRoot = process.env.SystemRoot || 'C:\\Windows', run = spawnSync,
  kill = process.kill } = {}) {
  if (!child?.pid) return;
  try {
    if (platform === 'win32') {
      // Windows Node kills the wrapper immediately on SIGTERM, before its
      // forwarding handler can retire the MCP child. taskkill owns the tree;
      // use the system executable directly, with no shell or PATH lookup.
      const root = win32.isAbsolute(systemRoot) && !systemRoot.includes('\0') ? systemRoot : 'C:\\Windows';
      const result = run(win32.join(root, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true, timeout: WINDOWS_TERMINATION_TIMEOUT_MS, killSignal: 'SIGKILL',
      });
      if (result.error || result.status !== 0) child.kill('SIGKILL');
    } else kill(-child.pid, signal);
  } catch { /* already exited or process cleanup is unavailable */ }
}

function parseGasPrice(value) {
  if (typeof value !== 'string' || value.length > 256) throw new Error('Invalid gas price');
  // Scientific notation is not a decimal gas price. Avoid interpreting its
  // exponent as the beginning of an unrelated denom (e.g. "e-6umfx").
  if (/^\d+(?:\.\d+)?[eE][+-]?\d/.test(value)) throw new Error('Invalid gas price');
  const match = /^(\d+)(?:\.(\d+))?([a-zA-Z][a-zA-Z0-9/:._-]{2,127})$/.exec(value);
  if (!match) throw new Error('Invalid gas price');
  const fraction = match[2] || '';
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(match[1] + fraction) * 200000n * 2n;
  return { denom: match[3], threshold: (numerator + denominator - 1n) / denominator };
}

function readIdentity(dataDir) {
  let raw;
  try { raw = readFileSync(join(dataDir, 'config.json'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (raw.length > 1024 * 1024) throw new Error('Invalid config');
  const config = JSON.parse(raw);
  const activeChain = config?.activeChain;
  const chainId = config?.chains?.[activeChain]?.chainId;
  const address = config?.agent?.address;
  // Only these validated public fields can be printed. Never serialize the
  // config, credential references, RPC URLs, or a caught error/stack.
  if (!['mainnet', 'testnet'].includes(activeChain)
    || typeof chainId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(chainId)
    || typeof address !== 'string' || !/^manifest1[a-z0-9]{6,83}$/.test(address)) {
    throw new Error('Invalid identity');
  }
  return { address, activeChain, chainId, ...parseGasPrice(config.gasPrice) };
}

function parseBalance(result, denom) {
  if (!result || result.isError || !Array.isArray(result.content)
    || result.content.length !== 1 || result.content[0]?.type !== 'text'
    || typeof result.content[0].text !== 'string') throw new Error('Invalid balance response');
  // manifest-mcp-chain@0.22.0 cosmos_query uses jsonResponse(cosmosQuery(...)):
  // {module, subcommand, result: {balance: {denom, amount}}} in one text block.
  const payload = JSON.parse(result.content[0].text);
  const balance = payload?.result?.balance;
  if (payload?.module !== 'bank' || payload?.subcommand !== 'balance'
    || balance?.denom !== denom || typeof balance.amount !== 'string'
    || !/^\d{1,100}$/.test(balance.amount)) throw new Error('Invalid balance response');
  return BigInt(balance.amount);
}

function queryBalance({ address, denom, dataDir, launcherPath, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    let finished = false;
    let buffer = '';
    let receivedBytes = 0;
    let initialized = false;
    let closed = false;
    let deadline;
    const grouped = process.platform !== 'win32';
    let windowsTreeStopped = false;
    const signal = (name) => {
      if (!grouped && windowsTreeStopped) return;
      terminateProcessTree(child, name);
      if (!grouped) windowsTreeStopped = true;
    };
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      if (!child?.pid) { resolve(value); return; }
      // The launcher owns an MCP descendant. Kill their private process group
      // so connection retries cannot outlive this bounded, read-only probe.
      // Keep stdin open until shutdown. Pinned bootstrap treats EOF as a
      // non-exiting shutdown and removes its SIGTERM handler; closing stdin
      // first can swallow TERM while a hung RPC keeps the server alive.
      const release = () => {
        child.stdin.destroy();
        child.stdout.destroy();
        resolve(value);
      };
      if (closed || child.exitCode !== null || child.signalCode !== null) {
        signal('SIGTERM');
        signal('SIGKILL');
        release();
        return;
      }
      let force;
      let retry;
      child.once('close', () => {
        clearTimeout(retry);
        clearTimeout(force);
        signal('SIGKILL'); // also retire any remaining descendant
        release();
      });
      signal('SIGTERM');
      retry = setTimeout(() => {
        signal('SIGTERM');
        force = setTimeout(() => { signal('SIGKILL'); release(); }, TERMINATION_GRACE_MS);
      }, TERMINATION_GRACE_MS);
    };
    const fail = (error) => finish({ error, stage: initialized ? 'query' : 'startup' });
    const send = (message) => {
      if (!finished) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    };
    try {
      child = spawn(process.execPath, [launcherPath, 'chain'], {
        env: { ...process.env, MANIFEST_PLUGIN_DATA: dataDir },
        detached: grouped, stdio: ['pipe', 'pipe', 'ignore'],
      });
      deadline = setTimeout(() => fail('timed out'), timeoutMs);
      child.on('error', () => fail('unavailable'));
      child.on('close', () => {
        closed = true;
        fail('unavailable');
      });
      child.stdin.on('error', () => fail('unavailable'));
      child.stdout.on('error', () => fail('unavailable'));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        if (finished) return;
        receivedBytes += Buffer.byteLength(chunk);
        if (receivedBytes > MAX_RESPONSE_BYTES) { fail('invalid response'); return; }
        buffer += chunk;
        let newline;
        while (!finished && (newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          try {
            const message = JSON.parse(line);
            if (!message || message.jsonrpc !== '2.0') throw new Error('Invalid protocol');
            if (message.method && message.id === undefined) continue; // bounded notifications
            if (!initialized && message.id === 1 && !message.error && message.result?.capabilities?.tools) {
              initialized = true;
              send({ method: 'notifications/initialized' });
              send({ id: 2, method: 'tools/call', params: {
                name: 'cosmos_query', arguments: { module: 'bank', subcommand: 'balance', args: [address, denom] },
              } });
            } else if (initialized && message.id === 2 && !message.error) {
              finish({ amount: parseBalance(message.result, denom) });
            } else fail('unavailable');
          } catch { fail('invalid response'); }
        }
      });
      send({ id: 1, method: 'initialize', params: {
        protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'manifest-session-identity', version: '1.0.0' },
      } });
    } catch { fail('unavailable'); }
  });
}

async function reportSessionIdentity({ dataDir = process.env.MANIFEST_PLUGIN_DATA,
  timeoutMs = DEFAULT_TIMEOUT_MS, launcherPath = join(__dirname, 'start-server.cjs'),
  stderr = process.stderr } = {}) {
  const print = (line) => stderr.write(`manifest-agent: ${line}\n`);
  if (!dataDir) return;
  let identity;
  try { identity = readIdentity(dataDir); }
  catch { print('Session identity unavailable; check the public identity and gas settings in config.json.'); return; }
  if (!identity) return; // First session: init-agent still needs to create config.
  print(`Agent address: ${identity.address}`);
  print(`Active chain: ${identity.activeChain} (${identity.chainId})`);
  print(`Gas denom: ${identity.denom}`);
  const boundedTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.min(timeoutMs, DEFAULT_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  const result = await queryBalance({ ...identity, dataDir, launcherPath, timeoutMs: boundedTimeout });
  if (result.error) {
    if (result.stage === 'startup') {
      print(`Gas-token balance unavailable (launcher initialization ${result.error}); check runtime setup and wallet credential access, then retry. The chain query did not start.`);
    } else {
      print(`Gas-token balance unavailable (${result.error}); retry the balance check when the chain server is reachable.`);
    }
    return;
  }
  print(`Gas-token balance: ${result.amount} ${identity.denom}`);
  if (identity.activeChain === 'testnet' && (result.amount === 0n || result.amount < identity.threshold)) {
    print(`Low testnet gas balance (target for two typical transactions: ${identity.threshold} ${identity.denom}). Ask to fund this wallet using request_faucet; refresh the registry if that tool is unavailable.`);
  }
}

const REPORT_UNAVAILABLE = 'manifest-agent: Session balance check unavailable.';
const MIGRATION_FAILED = 'manifest-agent: Credential migration failed; wallet startup is blocked. Unlock the OS credential store, then run node "$MANIFEST_PLUGIN_ROOT/scripts/migrate-credentials.cjs" and reconnect the MCP servers. For headless setup, explicitly choose MANIFEST_CREDENTIAL_STORE=file and rerun migration; this stores the password in a private local file.';

async function reportHook({ policy, skipProbe = false, migrationFailed = false,
  stdout = process.stdout, ...identityOptions }) {
  const lines = [];
  if (migrationFailed) lines.push(MIGRATION_FAILED);
  else if (!skipProbe) {
    try {
      await reportSessionIdentity({ ...identityOptions, stderr: { write: (line) => lines.push(line.trimEnd()) } });
    } catch { lines.push(REPORT_UNAVAILABLE); }
  }
  const message = lines.join('\n');
  let context = policy.trimEnd();
  if (message) {
    // Claude caps each output string at 10k characters. Preserve the complete
    // policy and prioritize balance/faucet advice over repeated identity labels
    // for unusually long but valid public fields. The user gets every line.
    const selected = [];
    for (const line of [...lines].reverse()) {
      if (context.length + selected.join('\n').length + line.length + 3 <= 10000) selected.unshift(line);
    }
    if (selected.length) context += `\n\n${selected.join('\n')}`;
  }
  stdout.write(`${JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
    ...(message ? { systemMessage: message } : {}),
  })}\n`);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0) reportSessionIdentity().catch(() => console.error(REPORT_UNAVAILABLE));
  else if (args[0] === '--hook-report' && (args.length === 1
    || (args.length === 2 && ['--skip-probe', '--migration-failed'].includes(args[1])))) {
    reportHook({ policy: readFileSync(0, 'utf8'), skipProbe: args[1] === '--skip-probe',
      migrationFailed: args[1] === '--migration-failed' });
  } else {
    console.error('Usage: node session-identity.cjs [--hook-report [--skip-probe|--migration-failed]]');
    process.exitCode = 1;
  }
}

module.exports = { reportSessionIdentity, reportHook, parseGasPrice, parseBalance, terminateProcessTree, DEFAULT_TIMEOUT_MS };
