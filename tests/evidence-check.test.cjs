'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { join, dirname } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const { SOURCE_FILES, sha256, checkEvidence, readHistoricalSources } = require('../ci/evidence-check.cjs');

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
  // Keep the genuine recorded observations as the valid baseline; each test
  // changes source bytes or report content independently of the validator.
  const current = JSON.parse(readFileSync(join(__dirname, '../docs/evidence/claude-runtime-0.22.0.json')));
  const historical = JSON.parse(readFileSync(join(__dirname, '../docs/evidence/claude-terminal-2.1.263.json')));
  current.files_sha256 = { ...hashes };
  historical.files_sha256 = { ...hashes };
  historical.head = 'a'.repeat(40);
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

test('matching source hashes cannot substitute for current results or historical observations', (t) => {
  const f = fixture(t);
  delete f.current.results;
  delete f.historical.cases;
  f.save('current', f.current);
  f.save('historical', f.historical);
  const failures = f.check().failures.join('\n');
  assert.match(failures, /Current results must contain exactly the 14 expected named cases/);
  assert.match(failures, /Historical terminal cases must contain exactly the 4 expected named cases/);
});

test('case names and passed flags without measurements are insufficient', (t) => {
  const f = fixture(t);
  f.current.results = f.current.results.map(({ name }) => ({ name, passed: true }));
  f.historical.cases = f.historical.cases.map(({ name }) => ({ name, passed: true }));
  f.save('current', f.current);
  f.save('historical', f.historical);
  const failures = f.check().failures.join('\n');
  assert.match(failures, /bare-name-misses.exitCode/);
  assert.match(failures, /elicitation-cancel.sequence/);
});

test('current and historical case coverage rejects duplicates, omissions and unknown cases', (t) => {
  const f = fixture(t);
  for (const [name, record, field] of [['current', f.current, 'results'], ['historical', f.historical, 'cases']]) {
    const original = structuredClone(record[field]);
    for (const changed of [original.slice(1), [...original, original[0]],
      original.map((item, index) => index === 0 ? { ...item, name: original[1].name } : item),
      original.map((item, index) => index === 0 ? { ...item, name: 'unknown-case' } : item)]) {
      record[field] = changed;
      f.save(name, record);
      assert.match(f.check().failures.join('\n'), /expected named cases, without omissions or duplicates/);
    }
    record[field] = original;
    f.save(name, record);
  }
});

test('current outcomes enforce host completion, permission boundaries and negative controls', (t) => {
  const f = fixture(t);
  const original = structuredClone(f.current.results);
  const changes = [
    ['project-lookup', 'reads', 0],
    ['project-lookup', 'mutations', 1],
    ['elicitation-decline', 'mutations', 1],
    ['elicitation-cancel', 'controlEvents', []],
    ['elicitation-accept', 'mutations', 0],
    ['elicitation-accept', 'controlEvents', [...original.find(({ name }) => name === 'elicitation-accept').controlEvents].reverse()],
    ['scoped-deny', 'hooks', []],
    ['project-direct-ask', 'hooks', [{ ...original.find(({ name }) => name === 'project-direct-ask').hooks[0], decision: 'allow' }]],
    ['project-direct-ask-bypass', 'permissionMode', 'manual'],
    ['bare-name-misses', 'mutations', 0],
    ['polluted-deny-drops-decision', 'mutations', 0],
    ['project-lookup', 'exitCode', 1],
    ['project-lookup', 'timedOut', true],
    ['project-lookup', 'apiCalls', 0],
    ['project-lookup', 'passed', false],
  ];
  for (const [name, field, value] of changes) {
    f.current.results = structuredClone(original);
    f.current.results.find((item) => item.name === name)[field] = value;
    f.save('current', f.current);
    assert.ok(f.check().failures.some((message) => message.includes(`${name}.${field}`)), `${name}.${field} must fail`);
  }
});

test('historical outcomes retain terminal boundaries, response ordering and input evidence', (t) => {
  const f = fixture(t);
  const original = structuredClone(f.historical.cases);
  const changes = [
    ['outer-permission-deny', 'toolCalls', 1],
    ['elicitation-cancel', 'mutationMarkers', 1],
    ['elicitation-decline', 'beforeOuterPermissionAnswer', { toolCalls: 1, mutationMarkers: 0 }],
    ['elicitation-accept', 'atNativeElicitationBeforeAnswer', { toolCalls: 1, mutationMarkers: 1 }],
    ['elicitation-accept', 'sequence', [...original.find(({ name }) => name === 'elicitation-accept').sequence].reverse()],
    ['elicitation-cancel', 'sequence', original.find(({ name }) => name === 'elicitation-decline').sequence],
    ['elicitation-accept', 'keys', []],
  ];
  for (const [name, field, value] of changes) {
    f.historical.cases = structuredClone(original);
    f.historical.cases.find((item) => item.name === name)[field] = value;
    f.save('historical', f.historical);
    assert.ok(f.check().failures.some((message) => message.includes(`${name}.${field}`)), `${name}.${field} must fail`);
  }
});

test('real Git history loads exact committed bytes and verifies independently of workspace drift', (t) => {
  const f = fixture(t);
  const git = (...args) => {
    const result = spawnSync('git', ['-C', f.root, '-c', 'user.name=Evidence Test',
      '-c', 'user.email=evidence-test@example.invalid', '-c', 'commit.gpgsign=false',
      '-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', ...args], {
      encoding: 'utf8', timeout: 10000,
      env: { PATH: process.env.PATH, HOME: f.root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  // Include non-UTF-8 bytes so an accidental text decode in git show fails.
  const file = SOURCE_FILES[0];
  f.sources[file] = Buffer.concat([f.sources[file], Buffer.from([0, 255, 128])]);
  writeFileSync(join(f.root, file), f.sources[file]);
  f.current.files_sha256[file] = f.historical.files_sha256[file] = sha256(f.sources[file]);
  git('init', '--quiet');
  git('add', '--', ...SOURCE_FILES);
  git('commit', '--quiet', '-m', 'Record isolated evidence test sources');
  f.historical.head = git('rev-parse', 'HEAD');
  assert.deepEqual(readHistoricalSources(f.root, f.historical.head), f.sources);
  writeFileSync(join(f.root, file), 'new workspace version\n');
  f.current.files_sha256[file] = sha256(readFileSync(join(f.root, file)));
  f.save('current', f.current);
  f.save('historical', f.historical);
  const result = checkEvidence(f.root, { requireHistory: true });
  assert.deepEqual(result.failures, []);
  assert.equal(result.records.find((r) => r.status === 'historical').verification, 'commit');
  assert.deepEqual(result.records.find((r) => r.status === 'historical').workspaceDrift, [file]);
  f.historical.files_sha256[file] = f.current.files_sha256[file];
  f.save('historical', f.historical);
  assert.match(checkEvidence(f.root).failures.join('\n'), /Historical hash differs from recorded commit/);
  assert.equal(readHistoricalSources(f.root, '0'.repeat(40)), null);
  assert.throws(() => readHistoricalSources(f.root, git('rev-parse', `HEAD:${file}`)), /must identify a commit/);
});
