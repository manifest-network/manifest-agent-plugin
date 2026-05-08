'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, readFileSync, statSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = join(__dirname, '..', 'scripts', 'journal-write.cjs');

function withDataDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-journal-write-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runWrite(dataDir, recordJson, extraArgs = [], extraEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...extraArgs], {
    encoding: 'utf8',
    input: typeof recordJson === 'string' ? recordJson : JSON.stringify(recordJson),
    env: { ...process.env, MANIFEST_PLUGIN_DATA: dataDir, ...extraEnv },
  });
}

function makeRecord(overrides = {}) {
  return {
    skill: 'set-gas-price',
    active_chain: 'testnet',
    signer_address: 'manifest1abc',
    intent: 'change gas price',
    plan_summary: 'set gas_multiplier=1.6',
    tool_calls: [],
    outcome: 'success',
    final_state: { gas_multiplier: 1.6 },
    errors: [],
    recovery_actions: [],
    ...overrides,
  };
}

const TODAY = new Date().toISOString().slice(0, 10);

test('happy path: appends a record and returns the journal file path', () => {
  withDataDir((dataDir) => {
    const r = runWrite(dataDir, makeRecord(), [], { MANIFEST_SESSION_ID: '' });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const filePath = r.stdout.trim();
    assert.ok(filePath.endsWith(`${TODAY}.jsonl`));
    assert.equal(existsSync(filePath), true);
    const lines = readFileSync(filePath, 'utf8').trimEnd().split('\n');
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.skill, 'set-gas-price');
    assert.equal(record.outcome, 'success');
  });
});

test('auto-fills timestamp_iso, timestamp_unix, schema_version when absent', () => {
  withDataDir((dataDir) => {
    const r = runWrite(dataDir, makeRecord(), [], { MANIFEST_SESSION_ID: '' });
    assert.equal(r.status, 0);
    const record = JSON.parse(readFileSync(r.stdout.trim(), 'utf8').trimEnd());
    assert.match(record.timestamp_iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    assert.equal(typeof record.timestamp_unix, 'number');
    assert.equal(record.schema_version, 1);
  });
});

test('auto-fills session_id from $MANIFEST_SESSION_ID when absent', () => {
  withDataDir((dataDir) => {
    const r = runWrite(dataDir, makeRecord(), [], { MANIFEST_SESSION_ID: 'sess-xyz' });
    assert.equal(r.status, 0);
    const record = JSON.parse(readFileSync(r.stdout.trim(), 'utf8').trimEnd());
    assert.equal(record.session_id, 'sess-xyz');
  });
});

test('session_id falls back to null when $MANIFEST_SESSION_ID is unset', () => {
  withDataDir((dataDir) => {
    // Pass MANIFEST_SESSION_ID explicitly empty (Node treats that as set-but-empty).
    const r = runWrite(dataDir, makeRecord(), [], { MANIFEST_SESSION_ID: '' });
    assert.equal(r.status, 0);
    const record = JSON.parse(readFileSync(r.stdout.trim(), 'utf8').trimEnd());
    assert.equal(record.session_id, null);
  });
});

test('caller-supplied session_id is preserved', () => {
  withDataDir((dataDir) => {
    const r = runWrite(dataDir, makeRecord({ session_id: 'caller-id' }), [], {
      MANIFEST_SESSION_ID: 'env-id',
    });
    assert.equal(r.status, 0);
    const record = JSON.parse(readFileSync(r.stdout.trim(), 'utf8').trimEnd());
    assert.equal(record.session_id, 'caller-id');
  });
});

test('rejects record containing a forbidden key (defense in depth)', () => {
  withDataDir((dataDir) => {
    const bad = makeRecord({ final_state: { password: 'leak' } });
    const r = runWrite(dataDir, bad);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /secret-key denylist/);
    // No journal file should have been created.
    const file = join(dataDir, 'journal', `${TODAY}.jsonl`);
    assert.equal(existsSync(file), false);
  });
});

test('rejects empty stdin', () => {
  withDataDir((dataDir) => {
    const r = runWrite(dataDir, '');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /stdin is empty/);
  });
});

test('rejects non-JSON stdin', () => {
  withDataDir((dataDir) => {
    const r = runWrite(dataDir, 'not json');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not valid JSON/);
  });
});

test('rejects array stdin (record must be an object)', () => {
  withDataDir((dataDir) => {
    const r = runWrite(dataDir, '[]');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /must be a JSON object/);
  });
});

test('--dry-run does not write to disk; prints the would-be line and path', () => {
  withDataDir((dataDir) => {
    const r = runWrite(dataDir, makeRecord(), ['--dry-run'], { MANIFEST_SESSION_ID: '' });
    assert.equal(r.status, 0);
    const lines = r.stdout.trimEnd().split('\n');
    assert.equal(lines.length, 2);
    const record = JSON.parse(lines[0]);
    assert.equal(record.skill, 'set-gas-price');
    assert.ok(lines[1].endsWith(`${TODAY}.jsonl`));
    // Nothing on disk.
    assert.equal(existsSync(join(dataDir, 'journal')), false);
  });
});

test('rejects unknown argv flag', () => {
  withDataDir((dataDir) => {
    const r = runWrite(dataDir, makeRecord(), ['--bogus']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Unknown argument/);
  });
});

test('journal file is mode 0600 and parent dir is mode 0700', () => {
  withDataDir((dataDir) => {
    const r = runWrite(dataDir, makeRecord(), [], { MANIFEST_SESSION_ID: '' });
    assert.equal(r.status, 0);
    const filePath = r.stdout.trim();
    assert.equal(statSync(filePath).mode & 0o777, 0o600);
    assert.equal(statSync(join(dataDir, 'journal')).mode & 0o777, 0o700);
  });
});

test('errors when MANIFEST_PLUGIN_DATA is unset and the writer needs it', () => {
  // Spawn without MANIFEST_PLUGIN_DATA in env.
  const env = { ...process.env };
  delete env.MANIFEST_PLUGIN_DATA;
  delete env.MANIFEST_SESSION_ID;
  const r = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    input: JSON.stringify(makeRecord()),
    env,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /MANIFEST_PLUGIN_DATA/);
});
