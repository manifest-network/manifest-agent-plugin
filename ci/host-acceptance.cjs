#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { resolve, join, relative, isAbsolute } = require('node:path');
const { sourceHashes } = require('./codex-host-smoke.cjs');
const { validateReport: validateTerminalReport, hashes: terminalHashes } = require('./terminal-host-smoke.cjs');
const { readHistoricalSources, verifyProvenance, fetchEvidenceHistory, sha256 } = require('./evidence-check.cjs');
const ROOT = resolve(__dirname, '..');
const CASES = [
  ['direct-decline', 0, 'OPERATION_CANCELLED'], ['orchestrated-decline', 0, 'OPERATION_CANCELLED'],
  ['orchestrated-cancel', 0, 'OPERATION_CANCELLED'], ['direct-success', 1, 'complete'],
  ['orchestrated-success', 1, 'complete'], ['paid-partial-recovery-decline', 1, 'partial'],
  ['read-only-discovery', 0, 'read_only'], ['reinstall-preserves-config', 0, undefined],
];
const COVERAGE = {
  interactive: ['install', 'upgrade', 'discovery', 'decline-zero-mutations', 'success', 'cancel', 'paid-partial', 'progress'],
  testnet: ['author', 'validate', 'deploy', 'status', 'troubleshoot', 'domain', 'restart', 'balance', 'providers', 'saved-records', 'cleanup'],
};

function validateHostReport(report, { root = ROOT, hashes, requireCurrent = false,
  requireHistory = false, historicalSources = readHistoricalSources } = {}) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.evidenceKind, 'codex-app-server-local-fixture');
  assert.equal(report.hostVersion, 'codex-cli 0.153.4');
  assert.ok(Number.isFinite(Date.parse(report.observedAt)), 'Missing observation date');
  const expected = hashes || sourceHashes(root);
  const { verification } = verifyProvenance(report, { root, files: Object.keys(expected), currentHashes: expected,
    requireCurrent, requireHistory, historicalSources });
  const skills = Object.keys(expected).filter((file) => /^workflows\/[^/]+\.md$/.test(file))
    .map((file) => `manifest-agent:${file.slice(10, -3)}`);
  assert.deepEqual(report.servers, ['manifest-agent', 'manifest-chain', 'manifest-cosmwasm', 'manifest-fred', 'manifest-lease']);
  assert.ok(skills.length > 0, 'Missing workflow provenance');
  assert.deepEqual(report.skills, skills.sort());
  assert.equal(report.cases.length, CASES.length);
  for (let i = 0; i < CASES.length; i++) {
    const [name, mutationMarkers, outcome] = CASES[i];
    assert.deepEqual(report.cases[i], { name, passed: true, mutationMarkers, ...(outcome ? { outcome } : {}) });
  }
  assert.deepEqual(report.prompts.map((prompt) => prompt.action), ['decline', 'decline', 'cancel', 'accept', 'accept', 'accept', 'decline']);
  assert.ok(report.prompts.every((prompt) => prompt.mode === 'form'));
  assert.ok(Array.isArray(report.limitations) && report.limitations.length >= 3 && report.cleanup, 'Fixture limitations and cleanup must remain explicit');
  return { status: report.source_status, verification };
}

function readEvidence(root, evidencePath) {
  assert.equal(typeof evidencePath, 'string', 'Evidence must reference a repository file');
  const file = resolve(root, evidencePath);
  const inside = (target) => { const rel = relative(fs.realpathSync(root), target); return rel && !rel.startsWith('..') && !isAbsolute(rel); };
  assert.ok(inside(file) && inside(fs.realpathSync(file)), 'Evidence path must be inside the repository');
  assert.ok(fs.statSync(file).isFile(), 'Evidence must be a file');
  const bytes = fs.readFileSync(file);
  return { bytes, report: JSON.parse(bytes) };
}

function hasBankModules(value) {
  if (typeof value === 'string') { try { return hasBankModules(JSON.parse(value)); } catch { return false; } }
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value.queryModules) && value.queryModules.some((m) => m.name === 'bank') && Array.isArray(value.txModules)) return true;
  return Object.values(value).some(hasBankModules);
}

function validatePreservation(report, { host, row, terminal, terminalBytes }) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.evidenceKind, 'current-install-preservation');
  assert.equal(report.recordedAt, row.recordedAt, 'Preservation observation date differs');
  assert.equal(report.head, row.sourceCommit, 'Preservation source commit differs');
  assert.equal(report.scope.legacyUpgradeExemption, row.legacyUpgradeExemption);
  const observed = report.hosts[host];
  assert.equal(observed.hostVersion, row.hostVersion);
  assert.equal(new Set(Object.values(report.hosts).map((h) => h.dataRoot)).size, 2, 'Host data roots must differ');
  const stages = ['baseline', 'after-startup', 'uninstalled', 'after-install', 'reinstalled', 'repaired'];
  assert.deepEqual(Object.keys(observed.records).sort(), [...stages].sort(), 'Preservation stages incomplete');
  const baseline = observed.records.baseline;
  const paths = Object.keys(baseline.files);
  assert.equal(paths.length, 7, 'Seven preserved files required');
  for (const [pattern, count] of [[/^config\.json$/, 1], [/^keys\/[^/]+\.json$/, 1], [/^chains\/[^/]+\.json$/, 1],
    [/^manifests-drafts\/[^/]+\.json$/, 1], [/^manifests\/[^/]+\.json$/, 2], [/^journal\/[^/]+\.jsonl$/, 1]]) {
    assert.equal(paths.filter((file) => pattern.test(file)).length, count, 'Preserved file categories differ');
  }
  for (const file of Object.values(baseline.files)) {
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(file.bytes) && file.bytes > 0);
    assert.equal(file.mode, '600');
  }
  for (const stage of stages) {
    const result = observed.records[stage];
    assert.equal(result.stage, stage);
    assert.equal(result.host, host);
    assert.equal(result.address, observed.walletAddress);
    assert.deepEqual(result.files, baseline.files, `${host}/${stage} preserved files differ`);
    assert.equal(result.activeChain, baseline.activeChain);
    assert.equal(result.gasPrice, baseline.gasPrice);
    for (const field of ['exactBytesAndModesPreserved', 'offlineKeyDecryptionAndSigning', 'canaryRedacted', 'runtimeReady']) assert.equal(result[field], true, `${stage}/${field} missing`);
    assert.equal(result.runtimeVersion, report.upstreamVersion);
    assert.deepEqual(result.savedManifests.map((m) => m.schema_version).sort(), [2, 3]);
    assert.deepEqual(result.savedManifests, baseline.savedManifests);
    assert.equal(result.journalRecords, 1);
    assert.equal(result.summaries.length, 2);
    assert.ok(result.summaries.every((summary) => summary.includes('ACCEPTANCE_CANARY') && summary.includes('redacted')));
  }
  assert.deepEqual(Object.keys(observed.phases).sort(), ['baseline', 'reinstalled', 'repaired'].sort());
  for (const [phase, result] of Object.entries(observed.phases)) {
    assert.equal(result.phase, phase);
    assert.equal(result.host, host);
    assert.equal(result.tool, 'list_modules');
    assert.equal(result.readOnlyProbePassed, true);
    assert.equal(result.normalPermissions, true);
    assert.ok(hasBankModules(result.toolOutput), 'Missing actual read-only module result');
    assert.ok(result.screens.some((s) => s.label === 'probe-result' && s.screen.includes('bank')));
  }
  const commands = observed.reinstallCommands;
  assert.equal(commands.length, 4);
  assert.ok(commands.every((c) => c.exitCode === 0), 'Native reinstall command failed');
  assert.deepEqual(commands[0].command.slice(0, 3), [host, 'plugin', host === 'claude' ? 'uninstall' : 'remove']);
  if (host === 'claude') assert.ok(commands[0].command.includes('--keep-data'), 'Claude reinstall must retain data');
  assert.deepEqual(commands[2].command.slice(0, 3), [host, 'plugin', host === 'claude' ? 'install' : 'add']);
  assert.equal(commands[0].command[3], commands[2].command[3], 'Reinstall changed plugin identity');
  assert.equal(commands[1].command.at(-1), 'uninstalled');
  assert.equal(commands[3].command.at(-1), 'after-install');
  const repair = observed.runtimeRepair;
  assert.equal(repair.relative, 'node_modules/@manifest-network/manifest-mcp-node/package.json');
  assert.equal(repair.before.ready, true);
  assert.equal(repair.after.ready, false);
  assert.equal(repair.afterRepair.ready, true);
  assert.equal(repair.completionRecordLeftInPlace, true);
  assert.match(repair.originalSha256, /^[a-f0-9]{64}$/);
  assert.equal(repair.originalSha256, repair.restoredSha256);
  assert.ok(report.cleanup.verified && report.cleanup.temporaryProfilesRemoved && report.cleanup.temporaryWalletKeysAndPasswordsRemoved);
  assert.equal(report.cleanup.ownedProcessesRemaining, 0);
  assert.equal(report.cleanup.residue, 'none');
  const link = report.terminalCoverage[host];
  assert.equal(link.evidencePath, row.terminalEvidencePath, 'Terminal evidence link differs');
  assert.equal(link.evidenceSha256, sha256(terminalBytes), 'Terminal evidence digest differs');
  assert.equal(link.sourceCommit, terminal.head, 'Terminal evidence commit differs');
  assert.deepEqual(link.cases, terminal.cases.map((c) => c.name), 'Terminal coverage differs');
}

function validateRelease(record, { root = ROOT, hashes = sourceHashes(root), hosts = ['claude', 'codex'],
  historicalSources = readHistoricalSources } = {}) {
  const pkg = JSON.parse(fs.readFileSync(join(root, 'package.json')));
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.pluginVersion, pkg.version, 'Release evidence package version differs');
  assert.equal(record.upstreamVersion, pkg.dependencies['@manifest-network/manifest-mcp-node']);
  for (const host of hosts) for (const kind of ['interactive', 'testnet']) {
    const row = record.hosts?.[host]?.[kind];
    assert.equal(row?.status, 'complete', `${host} ${kind} evidence is pending; see docs/host-acceptance.md`);
    assert.ok(row.hostVersion && Number.isFinite(Date.parse(row.recordedAt)), `${host}/${kind} version/date missing`);
    assert.deepEqual(row.sourceHashes, hashes, `${host}/${kind} source evidence differs`);
    const coverage = [...COVERAGE[kind]];
    if (row.legacyUpgradeExemption !== undefined) {
      assert.equal(kind, 'interactive', 'Legacy upgrade exemption applies only to interactive evidence');
      assert.equal(row.legacyUpgradeExemption, 'no-existing-users', 'Unrecognized legacy upgrade exemption');
      // The release record explicitly declares that no legacy users need a
      // migration. Require current-install preservation and repair instead.
      const upgradeIndex = coverage.indexOf('upgrade');
      assert.ok(upgradeIndex >= 0, 'Upgrade exemption requires an upgrade coverage entry');
      coverage.splice(upgradeIndex, 1, 'reinstall', 'runtime-repair');
    }
    assert.deepEqual([...row.cases].sort(), coverage.sort(), `${host}/${kind} coverage incomplete`);
    const { report } = readEvidence(root, row.evidencePath);
    verifyProvenance(report, { root, files: Object.keys(hashes), currentHashes: hashes,
      historicalSources, requireHistory: true, upstreamField: 'upstreamVersion' });
    assert.deepEqual(report.sourceHashes, hashes, `${host}/${kind} primary evidence is stale`);
    if (kind === 'interactive') {
      const terminal = readEvidence(root, row.terminalEvidencePath);
      validateTerminalReport(terminal.report, { root, requireHistory: true, requireCleanup: true, historicalSources });
      assert.equal(terminal.report.host, host, 'Wrong host terminal evidence');
      assert.equal(terminal.report.hostVersion, row.hostVersion);
      for (const [file, hash] of Object.entries(hashes)) assert.equal(terminal.report.sourceHashes[file], hash, `Terminal runtime source differs: ${file}`);
      validatePreservation(report, { host, row, terminal: terminal.report, terminalBytes: terminal.bytes });
    }
    if (kind === 'testnet') {
      assert.ok(row.chainId && row.walletAddress && Array.isArray(row.leases) && row.leases.length, 'Testnet resource identities missing');
      assert.ok(row.cleanup?.verified === true && row.cleanup?.residue === 'none', 'Testnet cleanup is incomplete');
      assert.equal(report.evidenceKind, 'real-cli-live-testnet-local-model-driver');
      assert.equal(report.head, row.sourceCommit);
      assert.equal(report.recordedAt, row.recordedAt);
      assert.equal(report.chain.chainId, row.chainId);
      assert.equal(report.chain.walletAddress, row.walletAddress);
      assert.equal(report.hosts[host].hostVersion, row.hostVersion);
      assert.deepEqual([report.hosts[host].leaseUuid], row.leases);
      assert.deepEqual(report.hosts[host].checks.map((c) => c.name).sort(), [...COVERAGE.testnet].sort());
      assert.ok(report.hosts[host].checks.every((c) => c.passed === true));
      assert.equal(report.cleanup.verifiedResources, true);
      assert.equal(report.cleanup.resourceResidue, 'none');
      assert.equal(report.cleanup.activeLeases, 0);
      assert.equal(report.cleanup.pendingLeases, 0);
      assert.ok(report.cleanup.temporaryKeyMaterialRemoved && report.cleanup.ownedHostProcessesStopped);
    }
  }
}

function codexReleaseCandidate(record, { root = ROOT } = {}) {
  const pkg = JSON.parse(fs.readFileSync(join(root, 'package.json')));
  assert.equal(record.schemaVersion, 1);
  for (const kind of ['interactive', 'testnet']) {
    assert.ok(['pending', 'complete'].includes(record.hosts?.codex?.[kind]?.status), `Invalid codex/${kind} evidence status`);
  }
  return record.pluginVersion === pkg.version && record.upstreamVersion === pkg.dependencies['@manifest-network/manifest-mcp-node']
    && Object.keys(COVERAGE).every((kind) => record.hosts.codex[kind].status === 'complete');
}

function codexReleaseEligible(record, { root = ROOT, hashes, historicalSources } = {}) {
  if (!codexReleaseCandidate(record, { root })) return false;
  validateRelease(record, { root, hashes, historicalSources, hosts: ['codex'] });
  return true;
}

function main(argv = process.argv.slice(2)) {
  if (argv[0] === '--codex-release-status' && (argv.length === 1 || (argv.length === 2 && argv[1] === '--fetch-history'))) {
    const record = JSON.parse(fs.readFileSync(join(ROOT, 'docs/host-acceptance-release.json')));
    // Ineligible archives still skip successfully, without fetching unrelated
    // historical evidence. Only this explicit CLI flag permits network access.
    if (argv.includes('--fetch-history') && codexReleaseCandidate(record)) fetchEvidenceHistory(ROOT);
    const eligible = codexReleaseEligible(record);
    if (!eligible) console.error('Codex archive skipped: interactive/testnet evidence is pending or belongs to another version.');
    console.log(`eligible=${eligible}`);
    return;
  }
  let reportPath = join(ROOT, 'docs/host-evidence/codex-app-server.json');
  const options = {};
  let release = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--report' && argv[i + 1]) reportPath = resolve(argv[++i]);
    else if (argv[i] === '--require-current') options.requireCurrent = true;
    else if (argv[i] === '--require-history') options.requireHistory = true;
    else if (argv[i] === '--release') { release = true; options.requireCurrent = true; }
    else throw new Error('Usage: node ci/host-acceptance.cjs [--report <file>] [--require-current|--require-history] [--release] or --codex-release-status [--fetch-history]');
  }
  const result = validateHostReport(JSON.parse(fs.readFileSync(reportPath)), options);
  if (release) validateRelease(JSON.parse(fs.readFileSync(join(ROOT, 'docs/host-acceptance-release.json'))));
  console.log(`host-acceptance: ${result.status} Codex fixture evidence; ${result.verification === 'metadata-only'
    ? 'metadata only; source commit unavailable locally, historical bytes NOT verified'
    : `${result.verification} hashes verified`}${release ? '; both hosts have declared interactive/testnet coverage' : ''}`);
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { validateHostReport, validateRelease, codexReleaseCandidate, codexReleaseEligible, validatePreservation, COVERAGE };
