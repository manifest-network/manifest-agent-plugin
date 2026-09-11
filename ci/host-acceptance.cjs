#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { resolve, join, relative, isAbsolute } = require('node:path');
const { sourceHashes } = require('./codex-host-smoke.cjs');
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

function validateHostReport(report, { root = ROOT, hashes = sourceHashes(root) } = {}) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.evidenceKind, 'codex-app-server-local-fixture');
  assert.equal(report.hostVersion, 'codex-cli 0.153.4');
  assert.ok(Number.isFinite(Date.parse(report.observedAt)), 'Missing observation date');
  assert.deepEqual(report.sourceHashes, hashes, 'Codex host evidence is stale; rerun ci/codex-host-smoke.cjs');
  assert.equal(report.pluginVersion, JSON.parse(fs.readFileSync(join(root, 'package.json'))).version);
  assert.equal(report.upstreamPin, JSON.parse(fs.readFileSync(join(root, 'package.json'))).dependencies['@manifest-network/manifest-mcp-node']);
  assert.deepEqual(report.servers, ['manifest-agent', 'manifest-chain', 'manifest-cosmwasm', 'manifest-fred', 'manifest-lease']);
  assert.deepEqual(report.skills, fs.readdirSync(join(root, 'workflows')).map((file) => `manifest-agent:${file.slice(0, -3)}`).sort());
  assert.equal(report.cases.length, CASES.length);
  for (let i = 0; i < CASES.length; i++) {
    const [name, mutationMarkers, outcome] = CASES[i];
    assert.deepEqual(report.cases[i], { name, passed: true, mutationMarkers, ...(outcome ? { outcome } : {}) });
  }
  assert.deepEqual(report.prompts.map((prompt) => prompt.action), ['decline', 'decline', 'cancel', 'accept', 'accept', 'accept', 'decline']);
  assert.ok(report.prompts.every((prompt) => prompt.mode === 'form'));
  assert.ok(report.limitations.length >= 3 && report.cleanup, 'Fixture limitations and cleanup must remain explicit');
}

function validateRelease(record, { root = ROOT, hashes = sourceHashes(root) } = {}) {
  const pkg = JSON.parse(fs.readFileSync(join(root, 'package.json')));
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.pluginVersion, pkg.version, 'Release evidence package version differs');
  assert.equal(record.upstreamVersion, pkg.dependencies['@manifest-network/manifest-mcp-node']);
  for (const host of ['claude', 'codex']) for (const kind of ['interactive', 'testnet']) {
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

function main(argv = process.argv.slice(2)) {
  if (argv.length && (argv.length !== 1 || argv[0] !== '--release')) throw new Error('Usage: node ci/host-acceptance.cjs [--release]');
  const report = JSON.parse(fs.readFileSync(join(ROOT, 'docs/host-evidence/codex-app-server.json')));
  validateHostReport(report);
  if (argv[0]) validateRelease(JSON.parse(fs.readFileSync(join(ROOT, 'docs/host-acceptance-release.json'))));
  console.log(`host-acceptance: current Codex fixture evidence verified${argv[0] ? '; declared interactive/testnet release coverage verified' : '; UI/live release coverage remains separately gated'}`);
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { validateHostReport, validateRelease, COVERAGE };
