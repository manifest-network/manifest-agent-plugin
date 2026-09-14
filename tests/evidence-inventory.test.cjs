'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join, dirname } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const { readHistoricalSources, hostSourceFiles } = require('../ci/evidence-check.cjs');
const { sourceHashes } = require('../ci/codex-host-smoke.cjs');
const { hashes, validateReport } = require('../ci/terminal-host-smoke.cjs');
const { validateHostReport } = require('../ci/host-acceptance.cjs');

test('historical scope and skill inventory follow the recorded tree as current files are added and removed', (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'manifest-evidence-inventory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, bytes) => { fs.mkdirSync(dirname(join(root, file)), { recursive: true }); fs.writeFileSync(join(root, file), bytes); };
  for (const file of Object.keys(hashes())) write(file, fs.readFileSync(join(__dirname, '..', file)));
  const git = (...args) => {
    const result = spawnSync('git', ['-C', root, '-c', 'user.name=Evidence Test', '-c', 'user.email=evidence@example.invalid',
      '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', ...args], {
      encoding: 'utf8', timeout: 10000,
      env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '--quiet');
  // These files are outside the emitters' top-level globs. A symlink is not
  // a regular workflow file, even when its name ends in .md.
  for (const file of ['scripts/nested/ignored.cjs', 'scripts/ignored.js', 'workflows/nested/ignored.md', 'skills/orphan/SKILL.md']) write(file, 'ignored');
  fs.symlinkSync('balance.md', join(root, 'workflows/symlink.md'));
  const commit = () => { git('add', '.'); git('commit', '--quiet', '-m', 'Synthetic inventory fixture'); return git('rev-parse', 'HEAD'); };
  // Reuse observation shapes only as synthetic unit fixtures; never archive
  // these invented source bindings as actual host acceptance.
  const records = (head) => {
    const pkg = JSON.parse(fs.readFileSync(join(root, 'package.json')));
    const app = structuredClone(require('../docs/host-evidence/codex-app-server.json'));
    const terminal = structuredClone(require('../docs/host-evidence/claude-terminal.json'));
    for (const report of [app, terminal]) Object.assign(report, {
      pluginVersion: pkg.version, upstreamPin: pkg.dependencies['@manifest-network/manifest-mcp-node'],
    });
    Object.assign(app, { head, sourceHashes: sourceHashes(root) });
    app.skills = Object.keys(app.sourceHashes).filter((file) => /^workflows\/[^/]+\.md$/.test(file)).map((file) => `manifest-agent:${file.slice(10, -3)}`).sort();
    Object.assign(terminal, { head, sourceHashes: hashes(root) });
    return [[app, validateHostReport], [terminal, validateReport]];
  };
  const original = records(commit());
  for (const [report, validate] of original) {
    const source = readHistoricalSources(root, report.head, (tree) => hostSourceFiles(tree, { terminal: validate === validateReport }));
    assert.deepEqual(Object.keys(source).sort(), Object.keys(report.sourceHashes).sort(), 'Historical rules must match the emitter');
    assert.equal(validate(report, { root, requireHistory: true }).verification, 'commit');
    assert.equal(validate({ ...report, source_status: 'current' }, { root, requireCurrent: true }).verification, 'workspace');
  }
  for (const file of ['scripts/zz-review-probe.cjs', 'workflows/zz-review-probe.md', 'skills/zz-review-probe/SKILL.md']) write(file, 'new file');
  for (const [report, validate] of original) {
    assert.equal(validate(report, { root, requireHistory: true }).verification, 'commit');
    assert.throws(() => validate({ ...report, source_status: 'current' }, { root, requireCurrent: true }), /exactly the expected files/);
  }
  const expanded = records(commit());
  for (const file of ['scripts/zz-review-probe.cjs', 'workflows/zz-review-probe.md', 'skills/zz-review-probe/SKILL.md',
    'scripts/_io.cjs', 'workflows/balance.md', 'skills/balance/SKILL.md', 'package.json', '.mcp.json']) fs.rmSync(join(root, file));
  for (const [report, validate] of [...original, ...expanded]) {
    assert.equal(validate(report, { root, requireHistory: true }).verification, 'commit');
    for (const changed of [
      { ...report, sourceHashes: Object.fromEntries(Object.entries(report.sourceHashes).slice(0, 5)) },
      { ...report, sourceHashes: { ...report.sourceHashes, 'scripts/not-recorded.cjs': '0'.repeat(64) } },
    ]) assert.throws(() => validate(changed, { root, requireHistory: true }), /exactly the expected files/);
  }
  assert.equal(readHistoricalSources(root, '0'.repeat(40), hostSourceFiles), null);
  assert.throws(() => readHistoricalSources(root, git('rev-parse', `${original[0][0].head}:package.json`), hostSourceFiles), /must identify a commit/);
});
