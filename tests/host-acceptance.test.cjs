'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join, dirname } = require('node:path');
const { tmpdir } = require('node:os');
const { validateHostReport, validateRelease, codexReleaseEligible, COVERAGE } = require('../ci/host-acceptance.cjs');
const { sourceHashes } = require('../ci/codex-host-smoke.cjs');
const { readHistoricalSources, sha256 } = require('../ci/evidence-check.cjs');
const { hashes: terminalHashes } = require('../ci/terminal-host-smoke.cjs');
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
  assert.equal(validateHostReport(report, { hashes: Object.fromEntries(Object.keys(sourceHashes()).map((p) => [p, '0'.repeat(64)])) }).status, 'historical');
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
  pending.hosts.codex.interactive = { status: 'pending' };
  assert.throws(() => validateRelease(pending), /evidence is pending/);
  assert.equal(codexReleaseEligible(pending), false, 'Pending Codex evidence skips its archive without blocking the Claude release');
});

test('release validation binds primary and terminal evidence, provenance, preservation and cleanup', (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'manifest-release-evidence-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = join(__dirname, '..'), hashes = sourceHashes();
  const options = { root, hashes, historicalSources: (_root, head, files) => readHistoricalSources(repo, head, files) };
  const record = structuredClone(require('../docs/host-acceptance-release.json'));
  const write = (file, bytes) => { fs.mkdirSync(dirname(join(root, file)), { recursive: true }); fs.writeFileSync(join(root, file), bytes); };
  for (const file of Object.keys(terminalHashes())) write(file, fs.readFileSync(join(repo, file)));
  for (const row of Object.values(record.hosts)) for (const kind of ['interactive', 'testnet']) {
    write(row[kind].evidencePath, fs.readFileSync(join(repo, row[kind].evidencePath)));
  }
  const preservationPath = record.hosts.claude.interactive.evidencePath;
  const preservation = JSON.parse(fs.readFileSync(join(root, preservationPath)));
  const cleanup = { processesStopped: true, apiClosed: true, temporaryRootRemoved: true };
  for (const host of ['claude', 'codex']) {
    const file = record.hosts[host].interactive.terminalEvidencePath;
    const terminal = JSON.parse(fs.readFileSync(join(repo, file)));
    // Synthetic cleanup observations are used only in this temporary unit
    // fixture. Actual v1 archives retain their unverified cleanup claim.
    terminal.schemaVersion = 2; terminal.cleanup = cleanup;
    for (const c of terminal.cases) c.cleanup = cleanup;
    const bytes = JSON.stringify(terminal);
    write(file, bytes);
    preservation.terminalCoverage[host].evidenceSha256 = sha256(bytes);
  }
  write(preservationPath, JSON.stringify(preservation));
  assert.doesNotThrow(() => validateRelease(record, options));
  assert.equal(codexReleaseEligible(record, options), true);
  const codexOnly = structuredClone(record);
  codexOnly.hosts.claude = { interactive: { status: 'pending' }, testnet: { status: 'pending' } };
  assert.equal(codexReleaseEligible(codexOnly, options), true);
  assert.throws(() => validateRelease(codexOnly, options), /claude interactive evidence is pending/);
  assert.equal(codexReleaseEligible({ ...record, pluginVersion: 'old' }, options), false);
  for (const alter of [
    (r) => { r.pluginVersion = 'other'; },
    (r) => { r.hosts.codex.interactive.sourceHashes = {}; },
    (r) => { r.hosts.codex.interactive.cases = ['install']; },
    (r) => { r.hosts.codex.testnet.cleanup.residue = 'paid-lease'; },
    (r) => { r.hosts.claude.testnet.leases = []; },
    (r) => { r.hosts.claude.interactive.evidencePath = '../outside.md'; },
    (r) => { r.hosts.claude.interactive.terminalEvidencePath = '../../missing.json'; },
    (r) => { r.hosts.codex.interactive.terminalEvidencePath = null; },
    (r) => { delete r.hosts.codex.interactive.legacyUpgradeExemption; },
    (r) => { r.hosts.codex.interactive.legacyUpgradeExemption = 'skip'; },
    (r) => { r.hosts.codex.testnet.legacyUpgradeExemption = 'no-existing-users'; },
    (r) => { r.hosts.codex.interactive.cases = COVERAGE.interactive; },
    (r) => { r.hosts.codex.interactive.cases = r.hosts.codex.interactive.cases.filter((c) => c !== 'reinstall'); },
    (r) => { r.hosts.codex.interactive.cases = r.hosts.codex.interactive.cases.filter((c) => c !== 'runtime-repair'); },
  ]) {
    const changed = structuredClone(record); alter(changed);
    assert.throws(() => validateRelease(changed, options));
  }
  assert.throws(() => validateRelease(record, { ...options, historicalSources: () => null }), /commit unavailable/);
  const upgrade = COVERAGE.interactive.indexOf('upgrade');
  try {
    COVERAGE.interactive[upgrade] = 'migrate';
    assert.throws(() => validateRelease(record, options), /requires an upgrade coverage entry/);
  } finally { COVERAGE.interactive[upgrade] = 'upgrade'; }
  for (const alter of [
    (p) => { delete p.head; },
    (p) => { p.head = '0'.repeat(40); },
    (p) => { p.evidenceKind = 'text-note'; },
    (p) => { delete p.sourceHashes['scripts/pre-tool-use.cjs']; },
    (p) => { p.sourceHashes['scripts/_io.cjs'] = '0'.repeat(64); },
    (p) => { p.hosts.codex.records.repaired.files['config.json'].sha256 = '0'.repeat(64); },
    (p) => { p.hosts.codex.records.repaired.offlineKeyDecryptionAndSigning = false; },
    (p) => { delete p.hosts.codex.records.uninstalled; },
    (p) => { p.hosts.claude.reinstallCommands[0].command = ['claude', 'plugin', 'uninstall', 'manifest-agent']; },
    (p) => { p.hosts.codex.phases.repaired.toolOutput = []; },
    (p) => { p.hosts.codex.runtimeRepair.after.ready = true; },
    (p) => { p.cleanup.verified = false; },
    (p) => { p.terminalCoverage.codex.evidenceSha256 = '0'.repeat(64); },
  ]) {
    const changed = structuredClone(preservation); alter(changed);
    write(preservationPath, JSON.stringify(changed));
    assert.throws(() => validateRelease(record, options));
  }
  write(preservationPath, JSON.stringify(preservation));
  const livePath = record.hosts.codex.testnet.evidencePath;
  const live = JSON.parse(fs.readFileSync(join(root, livePath)));
  for (const alter of [
    (r) => { r.hosts.codex.leaseUuid = 'unrelated'; },
    (r) => { r.hosts.codex.checks[0].passed = false; },
    (r) => { r.cleanup.activeLeases = 1; },
    (r) => { r.chain.walletAddress = 'unrelated'; },
  ]) {
    const changed = structuredClone(live); alter(changed); write(livePath, JSON.stringify(changed));
    assert.throws(() => validateRelease(record, options));
  }
  write(livePath, JSON.stringify(live));
  const file = record.hosts.codex.interactive.terminalEvidencePath;
  const terminal = JSON.parse(fs.readFileSync(join(root, file)));
  terminal.cases[0].modelReceivedToolResult = false;
  write(file, JSON.stringify(terminal));
  assert.throws(() => validateRelease(record, options), /Model result receipt/);
});
