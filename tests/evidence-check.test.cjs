'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { join, dirname } = require('node:path');
const { tmpdir } = require('node:os');
const { SOURCE_FILES, sha256, checkEvidence } = require('../ci/evidence-check.cjs');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'manifest-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs/evidence'), { recursive: true });
  const sources = Object.fromEntries(SOURCE_FILES.map((file) => [file, Buffer.from(`original ${file}\n`)]));
  for (const [file, content] of Object.entries(sources)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  const hashes = Object.fromEntries(SOURCE_FILES.map((file) => [file, sha256(sources[file])]));
  const current = { source_status: 'current', files_sha256: { ...hashes } };
  const historical = { source_status: 'historical', head: 'a'.repeat(40), sourceFiles: [...SOURCE_FILES], files_sha256: { ...hashes } };
  const save = (name, record) => writeFileSync(join(root, 'docs/evidence', `${name}.json`), JSON.stringify(record));
  save('current', current);
  save('historical', historical);
  return { root, sources, current, historical, save,
    check: (options = {}) => checkEvidence(root, { historicalSources: () => sources, ...options }) };
}

test('current source hashes and recorded historical commit hashes both verify', (t) => {
  const f = fixture(t);
  const result = f.check();
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.records.map((r) => r.verification), ['workspace', 'commit']);
});

test('a changed current hook fails rather than silently retaining old evidence', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'hooks/hooks.json'), 'changed hook\n');
  assert.match(f.check().failures.join('\n'), /Current evidence is stale for hooks\/hooks.json/);
});

test('missing current source and missing hash coverage fail', (t) => {
  const f = fixture(t);
  rmSync(join(f.root, SOURCE_FILES[0]));
  assert.match(f.check().failures.join('\n'), /current\.json:.*ENOENT/);
  delete f.current.files_sha256[SOURCE_FILES[0]];
  f.save('current', f.current);
  assert.match(f.check().failures.join('\n'), /exactly the five/);
});

test('historical source remains valid when current files and new evidence change', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'hooks/hooks.json'), 'newly tested hook\n');
  f.current.files_sha256['hooks/hooks.json'] = sha256(readFileSync(join(f.root, 'hooks/hooks.json')));
  f.save('current', f.current);
  const result = f.check();
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.records.find((r) => r.status === 'historical').workspaceDrift, ['hooks/hooks.json']);
});

test('a historical hash mismatch fails against the recorded commit', (t) => {
  const f = fixture(t);
  f.historical.files_sha256[SOURCE_FILES[0]] = '0'.repeat(64);
  f.save('historical', f.historical);
  assert.match(f.check().failures.join('\n'), /Historical hash differs from recorded commit/);
});

test('unavailable historical objects explicitly report metadata-only; strict mode fails', (t) => {
  const f = fixture(t);
  const historicalSources = () => null;
  const result = f.check({ historicalSources });
  assert.deepEqual(result.failures, []);
  assert.equal(result.records.find((r) => r.status === 'historical').verification, 'metadata-only');
  assert.match(f.check({ historicalSources, requireHistory: true }).failures.join('\n'), /source commit .* unavailable/);
});

test('historical source inspection errors fail instead of claiming metadata-only validation', (t) => {
  const f = fixture(t);
  const result = f.check({ historicalSources: () => { throw new Error('Git inspection failed'); } });
  assert.match(result.failures.join('\n'), /historical\.json: Git inspection failed/);
  assert.equal(result.records.some((r) => r.verification === 'metadata-only'), false);
});

test('missing declarations, invalid hashes and duplicate source names fail metadata validation', (t) => {
  const f = fixture(t);
  delete f.current.source_status;
  f.save('current', f.current);
  assert.match(f.check().failures.join('\n'), /source_status must explicitly/);
  f.historical.files_sha256[SOURCE_FILES[0]] = 'not-a-hash';
  f.save('historical', f.historical);
  assert.match(f.check().failures.join('\n'), /lowercase SHA-256/);
  f.historical.files_sha256[SOURCE_FILES[0]] = sha256(f.sources[SOURCE_FILES[0]]);
  f.historical.sourceFiles.push(SOURCE_FILES[0]);
  f.save('historical', f.historical);
  assert.match(f.check().failures.join('\n'), /without omissions or duplicates/);
});

test('historical evidence cannot substitute for a current host record', (t) => {
  const f = fixture(t);
  rmSync(join(f.root, 'docs/evidence/current.json'));
  assert.match(f.check().failures.join('\n'), /At least one current/);
  delete f.historical.head;
  f.save('historical', f.historical);
  assert.match(f.check().failures.join('\n'), /full recorded head commit/);
});
