#!/usr/bin/env node
'use strict';

// Real terminal UIs, deterministic loopback model, production host adapters,
// marker-only MCP runtime. Requires tmux and the explicitly recorded CLIs.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const { createServer } = require('node:http');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { buildCodex, workflowFiles } = require('./build-packages.cjs');
const { sourceHashes } = require('./codex-host-smoke.cjs');
const { readHistoricalSources, hostSourceFiles, verifyProvenance } = require('./evidence-check.cjs');
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

function resultLines(observed) {
  return observed.snapshots.filter((s) => ['result', 'after-cancel'].includes(s.label))
    .flatMap((s) => [...s.screen.matchAll(/^\s*(?:[●•]\s+)?Fixture result: ([^\n]*)$/gm)].map((m) => m[1]));
}

function cancellationObservation(observed) {
  const finalScreen = observed.snapshots.find((s) => s.label === 'after-cancel').screen;
  return { observationWindowMs: 2000,
    mcpCancellationReceived: observed.sequence.some((e) => e.kind === 'cancellation'),
    warningEmitted: observed.sequence.some((e) => e.kind === 'cancelled_after_broadcast'),
    warningVisible: finalScreen.includes('deploy_cancelled_after_broadcast'), leaseVisible: finalScreen.includes(LEASE),
    renderedProgress: ['plan_ready', 'broadcast_complete'].filter((phase) => observed.snapshots.some((s) => s.screen.includes(phase))) };
}

function validateCase(test, observed) {
  assert.equal(observed.name, test.name);
  const expectedCounts = { toolCalls: test.calls, mutationMarkers: test.writes };
  assert.deepEqual({ toolCalls: observed.toolCalls, mutationMarkers: observed.mutationMarkers }, expectedCounts, test.name);
  assert.deepEqual(counts(observed.sequence), expectedCounts, 'Event sequence differs from totals');
  assert.ok(observed.snapshots.every((s) => typeof s.screen === 'string'), 'Screens must retain rendered text');
  const labels = observed.snapshots.map((snapshot) => snapshot.label);
  assert.equal(new Set(labels).size, labels.length, 'Duplicate snapshot labels');
  assert.ok(labels.includes('ready'));
  if (test.name === 'discovery-read-only') assert.ok(labels.includes('skills'));
  else assert.ok(labels.includes('outer-permission'));
  if (test.outer === 'deny') assert.ok(!labels.includes('native-confirmation'), 'Outer denial cannot reach native confirmation');
  else if (test.server === 'agent') assert.ok(labels.includes('native-confirmation'));
  if (test.args?.fixture_scenario === 'partial') {
    assert.ok(labels.includes('recovery'));
    const recovery = observed.sequence.filter((e) => e.kind === 'elicitation_result' && e.phase === 'recovery');
    assert.equal(recovery.length, 1, 'Missing recovery response');
    assert.equal(recovery[0].accepted, false, 'Recovery must be declined');
    assert.ok(['accept', 'decline'].includes(recovery[0].action), 'Unexpected recovery action');
  }
  if (test.name === 'cancel-after-broadcast') {
    assert.ok(labels.includes('progress-after-broadcast') && labels.includes('after-cancel'));
    assert.match(observed.snapshots.find((s) => s.label === 'after-cancel').screen, /interrupt|cancel/i);
    assert.deepEqual(observed.cancellationObservation, cancellationObservation(observed), 'Cancellation observations differ from events/screens');
  } else assert.ok(labels.includes('result'));
  for (const snapshot of observed.snapshots) {
    if (snapshot.label === 'outer-permission') assert.deepEqual(snapshot.counts, { toolCalls: 0, mutationMarkers: 0 });
    if (snapshot.label === 'native-confirmation') assert.deepEqual(snapshot.counts,
      { toolCalls: test.server === 'agent' && test.outer !== 'deny' ? 1 : 0, mutationMarkers: 0 });
    if (snapshot.label === 'recovery') {
      assert.equal(test.args?.fixture_scenario, 'partial', 'Unexpected recovery snapshot');
      assert.deepEqual(snapshot.counts, { toolCalls: 1, mutationMarkers: 1 });
    }
  }
  const summaries = resultLines(observed);
  assert.equal(observed.modelReceivedToolResult, summaries.length > 0, 'Model result receipt differs from its rendered summary');
  assert.ok(summaries.length <= 1, 'Ambiguous model result summary');
  for (const summary of summaries) assert.match(summary,
    new RegExp(`^(read_only|complete LEASE_STATE_ACTIVE|OPERATION_CANCELLED|partial|host denied or interrupted tool)(; lease ${LEASE})?\\. Terminal fixture finished\\.$`),
    'Missing visible Fixture result or malformed model summary');
  if (test.outcome) {
    assert.equal(observed.modelReceivedToolResult, true, 'Model never received the tool result');
    assert.match(summaries[0], new RegExp(`^${test.outcome}(?= |;|\\.|$)`), `Missing visible Fixture result: ${test.outcome}`);
  }
  if (test.outcome === 'partial') assert.ok(summaries[0].includes(LEASE), 'Partial summary lost lease identifier');
}

function validateCleanup(cleanup) {
  assert.deepEqual(cleanup, { processesStopped: true, apiClosed: true, temporaryRootRemoved: true }, 'Terminal cleanup was not verified');
}

function validateReport(report, { root = ROOT, currentHashes, requireCurrent = false,
  requireHistory = false, requireCleanup = false, historicalSources = readHistoricalSources } = {}) {
  assert.ok([1, 2].includes(report.schemaVersion));
  assert.equal(report.evidenceKind, 'interactive-terminal-local-fixture');
  assert.ok(Object.hasOwn(VERSIONS, report.host));
  assert.equal(report.hostVersion, VERSIONS[report.host]);
  assert.ok(Number.isFinite(Date.parse(report.observedAt)));
  const expected = report.source_status === 'current' ? currentHashes || hashes(root) : undefined;
  const { verification } = verifyProvenance(report, { root, files: expected && Object.keys(expected), currentHashes: expected,
    requireCurrent, requireHistory, historicalSources, historicalScope: (tree) => hostSourceFiles(tree, { terminal: true }) });
  assert.equal(report.cases.length, CASES.length, 'A single-case diagnostic is not full terminal evidence');
  for (let i = 0; i < CASES.length; i++) {
    validateCase(CASES[i], report.cases[i]);
    if (report.host === 'codex' && CASES[i].server === 'fred') {
      assert.ok(report.cases[i].snapshots.some((s) => s.label === 'native-confirmation'), 'Missing direct mutation confirmation');
    }
    assert.deepEqual(report.cases[i].servers, Object.keys(TOOLS).sort());
    if (report.schemaVersion === 2 || requireCleanup) validateCleanup(report.cases[i].cleanup);
  }
  if (report.schemaVersion === 2 || requireCleanup) validateCleanup(report.cleanup);
  else assert.ok(typeof report.cleanup === 'string' && report.cleanup.trim(), 'Missing historical cleanup declaration');
  assert.ok(Array.isArray(report.limitations) && report.limitations.length >= 4 &&
    report.limitations.every((s) => typeof s === 'string' && s.trim()), 'Limitations must be a list of nonempty observations');
  return { status: report.source_status, verification };
}

function hashes(root = ROOT) {
  const extra = ['ci/terminal-host-smoke.cjs', 'tests/fixtures/terminal-model.cjs', '.mcp.json', '.claude-plugin/plugin.json',
    ...workflowFiles(root).map((file) => `skills/${file.slice(0, -3)}/SKILL.md`)];
  return { ...sourceHashes(root), ...Object.fromEntries(extra.map((file) => [file,
    createHash('sha256').update(fs.readFileSync(join(root, file))).digest('hex')])) };
}

function modelHandler({ host, test, modelRequests, onError, respond = host === 'claude' ? claudeEvents : codexEvents }) {
  return async (request, response) => {
    try {
      if (request.method === 'HEAD' || request.method === 'GET') { response.end('{}'); return; }
      let raw = '';
      for await (const chunk of request) { raw += chunk; assert.ok(raw.length < 4 * 1024 * 1024, 'Oversized fixture request'); }
      const body = JSON.parse(raw);
      if (request.url.includes('count_tokens')) { response.setHeader('Content-Type', 'application/json'); response.end('{"input_tokens":100}'); return; }
      assert.match(request.url, host === 'claude' ? /^\/v1\/messages(?:\?.*)?$/ : /^\/v1\/responses(?:\?.*)?$/);
      modelRequests.push(body);
      const payload = respond(body, test);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(payload);
    } catch (error) {
      onError(error);
      if (!response.headersSent) { response.writeHead(500); response.end('Fixture error'); }
      else response.destroy();
    }
  };
}

function completeCase(test, observed, apiError) {
  if (apiError) throw apiError;
  validateCase(test, observed);
}

async function finishCase(primaryError, cleanups, checkError = () => {}) {
  const errors = primaryError ? [primaryError] : [];
  // Every cleanup step still runs if an earlier one fails. Check for a late
  // model error only after the API and its connections have been closed.
  for (const cleanup of [...cleanups, checkError]) {
    try { await cleanup(); }
    catch (error) { if (!errors.includes(error)) errors.push(error); }
  }
  if (errors.length) {
    const [primary, ...secondary] = errors;
    if (secondary.length) {
      if (primary.cause) secondary.unshift(primary.cause);
      primary.cause = secondary.length === 1 ? secondary[0] : new AggregateError(secondary, 'Additional terminal cleanup/API failures');
    }
    throw primary;
  }
}

async function waitForCondition(description, predicate, { screen, checkError = () => {}, timeout = 35000,
  pollMs = 150, settleMs = 600 } = {}) {
  const end = Date.now() + timeout;
  do {
    checkError();
    if (await predicate()) { await delay(settleMs); checkError(); return; }
    await delay(pollMs);
  } while (Date.now() < end);
  let diagnostic;
  try { diagnostic = screen(); }
  catch (error) { diagnostic = `Terminal unavailable: ${error.message}`; }
  throw new Error(`Timed out: ${description}\n${diagnostic}`);
}

function processIdentity(stat) {
  const end = stat.lastIndexOf(')');
  assert.ok(end > 0, 'Invalid process stat command');
  const fields = stat.slice(end + 1).trim().split(/\s+/);
  assert.match(fields[19] || '', /^\d+$/, 'Invalid process start time');
  return { state: fields[0], start: fields[19] };
}

function ownedProcesses(temp) {
  // These CLI acceptance runs use Linux. Only processes carrying this run's
  // exact temporary HOME qualify, including children orphaned by the host.
  return fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name)).flatMap((name) => {
    try {
      const env = fs.readFileSync(`/proc/${name}/environ`, 'utf8').split('\0');
      if (!env.includes(`HOME=${join(temp, 'home')}`)) return [];
      const stat = processIdentity(fs.readFileSync(`/proc/${name}/stat`, 'utf8'));
      return stat.state === 'Z' ? [] : [{ pid: Number(name), start: stat.start }];
    } catch (error) {
      if (['ENOENT', 'EACCES', 'EPERM', 'ESRCH'].includes(error.code)) return [];
      throw error;
    }
  });
}

async function stopOwnedProcesses(temp) {
  const end = Date.now() + 6000;
  let remaining;
  const signalled = new Set();
  do {
    remaining = ownedProcesses(temp);
    if (!remaining.length) return;
    for (const processInfo of remaining) {
      try {
        const stat = processIdentity(fs.readFileSync(`/proc/${processInfo.pid}/stat`, 'utf8'));
        const signal = Date.now() > end - 2000 ? 'SIGKILL' : 'SIGTERM';
        const key = `${processInfo.pid}:${processInfo.start}:${signal}`;
        if (stat.start === processInfo.start && !signalled.has(key)) { process.kill(processInfo.pid, signal); signalled.add(key); }
      } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
    }
    await delay(100);
  } while (Date.now() < end);
  assert.deepEqual(ownedProcesses(temp), [], 'Acceptance processes did not exit; temporary data retained for diagnosis');
}

async function removeTemporaryRun(temp) {
  await stopOwnedProcesses(temp);
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await delay(200);
  assert.ok(!fs.existsSync(temp), 'Temporary acceptance tree was recreated after cleanup');
}

async function runCase(host, test, onProgress) {
  const temp = fs.mkdtempSync(join(tmpdir(), `manifest-terminal-${host}-`));
  const socket = join(temp, 'tmux.sock');
  const work = join(temp, 'work');
  const config = join(temp, 'config');
  const dataDir = host === 'claude' ? join(config, 'plugins/data/manifest-agent-inline') : join(temp, 'data');
  const snapshots = [], keys = [], modelRequests = [];
  let api, launched = false, apiError, observed, primaryError;
  const tmux = (...args) => command('tmux', ['-S', socket, ...args]);
  const events = () => fs.existsSync(join(dataDir, 'fixture-events.jsonl'))
    ? fs.readFileSync(join(dataDir, 'fixture-events.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
  const screen = (history = false) => tmux('capture-pane', '-p', ...(history ? ['-S', '-150'] : []));
  const snapshot = (label) => snapshots.push({ label, counts: counts(events()),
    screen: screen(true).replaceAll(temp, '<fixture>').split('\n').map((line) => line.trimEnd()).filter((line, i, all) => line || all[i - 1]).join('\n').trim() });
  const waitFor = (description, predicate, timeout) => waitForCondition(description, predicate, {
    screen, timeout, checkError: () => { if (apiError) throw apiError; },
  });
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
    api = createServer(modelHandler({ host, test, modelRequests, onError: (error) => { apiError = error; } }));
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
    observed = { name: test.name, ...counts(events()), keys, snapshots,
      sequence: events().filter((e) => !['started'].includes(e.kind) && (e.kind !== 'request' || e.method === 'tools/call')),
      modelReceivedToolResult: modelRequests.some((body) => outputs(body, host).length > 0),
      servers: [...new Set(events().filter((e) => e.method === 'tools/list').map((e) => e.server))].sort() };
    if (test.name === 'cancel-after-broadcast') {
      observed.cancellationObservation = cancellationObservation(observed);
    }
    completeCase(test, observed, apiError);
  } catch (error) {
    primaryError = error;
  }
  await finishCase(primaryError, [async () => {
    if (launched) {
      try {
        tmux('send-keys', 'C-c'); await delay(250);
        tmux('send-keys', 'C-c'); await delay(1000);
      } catch { /* Already exited. */ }
      try { tmux('kill-server'); } catch { /* Already exited. */ }
    }
  }, async () => {
    if (api) { api.closeAllConnections(); await new Promise((done, fail) => api.close((error) => error ? fail(error) : done())); }
  }, () => removeTemporaryRun(temp)], () => {
    if (apiError) throw apiError;
  }).catch((error) => { error.message = `${host}/${test.name}: ${error.message}`; throw error; });
  observed.cleanup = { processesStopped: true, apiClosed: true, temporaryRootRemoved: true };
  onProgress?.(`${host}: ${test.name} passed (${observed.mutationMarkers} markers)`);
  return observed;
}

async function runSuite({ host, only, onProgress = console.log } = {}) {
  assert.ok(Object.hasOwn(VERSIONS, host), 'Use --host claude or --host codex');
  assert.equal(process.platform, 'linux', 'Terminal cleanup verification requires Linux /proc');
  if (only !== undefined) assert.ok(CASES.some((test) => test.name === only), 'Unknown case');
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
  return { schemaVersion: 2, evidenceKind: 'interactive-terminal-local-fixture', source_status: 'current',
    observedAt: new Date().toISOString(), head: command('git', ['rev-parse', 'HEAD']), sourceHashes: source,
    host, hostVersion, nodeVersion: process.version, tmuxVersion, pluginVersion: pkg.version,
    upstreamPin: pkg.dependencies['@manifest-network/manifest-mcp-node'], runtime: 'marker-only 0.0.0-fixture',
    installation: host === 'claude' ? 'temporary --plugin-dir, production SessionStart hook' : 'temporary local marketplace, codex plugin add',
    cases, cleanup: { processesStopped: true, apiClosed: true, temporaryRootRemoved: true },
    limitations: ['Scripted terminal input and local model responses; no model reasoning or human usability signoff.',
      'Production launchers and hooks, fake MCP runtime. No live chain/provider, real wallet, funds or GUI.',
      'Fresh local installs only; published-version upgrades and preservation of real saved records require separate acceptance.',
      'Progress and late cancellation visibility are observations in the captured screens, not assumed from emitted notifications.'] };
}

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    assert.ok(['--host', '--out', '--case', '--check', '--require-current', '--require-history'].includes(flag), `Unknown option: ${flag}`);
    assert.ok(!Object.hasOwn(options, flag), `Duplicate option: ${flag}`);
    if (flag.startsWith('--require-')) options[flag] = true;
    else {
      const value = args[++i];
      assert.ok(value && !value.startsWith('--'), `Missing value for ${flag}`);
      options[flag] = value;
    }
  }
  if (options['--check']) {
    assert.ok(!options['--host'] && !options['--out'] && !options['--case'], 'Check mode cannot run cases');
    assert.ok(!(options['--require-current'] && options['--require-history']), 'Choose current or historical validation');
    return { check: resolve(options['--check']), requireCurrent: Boolean(options['--require-current']), requireHistory: Boolean(options['--require-history']) };
  }
  assert.ok(Object.hasOwn(VERSIONS, options['--host']) && options['--out'], 'Use --host claude|codex --out report.json [--case name]');
  assert.ok(!options['--require-current'] && !options['--require-history'], 'Validation flags require --check');
  if (options['--case'] !== undefined) assert.ok(CASES.some((c) => c.name === options['--case']), 'Unknown case');
  return { host: options['--host'], only: options['--case'], out: resolve(options['--out']) };
}

async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.check) console.log(JSON.stringify(validateReport(JSON.parse(fs.readFileSync(options.check)), options)));
  else {
    const report = await runSuite(options);
    fs.writeFileSync(options.out, JSON.stringify(report, null, 2) + '\n');
  }
}
if (require.main === module) main().catch((error) => {
  console.error(error.message);
  if (error.cause) console.error('Additional failure:', error.cause);
  process.exitCode = 1;
});

module.exports = { CASES, VERSIONS, counts, validateCase, validateReport, hashes, runSuite, parseArgs,
  modelHandler, completeCase, finishCase, waitForCondition, processIdentity, ownedProcesses, removeTemporaryRun };
