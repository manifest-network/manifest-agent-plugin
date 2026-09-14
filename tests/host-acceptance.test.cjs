'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { join, dirname } = require('node:path');
const { tmpdir } = require('node:os');
const { validateHostReport, validateRelease, codexReleaseCandidate, codexReleaseEligible, COVERAGE } = require('../ci/host-acceptance.cjs');
const { sourceHashes } = require('../ci/codex-host-smoke.cjs');
const { sha256 } = require('../ci/evidence-check.cjs');
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
  const pending = { schemaVersion: 1, pluginVersion: require('../package.json').version,
    upstreamVersion: require('../package.json').dependencies['@manifest-network/manifest-mcp-node'],
    hosts: Object.fromEntries(['claude', 'codex'].map((host) => [host, {
      interactive: { status: 'pending' }, testnet: { status: 'pending' },
    }])) };
  assert.throws(() => validateRelease(pending), /evidence is pending/);
  assert.equal(codexReleaseCandidate(pending), false, 'Pending archives need no history fetch');
  assert.equal(codexReleaseEligible(pending), false, 'Pending Codex evidence skips its archive without blocking the Claude release');
});

test('release validation binds primary and terminal evidence, provenance, preservation and cleanup', (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'manifest-release-evidence-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = join(__dirname, '..'), hashes = sourceHashes();
  const write = (file, bytes) => { fs.mkdirSync(dirname(join(root, file)), { recursive: true }); fs.writeFileSync(join(root, file), bytes); };
  const sources = Object.fromEntries(Object.keys(terminalHashes()).map((file) => [file, fs.readFileSync(join(repo, file))]));
  for (const [file, bytes] of Object.entries(sources)) write(file, bytes);
  const head = '1'.repeat(40);
  const options = { root, hashes, historicalSources: (_root, commit, scope) => {
    if (commit !== head) return null;
    const files = typeof scope === 'function' ? scope(Object.keys(sources).map((path) => ({ path, mode: '100644', type: 'blob' }))) : scope;
    return Object.fromEntries(files.map((file) => [file, sources[file]]));
  } };
  // Reuse observation shapes, but invent a self-contained release declaration
  // and source bindings for this temporary unit fixture. These are never
  // acceptance evidence. The real release record may be pending or stale;
  // release.yml validates its Codex rows before attaching the native archive.
  const pkg = require('../package.json');
  const record = { schemaVersion: 1, pluginVersion: pkg.version,
    upstreamVersion: pkg.dependencies['@manifest-network/manifest-mcp-node'], hosts: {} };
  const preservationPath = 'docs/host-evidence/current-install-preservation.json';
  const livePath = 'docs/host-evidence/live-testnet.json';
  const preservation = JSON.parse(fs.readFileSync(join(repo, preservationPath)));
  const liveFixture = JSON.parse(fs.readFileSync(join(repo, livePath)));
  for (const report of [preservation, liveFixture]) Object.assign(report, {
    head, source_status: 'historical', sourceHashes: hashes,
    pluginVersion: record.pluginVersion, upstreamVersion: record.upstreamVersion,
  });
  const cleanup = { processesStopped: true, apiClosed: true, temporaryRootRemoved: true };
  for (const host of ['claude', 'codex']) {
    const file = `docs/host-evidence/${host}-terminal-reviewed.json`;
    const terminal = JSON.parse(fs.readFileSync(join(repo, file)));
    Object.assign(terminal, { schemaVersion: 2, source_status: 'historical', head, sourceHashes: terminalHashes(root),
      pluginVersion: record.pluginVersion, upstreamPin: record.upstreamVersion, cleanup });
    for (const c of terminal.cases) c.cleanup = cleanup;
    for (const stage of Object.values(preservation.hosts[host].records)) stage.runtimeVersion = record.upstreamVersion;
    record.hosts[host] = {
      interactive: { status: 'complete', hostVersion: terminal.hostVersion, recordedAt: preservation.recordedAt,
        sourceCommit: head, sourceHashes: hashes, evidencePath: preservationPath, terminalEvidencePath: file,
        legacyUpgradeExemption: 'no-existing-users',
        cases: ['install', 'reinstall', 'runtime-repair', 'discovery', 'decline-zero-mutations', 'success', 'cancel', 'paid-partial', 'progress'] },
      testnet: { status: 'complete', hostVersion: liveFixture.hosts[host].hostVersion, recordedAt: liveFixture.recordedAt,
        sourceCommit: head, sourceHashes: hashes, evidencePath: livePath,
        chainId: liveFixture.chain.chainId, walletAddress: liveFixture.chain.walletAddress, leases: [liveFixture.hosts[host].leaseUuid],
        cases: liveFixture.hosts[host].checks.map((c) => c.name), cleanup: { verified: true, residue: 'none' } },
    };
    const bytes = JSON.stringify(terminal);
    write(file, bytes);
    preservation.terminalCoverage[host].sourceCommit = head;
    preservation.terminalCoverage[host].evidenceSha256 = sha256(bytes);
  }
  write(preservationPath, JSON.stringify(preservation));
  write(livePath, JSON.stringify(liveFixture));
  assert.doesNotThrow(() => validateRelease(record, options));
  assert.equal(codexReleaseCandidate(record, options), true);
  assert.equal(codexReleaseEligible(record, options), true);
  const codexOnly = structuredClone(record);
  codexOnly.hosts.claude = { interactive: { status: 'pending' }, testnet: { status: 'pending' } };
  assert.equal(codexReleaseEligible(codexOnly, options), true);
  assert.throws(() => validateRelease(codexOnly, options), /claude interactive evidence is pending/);
  assert.equal(codexReleaseEligible({ ...record, pluginVersion: 'old' }, options), false);
  assert.equal(codexReleaseCandidate({ ...record, pluginVersion: 'old' }, options), false);
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
  const terminalBytes = fs.readFileSync(join(root, file));
  const terminal = JSON.parse(terminalBytes);
  terminal.cases[0].modelReceivedToolResult = false;
  write(file, JSON.stringify(terminal));
  assert.throws(() => validateRelease(record, options), /Model result receipt/);
  write(file, terminalBytes);

  // Source changes still invalidate release eligibility, even though ordinary
  // unit tests no longer require the real release record to be current.
  write(`scripts/${randomUUID()}.cjs`, '');
  const changedWorkspace = { ...options, hashes: sourceHashes(root) };
  assert.throws(() => codexReleaseEligible(record, changedWorkspace), /codex\/interactive source evidence differs/);
  const pending = structuredClone(record);
  for (const row of Object.values(pending.hosts)) for (const kind of ['interactive', 'testnet']) row[kind].status = 'pending';
  assert.equal(codexReleaseEligible(pending, changedWorkspace), false);
});
