'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const {
  checkToolPolicy, listTools, matcherNames, probeEnvironment, scopedName, NETWORK_GUARD,
} = require('../ci/mcp-tool-policy.cjs');

const PLUGIN = 'manifest-agent';
const name = (server, tool) => scopedName(PLUGIN, server, tool);
const descriptor = (tool, mutates = false, broadcasts = mutates) => ({
  name: tool,
  annotations: {
    title: tool, readOnlyHint: !mutates, destructiveHint: false,
    idempotentHint: !mutates, openWorldHint: true,
  },
  _meta: { manifest: { v: 1, broadcasts, estimable: false } },
});
const hooks = (...names) => ({ hooks: { PreToolUse: [{ matcher: names.map((n) => `^${n}$`).join('|') }] } });
const baseInventory = () => [
  { serverName: 'manifest-chain', tools: [descriptor('cosmos_query'), descriptor('cosmos_tx', true), descriptor('request_faucet', true, false)] },
  { serverName: 'manifest-agent', tools: [descriptor('deploy_app_orchestrated', true), descriptor('troubleshoot_deployment_orchestrated')] },
];
const baseHooks = () => hooks(name('manifest-chain', 'cosmos_tx'), name('manifest-agent', 'deploy_app_orchestrated'));
const check = (inventory = baseInventory(), hooksJson = baseHooks()) => checkToolPolicy({ pluginName: PLUGIN, inventory, hooksJson });

test('installed inventory gates mutations including outer wrappers; read-only tools and faucet stay ungated', () => {
  const inventory = baseInventory();
  const result = check(inventory);
  assert.deepEqual(result, { ok: true, failures: [], tools: 5, mutations: 2 });
});

test('a newly published mutator fails before its exact hook matcher is added', () => {
  const inventory = baseInventory();
  inventory.push({ serverName: 'manifest-fred', tools: [descriptor('restore_app', true)] });
  const before = check(inventory);
  assert.equal(before.ok, false);
  assert.match(before.failures.join('\n'), /restore_app: mutation is not gated/);
  const after = check(inventory, hooks(
    name('manifest-chain', 'cosmos_tx'), name('manifest-agent', 'deploy_app_orchestrated'), name('manifest-fred', 'restore_app'),
  ));
  assert.equal(after.ok, true);
});

test('off-chain mutations require gating even when broadcasts is false', () => {
  const inventory = baseInventory();
  inventory.push({ serverName: 'manifest-fred', tools: [descriptor('restart_app', true, false)] });
  assert.match(check(inventory).failures.join('\n'), /restart_app: mutation is not gated/);
});

test('missing, unsupported, and contradictory metadata all fail rather than exempting a tool', () => {
  const invalidDescriptors = [
    { name: 'new_tool' },
    { ...descriptor('new_tool'), _meta: { manifest: { v: 2, broadcasts: false, estimable: false } } },
    descriptor('new_tool', false, true),
    { ...descriptor('new_tool'), annotations: { ...descriptor('new_tool').annotations, destructiveHint: true } },
  ];
  for (const invalid of invalidDescriptors) {
    const inventory = baseInventory();
    inventory[0].tools.push(invalid);
    assert.equal(check(inventory).ok, false);
    assert.match(check(inventory).failures.join('\n'), /new_tool: (missing|read-only)/);
  }
});

test('readonly gating, stale names, legacy unscoped names, and duplicate descriptors fail', () => {
  const inventory = baseInventory();
  const badHooks = hooks(
    name('manifest-chain', 'cosmos_tx'), name('manifest-agent', 'deploy_app_orchestrated'),
    name('manifest-chain', 'cosmos_query'), 'mcp__manifest-chain__cosmos_tx',
  );
  const result = check(inventory, badHooks);
  assert.match(result.failures.join('\n'), /cosmos_query: read-only tool or faucet is unexpectedly gated/);
  assert.match(result.failures.join('\n'), /mcp__manifest-chain__cosmos_tx: matcher has no tool/);
  inventory[0].tools.push(descriptor('cosmos_query'));
  assert.match(check(inventory).failures.join('\n'), /duplicate tool descriptor/);
});

test('optional faucet must be discovered and its exemption fails if it starts broadcasting', () => {
  const inventory = baseInventory();
  inventory[0].tools[2]._meta.manifest.broadcasts = true;
  assert.match(check(inventory).failures.join('\n'), /faucet exception no longer matches/);
  inventory[0].tools.pop();
  assert.match(check(inventory).failures.join('\n'), /Optional faucet was not advertised/);
});

test('matchers are exact, scoped tool names rather than permissive regular expressions', () => {
  for (const matcher of ['mcp__plugin_manifest-agent_manifest-fred__deploy_app', '^mcp__.*$', '^mcp__a__b$|^mcp__a__b$']) {
    assert.throws(() => matcherNames({ hooks: { PreToolUse: [{ matcher }] } }));
  }
});

test('fixture environment excludes inherited credentials and runtime injection', () => {
  const env = probeEnvironment('/tmp/policy-fixture');
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.MANIFEST_KEY_PASSWORD, undefined);
  assert.equal(env.HTTPS_PROXY, undefined);
  assert.equal(env.COSMOS_RPC_URL, 'http://127.0.0.1:1');
  assert.equal(env.MANIFEST_KEY_FILE, '/tmp/policy-fixture/no-wallet.json');
});

function fixture(t, source) {
  const cwd = mkdtempSync(join(tmpdir(), 'manifest-policy-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const binaryPath = join(cwd, 'server.cjs');
  const guardPath = join(cwd, 'deny-network.cjs');
  writeFileSync(binaryPath, source);
  writeFileSync(guardPath, NETWORK_GUARD);
  return { cwd, binaryPath, guardPath, timeoutMs: 5000 };
}

test('metadata client only initializes and lists every page, without invoking any tool', async (t) => {
  const opts = fixture(t, `
    const fs = require('node:fs');
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const msg = JSON.parse(line);
      fs.appendFileSync('methods.jsonl', JSON.stringify(msg) + '\\n');
      if (!msg.id) return;
      let result;
      if (msg.method === 'initialize') result = { capabilities: { tools: {} } };
      else if (msg.method === 'tools/list') result = msg.params.cursor
        ? { tools: [{ name: 'second' }] }
        : { tools: [{ name: 'first' }], nextCursor: 'page-two' };
      else process.exit(96);
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
    });
  `);
  assert.deepEqual(await listTools(opts), [{ name: 'first' }, { name: 'second' }]);
  const transcript = readFileSync(join(opts.cwd, 'methods.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(transcript.map((x) => x.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/list']);
  assert.deepEqual(transcript.at(-1).params, { cursor: 'page-two' });
});

test('completed metadata survives a nonzero exit from the requested shutdown', async (t) => {
  const opts = fixture(t, `
    const fs = require('node:fs');
    setInterval(() => {}, 1000);
    process.on('SIGTERM', () => {
      fs.writeFileSync('shutdown.json', JSON.stringify({ signal: 'SIGTERM', exitCode: 3 }));
      process.exit(3);
    });
    require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const msg = JSON.parse(line);
      if (!msg.id) return;
      const result = msg.method === 'initialize'
        ? { capabilities: { tools: {} } }
        : { tools: [{ name: 'completed' }] };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
    });
  `);
  assert.deepEqual(await listTools(opts), [{ name: 'completed' }]);
  assert.deepEqual(JSON.parse(readFileSync(join(opts.cwd, 'shutdown.json'), 'utf8')), {
    signal: 'SIGTERM', exitCode: 3,
  });
});

test('a nonzero exit before metadata completes still fails discovery', async (t) => {
  const opts = fixture(t, `
    require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const msg = JSON.parse(line);
      if (msg.method === 'tools/list') process.exit(3);
      if (msg.method === 'initialize') process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: msg.id, result: { capabilities: { tools: {} } },
      }) + '\\n');
    });
  `);
  await assert.rejects(listTools(opts), /exited with code 3/);
});

test('metadata discovery fails loudly when startup attempts network access', async (t) => {
  const opts = fixture(t, `require('node:net').connect({ host: '127.0.0.1', port: 1 });`);
  await assert.rejects(listTools(opts), /exited with code 97/);
});

test('network access during shutdown fails discovery even after a complete inventory', async (t) => {
  const opts = fixture(t, `
    setInterval(() => {}, 1000);
    process.on('SIGTERM', () => {
      require('node:fs').writeFileSync('shutdown.json', JSON.stringify({ signal: 'SIGTERM' }));
      require('node:net').connect({ host: '127.0.0.1', port: 1 });
    });
    require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const msg = JSON.parse(line);
      if (!msg.id) return;
      const result = msg.method === 'initialize'
        ? { capabilities: { tools: {} } }
        : { tools: [{ name: 'completed' }] };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
    });
  `);
  await assert.rejects(listTools(opts), /network access.*97/);
  assert.deepEqual(JSON.parse(readFileSync(join(opts.cwd, 'shutdown.json'), 'utf8')), { signal: 'SIGTERM' });
});

test('metadata discovery rejects an unexpected server request instead of executing it', async (t) => {
  const opts = fixture(t, `process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:9,method:'elicitation/create'})+'\\n'); setInterval(()=>{},1000);`);
  await assert.rejects(listTools(opts), /requested an operation/);
});
