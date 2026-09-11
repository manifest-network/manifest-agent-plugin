'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { validateHostReport, validateRelease, COVERAGE } = require('../ci/host-acceptance.cjs');

const recorded = () => JSON.parse(fs.readFileSync(join(__dirname, '../docs/host-evidence/codex-app-server.json')));

test('recorded native host evidence matches actual sources and rejects altered outcomes or stale hashes', () => {
  assert.doesNotThrow(() => validateHostReport(recorded()));
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
    const report = recorded();
    alter(report);
    assert.throws(() => validateHostReport(report));
  }
});

test('compatibility release stays blocked on the explicitly pending interactive/live evidence', () => {
  const pending = structuredClone(require('../docs/host-acceptance-release.json'));
  pending.hosts.claude.interactive = { status: 'pending' };
  assert.throws(() => validateRelease(pending), /evidence is pending/);
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
