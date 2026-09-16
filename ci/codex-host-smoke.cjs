#!/usr/bin/env node
'use strict';

// Runs the real Codex app-server in an isolated home. Only the package's
// dependency definition/runtime is replaced by a marker-only fixture. The
// shipped native manifest, skills, cwd, timeouts and launchers are exercised.
// This is host-protocol evidence, not terminal UI or live testnet evidence.
const fs = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const { buildCodex, workflowFiles } = require('./build-packages.cjs');
const { prepareFixture, LEASE } = require('../tests/fixtures/native-host-fixture.cjs');
const { peer } = require('../tests/fixtures/json-rpc-peer.cjs');
const ROOT = resolve(__dirname, '..');

function sourceHashes(root = ROOT) {
  const files = ['ci/build-packages.cjs', 'ci/codex-host-smoke.cjs', 'tests/fixtures/native-host-fixture.cjs', 'tests/fixtures/json-rpc-peer.cjs',
    'hosts/codex/manifest-agent/.mcp.json', 'hosts/codex/manifest-agent/.codex-plugin/plugin.json',
    ...fs.readdirSync(join(root, 'scripts')).filter((name) => /\.(cjs|ps1)$/.test(name)).map((name) => `scripts/${name}`),
    'scripts/session-start.sh', 'scripts/pre-tool-use.sh', 'hooks/hooks.json', 'package.json', 'package-lock.json', 'docs/codex.md', 'docs/identity.md',
    ...workflowFiles(root).map((name) => `workflows/${name}`), 'hosts/codex/env.sh', 'hosts/codex/restart-confirmation.md', 'hosts/claude/restart-confirmation.md'];
  return Object.fromEntries(files.sort().map((name) => [name, createHash('sha256').update(fs.readFileSync(join(root, name))).digest('hex')]));
}

async function runHost({ codex = 'codex' } = {}) {
  const temp = fs.mkdtempSync(join(tmpdir(), 'manifest-codex-host-'));
  const out = join(temp, 'marketplace');
  const pluginRoot = buildCodex({ out });
  const dataDir = join(temp, 'persistent-data');
  const hostHome = join(temp, 'codex-home');
  fs.mkdirSync(hostHome);
  const credentialEnvironment = { MANIFEST_CREDENTIAL_STORE: 'file',
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(temp, 'unused-fixture-bus')}`,
    XDG_RUNTIME_DIR: join(temp, 'runtime'), SystemRoot: process.env.SystemRoot || 'C:\\FixtureWindows' };
  const env = { PATH: process.env.PATH, HOME: join(temp, 'home'), LANG: 'C.UTF-8', CODEX_HOME: hostHome, MANIFEST_CODEX_DATA: dataDir,
    ...credentialEnvironment };
  fs.mkdirSync(env.HOME);
  fs.mkdirSync(env.XDG_RUNTIME_DIR, { mode: 0o700 });
  let client;
  const command = (args) => {
    const result = spawnSync(codex, args, { cwd: temp, env, encoding: 'utf8', timeout: 30000 });
    if (result.error || result.status !== 0) throw new Error(`Codex ${args[0]} failed: ${result.error?.message || result.stderr}`);
    return result.stdout.trim();
  };
  try {
    const hostVersion = command(['--version']);
    await prepareFixture({ pluginRoot, dataDir, legacyCredential: true });
    const legacyConfig = JSON.parse(fs.readFileSync(join(dataDir, 'config.json'), 'utf8'));
    assert.equal(legacyConfig.agent.keyPassword, 'public-fixture');
    assert.equal(fs.existsSync(join(dataDir, 'credentials')), false);
    command(['plugin', 'marketplace', 'add', out, '--json']);
    command(['plugin', 'add', 'manifest-agent@manifest', '--json']);
    const child = spawn(codex, ['app-server', '--stdio'], { cwd: temp, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let answers = [];
    const prompts = [];
    client = peer(child, { jsonrpc: false, timeoutMs: 30000, onRequest: async (message) => {
      assert.equal(message.method, 'mcpServer/elicitation/request');
      assert.equal(message.params.mode, 'form');
      const action = answers.shift();
      assert.ok(action, 'Unexpected native form');
      prompts.push({ server: message.params.serverName, action, mode: message.params.mode });
      return { action, content: action === 'accept' ? { confirm: true } : null, _meta: null };
    } });
    await client.request('initialize', { clientInfo: { name: 'manifest_host_acceptance', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    client.send({ method: 'initialized' });
    const { plugin } = await client.request('plugin/read', { marketplacePath: join(out, '.agents/plugins/marketplace.json'), pluginName: 'manifest-agent' });
    assert.equal(plugin.summary.installed, true);
    assert.equal(plugin.skills.length, 14);
    assert.equal(plugin.hooks.length, 0);
    const discovered = await client.request('skills/list', { cwds: [temp], forceReload: true });
    const names = discovered.data.flatMap((entry) => entry.skills).filter((skill) => skill.name.startsWith('manifest-agent:')).map((skill) => skill.name);
    assert.equal(new Set(names).size, 14);
    const { thread } = await client.request('thread/start', { cwd: temp, ephemeral: true, modelProvider: 'fixture', config: {
      'model_providers.fixture': { name: 'fixture', base_url: 'http://127.0.0.1:1', wire_api: 'responses' },
    } });
    const events = () => fs.existsSync(join(dataDir, 'fixture-events.jsonl'))
      ? fs.readFileSync(join(dataDir, 'fixture-events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    const count = () => events().filter((event) => event.kind === 'mutation').length;
    const cases = [];
    const casesToRun = [
      { name: 'direct-decline', server: 'manifest-fred', tool: 'restart_app', answers: ['decline'], writes: 0, expected: 'OPERATION_CANCELLED' },
      { name: 'orchestrated-decline', server: 'manifest-agent', tool: 'deploy_app_orchestrated', answers: ['decline'], writes: 0, expected: 'OPERATION_CANCELLED' },
      { name: 'orchestrated-cancel', server: 'manifest-agent', tool: 'deploy_app_orchestrated', answers: ['cancel'], writes: 0, expected: 'OPERATION_CANCELLED' },
      { name: 'direct-success', server: 'manifest-fred', tool: 'restart_app', answers: ['accept'], writes: 1, expected: 'complete' },
      { name: 'orchestrated-success', server: 'manifest-agent', tool: 'deploy_app_orchestrated', answers: ['accept'], writes: 1, expected: 'complete' },
      { name: 'paid-partial-recovery-decline', server: 'manifest-agent', tool: 'deploy_app_orchestrated', arguments: { fixture_scenario: 'partial' }, answers: ['accept', 'decline'], writes: 1, expected: 'partial' },
      { name: 'read-only-discovery', server: 'manifest-chain', tool: 'cosmos_query', answers: [], writes: 0, expected: 'read_only' },
    ];
    for (const example of casesToRun) {
      answers = [...example.answers];
      const before = count();
      const result = await client.request('mcpServer/tool/call', { threadId: thread.id, server: example.server, tool: example.tool, arguments: example.arguments || {}, _meta: { progressToken: example.name } });
      assert.equal(answers.length, 0);
      const value = JSON.parse(result.content.find((item) => item.type === 'text').text);
      assert.equal(value.code || value.status, example.expected);
      assert.equal(count() - before, example.writes);
      if (example.expected === 'partial') assert.equal(value.lease_uuid, LEASE);
      cases.push({ name: example.name, passed: true, mutationMarkers: count() - before, outcome: example.expected });
    }
    const status = await client.request('mcpServerStatus/list', { threadId: thread.id });
    const servers = status.data.filter((server) => server.name.startsWith('manifest-'));
    assert.equal(servers.length, 5);
    for (const server of servers) assert.ok(Object.keys(server.tools).length, `${server.name} tools not discovered`);
    const started = events().filter((event) => event.kind === 'started');
    // Discovery and thread startup may each launch a server. Every launch must
    // receive the same credential context, including a restart after migration.
    assert.deepEqual([...new Set(started.map((event) => `manifest-${event.server}`))].sort(), servers.map((server) => server.name).sort());
    for (const event of started) assert.deepEqual(event.credentialEnvironment, credentialEnvironment, `${event.server} credential environment`);
    const migrated = JSON.parse(fs.readFileSync(join(dataDir, 'config.json'), 'utf8'));
    assert.equal(Object.hasOwn(migrated.agent, 'keyPassword'), false);
    assert.equal(migrated.agent.keyPasswordRef.backend, 'file');
    assert.equal(migrated.agent.keyFile, legacyConfig.agent.keyFile);
    assert.deepEqual(migrated.chains, legacyConfig.chains);
    assert.deepEqual(fs.readdirSync(join(dataDir, 'credentials')), [`${migrated.agent.keyPasswordRef.id}.json`]);
    assert.equal(require('../scripts/_credentials.cjs').resolvePassword(migrated, dataDir), 'public-fixture');
    await client.close();
    client = null;
    const before = fs.readFileSync(join(dataDir, 'config.json'));
    const credentialPath = join(dataDir, 'credentials', `${migrated.agent.keyPasswordRef.id}.json`);
    const beforeCredential = fs.readFileSync(credentialPath);
    const beforeWallet = fs.readFileSync(join(dataDir, 'fixture-wallet.json'));
    command(['plugin', 'remove', 'manifest-agent@manifest', '--json']);
    command(['plugin', 'add', 'manifest-agent@manifest', '--json']);
    assert.deepEqual(fs.readFileSync(join(dataDir, 'config.json')), before);
    assert.deepEqual(fs.readFileSync(credentialPath), beforeCredential);
    assert.deepEqual(fs.readFileSync(join(dataDir, 'fixture-wallet.json')), beforeWallet);
    cases.push({ name: 'reinstall-preserves-config', passed: true, mutationMarkers: 0 });
    return { schemaVersion: 1, source_status: 'current', evidenceKind: 'codex-app-server-local-fixture', observedAt: new Date().toISOString(), hostVersion,
      nodeVersion: process.version, pluginVersion: require('../package.json').version, upstreamPin: require('../package.json').dependencies['@manifest-network/manifest-mcp-node'],
      sourceHashes: sourceHashes(), skills: [...new Set(names)].sort(), servers: servers.map((server) => server.name).sort(), prompts, cases,
      limitations: ['The MCP runtime is a marker-only fixture; no signer, provider or chain call ran.', 'No model turn or terminal/desktop UI was exercised.', 'Progress and post-broadcast cancellation are asserted separately by transport and pinned-runtime tests; this direct app-server call does not characterize UI rendering.'],
      cleanup: 'Isolated Codex home, marketplace and fixture data removed in finally; no live resources created.' };
  } finally {
    if (client) await client.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 0 && (argv.length !== 2 || argv[0] !== '--out')) throw new Error('Usage: node ci/codex-host-smoke.cjs [--out <report.json>]');
  const report = await runHost();
  if (argv[1]) fs.writeFileSync(resolve(argv[1]), JSON.stringify(report, null, 2) + '\n');
  console.log(`codex-host-smoke: ${report.cases.length} cases passed on ${report.hostVersion}; 14 skills, 5 native servers; fixture only`);
}
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { runHost, sourceHashes };
