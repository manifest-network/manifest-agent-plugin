'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseGasPrice, reportHook, terminateProcessTree, DEFAULT_TIMEOUT_MS } = require('../scripts/session-identity.cjs');

const ADDRESS = 'manifest1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqjpzgn4';
const SECRET = 'SESSION_PASSWORD_DO_NOT_PRINT_abc123';
const MNEMONIC = 'SECRET_MNEMONIC_DO_NOT_PRINT';

function fixture(t, { amount = '10000', gasPrice = '0.025umfx', activeChain = 'testnet',
  behavior = 'normal', payload, noConfig = false, rawConfig, timeoutMs = 1000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'manifest session identity '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const scripts = join(dir, 'scripts');
  const dataDir = join(dir, 'plugin data');
  const calls = join(dir, 'calls.jsonl');
  const pidFile = join(dir, 'probe.pid');
  const scratchDir = join(dir, 'launcher-private-cwd');
  const lifecycleFile = join(dir, 'lifecycle');
  mkdirSync(scripts);
  mkdirSync(dataDir);
  for (const name of ['session-identity.cjs', '_chain-config.cjs']) cpSync(join(__dirname, '../scripts', name), join(scripts, name));
  const config = { activeChain, gasPrice, chains: { [activeChain]: {
    chainId: 'manifest-ledger-test-1', rpcUrl: `https://unused.invalid/${SECRET}`,
    faucetUrl: `https://unused.invalid/${SECRET}`,
  } }, agent: { address: ADDRESS, keyFile: 'key.json', keyPassword: SECRET } };
  if (!noConfig) writeFileSync(join(dataDir, 'config.json'), rawConfig ?? JSON.stringify(config));
  const denom = /^\d+(?:\.\d+)?(.+)$/.exec(gasPrice)?.[1] || 'umfx';
  const response = payload === undefined
    ? { content: [{ type: 'text', text: JSON.stringify({ module: 'bank', subcommand: 'balance',
      result: { balance: { denom, amount } } }) }] } : payload;
  writeFileSync(join(scripts, 'start-server.cjs'), `
    const fs = require('node:fs');
    const readline = require('node:readline');
    const assert = require('node:assert/strict');
    const behavior = ${JSON.stringify(behavior)};
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    assert.equal(process.argv[2], 'chain');
    assert.equal(process.env.MANIFEST_PLUGIN_DATA, ${JSON.stringify(dataDir)});
    console.error(${JSON.stringify(SECRET)});
    console.error(${JSON.stringify(MNEMONIC)});
    if (behavior === 'offline') process.exit(1);
    if (behavior === 'ignore-signals') process.on('SIGTERM', () => {});
    if (behavior === 'eof-race') {
      fs.mkdirSync(${JSON.stringify(scratchDir)});
      process.on('exit', () => fs.rmSync(${JSON.stringify(scratchDir)}, { recursive: true }));
      process.on('SIGTERM', () => {
        fs.appendFileSync(${JSON.stringify(lifecycleFile)}, 'TERM\\n');
        process.exit(0);
      });
      // Model pinned bootstrap's non-exiting EOF shutdown. If stdin closes
      // first, a hung RPC keeps the loop alive after graceful shutdown ends.
      process.stdin.on('end', () => {
        fs.appendFileSync(${JSON.stringify(lifecycleFile)}, 'EOF\\n');
        process.removeAllListeners('SIGTERM');
        process.on('SIGTERM', () => {});
      });
    }
    const send = (id, result) => console.log(JSON.stringify({ jsonrpc: '2.0', id, result }));
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const message = JSON.parse(line);
      fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(message) + '\\n');
      if (message.method === 'initialize' && behavior !== 'initialization-timeout') {
        send(message.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} } });
      }
      if (message.method !== 'tools/call') return;
      assert.deepEqual(message.params, { name: 'cosmos_query', arguments: {
        module: 'bank', subcommand: 'balance', args: [${JSON.stringify(ADDRESS)}, ${JSON.stringify(denom)}],
      } });
      if (['query-timeout', 'ignore-signals', 'eof-race'].includes(behavior)) { setInterval(() => {}, 1000); return; }
      if (behavior === 'malformed-json') { console.log(${JSON.stringify(SECRET)}); return; }
      if (behavior === 'oversized') { console.log('x'.repeat(70000)); return; }
      if (behavior === 'rpc-error') { console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id,
        error: { code: -32603, message: ${JSON.stringify(SECRET)} } })); return; }
      send(message.id, ${JSON.stringify(response)});
    });
  `);
  writeFileSync(join(scripts, 'run.cjs'), `
    require('./session-identity.cjs').reportSessionIdentity({ timeoutMs: ${JSON.stringify(timeoutMs)} });
  `);
  const run = ({ cli = false, env = {}, args = [], input, hook = false } = {}) => {
    const started = Date.now();
    const result = spawnSync(process.execPath, [join(scripts, cli ? 'session-identity.cjs' : 'run.cjs'), ...args], {
      env: { PATH: process.env.PATH, MANIFEST_PLUGIN_DATA: dataDir,
        COSMOS_MNEMONIC: MNEMONIC, MANIFEST_KEY_PASSWORD: SECRET, ...env },
      input, encoding: 'utf8', timeout: DEFAULT_TIMEOUT_MS + 3000,
    });
    assert.equal(result.status, 0, result.stderr);
    if (!hook) assert.equal(result.stdout, '', 'manual identity must never pollute policy or MCP stdout');
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(`${SECRET}|${MNEMONIC}|rpcUrl|keyPassword|keyFile|unused.invalid`));
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'MCP probe must not survive the session report');
    }
    return { ...result, elapsed: Date.now() - started,
      calls: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse) : [] };
  };
  return { run, dataDir, scripts, scratchDir, lifecycleFile, calls };
}

test('CLI prints public identity and current exact gas balance using only a bank MCP query', (t) => {
  const result = fixture(t, { amount: '900719925474099312345678901234567890' }).run({ cli: true });
  assert.match(result.stderr, new RegExp(`Agent address: ${ADDRESS}`));
  assert.match(result.stderr, /Active chain: testnet \(manifest-ledger-test-1\)/);
  assert.match(result.stderr, /Gas denom: umfx/);
  assert.match(result.stderr, /Gas-token balance: 900719925474099312345678901234567890 umfx/);
  assert.doesNotMatch(result.stderr, /request_faucet|Low testnet/);
  assert.deepEqual(result.calls.map((message) => message.method), ['initialize', 'notifications/initialized', 'tools/call']);
  assert.deepEqual(result.calls[2].params, { name: 'cosmos_query', arguments: {
    module: 'bank', subcommand: 'balance', args: [ADDRESS, 'umfx'],
  } });
});

for (const amount of ['0', '9999', '10000', '10001']) {
  test(`testnet ${amount} umfx uses the precise two-transaction threshold boundary`, (t) => {
    const result = fixture(t, { amount }).run();
    assert.match(result.stderr, new RegExp(`Gas-token balance: ${amount} umfx`));
    if (BigInt(amount) < 10000n) {
      assert.match(result.stderr, /target for two typical transactions: 10000 umfx/);
      assert.match(result.stderr, /request_faucet/);
    } else assert.doesNotMatch(result.stderr, /request_faucet|Low testnet/);
    assert.equal(result.calls.filter((message) => message.method === 'tools/call').length, 1);
    assert.equal(result.calls[2].params.name, 'cosmos_query', 'a hint must never invoke a faucet or mutation');
  });
}

test('zero gas price still hints for a zero testnet balance', (t) => {
  const result = fixture(t, { gasPrice: '0umfx', amount: '0' }).run();
  assert.match(result.stderr, /target for two typical transactions: 0 umfx/);
  assert.match(result.stderr, /request_faucet/);
});

test('fractional fee thresholds round upward without floating-point loss', (t) => {
  const gasPrice = '0.00000250000000000000000000001umfx';
  assert.deepEqual(parseGasPrice(gasPrice), { denom: 'umfx', threshold: 2n });
  const result = fixture(t, { gasPrice, amount: '1' }).run();
  assert.match(result.stderr, /target for two typical transactions: 2 umfx/);
  assert.match(result.stderr, /request_faucet/);
});

test('gas threshold remains exact for prices above the safe integer range', () => {
  assert.deepEqual(parseGasPrice('9007199254740993.000001umfx'), {
    denom: 'umfx', threshold: 3602879701896397200001n,
  });
});

test('Windows cleanup invokes the absolute system taskkill to terminate the complete MCP tree', () => {
  const calls = [];
  terminateProcessTree({ pid: 123, kill: () => assert.fail('tree cleanup succeeded') }, 'SIGTERM', {
    platform: 'win32', systemRoot: 'D:\\Windows',
    run: (...args) => { calls.push(args); return { status: 0 }; },
    kill: () => assert.fail('POSIX process groups do not exist on Windows'),
  });
  assert.deepEqual(calls, [['D:\\Windows\\System32\\taskkill.exe', ['/PID', '123', '/T', '/F'], {
    stdio: 'ignore', windowsHide: true, timeout: 500, killSignal: 'SIGKILL',
  }]]);
});

test('Windows cleanup avoids relative executable roots and kills the wrapper if taskkill fails', () => {
  const fallback = [];
  terminateProcessTree({ pid: 456, kill: (signal) => fallback.push(signal) }, 'SIGTERM', {
    platform: 'win32', systemRoot: 'relative', run: (path, args, options) => {
      assert.equal(path, 'C:\\Windows\\System32\\taskkill.exe');
      assert.equal(options.stdio, 'ignore');
      return { status: null, error: new Error(SECRET) };
    },
  });
  assert.deepEqual(fallback, ['SIGKILL']);
});

test('the current gas denom controls the query and balance, including factory tokens', (t) => {
  const denom = `factory/${ADDRESS}/upwr`;
  const result = fixture(t, { gasPrice: `0.1${denom}`, amount: '50000' }).run();
  assert.ok(result.stderr.includes(`Gas-token balance: 50000 ${denom}`));
  assert.equal(result.calls[2].params.arguments.args[1], denom);
  assert.doesNotMatch(result.stderr, /request_faucet/);
});

test('mainnet zero balance never suggests the testnet faucet', (t) => {
  const result = fixture(t, { activeChain: 'mainnet', amount: '0' }).run();
  assert.match(result.stderr, /Active chain: mainnet/);
  assert.match(result.stderr, /Gas-token balance: 0 umfx/);
  assert.doesNotMatch(result.stderr, /request_faucet|Low testnet/);
});

test('uninitialized data silently skips querying', (t) => {
  const result = fixture(t, { noConfig: true }).run({ cli: true });
  assert.equal(result.stderr, '');
  assert.deepEqual(result.calls, []);
});

test('missing host data silently skips querying', (t) => {
  const result = fixture(t).run({ cli: true, env: { MANIFEST_PLUGIN_DATA: '' } });
  assert.equal(result.stderr, '');
  assert.deepEqual(result.calls, []);
});

test('malformed configuration never exposes source text or attempts MCP startup', (t) => {
  const result = fixture(t, { rawConfig: `{"agent":{"keyPassword":"${SECRET}"` }).run();
  assert.match(result.stderr, /Session identity unavailable/);
  assert.deepEqual(result.calls, []);
});

for (const gasPrice of ['-0.1umfx', 'NaNumfx', '1e-6umfx', '0.1umfx\nsecret']) {
  test(`invalid gas price ${JSON.stringify(gasPrice)} safely skips querying`, (t) => {
    const result = fixture(t, { gasPrice }).run();
    assert.match(result.stderr, /Session identity unavailable/);
    assert.deepEqual(result.calls, []);
    assert.doesNotMatch(result.stderr, /request_faucet/);
  });
}

for (const behavior of ['offline', 'rpc-error', 'malformed-json', 'oversized']) {
  test(`${behavior} preserves identity and reports a safe unavailable balance`, (t) => {
    const result = fixture(t, { behavior }).run();
    assert.match(result.stderr, /Agent address: manifest1/);
    assert.match(result.stderr, /Gas-token balance unavailable/);
    if (behavior === 'offline') {
      assert.match(result.stderr, /launcher initialization unavailable/);
      assert.match(result.stderr, /runtime setup and wallet credential access/);
      assert.doesNotMatch(result.stderr, /chain server is reachable/);
    } else assert.doesNotMatch(result.stderr, /launcher initialization/);
    assert.doesNotMatch(result.stderr, /Gas-token balance: 0|request_faucet/);
  });
}

for (const behavior of ['initialization-timeout', 'query-timeout', 'ignore-signals']) {
  test(`${behavior} ends the MCP process within the bounded session budget`, (t) => {
    const result = fixture(t, { behavior, timeoutMs: 200 }).run();
    if (behavior === 'initialization-timeout') {
      assert.match(result.stderr, /Gas-token balance unavailable \(launcher initialization timed out\)/);
      assert.match(result.stderr, /startup exceeded the five-second probe budget/);
      assert.match(result.stderr, /Retry after startup finishes; if it keeps failing/);
      assert.match(result.stderr, /The chain query did not start/);
    } else assert.match(result.stderr, /Gas-token balance unavailable \(timed out\)/);
    assert.ok(result.elapsed < 1800, `probe took ${result.elapsed}ms`);
    assert.doesNotMatch(result.stderr, /request_faucet/);
  });
}

test('hung RPC cleanup sends TERM while stdin remains open, preserving the launcher exit cleanup', (t) => {
  const f = fixture(t, { behavior: 'eof-race', timeoutMs: 200 });
  const result = f.run();
  assert.match(result.stderr, /Gas-token balance unavailable \(timed out\)/);
  assert.equal(readFileSync(f.lifecycleFile, 'utf8'), 'TERM\n', 'EOF must not preempt graceful signal shutdown');
  assert.equal(existsSync(f.scratchDir), false, 'launcher exit cleanup must run for the hung RPC deadline');
});

for (const args of [['--bogus'], ['--timeout', '10'], ['--hook-report', '--bogus'], ['--skip-probe'], ['--hook-report', '--skip-probe', '--migration-failed']]) {
  test(`CLI rejects unexpected arguments ${args.join(' ')} without launching a query`, (t) => {
    const f = fixture(t);
    const result = spawnSync(process.execPath, [join(f.scripts, 'session-identity.cjs'), ...args], {
      env: { PATH: process.env.PATH, MANIFEST_PLUGIN_DATA: f.dataDir }, encoding: 'utf8', timeout: 2000,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^Usage: node session-identity.cjs/);
    assert.equal(existsSync(f.calls), false);
  });
}

test('explicit hook mode serializes public diagnostics into model context and the user message', (t) => {
  const f = fixture(t, { amount: '0' });
  const result = f.run({ cli: true, args: ['--hook-report'], hook: true, input: '# trusted policy\n' });
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(output.hookSpecificOutput.additionalContext, `# trusted policy\n\n${output.systemMessage}`);
  assert.match(output.systemMessage, /Gas-token balance: 0 umfx/);
  assert.match(output.systemMessage, /request_faucet/);
});

test('explicit skipped hook mode emits policy without consulting configuration or starting the launcher', (t) => {
  const f = fixture(t, { rawConfig: SECRET });
  const result = f.run({ cli: true, args: ['--hook-report', '--skip-probe'], hook: true, input: '# trusted policy\n' });
  assert.deepEqual(JSON.parse(result.stdout), {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '# trusted policy' },
  });
  assert.deepEqual(result.calls, []);
});

test('hook context stays within the host limit while preserving the entire policy and faucet advice', async (t) => {
  const f = fixture(t, { amount: '0' });
  const policy = '# trusted policy\n' + 'x'.repeat(9590);
  let serialized = '';
  await reportHook({ policy, dataDir: f.dataDir, launcherPath: join(f.scripts, 'start-server.cjs'),
    stdout: { write: (text) => { serialized += text; } } });
  const output = JSON.parse(serialized);
  assert.ok(output.hookSpecificOutput.additionalContext.startsWith(policy));
  assert.ok(output.hookSpecificOutput.additionalContext.length <= 10000);
  assert.match(output.hookSpecificOutput.additionalContext, /request_faucet/);
  assert.match(output.systemMessage, /Agent address: manifest1/);
  assert.match(output.systemMessage, /Gas-token balance: 0 umfx/);
});

const balanceResponse = (balance) => ({ content: [{ type: 'text', text: JSON.stringify({
  module: 'bank', subcommand: 'balance', result: { balance },
}) }] });
const malformedResponses = [
  ['missing balance', balanceResponse(undefined)],
  ['null balance', balanceResponse(null)],
  ['wrong denom', balanceResponse({ denom: 'upwr', amount: '0' })],
  ['numeric amount', balanceResponse({ denom: 'umfx', amount: 0 })],
  ['negative amount', balanceResponse({ denom: 'umfx', amount: '-1' })],
  ['fractional amount', balanceResponse({ denom: 'umfx', amount: '0.5' })],
  ['untrusted amount', balanceResponse({ denom: 'umfx', amount: SECRET })],
  ['tool error', { isError: true, content: [{ type: 'text', text: SECRET }] }],
  ['unrecognized result', { content: [{ type: 'text', text: JSON.stringify({ balance: { denom: 'umfx', amount: '0' } }) }] }],
];
for (const [name, payload] of malformedResponses) {
  test(`${name} is unavailable, never mistaken for zero funds`, (t) => {
    const result = fixture(t, { payload }).run();
    assert.match(result.stderr, /Gas-token balance unavailable/);
    assert.doesNotMatch(result.stderr, /Gas-token balance: 0|request_faucet/);
  });
}
