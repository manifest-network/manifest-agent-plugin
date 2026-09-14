#!/usr/bin/env node
'use strict';

// Real terminal UIs, deterministic loopback model, production host adapters,
// marker-only MCP runtime. Requires tmux and the explicitly recorded CLIs.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { join, resolve, isAbsolute } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const { createServer } = require('node:http');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { buildCodex, workflowFiles } = require('./build-packages.cjs');
const { sourceHashes } = require('./codex-host-smoke.cjs');
const { readHistoricalSources, sha256 } = require('./evidence-check.cjs');
const { prepareFixture, TOOLS, LEASE } = require('../tests/fixtures/native-host-fixture.cjs');
const { claudeEvents, codexEvents, outputs } = require('../tests/fixtures/terminal-model.cjs');
const ROOT = resolve(__dirname, '..');
const VERSIONS = { claude: '2.1.270 (Claude Code)', codex: 'codex-cli 0.154.0' };
const CASES = [
  { name: 'discovery-read-only', server: 'lease', tool: 'query_leases', writes: 0, calls: 1, outcome: 'read_only' },
  { name: 'outer-deny', outer: 'deny', writes: 0, calls: 0 },
  { name: 'direct-decline', server: 'fred', tool: 'restart_app', answer: 'decline', writes: 0, calls: 0 },
  { name: 'direct-success', server: 'fred', tool: 'restart_app', answer: 'accept', writes: 1, calls: 1, outcome: 'complete' },
  { name: 'orchestrated-decline', answer: 'decline', writes: 0, calls: 1, outcome: 'OPERATION_CANCELLED' },
  { name: 'orchestrated-cancel', answer: 'cancel', writes: 0, calls: 1, outcome: 'OPERATION_CANCELLED' },
  { name: 'orchestrated-success', answer: 'accept', writes: 1, calls: 1, outcome: 'complete' },
  { name: 'paid-partial-recovery-decline', answer: 'accept', args: { fixture_scenario: 'partial' }, writes: 1, calls: 1, outcome: 'partial' },
  { name: 'cancel-after-broadcast', answer: 'accept', args: { fixture_scenario: 'wait_after_broadcast' }, writes: 1, calls: 1 },
].map((test) => ({ server: 'agent', tool: 'deploy_app_orchestrated', ...test }));

function command(bin, args, options = {}) {
  const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 30000, ...options });
  if (result.error || result.status !== 0) throw new Error(`${bin} ${args[0]} failed: ${result.error?.message || result.stderr}`);
  return result.stdout.trimEnd();
}

function counts(events) {
  return { toolCalls: events.filter((e) => e.kind === 'request' && e.method === 'tools/call').length,
    mutationMarkers: events.filter((e) => e.kind === 'mutation').length };
}

function validateCase(test, observed) {
  assert.equal(observed.name, test.name);
  assert.deepEqual({ toolCalls: observed.toolCalls, mutationMarkers: observed.mutationMarkers },
    { toolCalls: test.calls, mutationMarkers: test.writes }, test.name);
  const labels = observed.snapshots.map((snapshot) => snapshot.label);
  assert.ok(labels.includes('ready'));
  if (test.name === 'discovery-read-only') assert.ok(labels.includes('skills'));
  else assert.ok(labels.includes('outer-permission'));
  if (test.server === 'agent' && test.outer !== 'deny') assert.ok(labels.includes('native-confirmation'));
  if (test.args?.fixture_scenario === 'partial') assert.ok(labels.includes('recovery'));
  if (test.name === 'cancel-after-broadcast') {
    assert.ok(labels.includes('progress-after-broadcast') && labels.includes('after-cancel'));
    assert.match(observed.snapshots.find((s) => s.label === 'after-cancel').screen, /interrupt|cancel/i);
  } else assert.ok(labels.includes('result'));
  for (const snapshot of observed.snapshots) {
    if (snapshot.label === 'outer-permission') assert.deepEqual(snapshot.counts, { toolCalls: 0, mutationMarkers: 0 });
    if (snapshot.label === 'native-confirmation') assert.deepEqual(snapshot.counts,
      { toolCalls: test.server === 'agent' ? 1 : 0, mutationMarkers: 0 });
    if (snapshot.label === 'recovery') assert.equal(snapshot.counts.mutationMarkers, 1);
  }
  assert.ok(observed.snapshots.length > 0);
  if (test.outcome) assert.ok(observed.snapshots.some((s) => s.label === 'result' && s.screen.includes(test.outcome)), `Missing visible ${test.outcome}`);
  if (test.outcome === 'partial') {
    const result = observed.snapshots.find((s) => s.label === 'result').screen;
    assert.ok(result.includes(LEASE), 'Partial result lost lease identifier');
    assert.ok(!result.includes('Fixture result: complete'), 'Partial result mislabeled success');
  }
}

function validateReport(report, { requireCurrent = false, requireHistory = false, historicalSources = readHistoricalSources } = {}) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.evidenceKind, 'interactive-terminal-local-fixture');
  assert.ok(Object.hasOwn(VERSIONS, report.host));
  assert.equal(report.hostVersion, VERSIONS[report.host]);
  assert.ok(Number.isFinite(Date.parse(report.observedAt)));
  assert.ok(['current', 'historical'].includes(report.source_status));
  if (requireCurrent) assert.equal(report.source_status, 'current', 'Fresh current terminal evidence required');
  const files = Object.keys(report.sourceHashes || {});
  for (const name of ['package.json', '.mcp.json', 'ci/terminal-host-smoke.cjs', 'tests/fixtures/terminal-model.cjs', 'tests/fixtures/native-host-fixture.cjs']) assert.ok(files.includes(name));
  assert.ok(files.every((file) => /^[a-zA-Z0-9_./-]+$/.test(file) && !isAbsolute(file) && !file.split('/').includes('..')));
  assert.ok(Object.values(report.sourceHashes).every((hash) => /^[a-f0-9]{64}$/.test(hash)));
  let verification = 'workspace', pkg;
  if (report.source_status === 'current') {
    assert.deepEqual(report.sourceHashes, hashes(), 'Terminal evidence is stale; rerun the terminal harness');
    pkg = require('../package.json');
  } else {
    assert.match(report.head || '', /^[a-f0-9]{40}$/, 'Historical evidence needs its full source commit');
    const sources = historicalSources(ROOT, report.head, files);
    if (requireHistory) assert.ok(sources, 'Historical source commit unavailable');
    verification = sources ? 'commit' : 'metadata-only';
    if (sources) {
      for (const file of files) assert.equal(sha256(sources[file]), report.sourceHashes[file], `Historical source differs: ${file}`);
      pkg = JSON.parse(sources['package.json']);
    }
  }
  if (pkg) {
    assert.equal(report.pluginVersion, pkg.version);
    assert.equal(report.upstreamPin, pkg.dependencies['@manifest-network/manifest-mcp-node']);
  }
  assert.equal(report.cases.length, CASES.length, 'A single-case diagnostic is not full terminal evidence');
  for (let i = 0; i < CASES.length; i++) {
    validateCase(CASES[i], report.cases[i]);
    if (report.host === 'codex' && CASES[i].server === 'fred') {
      assert.ok(report.cases[i].snapshots.some((s) => s.label === 'native-confirmation'), 'Missing direct mutation confirmation');
    }
    assert.deepEqual(report.cases[i].servers, Object.keys(TOOLS).sort());
    assert.deepEqual(counts(report.cases[i].sequence), { toolCalls: CASES[i].calls, mutationMarkers: CASES[i].writes });
  }
  assert.ok(report.cleanup && report.limitations.length >= 4);
  return { status: report.source_status, verification };
}

function hashes(root = ROOT) {
  const extra = ['ci/terminal-host-smoke.cjs', 'tests/fixtures/terminal-model.cjs', '.mcp.json', '.claude-plugin/plugin.json',
    ...workflowFiles(root).map((file) => `skills/${file.slice(0, -3)}/SKILL.md`)];
  return { ...sourceHashes(root), ...Object.fromEntries(extra.map((file) => [file,
    createHash('sha256').update(fs.readFileSync(join(root, file))).digest('hex')])) };
}

async function runCase(host, test, onProgress) {
  const temp = fs.mkdtempSync(join(tmpdir(), `manifest-terminal-${host}-`));
  const socket = join(temp, 'tmux.sock');
  const work = join(temp, 'work');
  const config = join(temp, 'config');
  const dataDir = host === 'claude' ? join(config, 'plugins/data/manifest-agent-inline') : join(temp, 'data');
  const snapshots = [], keys = [], modelRequests = [];
  let api, launched = false, apiError;
  const tmux = (...args) => command('tmux', ['-S', socket, ...args]);
  const events = () => fs.existsSync(join(dataDir, 'fixture-events.jsonl'))
    ? fs.readFileSync(join(dataDir, 'fixture-events.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
  const screen = (history = false) => tmux('capture-pane', '-p', ...(history ? ['-S', '-150'] : []));
  const snapshot = (label) => snapshots.push({ label, counts: counts(events()),
    screen: screen(true).replaceAll(temp, '<fixture>').split('\n').map((line) => line.trimEnd()).filter((line, i, all) => line || all[i - 1]).join('\n').trim() });
  const waitFor = async (description, predicate, timeout = 35000) => {
    const end = Date.now() + timeout;
    do {
      if (apiError) throw apiError;
      if (await predicate()) { await delay(600); return; }
      await delay(150);
    } while (Date.now() < end);
    throw new Error(`Timed out: ${description}\n${screen()}`);
  };
  const press = async (...inputs) => {
    keys.push(inputs.join(' '));
    tmux('send-keys', ...inputs);
    await delay(250); // Let the UI render a selection before its Enter.
  };
  const type = async (text) => { keys.push(`type ${text}`); tmux('send-keys', '-l', text); await delay(250); await press('Enter'); };
  try {
    for (const dir of [work, config, join(temp, 'home')]) fs.mkdirSync(dir, { recursive: true });
    let pluginRoot;
    if (host === 'codex') pluginRoot = buildCodex({ out: join(temp, 'marketplace') });
    else {
      pluginRoot = join(temp, 'plugin'); fs.mkdirSync(pluginRoot);
      for (const file of ['.claude-plugin', '.mcp.json', 'scripts', 'hooks', 'skills', 'package.json', 'package-lock.json']) {
        fs.cpSync(join(ROOT, file), join(pluginRoot, file), { recursive: true });
      }
    }
    await prepareFixture({ pluginRoot, dataDir });
    api = createServer(async (request, response) => {
      try {
        if (request.method === 'HEAD' || request.method === 'GET') { response.end('{}'); return; }
        let raw = '';
        for await (const chunk of request) { raw += chunk; assert.ok(raw.length < 4 * 1024 * 1024, 'Oversized fixture request'); }
        const body = JSON.parse(raw);
        if (request.url.includes('count_tokens')) { response.setHeader('Content-Type', 'application/json'); response.end('{"input_tokens":100}'); return; }
        assert.match(request.url, host === 'claude' ? /^\/v1\/messages(?:\?.*)?$/ : /^\/v1\/responses(?:\?.*)?$/);
        modelRequests.push(body);
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end((host === 'claude' ? claudeEvents : codexEvents)(body, test));
      } catch (error) { apiError = error; response.writeHead(500); response.end('Fixture error'); }
    });
    await new Promise((ready) => api.listen(0, '127.0.0.1', ready));
    const baseUrl = `http://127.0.0.1:${api.address().port}`;
    const env = { PATH: process.env.PATH, HOME: join(temp, 'home'), TERM: 'xterm-256color', LANG: 'C.UTF-8',
      npm_config_registry: 'http://127.0.0.1:1', npm_config_offline: 'true' };
    let args;
    if (host === 'codex') {
      Object.assign(env, { CODEX_HOME: config, MANIFEST_CODEX_DATA: dataDir });
      fs.writeFileSync(join(config, 'config.toml'), `model = "gpt-5.6-terra"\nmodel_provider = "fixture"\nmodel_reasoning_effort = "low"\ncheck_for_update_on_startup = false\n[model_providers.fixture]\nname = "Local acceptance fixture"\nbase_url = "${baseUrl}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n[projects.${JSON.stringify(work)}]\ntrust_level = "trusted"\n`);
      // Seed only the CLI's bundled public catalog, never the user's cache.
      const catalog = JSON.parse(command(host, ['debug', 'models', '--bundled'], { env }));
      fs.writeFileSync(join(config, 'models_cache.json'), JSON.stringify({ ...catalog, fetched_at: new Date().toISOString(), etag: null, client_version: '0.154.0' }));
      command(host, ['plugin', 'marketplace', 'add', join(temp, 'marketplace'), '--json'], { env });
      command(host, ['plugin', 'add', 'manifest-agent@manifest', '--json'], { env });
      args = ['--no-alt-screen', '-C', work, '-a', 'on-request'];
    } else {
      Object.assign(env, { CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: 'fixture-dummy-key-not-a-credential',
        DISABLE_UPDATES: '1', DISABLE_INSTALLATION_CHECKS: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
      fs.mkdirSync(join(config, 'plugins/cache'), { recursive: true });
      fs.writeFileSync(join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', lastOnboardingVersion: '2.1.270', projects: { [work]: { hasTrustDialogAccepted: true } } }));
      args = ['--plugin-dir', pluginRoot, '--setting-sources', '', '--settings', '{}', '--permission-mode', 'manual',
        '--allowedTools', `mcp__plugin_manifest-agent_manifest-${test.server}__${test.tool}`, '--tools', '', '--model', 'claude-sonnet-4-5-20250929', '--debug-file', join(temp, 'debug.log')];
    }
    fs.writeFileSync(join(temp, 'launch.cjs'), `const r=require('node:child_process').spawnSync(${JSON.stringify(host)},${JSON.stringify(args)},{env:${JSON.stringify(env)},stdio:'inherit'});process.exitCode=r.status??1;`);
    tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'acceptance', '-x', '140', '-y', '55', '-c', work, process.execPath, join(temp, 'launch.cjs'));
    launched = true;
    if (host === 'claude') {
      await waitFor('dummy API key prompt', () => screen().includes('Detected a custom API key'));
      await press('Up'); await press('Enter');
    }
    await waitFor('five MCP servers', () => new Set(events().filter((e) => e.method === 'tools/list').map((e) => e.server)).size === 5, 60000);
    await delay(500);
    snapshot('ready');
    if (test.name === 'discovery-read-only') {
      await type('/skills');
      if (host === 'codex') {
        await waitFor('skills action menu', () => screen().includes('List skills'));
        await press('Enter');
      }
      await waitFor('skills menu', () => host === 'claude'
        ? screen().includes('14 skills') && screen().includes('manifest-agent')
        : screen().includes('Press enter to insert') && screen().includes('Manifest'));
      snapshot('skills');
      await press('Escape');
      if (host === 'codex') await press('C-u');
    }
    await type('Call the harmless fixture tool once.');
    if (test.name !== 'discovery-read-only') {
      await waitFor('outer permission', () => host === 'claude' ? screen().includes('Do you want to proceed?') : screen().includes('Allow the manifest-'));
      snapshot('outer-permission');
      assert.deepEqual(counts(events()), { toolCalls: 0, mutationMarkers: 0 });
      const deny = test.outer === 'deny' || (host === 'claude' && test.name === 'direct-decline');
      if (deny) { await press('Down'); await press('Enter'); }
      else {
        await press('Enter');
        const form = test.server === 'agent' || host === 'codex';
        if (form) {
          await waitFor('native confirmation', () => screen().includes(host === 'claude' ? 'requests your input'
            : test.server === 'agent' ? 'Approve a harmless fixture operation?' : 'Allow Manifest restart_app?'));
          snapshot('native-confirmation');
          const answer = async (choice) => {
            if (choice === 'cancel') return press('Escape');
            if (host === 'claude') {
              if (choice === 'accept') { await press('Space'); await press('Down'); }
              else { await press('Down'); await press('Down'); }
            } else if (choice === 'accept') await press('Up');
            await press('Enter');
          };
          await answer(test.answer);
          if (test.args?.fixture_scenario === 'partial') {
            await waitFor('partial recovery', () => screen().includes('Harmless partial deployment'));
            snapshot('recovery'); await answer('decline');
          }
        }
      }
    }
    if (test.name === 'cancel-after-broadcast') {
      await waitFor('broadcast marker', () => counts(events()).mutationMarkers === 1);
      await delay(750); snapshot('progress-after-broadcast');
      await press('Escape');
      // Host cancellation may discard late tool results. Record that explicitly.
      await delay(2000); snapshot('after-cancel');
    } else {
      await waitFor('completed terminal response', () => screen().includes('Terminal fixture finished.') ||
        ((test.outer === 'deny' || (host === 'claude' && test.name === 'direct-decline')) && /interrupted|rejected|rejection|declined/i.test(screen())));
      snapshot('result');
    }
    const observed = { name: test.name, ...counts(events()), keys, snapshots,
      sequence: events().filter((e) => !['started'].includes(e.kind) && (e.kind !== 'request' || e.method === 'tools/call')),
      modelReceivedToolResult: modelRequests.some((body) => outputs(body, host).length > 0),
      servers: [...new Set(events().filter((e) => e.method === 'tools/list').map((e) => e.server))].sort() };
    if (test.name === 'cancel-after-broadcast') {
      const finalScreen = snapshots.find((s) => s.label === 'after-cancel').screen;
      observed.cancellationObservation = { observationWindowMs: 2000,
        mcpCancellationReceived: events().some((e) => e.kind === 'cancellation'),
        warningEmitted: events().some((e) => e.kind === 'cancelled_after_broadcast'),
        warningVisible: finalScreen.includes('deploy_cancelled_after_broadcast'), leaseVisible: finalScreen.includes(LEASE),
        renderedProgress: ['plan_ready', 'broadcast_complete'].filter((phase) => snapshots.some((s) => s.screen.includes(phase))) };
    }
    validateCase(test, observed);
    onProgress?.(`${host}: ${test.name} passed (${observed.mutationMarkers} markers)`);
    return observed;
  } catch (error) {
    error.message = `${host}/${test.name}: ${error.message}`;
    throw error;
  } finally {
    if (launched) {
      try {
        tmux('send-keys', 'C-c'); await delay(250);
        tmux('send-keys', 'C-c'); await delay(1000);
      } catch { /* Already exited. */ }
      try { tmux('kill-server'); } catch { /* Already exited. */ }
    }
    if (api) { api.closeAllConnections(); await new Promise((done) => api.close(done)); }
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function runSuite({ host, only, onProgress = console.log } = {}) {
  assert.ok(Object.hasOwn(VERSIONS, host), 'Use --host claude or --host codex');
  const hostVersion = command(host, ['--version']);
  assert.equal(hostVersion, VERSIONS[host], 'Host UI version changed; review the driver before updating its version pin');
  const tmuxVersion = command('tmux', ['-V']);
  const source = hashes();
  const selected = only ? CASES.filter((test) => test.name === only) : CASES;
  assert.ok(selected.length, 'Unknown case');
  const cases = [];
  for (const test of selected) cases.push(await runCase(host, test, onProgress));
  assert.deepEqual(hashes(), source, 'Sources changed during acceptance run');
  const pkg = require('../package.json');
  return { schemaVersion: 1, evidenceKind: 'interactive-terminal-local-fixture', source_status: 'current',
    observedAt: new Date().toISOString(), head: command('git', ['rev-parse', 'HEAD']), sourceHashes: source,
    host, hostVersion, nodeVersion: process.version, tmuxVersion, pluginVersion: pkg.version,
    upstreamPin: pkg.dependencies['@manifest-network/manifest-mcp-node'], runtime: 'marker-only 0.0.0-fixture',
    installation: host === 'claude' ? 'temporary --plugin-dir, production SessionStart hook' : 'temporary local marketplace, codex plugin add',
    cases, cleanup: 'Owned tmux servers and loopback API stopped; all temporary homes, plugins, data and dummy credentials removed.',
    limitations: ['Scripted terminal input and local model responses; no model reasoning or human usability signoff.',
      'Production launchers and hooks, fake MCP runtime. No live chain/provider, real wallet, funds or GUI.',
      'Fresh local installs only; published-version upgrades and preservation of real saved records require separate acceptance.',
      'Progress and late cancellation visibility are observations in the captured screens, not assumed from emitted notifications.'] };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const value = (flag) => args[args.indexOf(flag) + 1];
  if (args.includes('--check')) {
    try { console.log(JSON.stringify(validateReport(JSON.parse(fs.readFileSync(resolve(value('--check')))), {
      requireCurrent: args.includes('--require-current'), requireHistory: args.includes('--require-history'),
    }))); } catch (error) { console.error(error.message); process.exitCode = 1; }
  } else if (!args.includes('--host') || !args.includes('--out')) {
    console.error('Usage: node ci/terminal-host-smoke.cjs --host claude|codex --out report.json [--case name]\n       node ci/terminal-host-smoke.cjs --check report.json [--require-current|--require-history]'); process.exitCode = 1;
  } else runSuite({ host: value('--host'), only: args.includes('--case') ? value('--case') : undefined })
    .then((report) => { fs.writeFileSync(resolve(value('--out')), JSON.stringify(report, null, 2) + '\n'); })
    .catch((error) => { console.error(error.stack); process.exitCode = 1; });
}

module.exports = { CASES, VERSIONS, counts, validateCase, validateReport, hashes, runSuite };
