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
  const record = { name: spec.name, toolCalls: 1, mutationMarkers: 1, snapshots: [
    { label: 'outer-permission', counts: { toolCalls: 0, mutationMarkers: 0 } },
    { label: 'native-confirmation', counts: { toolCalls: 1, mutationMarkers: 0 } },
    { label: 'recovery', counts: { toolCalls: 1, mutationMarkers: 1 } },
    { label: 'result', screen: `Fixture result: partial; lease ${LEASE}.` },
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
  return { schemaVersion: 1, evidenceKind: 'interactive-terminal-local-fixture', host: 'claude', hostVersion: VERSIONS.claude,
    observedAt: '2026-09-14T00:00:00Z', source_status: 'current', sourceHashes: hashes(), pluginVersion: pkg.version,
    upstreamPin: pkg.dependencies['@manifest-network/manifest-mcp-node'], cleanup: 'unit fixture', limitations: ['a', 'b', 'c', 'd'],
    cases: CASES.map((spec) => ({ name: spec.name, toolCalls: spec.calls, mutationMarkers: spec.writes,
      servers: ['agent', 'chain', 'cosmwasm', 'fred', 'lease'],
      sequence: [...Array.from({ length: spec.calls }, () => ({ kind: 'request', method: 'tools/call' })),
        ...Array.from({ length: spec.writes }, () => ({ kind: 'mutation' }))],
      snapshots: [
        { label: 'ready' }, { label: 'skills' },
        { label: 'outer-permission', counts: { toolCalls: 0, mutationMarkers: 0 } },
        { label: 'native-confirmation', counts: { toolCalls: spec.server === 'agent' ? 1 : 0, mutationMarkers: 0 } },
        { label: 'recovery', counts: { toolCalls: 1, mutationMarkers: 1 } },
        { label: 'progress-after-broadcast' }, { label: 'after-cancel', screen: 'Interrupted' },
        { label: 'result', screen: `Fixture result: ${spec.outcome}; lease ${LEASE}` },
      ],
    })) };
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
