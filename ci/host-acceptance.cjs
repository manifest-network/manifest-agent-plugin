#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { resolve, join, relative, isAbsolute } = require('node:path');
const { sourceHashes } = require('./codex-host-smoke.cjs');
const { workflowFiles } = require('./build-packages.cjs');
const { readHistoricalSources, sha256 } = require('./evidence-check.cjs');
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
  assert.ok(['current', 'historical'].includes(report.source_status), 'Evidence must explicitly be current or historical');
  if (requireCurrent) assert.equal(report.source_status, 'current', 'Fresh current Codex host evidence is required');
  assert.ok(report.sourceHashes && typeof report.sourceHashes === 'object' && !Array.isArray(report.sourceHashes));
  const files = Object.keys(report.sourceHashes);
  assert.ok(files.includes('package.json') && files.includes('ci/codex-host-smoke.cjs') && files.includes('scripts/codex-server.cjs'), 'Missing core source provenance');
  assert.ok(files.every((file) => /^[a-zA-Z0-9_./-]+$/.test(file) && !isAbsolute(file) && !file.split('/').includes('..')));
  assert.ok(Object.values(report.sourceHashes).every((hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)), 'Invalid source hashes');
  let verification = 'workspace';
  let pkg;
  let skills;
  if (report.source_status === 'current') {
    assert.deepEqual(report.sourceHashes, hashes || sourceHashes(root), 'Codex host evidence is stale; rerun ci/codex-host-smoke.cjs');
    pkg = JSON.parse(fs.readFileSync(join(root, 'package.json')));
    skills = workflowFiles(root).map((file) => `manifest-agent:${file.slice(0, -3)}`);
  } else {
    assert.match(report.head || '', /^[a-f0-9]{40}$/, 'Historical evidence needs its full recorded commit');
    const sources = historicalSources(root, report.head, files);
    if (requireHistory) assert.ok(sources, 'Historical source commit unavailable; fetch it before --require-history validation');
    verification = sources ? 'commit' : 'metadata-only';
    if (sources) {
      for (const file of files) assert.equal(sha256(sources[file]), report.sourceHashes[file], `Historical source differs: ${file}`);
      pkg = JSON.parse(sources['package.json']);
    }
    skills = files.filter((file) => /^workflows\/[^/]+\.md$/.test(file)).map((file) => `manifest-agent:${file.slice(10, -3)}`);
  }
  if (pkg) {
    assert.equal(report.pluginVersion, pkg.version);
    assert.equal(report.upstreamPin, pkg.dependencies['@manifest-network/manifest-mcp-node']);
  }
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
  assert.ok(report.limitations.length >= 3 && report.cleanup, 'Fixture limitations and cleanup must remain explicit');
  return { status: report.source_status, verification };
}

function validateRelease(record, { root = ROOT, hashes = sourceHashes(root), hosts = ['claude', 'codex'] } = {}) {
  const pkg = JSON.parse(fs.readFileSync(join(root, 'package.json')));
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.pluginVersion, pkg.version, 'Release evidence package version differs');
  assert.equal(record.upstreamVersion, pkg.dependencies['@manifest-network/manifest-mcp-node']);
  for (const host of hosts) for (const kind of ['interactive', 'testnet']) {
    const row = record.hosts?.[host]?.[kind];
    assert.equal(row?.status, 'complete', `${host} ${kind} evidence is pending; see docs/host-acceptance.md`);
    assert.ok(row.hostVersion && Number.isFinite(Date.parse(row.recordedAt)), `${host}/${kind} version/date missing`);
    assert.deepEqual(row.sourceHashes, hashes, `${host}/${kind} source evidence differs`);
    assert.deepEqual([...row.cases].sort(), [...COVERAGE[kind]].sort(), `${host}/${kind} coverage incomplete`);
    assert.equal(typeof row.evidencePath, 'string', 'Evidence must reference a repository file');
    const path = resolve(root, row.evidencePath);
    const rel = relative(root, path);
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), 'Evidence path must be inside the repository');
    assert.ok(fs.statSync(path).isFile() && fs.statSync(path).size > 0, 'Evidence file is missing or empty');
    if (kind === 'testnet') {
      assert.ok(row.chainId && row.walletAddress && Array.isArray(row.leases) && row.leases.length, 'Testnet resource identities missing');
      assert.ok(row.cleanup?.verified === true && row.cleanup?.residue === 'none', 'Testnet cleanup is incomplete');
    }
  }
}

function codexReleaseEligible(record, { root = ROOT, hashes } = {}) {
  const pkg = JSON.parse(fs.readFileSync(join(root, 'package.json')));
  assert.equal(record.schemaVersion, 1);
  for (const kind of ['interactive', 'testnet']) {
    assert.ok(['pending', 'complete'].includes(record.hosts?.codex?.[kind]?.status), `Invalid codex/${kind} evidence status`);
  }
  if (record.pluginVersion !== pkg.version || record.upstreamVersion !== pkg.dependencies['@manifest-network/manifest-mcp-node']
    || !Object.keys(COVERAGE).every((kind) => record.hosts.codex[kind].status === 'complete')) return false;
  validateRelease(record, { root, hashes, hosts: ['codex'] });
  return true;
}

function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--codex-release-status') {
    const eligible = codexReleaseEligible(JSON.parse(fs.readFileSync(join(ROOT, 'docs/host-acceptance-release.json'))));
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
    else throw new Error('Usage: node ci/host-acceptance.cjs [--report <file>] [--require-current|--require-history] [--release] or --codex-release-status');
  }
  const result = validateHostReport(JSON.parse(fs.readFileSync(reportPath)), options);
  if (release) validateRelease(JSON.parse(fs.readFileSync(join(ROOT, 'docs/host-acceptance-release.json'))));
  console.log(`host-acceptance: ${result.status} Codex fixture evidence; ${result.verification === 'metadata-only'
    ? 'metadata only; source commit unavailable locally, historical bytes NOT verified'
    : `${result.verification} hashes verified`}${release ? '; both hosts have declared interactive/testnet coverage' : ''}`);
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { validateHostReport, validateRelease, codexReleaseEligible, COVERAGE };
