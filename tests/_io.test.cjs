'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, existsSync, statSync, readFileSync, readdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { atomicWrite, readJsonFile, getDataDir } = require('../scripts/_io.cjs');

function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-io-test-'));
  try { return fn(dir); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test('atomicWrite: produces 0o600 file by default (secrets-by-default posture)', () => {
  withTmpDir((dir) => {
    const target = join(dir, 'secret.json');
    atomicWrite(target, '{}\n');
    assert.equal(existsSync(target), true);
    const mode = statSync(target).mode & 0o777;
    assert.equal(mode, 0o600);
    assert.equal(readFileSync(target, 'utf8'), '{}\n');
  });
});

test('atomicWrite: respects explicit mode', () => {
  withTmpDir((dir) => {
    const target = join(dir, 'public.json');
    atomicWrite(target, '{}\n', { mode: 0o644 });
    const mode = statSync(target).mode & 0o777;
    assert.equal(mode, 0o644);
  });
});

test('atomicWrite: leaves no .tmp residue on success', () => {
  withTmpDir((dir) => {
    const target = join(dir, 'a.json');
    atomicWrite(target, '{}\n');
    const residue = readdirSync(dir).filter((n) => n.endsWith('.tmp'));
    assert.deepEqual(residue, []);
  });
});

test('atomicWrite: ensureDir creates the parent directory', () => {
  withTmpDir((dir) => {
    const target = join(dir, 'sub', 'nested', 'x.json');
    atomicWrite(target, '{}\n', { ensureDir: true });
    assert.equal(existsSync(target), true);
    assert.equal(readFileSync(target, 'utf8'), '{}\n');
  });
});

test('atomicWrite: without ensureDir, missing parent throws (current behavior)', () => {
  withTmpDir((dir) => {
    const target = join(dir, 'nope', 'x.json');
    assert.throws(() => atomicWrite(target, '{}\n'), /ENOENT/);
  });
});

test('atomicWrite: ensureDir + custom dirMode applies the mode', () => {
  withTmpDir((dir) => {
    const subDir = join(dir, 'private');
    const target = join(subDir, 'x.json');
    atomicWrite(target, '{}\n', { ensureDir: true, dirMode: 0o700 });
    assert.equal(statSync(subDir).mode & 0o777, 0o700);
  });
});

test('readJsonFile: parses a plain JSON object', () => {
  withTmpDir((dir) => {
    const target = join(dir, 'a.json');
    atomicWrite(target, JSON.stringify({ k: 'v' }));
    const parsed = readJsonFile(target);
    assert.deepEqual(parsed, { k: 'v' });
  });
});

test('readJsonFile: rejects non-object JSON (array, string, null)', () => {
  withTmpDir((dir) => {
    const target = join(dir, 'a.json');
    atomicWrite(target, '[]');
    assert.throws(() => readJsonFile(target), /must contain a JSON object/);
    atomicWrite(target, '"string"');
    assert.throws(() => readJsonFile(target), /must contain a JSON object/);
    atomicWrite(target, 'null');
    assert.throws(() => readJsonFile(target), /must contain a JSON object/);
  });
});

test('readJsonFile: rejects malformed JSON with descriptive message', () => {
  withTmpDir((dir) => {
    const target = join(dir, 'bad.json');
    atomicWrite(target, '{ not json');
    assert.throws(() => readJsonFile(target), /Failed to parse/);
  });
});

test('readJsonFile: rejects missing file', () => {
  withTmpDir((dir) => {
    assert.throws(() => readJsonFile(join(dir, 'missing.json')), /File not found/);
  });
});

test('getDataDir: throws with a helpful message when env var is unset', () => {
  const saved = process.env.MANIFEST_PLUGIN_DATA;
  delete process.env.MANIFEST_PLUGIN_DATA;
  try {
    assert.throws(() => getDataDir(), /MANIFEST_PLUGIN_DATA env var is not set/);
  } finally {
    if (saved !== undefined) process.env.MANIFEST_PLUGIN_DATA = saved;
  }
});

test('getDataDir: returns the env var value when set', () => {
  const saved = process.env.MANIFEST_PLUGIN_DATA;
  process.env.MANIFEST_PLUGIN_DATA = '/tmp/some-data-dir';
  try {
    assert.equal(getDataDir(), '/tmp/some-data-dir');
  } finally {
    if (saved !== undefined) process.env.MANIFEST_PLUGIN_DATA = saved;
    else delete process.env.MANIFEST_PLUGIN_DATA;
  }
});
