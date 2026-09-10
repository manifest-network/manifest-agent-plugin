#!/usr/bin/env node
'use strict';

// Exercise the installed, real Claude Code host with an isolated plugin,
// deterministic local Anthropic API, and harmless MCP marker tools. This
// proves host naming/permission/protocol behavior, not native UI rendering,
// model compliance, live-chain behavior, or the upstream orchestrator.
// No npm install, real API key, wallet, or user-settings mutation is needed.
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { createServer } = require('node:http');
const { createInterface } = require('node:readline');
const { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'claude-host-mcp.cjs');
const PREFIX = 'mcp__plugin_manifest-agent_';
const DIRECT = `${PREFIX}manifest-chain__cosmos_tx`;
const OUTER = `${PREFIX}manifest-agent__deploy_app_orchestrated`;
const MANAGE = `${PREFIX}manifest-agent__manage_domain_orchestrated`;
const LOOKUP = `${PREFIX}manifest-agent__lookup_custom_domain_orchestrated`;
const EXPECTED_TOOLS = [DIRECT, OUTER, MANAGE, LOOKUP].sort();
const EXPECTED_API_CALLS = 2;
const CASES = [
  { name: 'bare-name-misses', matcher: '^mcp__manifest-chain__cosmos_tx$', tool: DIRECT, mutations: 1, hooks: 0 },
  { name: 'scoped-deny', matcher: `^${DIRECT}$`, tool: DIRECT, mutations: 0, hooks: 1, decision: 'deny' },
  { name: 'polluted-deny-drops-decision', matcher: `^${DIRECT}$`, polluteFixtureStdout: true, tool: DIRECT, mutations: 1, hooks: 1, decision: 'deny' },
  { name: 'inner-only-misses-outer', matcher: `^${DIRECT}$`, tool: OUTER, mutations: 1, hooks: 0 },
  { name: 'scoped-outer-deny', matcher: `^${OUTER}$`, tool: OUTER, mutations: 0, hooks: 1, decision: 'deny' },
  { name: 'project-direct-ask', project: true, tool: DIRECT, mutations: 0, hooks: 1, decision: 'ask' },
  { name: 'project-stdout-pollution', project: true, polluteStdout: true, tool: DIRECT, mutations: 0, hooks: 1, decision: 'deny' },
  { name: 'project-direct-ask-bypass', project: true, mode: 'bypassPermissions', tool: DIRECT, mutations: 0, hooks: 1, decision: 'ask' },
  { name: 'scoped-deny-bypass', mode: 'bypassPermissions', matcher: `^${DIRECT}$`, tool: DIRECT, mutations: 0, hooks: 1, decision: 'deny' },
  { name: 'project-outer-ask', project: true, tool: OUTER, mutations: 0, hooks: 1, decision: 'ask' },
  { name: 'project-lookup', project: true, tool: LOOKUP, input: { fqdn: 'fixture.example.com' }, mutations: 0, hooks: 0, reads: 1 },
  { name: 'elicitation-decline', project: true, tool: OUTER, response: 'decline', mutations: 0, hooks: 1, decision: 'ask' },
  { name: 'elicitation-cancel', project: true, tool: OUTER, response: 'cancel', mutations: 0, hooks: 1, decision: 'ask' },
  { name: 'elicitation-accept', project: true, tool: OUTER, response: 'accept', mutations: 1, hooks: 1, decision: 'ask' },
];

function shellQuote(value) { return `'${value.replace(/'/g, `'\\''`)}'`; }
function jsonFile(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }
function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function readLines(path) {
  try { return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function prepareCase(directory, test) {
  const plugin = join(directory, 'plugin');
  const config = join(directory, 'config');
  for (const path of [plugin, join(plugin, '.claude-plugin'), join(plugin, 'hooks'), join(plugin, 'scripts'),
    config, join(directory, 'work'), join(directory, 'runtime'), join(directory, 'cache')]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  // Claude's startup rg scan expects its plugin cache directory to exist.
  mkdirSync(join(config, 'plugins', 'cache'), { recursive: true, mode: 0o700 });
  jsonFile(join(config, '.claude.json'), {});
  jsonFile(join(plugin, '.claude-plugin', 'plugin.json'), {
    name: 'manifest-agent', version: '0.0.0', description: 'Harmless isolated host characterization fixture.',
  });
  jsonFile(join(plugin, '.mcp.json'), { mcpServers: Object.fromEntries(['chain', 'agent'].map((server) => [
    `manifest-${server}`, { command: process.execPath, args: [FIXTURE, 'server', server] },
  ])) });
  const traceCommand = `${shellQuote(process.execPath)} ${shellQuote(FIXTURE)} hook`;
  const entries = test.project
    ? readJson(join(ROOT, 'hooks', 'hooks.json')).hooks.PreToolUse
    : [{ matcher: test.matcher }];
  jsonFile(join(plugin, 'hooks', 'hooks.json'), { hooks: { PreToolUse: entries.map(({ matcher }) => ({
    matcher, hooks: [{ type: 'command', command: traceCommand }],
  })) } });
  if (test.project) {
    for (const file of ['pre-tool-use.sh', 'pre-tool-use.cjs']) {
      copyFileSync(join(ROOT, 'scripts', file), join(plugin, 'scripts', file));
    }
  }
  if (test.polluteStdout) {
    const shimDirectory = join(directory, 'node-shim');
    mkdirSync(shimDirectory, { mode: 0o700 });
    writeFileSync(join(shimDirectory, 'node'), `#!/bin/sh\nprintf '%s\\n' 'fixture node startup noise'\nexec ${shellQuote(process.execPath)} "$@"\n`, { mode: 0o700 });
  }
  return { plugin, config };
}

function environment(directory, config, port, test) {
  // Do not inherit authentication, wallet, proxy, provider-selection,
  // NODE_OPTIONS, user MCP settings, or model-backend environment variables.
  return {
    PATH: process.env.PATH || '',
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    CLAUDE_CONFIG_DIR: config,
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: join(directory, 'cache'),
    XDG_RUNTIME_DIR: join(directory, 'runtime'),
    TMPDIR: directory,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_API_KEY: 'fixture-dummy-key-not-a-credential',
    DISABLE_UPDATES: '1', DISABLE_INSTALLATION_CHECKS: '1',
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    MANIFEST_HOST_FIXTURE_LOG: join(directory, 'events.jsonl'),
    ...(test.project ? { MANIFEST_HOST_FIXTURE_POLICY: join(directory, 'plugin', 'scripts', 'pre-tool-use.sh') } : {}),
    ...(test.polluteStdout ? { MANIFEST_HOST_FIXTURE_NODE_SHIM: join(directory, 'node-shim') } : {}),
    ...(test.polluteFixtureStdout ? { MANIFEST_HOST_FIXTURE_STDOUT_NOISE: '1' } : {}),
    ...(test.response ? { MANIFEST_HOST_FIXTURE_ELICIT: '1' } : {}),
  };
}

function modelResponse(response, body, test) {
  const hasResult = body.messages?.some(({ content }) => Array.isArray(content)
    && content.some((block) => block.type === 'tool_result'));
  const block = hasResult ? { type: 'text', text: '' }
    : { type: 'tool_use', id: 'toolu_fixture_1', name: test.tool, input: {} };
  const delta = hasResult ? { type: 'text_delta', text: 'Harmless fixture characterization complete.' }
    : { type: 'input_json_delta', partial_json: JSON.stringify(test.input || {}) };
  const events = [
    ['message_start', { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant',
      model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: block }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: hasResult ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 10 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  response.end(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
}

async function runCase(claude, outputDirectory, test) {
  const directory = join(outputDirectory, test.name);
  const { plugin, config } = prepareCase(directory, test);
  const apiCalls = [];
  const controlEvents = [];
  let apiError;
  let child;
  const server = createServer(async (request, response) => {
    try {
      // Claude checks custom API endpoint reachability before inference.
      if (request.method === 'HEAD') { response.writeHead(200); response.end(); return; }
      assert.equal(request.method, 'POST');
      assert.match(request.url, /^\/v1\/messages(?:\/count_tokens)?(?:\?.*)?$/);
      let raw = '';
      for await (const chunk of request) {
        raw += chunk;
        assert.ok(Buffer.byteLength(raw) <= 8 * 1024 * 1024, 'API fixture request exceeds 8 MiB');
      }
      const body = JSON.parse(raw);
      if (request.url.includes('count_tokens')) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"input_tokens":100}');
        return;
      }
      const names = (body.tools || []).map(({ name }) => name).sort();
      assert.deepEqual(names, EXPECTED_TOOLS, 'Host advertised unexpected or missing tools');
      apiCalls.push({ path: request.url, tools: names });
      assert.ok(apiCalls.length <= EXPECTED_API_CALLS, 'Unexpected repeated model requests');
      modelResponse(response, body, test);
    } catch (error) {
      apiError = error;
      response.writeHead(500); response.end('Fixture request validation failed');
      if (child) stopChild(child);
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const argv = ['-p', '--plugin-dir', plugin, '--setting-sources', '', '--settings', '{}',
    '--no-session-persistence', '--output-format', 'stream-json', '--verbose', '--include-hook-events',
    '--permission-mode', test.mode || 'manual', '--allowedTools', test.tool, '--tools', '',
    '--model', 'claude-sonnet-4-5-20250929', '--debug-file', join(directory, 'debug.log')];
  if (test.response) argv.push('--input-format', 'stream-json', '--permission-prompt-tool', 'stdio');
  else argv.push('--permission-prompts', 'none', 'Call the harmless fixture tool exactly once. It only writes a test marker.');
  let stdout = '';
  let stderr = '';
  let protocolError;
  let timedOut = false;
  let deadline;
  let forceStop;
  let exitCode;
  function stopChild(target) {
    try {
      if (target.pid && process.platform !== 'win32') process.kill(-target.pid, 'SIGTERM');
      else target.kill('SIGTERM');
    } catch { /* already exited */ }
    if (!forceStop) forceStop = setTimeout(() => {
      try { if (target.pid && process.platform !== 'win32') process.kill(-target.pid, 'SIGKILL'); else target.kill('SIGKILL'); }
      catch { /* already exited */ }
    }, 1000);
  }
  try {
    child = spawn(claude, argv, { cwd: join(directory, 'work'),
      env: environment(directory, config, server.address().port, test),
      stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    deadline = setTimeout(() => { timedOut = true; stopChild(child); }, 45000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', (error) => { protocolError ||= error; });
    if (test.response) {
      const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
      createInterface({ input: child.stdout }).on('line', (line) => {
        try {
          const message = JSON.parse(line);
          if (message.type === 'control_request') {
            const request = message.request;
            controlEvents.push({ subtype: request.subtype, tool: request.tool_name, server: request.mcp_server_name });
            let response;
            if (request.subtype === 'can_use_tool') {
              assert.equal(request.tool_name, test.tool, 'Unexpected host permission request');
              response = { behavior: 'allow', updatedInput: request.input };
            } else if (request.subtype === 'elicitation') {
              assert.equal(request.mcp_server_name, 'plugin:manifest-agent:manifest-agent');
              response = { action: test.response, ...(test.response === 'accept' ? { content: { confirm: true } } : {}) };
            } else throw new Error(`Unexpected host control request: ${request.subtype}`);
            send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } });
          } else if (message.type === 'result') child.stdin.end();
        } catch (error) { protocolError = error; stopChild(child); }
      });
      send({ type: 'user', message: { role: 'user', content: 'Call the harmless fixture tool exactly once.' } });
    } else child.stdin.end();
    exitCode = await new Promise((resolveExit, reject) => {
      child.once('error', reject);
      child.once('close', resolveExit);
    });
  } finally {
    clearTimeout(deadline); clearTimeout(forceStop);
    server.closeAllConnections();
    await new Promise((resolveClose) => server.close(resolveClose));
    writeFileSync(join(directory, 'stdout.jsonl'), stdout, { mode: 0o600 });
    writeFileSync(join(directory, 'stderr.log'), stderr, { mode: 0o600 });
    jsonFile(join(directory, 'api-calls.json'), apiCalls);
    jsonFile(join(directory, 'control-events.json'), controlEvents);
  }
  const events = readLines(join(directory, 'events.jsonl'));
  const hooks = events.filter(({ kind }) => kind === 'hook');
  const mutations = events.filter(({ kind }) => kind.endsWith('_mutation_marker'));
  const summary = { name: test.name, permissionMode: test.mode || 'manual', exitCode, timedOut, hooks, mutations: mutations.length,
    reads: events.filter(({ kind }) => kind === 'read_only_marker').length, controlEvents, apiCalls: apiCalls.length };
  jsonFile(join(directory, 'summary.json'), summary);
  if (apiError) throw apiError;
  if (protocolError) throw protocolError;
  assert.equal(timedOut, false, 'Claude host timed out');
  assert.equal(exitCode, 0, 'Claude host failed; inspect stderr.log and debug.log');
  assert.equal(apiCalls.length, EXPECTED_API_CALLS, 'Expected one tool decision and one final model response');
  assert.equal(hooks.length, test.hooks, 'Unexpected PreToolUse hook count');
  assert.equal(mutations.length, test.mutations, 'Unexpected fixture mutation count');
  assert.equal(summary.reads, test.reads || 0, 'Unexpected read-only fixture count');
  for (const hook of hooks) {
    assert.equal(hook.tool, test.tool);
    assert.equal(hook.decision, test.decision);
  }
  if (test.response) {
    assert.deepEqual(controlEvents.map(({ subtype }) => subtype), ['can_use_tool', 'elicitation']);
    assert.deepEqual(events.filter(({ kind }) => kind === 'elicitation_result').map(({ action }) => action), [test.response]);
  }
  return summary;
}

async function main() {
  let claude = 'claude';
  const selected = [];
  for (let index = 2; index < process.argv.length; index++) {
    const flag = process.argv[index];
    if (flag === '--claude' && process.argv[index + 1]) claude = process.argv[++index];
    else if (flag === '--case' && process.argv[index + 1]) selected.push(process.argv[++index]);
    else throw new Error('Usage: node ci/claude-hook-smoke.cjs [--claude <binary>] [--case <name>]');
  }
  const cases = selected.length ? selected.map((name) => {
    const test = CASES.find((item) => item.name === name);
    if (!test) throw new Error(`Unknown case: ${name}`);
    return test;
  }) : CASES;
  const version = spawnSync(claude, ['--version'], { encoding: 'utf8', timeout: 10000 });
  if (version.error || version.status !== 0) throw new Error('Installed Claude Code is required; this check never installs it');
  const outputDirectory = mkdtempSync(join(tmpdir(), 'manifest-claude-hook-smoke-'));
  console.log(`Claude host: ${version.stdout.trim()}`);
  console.log(`Artifacts: ${outputDirectory}`);
  const results = [];
  for (const test of cases) {
    try {
      const result = await runCase(claude, outputDirectory, test);
      results.push({ ...result, passed: true });
      console.log(`PASS ${test.name}`);
    } catch (error) {
      results.push({ name: test.name, passed: false, error: error.message });
      jsonFile(join(outputDirectory, 'report.json'), { claudeVersion: version.stdout.trim(), results });
      throw new Error(`${test.name}: ${error.message}. Artifacts: ${outputDirectory}`);
    }
  }
  jsonFile(join(outputDirectory, 'report.json'), { claudeVersion: version.stdout.trim(), results });
  console.log(`claude-hook-smoke: OK — ${results.length} real-host checks; API and MCP behavior are harmless fixtures`);
}

if (require.main === module) main().catch((error) => {
  console.error(`claude-hook-smoke: ${error.message}`);
  process.exitCode = 1;
});
