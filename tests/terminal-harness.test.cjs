'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { parseArgs, modelHandler, completeCase, finishCase, waitForCondition, processIdentity, ownedProcesses, removeTemporaryRun, CASES } = require('../ci/terminal-host-smoke.cjs');

test('argument errors fail before invoking a CLI or losing a completed matrix', () => {
  for (const args of [
    ['--host', 'claude', '--out'], ['--host', 'claude', '--out', '--case', 'outer-deny'],
    ['--host', 'claude', '--out', 'report.json', '--case'], ['--check'],
    ['--host', 'codex', '--out', 'r.json', '--case', 'unknown'],
    ['--host', 'claude', '--out', 'r.json', '--typo'], ['--host', 'codex', '--host', 'claude', '--out', 'r.json'],
  ]) {
    assert.throws(() => parseArgs(args));
    const result = spawnSync(process.execPath, [join(__dirname, '../ci/terminal-host-smoke.cjs'), ...args], {
      env: { PATH: '/nonexistent' }, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /spawnSync|ENOENT|Host UI version/);
  }
  assert.ok(parseArgs(['--host', 'claude', '--out', 'report.json']).out.endsWith('/report.json'));
});

test('timeouts retain the waiting step even after tmux has disappeared', async () => {
  await assert.rejects(waitForCondition('five MCP servers', () => false, {
    timeout: 1, pollMs: 1, settleMs: 0, screen: () => { throw new Error('tmux server gone'); },
  }), /Timed out: five MCP servers\nTerminal unavailable: tmux server gone/);
});

test('late model fixture failures return 500 and invalidate an otherwise passing case', async (t) => {
  let error;
  const server = createServer(modelHandler({ host: 'codex', test: CASES[0], modelRequests: [],
    onError: (e) => { error = e; }, respond: () => { throw new Error('late model failure'); } }));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 500);
  assert.equal(await response.text(), 'Fixture error');
  const observed = JSON.parse(fs.readFileSync(join(__dirname, '../docs/host-evidence/codex-terminal.json'))).cases[0];
  assert.throws(() => completeCase(CASES[0], observed, error), /late model failure/);
});

test('a response error after headers are sent destroys the stream without a second writeHead', async () => {
  let error, writes = 0, destroyed = false;
  const response = { headersSent: false,
    writeHead() { writes++; this.headersSent = true; },
    end() { throw new Error('write failed after headers'); }, destroy() { destroyed = true; } };
  const request = { method: 'POST', url: '/v1/responses', async *[Symbol.asyncIterator]() { yield '{}'; } };
  await modelHandler({ host: 'codex', test: CASES[0], modelRequests: [], onError: (e) => { error = e; } })(request, response);
  assert.equal(writes, 1); assert.equal(destroyed, true); assert.match(error.message, /write failed/);
});

for (const primaryFails of [false, true]) for (const cleanupFails of [false, true]) for (const apiFails of [false, true]) {
  test(`case finalization preserves errors and completes cleanup (case=${primaryFails}, cleanup=${cleanupFails}, API=${apiFails})`, async () => {
    const primary = primaryFails ? new Error('Timed out: native confirmation') : undefined;
    const cleanup = new Error('Temporary root was recreated'), api = new Error('Late model response failed');
    let lateError;
    const steps = [], failures = [primary, cleanupFails && cleanup, apiFails && api].filter(Boolean);
    const finished = finishCase(primary, [
      () => { steps.push('close API'); if (apiFails) lateError = api; },
      () => { steps.push('remove root'); if (cleanupFails) throw cleanup; },
      () => { steps.push('verify processes'); },
    ], () => { steps.push('check API'); if (lateError) throw lateError; });
    if (!failures.length) await finished;
    else await assert.rejects(finished, (error) => {
      assert.equal(error, failures[0], 'The first error must remain primary');
      assert.deepEqual(error.cause instanceof AggregateError ? error.cause.errors : error.cause ? [error.cause] : [], failures.slice(1));
      return true;
    });
    assert.deepEqual(steps, ['close API', 'remove root', 'verify processes', 'check API']);
  });
}

test('finalization retains an existing cause and does not suppress an error with itself', async () => {
  const cause = new Error('Original cause'), primary = new Error('Case failure', { cause }), cleanup = new Error('Cleanup failure');
  await assert.rejects(finishCase(primary, [() => { throw cleanup; }], () => { throw primary; }), (error) => {
    assert.equal(error, primary);
    assert.deepEqual(error.cause.errors, [cause, cleanup]);
    return true;
  });
});

test('process identity uses the last closing parenthesis, including spaces and parentheses in comm', () => {
  for (const state of ['S', 'Z']) {
    const fields = [state, ...Array(18).fill('0'), '9007199254740993', '0'];
    assert.deepEqual(processIdentity(`123 (worker) Z (flush\nname) ${fields.join(' ')}\n`), { state, start: '9007199254740993' });
  }
  assert.throws(() => processIdentity('123 missing-comm'), /Invalid process stat command/);
  assert.throws(() => processIdentity('123 (worker) S 1'), /Invalid process start time/);
});

test('cleanup waits for a late-writing process to exit before deleting its tree', async (t) => {
  const temp = fs.mkdtempSync(join(tmpdir(), 'manifest-terminal-cleanup-test-'));
  const home = join(temp, 'home'); fs.mkdirSync(home);
  const child = spawn(process.execPath, ['-e', `
    process.title = 'flush) Z worker';
    process.once('SIGTERM', () => setTimeout(() => {
      require('node:fs').writeFileSync(process.env.HOME + '/late-debug.log', 'late flush');
      process.exit(0);
    }, 300));
    process.stdout.write('ready'); setInterval(() => {}, 1000);
  `], { env: { HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(temp, { recursive: true, force: true }); });
  const closed = once(child, 'close'); await once(child.stdout, 'data');
  assert.match(fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8'), /\(flush\) Z worker\)/);
  assert.ok(ownedProcesses(temp).some((p) => p.pid === child.pid));
  await removeTemporaryRun(temp);
  const [code] = await closed; assert.equal(code, 0);
  await delay(350);
  assert.equal(fs.existsSync(temp), false);
  assert.deepEqual(ownedProcesses(temp), []);
});
