'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { validateHostReport, validateRelease, codexReleaseEligible, COVERAGE } = require('../ci/host-acceptance.cjs');
const { sourceHashes } = require('../ci/codex-host-smoke.cjs');
const { workflowFiles } = require('../ci/build-packages.cjs');

const recorded = () => JSON.parse(fs.readFileSync(join(__dirname, '../docs/host-evidence/codex-app-server.json')));
const unitRecord = () => ({ ...recorded(), pluginVersion: require('../package.json').version,
  upstreamPin: require('../package.json').dependencies['@manifest-network/manifest-mcp-node'],
  skills: workflowFiles().map((file) => `manifest-agent:${file.slice(0, -3)}`).sort(), sourceHashes: sourceHashes() });

test('historical native host evidence retains its commit and rejects altered observations', () => {
  assert.equal(validateHostReport(recorded()).status, 'historical');
  // Synthetic unit history avoids requiring old PR commits in shallow clones.
  const hashes = sourceHashes();
  const sources = Object.fromEntries(Object.keys(hashes).map((file) => [file, fs.readFileSync(join(__dirname, '..', file))]));
  const report = unitRecord();
  const options = { requireHistory: true, historicalSources: () => sources };
  assert.equal(validateHostReport(report, options).verification, 'commit');
  for (const alter of [
    (r) => { r.cases[0].mutationMarkers = 1; },
    (r) => { r.cases.pop(); },
    (r) => { r.prompts[0].action = 'accept'; },
    (r) => { r.servers.pop(); },
    (r) => { r.skills[0] = 'missing'; },
    (r) => { r.hostVersion = 'unknown'; },
    (r) => { r.sourceHashes['scripts/codex-server.cjs'] = '0'.repeat(64); },
    (r) => { r.limitations = []; },
  ]) {
    const changed = structuredClone(report);
    alter(changed);
    assert.throws(() => validateHostReport(changed, options));
  }
});

test('historical evidence permits workspace drift without masquerading as a current run', () => {
  const report = recorded();
  assert.equal(validateHostReport(report, { hashes: { 'unrelated-change': 'different' } }).status, 'historical');
  assert.throws(() => validateHostReport(report, { requireCurrent: true }), /Fresh current/);
  assert.equal(validateHostReport(report, { historicalSources: () => null }).verification, 'metadata-only');
  assert.throws(() => validateHostReport(report, { historicalSources: () => null, requireHistory: true }), /commit unavailable/);
  for (const head of ['short', '', '0'.repeat(39)]) assert.throws(() => validateHostReport({ ...report, head }), /full recorded commit/);
});

test('fresh reports must cover the current checkout including package versions and workflow inventory', () => {
  // A synthetic unit record, never written as observed host evidence.
  const report = { ...unitRecord(), source_status: 'current' };
  assert.equal(validateHostReport(report, { requireCurrent: true }).verification, 'workspace');
  for (const alter of [
    (r) => { r.sourceHashes['scripts/_io.cjs'] = '0'.repeat(64); },
    (r) => { delete r.sourceHashes['workflows/balance.md']; },
    (r) => { r.pluginVersion = 'other'; },
    (r) => { r.upstreamPin = 'other'; },
    (r) => { delete r.source_status; },
  ]) {
    const changed = structuredClone(report);
    alter(changed);
    assert.throws(() => validateHostReport(changed, { requireCurrent: true }));
  }
});

test('compatibility release stays blocked on the explicitly pending interactive/live evidence', () => {
  const pending = structuredClone(require('../docs/host-acceptance-release.json'));
  pending.pluginVersion = require('../package.json').version;
  pending.upstreamVersion = require('../package.json').dependencies['@manifest-network/manifest-mcp-node'];
  pending.hosts.claude.interactive = { status: 'pending' };
  assert.throws(() => validateRelease(pending), /evidence is pending/);
  assert.equal(codexReleaseEligible(pending), false, 'Pending Codex evidence skips its archive without blocking the Claude release');
});

test('release validation requires source-bound coverage, repository evidence files and verified cleanup', (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'manifest-release-evidence-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = require('../package.json');
  fs.writeFileSync(join(root, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(join(root, 'test-only-transcript.md'), 'Unit fixture only. This is not release evidence.');
  const hashes = { fixture: '123' };
  const record = { schemaVersion: 1, pluginVersion: pkg.version, upstreamVersion: pkg.dependencies['@manifest-network/manifest-mcp-node'], hosts: {} };
  for (const host of ['claude', 'codex']) {
    record.hosts[host] = {};
    for (const kind of ['interactive', 'testnet']) record.hosts[host][kind] = {
      status: 'complete', hostVersion: 'unit-fixture', recordedAt: '2026-09-11T00:00:00Z', sourceHashes: hashes,
      cases: COVERAGE[kind], evidencePath: 'test-only-transcript.md', chainId: 'fixture', walletAddress: 'public-fixture',
      leases: ['fixture'], cleanup: { verified: true, residue: 'none' },
    };
  }
  assert.doesNotThrow(() => validateRelease(record, { root, hashes }));
  const codexOnly = structuredClone(record);
  codexOnly.hosts.claude = { interactive: { status: 'pending' }, testnet: { status: 'pending' } };
  assert.equal(codexReleaseEligible(codexOnly, { root, hashes }), true);
  assert.throws(() => validateRelease(codexOnly, { root, hashes }), /claude interactive evidence is pending/);
  const staleVersion = { ...codexOnly, pluginVersion: 'old' };
  assert.equal(codexReleaseEligible(staleVersion, { root, hashes }), false);
  const malformed = structuredClone(codexOnly);
  malformed.hosts.codex.testnet.cleanup.residue = 'paid-lease';
  assert.throws(() => codexReleaseEligible(malformed, { root, hashes }), /cleanup is incomplete/);
  for (const alter of [
    (r) => { r.pluginVersion = 'other'; },
    (r) => { r.hosts.codex.interactive.sourceHashes = {}; },
    (r) => { r.hosts.codex.interactive.cases = ['install']; },
    (r) => { r.hosts.codex.testnet.cleanup.residue = 'paid-lease'; },
    (r) => { r.hosts.claude.testnet.leases = []; },
    (r) => { r.hosts.claude.interactive.evidencePath = '../outside.md'; },
  ]) {
    const changed = structuredClone(record);
    alter(changed);
    assert.throws(() => validateRelease(changed, { root, hashes }));
  }
});
