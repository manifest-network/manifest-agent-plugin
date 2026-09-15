'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join } = require('node:path');
const { claudeEvents, codexEvents, replyText } = require('./fixtures/terminal-model.cjs');
const { CASES, VERSIONS, counts, validateCase, validateReport, hashes } = require('../ci/terminal-host-smoke.cjs');
const { LEASE } = require('./fixtures/native-host-fixture.cjs');
const operation = { server: 'agent', tool: 'deploy_app_orchestrated', args: { fixture_scenario: 'partial' } };
const parse = (sse) => sse.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));

test('loopback models request only the fixture operation, never approval answers', () => {
  const claude = parse(claudeEvents({ tools: [{ name: 'mcp__plugin_manifest-agent_manifest-agent__deploy_app_orchestrated' }] }, operation));
  assert.equal(claude.find((e) => e.type === 'content_block_start').content_block.name,
    'mcp__plugin_manifest-agent_manifest-agent__deploy_app_orchestrated');
  assert.deepEqual(JSON.parse(claude.find((e) => e.type === 'content_block_delta').delta.partial_json), operation.args);
  const codex = parse(codexEvents({}, operation));
  const call = codex.find((e) => e.type === 'response.output_item.done').item;
  assert.equal(call.type, 'custom_tool_call');
  assert.equal(call.namespace, 'functions');
  assert.equal(call.name, 'exec');
  assert.equal(call.input, '// @exec: {"yield_time_ms":120000}\ntext(await tools.mcp__manifest_agent__deploy_app_orchestrated({"fixture_scenario":"partial"}));');
});

test('background metadata cannot accidentally start a mutation', () => {
  const claude = parse(claudeEvents({ messages: [{ role: 'user', content: 'Generate metadata' }] }, operation));
  assert.ok(!claude.some((event) => event.content_block?.type === 'tool_use'));
  const codex = parse(codexEvents({ text: { format: { type: 'json_schema' } } }, operation));
  const item = codex.find((event) => event.type === 'response.output_item.done').item;
  assert.equal(item.type, 'message');
  assert.deepEqual(JSON.parse(item.content[0].text), { title: 'Manifest fixture' });
});

test('local model result summaries come from actual host outputs and preserve partial IDs', () => {
  for (const host of ['claude', 'codex']) for (const [result, expected] of [
    [{ status: 'partial', lease_uuid: LEASE, broadcast: true }, 'partial'],
    [{ status: 'complete', leaseState: 'LEASE_STATE_ACTIVE', lease_uuid: LEASE }, 'complete LEASE_STATE_ACTIVE'],
    [{ code: 'OPERATION_CANCELLED', broadcast: false }, 'OPERATION_CANCELLED'],
    [{ status: 'read_only' }, 'read_only'],
    [{ error: 'No such tool available' }, 'host denied or interrupted tool'],
  ]) {
    const body = host === 'claude' ? { messages: [{ content: [{ type: 'tool_result', content: JSON.stringify(result) }] }] }
      : { input: [{ type: 'custom_tool_call_output', output: JSON.stringify(result) }] };
    const text = replyText(body, host);
    assert.ok(text.includes(`Fixture result: ${expected}`), text);
    if (result.lease_uuid) assert.ok(text.includes(LEASE));
    const events = parse((host === 'claude' ? claudeEvents : codexEvents)(body, operation));
    assert.ok(!events.some((e) => e.content_block?.type === 'tool_use' || e.item?.type === 'custom_tool_call'));
  }
});

test('marker evidence distinguishes reaching the MCP handler from mutation', () => {
  assert.deepEqual(counts([{ kind: 'request', method: 'initialize' }, { kind: 'request', method: 'tools/call' },
    { kind: 'elicitation' }, { kind: 'progress' }]), { toolCalls: 1, mutationMarkers: 0 });
  const spec = CASES.find((test) => test.name === 'paid-partial-recovery-decline');
  const record = { name: spec.name, toolCalls: 1, mutationMarkers: 1, modelReceivedToolResult: true,
    sequence: [{ kind: 'request', method: 'tools/call' }, { kind: 'mutation' },
      { kind: 'elicitation_result', phase: 'recovery', action: 'decline', accepted: false }], snapshots: [
    { label: 'outer-permission', screen: 'Permission', counts: { toolCalls: 0, mutationMarkers: 0 } },
    { label: 'native-confirmation', screen: 'Confirm', counts: { toolCalls: 1, mutationMarkers: 0 } },
    { label: 'recovery', screen: 'Recovery', counts: { toolCalls: 1, mutationMarkers: 1 } },
    { label: 'result', screen: `Fixture result: partial; lease ${LEASE}. Terminal fixture finished.` },
    { label: 'ready', screen: 'Synthetic fixture' },
  ] };
  assert.doesNotThrow(() => validateCase(spec, record));
  for (const alter of [
    (r) => { r.mutationMarkers = 0; },
    (r) => { r.toolCalls = 2; },
    (r) => { r.snapshots[0].counts.toolCalls = 1; },
    (r) => { r.snapshots[1].counts.mutationMarkers = 1; },
    (r) => { r.snapshots[2].counts.mutationMarkers = 0; },
    (r) => { r.snapshots[3].screen = 'partial'; },
    (r) => { r.snapshots[3].screen += 'Fixture result: complete'; },
  ]) {
    const changed = structuredClone(record); alter(changed);
    assert.throws(() => validateCase(spec, changed));
  }
});

test('terminal provenance covers both host packages, all generated skills and the driver', () => {
  const files = hashes();
  for (const file of ['.mcp.json', '.claude-plugin/plugin.json', 'scripts/_mcp-bridge.cjs', 'scripts/pre-tool-use.cjs',
    'ci/terminal-host-smoke.cjs', 'tests/fixtures/terminal-model.cjs', 'tests/fixtures/native-host-fixture.cjs']) {
    assert.match(files[file], /^[a-f0-9]{64}$/);
  }
  assert.equal(Object.keys(files).filter((file) => /^skills\/.+\/SKILL.md$/.test(file)).length, 14);
});

// Synthetic records exercise validation; they are never written as evidence.
function unitReport() {
  const pkg = require('../package.json');
  const report = JSON.parse(fs.readFileSync(join(__dirname, '../docs/host-evidence/claude-terminal.json')));
  // Reuse realistic UI/event shapes, but this synthetic current record is
  // only an in-memory validator fixture, never an acceptance result.
  const cleanup = { processesStopped: true, apiClosed: true, temporaryRootRemoved: true };
  return { ...report, schemaVersion: 2, source_status: 'current', sourceHashes: hashes(), pluginVersion: pkg.version,
    upstreamPin: pkg.dependencies['@manifest-network/manifest-mcp-node'], cleanup,
    cases: report.cases.map((c) => ({ ...c, cleanup })) };

}

test('full terminal evidence rejects missing cases, unsafe counts, stale hashes and absent UI boundaries', () => {
  assert.equal(validateReport(unitReport(), { requireCurrent: true }).verification, 'workspace');
  for (const alter of [
    (r) => { r.cases.pop(); },
    (r) => { r.cases[1].mutationMarkers = 1; },
    (r) => { r.cases[1].sequence.push({ kind: 'mutation' }); },
    (r) => { r.cases[4].snapshots = r.cases[4].snapshots.filter((s) => s.label !== 'native-confirmation'); },
    (r) => { r.cases[1].servers.pop(); },
    (r) => { r.sourceHashes['ci/terminal-host-smoke.cjs'] = '0'.repeat(64); },
    (r) => { delete r.sourceHashes['tests/fixtures/terminal-model.cjs']; },
    (r) => { r.sourceHashes['../outside'] = '0'.repeat(64); },
    (r) => { r.hostVersion = 'unknown'; },
    (r) => { r.pluginVersion = 'unknown'; },
  ]) {
    const report = unitReport(); alter(report);
    assert.throws(() => validateReport(report));
  }
});

test('historical terminal evidence verifies its recorded commit and is never fresh evidence', () => {
  const report = { ...unitReport(), source_status: 'historical', head: '1'.repeat(40) };
  const sources = Object.fromEntries(Object.keys(report.sourceHashes).map((file) => [file, fs.readFileSync(join(__dirname, '..', file))]));
  assert.deepEqual(validateReport(report, { historicalSources: () => sources, requireHistory: true }), { status: 'historical', verification: 'commit' });
  assert.throws(() => validateReport(report, { requireCurrent: true }), /Fresh current/);
  assert.equal(validateReport(report, { historicalSources: () => null }).verification, 'metadata-only');
  assert.throws(() => validateReport(report, { historicalSources: () => null, requireHistory: true }), /commit unavailable/);
  sources['ci/terminal-host-smoke.cjs'] = 'modified';
  assert.throws(() => validateReport(report, { historicalSources: () => sources }), /Historical source differs/);
});

for (const host of ['claude', 'codex']) test(`archived ${host} terminal evidence preserves the complete observed matrix`, () => {
  const report = JSON.parse(fs.readFileSync(join(__dirname, '../docs/host-evidence', `${host}-terminal.json`)));
  assert.equal(report.host, host);
  assert.deepEqual(validateReport(report, { requireHistory: true }), { status: 'historical', verification: 'commit' });
  assert.throws(() => validateReport(report, { requireCurrent: true }), /Fresh current/);
});

test('historical reports cannot drop their provenance scope or use unreachable history in strict checks', () => {
  const report = unitReport();
  report.source_status = 'historical'; report.head = '1'.repeat(40);
  const sources = Object.fromEntries(Object.keys(report.sourceHashes).map((file) => [file, fs.readFileSync(join(__dirname, '..', file))]));
  const narrowed = structuredClone(report);
  narrowed.sourceHashes = Object.fromEntries(Object.entries(narrowed.sourceHashes).slice(0, 5));
  assert.throws(() => validateReport(narrowed, { requireHistory: true, historicalSources: () => sources }), /exactly the expected files/);
  report.sourceHashes = Object.fromEntries(Object.keys(report.sourceHashes).map((file) => [file, '0'.repeat(64)]));
  report.pluginVersion = '99.99.99';
  assert.throws(() => validateReport(report, { requireHistory: true, historicalSources: () => null }), /commit unavailable/);
  assert.throws(() => validateReport(report, { requireHistory: true, historicalSources: () => sources }), /Historical source differs/);
});

for (const host of ['claude', 'codex']) test(`${host} outcomes come from the model summary, not echoed raw tool output`, () => {
  const report = JSON.parse(fs.readFileSync(join(__dirname, `../docs/host-evidence/${host}-terminal.json`)));
  for (const spec of CASES.filter((c) => c.outcome)) {
    const observed = structuredClone(report.cases.find((c) => c.name === spec.name));
    const result = observed.snapshots.find((s) => s.label === 'result');
    result.screen = result.screen.replace(/Fixture result: [^\n]+/g, 'Fixture result: failed.') + `\nRaw MCP output: ${spec.outcome} ${LEASE}`;
    assert.throws(() => validateCase(spec, observed), /Missing visible Fixture result/);
  }
  const success = structuredClone(report.cases.find((c) => c.name === 'direct-success'));
  success.snapshots.find((s) => s.label === 'result').screen = 'Fixture result: incomplete — deployment failed.';
  assert.throws(() => validateCase(CASES.find((c) => c.name === success.name), success), /Missing visible Fixture result/);
  const recovery = structuredClone(report.cases.find((c) => c.name === 'paid-partial-recovery-decline'));
  Object.assign(recovery.sequence.find((e) => e.kind === 'elicitation_result' && e.phase === 'recovery'), { action: 'accept', accepted: true });
  assert.throws(() => validateCase(CASES.find((c) => c.name === recovery.name), recovery), /Recovery must be declined/);
  const cancelled = report.cases.find((c) => c.name === 'cancel-after-broadcast');
  for (const field of Object.keys(cancelled.cancellationObservation)) {
    const changed = structuredClone(cancelled);
    const value = changed.cancellationObservation[field];
    changed.cancellationObservation[field] = Array.isArray(value) ? ['invented'] : typeof value === 'number' ? 1 : !value;
    assert.throws(() => validateCase(CASES.at(-1), changed), /Cancellation observations differ/);
  }
  for (const c of report.cases) {
    const changed = structuredClone(c); changed.modelReceivedToolResult = !changed.modelReceivedToolResult;
    assert.throws(() => validateCase(CASES.find((spec) => spec.name === c.name), changed), /Model result receipt/);
  }
});

test('outer denial cannot claim an impossible native prompt and v2 cleanup requires measurements', () => {
  const report = unitReport(), outer = report.cases.find((c) => c.name === 'outer-deny');
  for (const toolCalls of [0, 1]) {
    const changed = structuredClone(outer);
    changed.snapshots.push({ label: 'native-confirmation', screen: 'Impossible', counts: { toolCalls, mutationMarkers: 0 } });
    assert.throws(() => validateCase(CASES.find((c) => c.name === 'outer-deny'), changed), /Outer denial cannot reach/);
  }
  for (const alter of [
    (r) => { r.limitations = 'abcd'; },
    (r) => { r.cleanup = 'cleaned'; },
    (r) => { r.cases[0].cleanup.temporaryRootRemoved = false; },
  ]) { const changed = structuredClone(report); alter(changed); assert.throws(() => validateReport(changed)); }
});
