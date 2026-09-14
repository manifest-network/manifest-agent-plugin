'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { buildCodex } = require('../ci/build-packages.cjs');
const { prepareFixture, LEASE } = require('./fixtures/native-host-fixture.cjs');
const { peer } = require('./fixtures/json-rpc-peer.cjs');
const { packagedAssets } = require('../scripts/codex-server.cjs');
const { acquireLock } = require('../scripts/setup-runtime.cjs');
const { setTimeout: delay } = require('node:timers/promises');

async function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'manifest native transport '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pluginRoot = buildCodex({ out: join(root, 'package') });
  const dataDir = join(root, 'codex data');
  await prepareFixture({ pluginRoot, dataDir });
  const events = () => fs.existsSync(join(dataDir, 'fixture-events.jsonl'))
    ? fs.readFileSync(join(dataDir, 'fixture-events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  async function connect(server, { capabilities = { elicitation: { form: {} } }, onRequest, onNotification } = {}) {
    const child = spawn(process.execPath, [join(pluginRoot, 'scripts/codex-server.cjs'), server], {
      cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, MANIFEST_CODEX_DATA: dataDir,
        CLAUDE_PLUGIN_DATA: join(root, 'unrelated Claude data'), MANIFEST_PLUGIN_DATA: join(root, 'stale data') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const client = peer(child, { onRequest, onNotification });
    t.after(() => client.close());
    const initialized = await client.request('initialize', { protocolVersion: '2025-11-25', clientInfo: { name: 'fixture', version: '1' }, capabilities });
    client.send({ method: 'notifications/initialized' });
    return { client, child, initialized };
  }
  return { root, pluginRoot, dataDir, events, connect };
}

test('native launcher validates arguments before setup', () => {
  for (const args of [[], ['other'], ['chain', 'extra']]) {
    const result = spawnSync(process.execPath, [resolve(__dirname, '../scripts/codex-server.cjs'), ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage: node codex-server/);
  }
});

test('all five native launchers preserve upstream instructions and inject shared policy exactly once', async (t) => {
  const f = await fixture(t);
  let policies = 0;
  await Promise.all(['chain', 'lease', 'fred', 'cosmwasm', 'agent'].map(async (server) => {
    const { client, initialized } = await f.connect(server);
    assert.match(initialized.instructions, new RegExp(`Upstream fixture ${server} instructions`));
    if (server === 'agent') {
      assert.match(initialized.instructions, /cosmos_estimate_fee/);
      assert.match(initialized.instructions, /unknown outcome/);
      policies++;
    } else assert.equal(initialized.instructions, `Upstream fixture ${server} instructions.`);
    assert.ok((await client.request('tools/list', {})).tools.length);
    await client.close();
  }));
  assert.equal(policies, 1);
  assert.equal(fs.existsSync(join(f.root, 'unrelated Claude data')), false);
  assert.equal(fs.existsSync(join(f.root, 'stale data')), false);
  assert.equal(fs.existsSync(join(f.pluginRoot, 'node_modules')), false);
  assert.equal(f.events().filter((e) => e.kind === 'started').length, 5);
  for (const e of f.events().filter((e) => e.kind === 'started')) {
    assert.equal(e.host, 'codex');
    assert.equal(e.data, f.dataDir);
  }
});

test('missing or invalid packaged assets fail before creating runtime data or installing dependencies', (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'manifest-assets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plugin = buildCodex({ out: join(root, 'package') });
  const dataDir = join(root, 'must-not-be-created');
  const run = (launcher, data = dataDir) => spawnSync(process.execPath, [launcher, 'chain'], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, MANIFEST_CODEX_DATA: data }, encoding: 'utf8', timeout: 5000,
  });
  for (const [file, invalid] of [['mcp-policy.json', null], ['mcp-policy.json', '{bad'], ['mcp-policy.json', '{"chain":[]}'],
    ['mcp-policy.json', '{"chain":[3]}'], ['references/runtime-policy.md', null], ['references/runtime-policy.md', ' \n'],
    ['.mcp.json', '{"mcpServers":{}}']]) {
    const path = join(plugin, file);
    const original = fs.readFileSync(path);
    if (invalid === null) fs.rmSync(path); else fs.writeFileSync(path, invalid);
    const result = run(join(plugin, 'scripts/codex-server.cjs'));
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /package assets are missing or invalid; rebuild/);
    assert.equal(fs.existsSync(dataDir), false);
    fs.writeFileSync(path, original);
  }
  const checkout = resolve(__dirname, '../scripts/codex-server.cjs');
  assert.match(run(checkout, resolve(__dirname, '../must-not-be-created')).stderr, /package assets are missing or invalid/);
});

test('Codex setup waiters can acquire a lock after 60 seconds within the packaged startup budget', async (t) => {
  const f = await fixture(t);
  const { lockOptions } = packagedAssets(f.pluginRoot, 'chain');
  const release = await acquireLock(f.dataDir);
  t.after(release);
  let elapsed = 0;
  const waiterRelease = await acquireLock(f.dataDir, { ...lockOptions, now: () => elapsed,
    sleep: async () => { elapsed += 35000; if (elapsed > 60000) release(); },
  });
  waiterRelease();
  assert.equal(elapsed, 70000);
  const startupMs = JSON.parse(fs.readFileSync(join(f.pluginRoot, '.mcp.json'))).mcpServers['manifest-chain'].startup_timeout_sec * 1000;
  assert.ok(lockOptions.timeoutMs < startupMs && lockOptions.timeoutMs >= startupMs - 10000);
});

test('native launcher drains a complete final 2 MiB frame for a slow reader before exiting', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const { client, child } = await f.connect('fred');
  const closed = new Promise((resolve) => child.once('close', resolve));
  child.stdout.pause();
  t.after(() => child.stdout.resume());
  const response = client.request('tools/call', { name: 'app_status', arguments: { fixture_scenario: 'final_large_frame' } });
  // Attach a rejection handler while the stream is deliberately paused.
  response.catch(() => {});
  const deadline = Date.now() + 5000;
  while (!f.events().some((event) => event.kind === 'final_frame_written')) {
    assert.ok(Date.now() < deadline, 'Upstream must finish its frame while the host reader is paused');
    await delay(10);
  }
  await delay(100);
  child.stdout.resume();
  const result = await response;
  assert.equal(result.content[0].text, 'x'.repeat(2 * 1024 * 1024));
  assert.equal(await closed, 0, client.stderr);
});

test('native launcher rejects missing and URL-only forms before either direct or orchestrated writes', async (t) => {
  const f = await fixture(t);
  for (const capabilities of [{}, { elicitation: { url: {} } }]) for (const [server, name] of [['chain', 'cosmos_tx'], ['agent', 'deploy_app_orchestrated']]) {
    const { client } = await f.connect(server, { capabilities });
    const result = await client.request('tools/call', { name, arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /CONFIRMATION_UNAVAILABLE/);
    await client.close();
  }
  assert.equal(f.events().filter((e) => e.kind === 'mutation').length, 0);
  assert.equal(f.events().filter((e) => e.method === 'tools/call').length, 0);
});

test('native direct mutation only reaches the provider after a form accept', async (t) => {
  const f = await fixture(t);
  for (const action of ['decline', 'cancel', 'accept']) {
    const { client } = await f.connect('fred', { onRequest: async (request) => {
      assert.equal(request.method, 'elicitation/create');
      assert.equal(f.events().filter((e) => e.kind === 'mutation').length, 0);
      return { action, content: { confirm: true } };
    } });
    const result = await client.request('tools/call', { name: 'restart_app', arguments: { lease_uuid: LEASE } });
    assert.match(result.content[0].text, action === 'accept' ? /complete/ : /OPERATION_CANCELLED/);
    await client.close();
  }
  assert.equal(f.events().filter((e) => e.kind === 'mutation').length, 1);
});

test('native orchestrator retains progress and paid partial identifiers when recovery is declined', async (t) => {
  const f = await fixture(t);
  let prompts = 0;
  const { client } = await f.connect('agent', { onRequest: async () => ({ action: ++prompts === 1 ? 'accept' : 'decline', content: { confirm: true } }) });
  const result = await client.request('tools/call', { name: 'deploy_app_orchestrated', arguments: { fixture_scenario: 'partial' }, _meta: { progressToken: 'host-progress' } });
  assert.equal(result.structuredContent.status, 'partial');
  assert.equal(result.structuredContent.lease_uuid, LEASE);
  assert.equal(result.structuredContent.recoveryAccepted, false);
  assert.equal(prompts, 2);
  assert.equal(f.events().filter((e) => e.kind === 'mutation').length, 1);
  assert.equal(client.messages.filter((m) => m.method === 'notifications/progress' && m.params.progressToken === 'host-progress').length, 2);
});

test('native cancellation after broadcast preserves the upstream partial-outcome warning', async (t) => {
  const f = await fixture(t);
  let started;
  const broadcast = new Promise((resolve) => { started = resolve; });
  const { client } = await f.connect('agent', { onRequest: async () => ({ action: 'accept', content: { confirm: true } }),
    onNotification: (m) => { if (m.method === 'notifications/progress' && m.params.message === 'broadcast_complete') started(); },
  });
  const call = client.request('tools/call', { name: 'deploy_app_orchestrated', arguments: { fixture_scenario: 'wait_after_broadcast' } });
  await broadcast;
  client.send({ method: 'notifications/cancelled', params: { requestId: call.id } });
  const result = await call;
  assert.equal(result.structuredContent.partial, true);
  assert.equal(result.structuredContent.lease_uuid, LEASE);
  assert.ok(client.messages.some((m) => m.params?.data?.kind === 'deploy_cancelled_after_broadcast'));
  assert.equal(f.events().filter((e) => e.kind === 'mutation').length, 1);
});

test('native launcher reports missing configuration using a Codex skill invocation', async (t) => {
  const f = await fixture(t);
  fs.rmSync(join(f.dataDir, 'config.json'));
  await assert.rejects(f.connect('chain'), (error) => {
    assert.match(error.message, /process exited 1/);
    assert.match(error.message, /\$manifest-agent:init-agent/);
    return true;
  });
});

test('malformed native transport stops the process with an unknown-outcome diagnostic', async (t) => {
  const f = await fixture(t);
  const { client, child } = await f.connect('chain');
  const closed = new Promise((resolve) => child.once('close', resolve));
  child.stdin.write('not JSON\n');
  assert.equal(await closed, 1);
  assert.match(client.stderr, /unknown outcome/);
  assert.equal(f.events().filter((e) => e.kind === 'mutation').length, 0);
});

test('native launcher terminates upstream when the host stops reading responses', async (t) => {
  const f = await fixture(t);
  const { client, child } = await f.connect('chain');
  const closed = new Promise((resolve) => child.once('close', resolve));
  child.stdout.destroy();
  client.send({ id: 99, method: 'tools/list', params: {} });
  assert.equal(await closed, 1);
  assert.match(client.stderr, /unknown outcome/);
});
