'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = join(__dirname, '..', 'scripts', 'merge-env.cjs');

function withDataDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-merge-env-test-'));
  mkdirSync(join(dir, 'manifests-drafts'), { recursive: true });
  try { return fn(dir); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

function runMerge(specFile, dotenv, dataDir, extraArgs = []) {
  return spawnSync(process.execPath, [SCRIPT, '--spec-file', specFile, ...extraArgs], {
    encoding: 'utf8',
    input: dotenv,
    env: { ...process.env, MANIFEST_PLUGIN_DATA: dataDir },
  });
}

test('merge: dotenv → spec.env (legacy flat shape)', () => {
  withDataDir((dataDir) => {
    const specPath = join(dataDir, 'manifests-drafts', 'app.json');
    writeFileSync(specPath, JSON.stringify({ image: 'a', port: 80 }));
    const r = runMerge(specPath, 'FOO=bar\nBAZ=qux\n', dataDir);
    assert.equal(r.status, 0);
    const merged = JSON.parse(readFileSync(specPath, 'utf8'));
    assert.deepEqual(merged.env, { FOO: 'bar', BAZ: 'qux' });
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.keys_merged.sort(), ['BAZ', 'FOO']);
    // Critical: the script's stdout must contain only KEYS, never VALUES.
    assert.ok(!r.stdout.includes('bar'));
    assert.ok(!r.stdout.includes('qux'));
  });
});

test('merge: dotenv → spec.services.<name>.env (stack)', () => {
  withDataDir((dataDir) => {
    const specPath = join(dataDir, 'manifests-drafts', 'stack.json');
    writeFileSync(specPath, JSON.stringify({ services: { web: { image: 'a' } } }));
    const r = runMerge(specPath, 'DB=secret\n', dataDir, ['--service-name', 'web']);
    assert.equal(r.status, 0);
    const merged = JSON.parse(readFileSync(specPath, 'utf8'));
    assert.equal(merged.services.web.env.DB, 'secret');
  });
});

test('merge: quoted values are unwrapped', () => {
  withDataDir((dataDir) => {
    const specPath = join(dataDir, 'manifests-drafts', 'app.json');
    writeFileSync(specPath, JSON.stringify({ image: 'a' }));
    const r = runMerge(specPath, 'A="hello world"\nB=\'has spaces\'\n', dataDir);
    assert.equal(r.status, 0);
    const merged = JSON.parse(readFileSync(specPath, 'utf8'));
    assert.equal(merged.env.A, 'hello world');
    assert.equal(merged.env.B, 'has spaces');
  });
});

test('merge: comments and blank lines are ignored', () => {
  withDataDir((dataDir) => {
    const specPath = join(dataDir, 'manifests-drafts', 'app.json');
    writeFileSync(specPath, JSON.stringify({ image: 'a' }));
    const r = runMerge(specPath, '# comment\n\nFOO=bar\n  # indented comment is also ignored\n', dataDir);
    assert.equal(r.status, 0);
    const merged = JSON.parse(readFileSync(specPath, 'utf8'));
    assert.deepEqual(merged.env, { FOO: 'bar' });
  });
});

test('reject: invalid env key with line number', () => {
  withDataDir((dataDir) => {
    const specPath = join(dataDir, 'manifests-drafts', 'app.json');
    writeFileSync(specPath, JSON.stringify({ image: 'a' }));
    const r = runMerge(specPath, 'A=ok\n2BAD_KEY=nope\n', dataDir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /line 2.*invalid env key/);
  });
});

test('reject: missing = is reported with line number', () => {
  withDataDir((dataDir) => {
    const specPath = join(dataDir, 'manifests-drafts', 'app.json');
    writeFileSync(specPath, JSON.stringify({ image: 'a' }));
    const r = runMerge(specPath, 'NO_EQUALS_HERE\n', dataDir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /line 1.*missing '='/);
  });
});

test('reject: spec file outside allowlist (refuses to downgrade mode)', () => {
  withDataDir((dataDir) => {
    // Use a path that is clearly NOT in tmpdir() and NOT in the data dir's
    // drafts subdir. The data dir itself sits under tmpdir() (mkdtempSync),
    // so any path inside `dataDir` would falsely pass the allowlist check.
    // /etc/no-such-spec.json is a guaranteed-outside path; the script must
    // refuse before attempting to read the (nonexistent) file.
    const outsidePath = '/etc/no-such-spec.json';
    const r = runMerge(outsidePath, 'FOO=bar\n', dataDir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /must live under.*manifests-drafts.*system tmpdir/);
  });
});

test('reject: relative spec file path', () => {
  withDataDir((dataDir) => {
    const r = runMerge('./relative.json', 'FOO=bar\n', dataDir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /must be absolute/);
  });
});

test('written file is mode 0o600 (secrets-handling discipline)', () => {
  withDataDir((dataDir) => {
    const specPath = join(dataDir, 'manifests-drafts', 'app.json');
    writeFileSync(specPath, JSON.stringify({ image: 'a' }));
    const r = runMerge(specPath, 'FOO=bar\n', dataDir);
    assert.equal(r.status, 0);
    const mode = statSync(specPath).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});
