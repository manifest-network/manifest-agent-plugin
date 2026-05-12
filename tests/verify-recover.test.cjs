'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, chmodSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { runScript } = require('./_subprocess.cjs');

const UUID = '11111111-1111-4111-8111-111111111111';
const LEASE_VERIFIER = 'verify-domain-state.cjs';
const STATE_VERIFIER = 'decode-lease-state.cjs';

function drive(envelope, env = {}) {
  // Same shape as `runScript` but allows env-var overrides for the
  // SCRIPTS_DIR backdoor (test-only).
  const { spawnSync } = require('node:child_process');
  const { join: joinPath } = require('node:path');
  const SCRIPTS_DIR = joinPath(__dirname, '..', 'scripts');
  const res = spawnSync(process.execPath, [joinPath(SCRIPTS_DIR, 'verify-recover.cjs')], {
    input: JSON.stringify(envelope),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  const out = { status: res.status, stdout: res.stdout, stderr: res.stderr };
  const trimmed = (res.stdout || '').trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { out.json = JSON.parse(trimmed); } catch { /* not JSON */ }
  }
  return out;
}

// ------------------------------ Fixtures ------------------------------

// Leases-by-tenant payload skeletons.
function leasesMatch(fqdn) {
  return { leases: [{ uuid: UUID, items: [{ serviceName: 'web', customDomain: fqdn }] }] };
}
function leasesMismatch(actual) {
  return { leases: [{ uuid: UUID, items: [{ serviceName: 'web', customDomain: actual }] }] };
}
function leasesNotFound() {
  return { leases: [] };
}

// Standard spec builders for the most-used verifiers.
function domainSpec({ fqdn = 'app.example.com', expected = 'app.example.com', other = false } = {}) {
  const branches = {
    mismatch: {
      branch_id: 'domain-mismatch',
      journal_action_tag: 'domain-verification-mismatch',
      user_message: 'Chain shows `{{actual}}` instead of `{{fqdn}}`.',
    },
    not_found: {
      branch_id: 'domain-not-found',
      journal_action_tag: 'domain-verification-not-found',
      user_message: 'Lease not visible: `{{reason}}`.',
    },
  };
  if (other) {
    branches.other = {
      branch_id: 'catchall',
      journal_action_tag: 'verify-catchall',
      user_message: 'caught by other: {{outcome}}',
    };
  }
  return {
    verifier: {
      script: LEASE_VERIFIER,
      args: ['--lease-uuid', '{{lease_uuid}}', '--service-name', 'web', '--expected', expected],
      stdin_source: 'leases_by_tenant_response',
    },
    success: { field: 'outcome', values: ['match'] },
    branches,
  };
}

function closeLeaseSpec() {
  return {
    verifier: {
      script: STATE_VERIFIER,
      args: ['--state', '{{state_int}}', '--json'],
      stdin_source: null,
    },
    success: { field: 'terminal', values: [true] },
    branches: {
      other: {
        branch_id: 'close-not-yet-terminal',
        journal_action_tag: 'close-lease-verify-pending',
        user_message: 'close_lease tx accepted but state is still `{{name}}`.',
      },
    },
  };
}

function restartSpec() {
  return {
    verifier: {
      script: STATE_VERIFIER,
      args: ['--state', '{{state_int}}', '--json'],
      stdin_source: null,
    },
    success: { field: 'name', values: ['LEASE_STATE_ACTIVE'] },
    branches: {
      other: {
        branch_id: 'restart-state-not-active',
        journal_action_tag: 'restart-post-verify-not-active',
        user_message: 'Restart sent but state is now `{{name}}`.',
      },
    },
  };
}

// ------------------------------ Cases 1–3: domain verify ------------------------------

test('case 1: success on match outcome → branch_id null, no tags', () => {
  const r = drive({
    spec: domainSpec(),
    payloads: { leases_by_tenant_response: leasesMatch('app.example.com') },
    context: { lease_uuid: UUID, fqdn: 'app.example.com' },
  });
  assert.equal(r.status, 0);
  assert.equal(r.json.result, 'success');
  assert.equal(r.json.verifier_outcome, 'match');
  assert.equal(r.json.branch_id, null);
  assert.deepEqual(r.json.journal_action_tags, []);
  assert.equal(r.json.user_message, null);
  assert.equal(r.json.diagnostic_delta.actual, 'app.example.com');
});

test('case 2: failure on mismatch → branch_id domain-mismatch, tag spliced, user_message interpolated', () => {
  const r = drive({
    spec: domainSpec({ expected: 'new.example.com' }),
    payloads: { leases_by_tenant_response: leasesMismatch('old.example.com') },
    context: { lease_uuid: UUID, fqdn: 'new.example.com' },
  });
  assert.equal(r.status, 0);
  assert.equal(r.json.result, 'failure');
  assert.equal(r.json.branch_id, 'domain-mismatch');
  assert.deepEqual(r.json.journal_action_tags, ['domain-verification-mismatch']);
  assert.equal(r.json.user_message, 'Chain shows `old.example.com` instead of `new.example.com`.');
});

test('case 3: failure on not_found → branch_id domain-not-found', () => {
  const r = drive({
    spec: domainSpec(),
    payloads: { leases_by_tenant_response: leasesNotFound() },
    context: { lease_uuid: UUID, fqdn: 'app.example.com' },
  });
  assert.equal(r.status, 0);
  assert.equal(r.json.result, 'failure');
  assert.equal(r.json.branch_id, 'domain-not-found');
  assert.deepEqual(r.json.journal_action_tags, ['domain-verification-not-found']);
  assert.match(r.json.user_message, /lease UUID not in tenant leases/);
});

// ------------------------------ Cases 4–5: close-lease verify ------------------------------

test('case 4: close-lease success — terminal:true (LEASE_STATE_CLOSED == 4)', () => {
  const r = drive({
    spec: closeLeaseSpec(),
    payloads: {},
    context: { state_int: '4', lease_uuid: UUID },
  });
  assert.equal(r.status, 0);
  assert.equal(r.json.result, 'success');
  assert.equal(r.json.verifier_outcome, true);
  // diagnostic_delta should still carry `name` (the non-success field).
  assert.equal(r.json.diagnostic_delta.name, 'LEASE_STATE_CLOSED');
});

test('case 5: close-lease failure — pending state (1) → close-not-yet-terminal', () => {
  const r = drive({
    spec: closeLeaseSpec(),
    payloads: {},
    context: { state_int: '1', lease_uuid: UUID },
  });
  assert.equal(r.status, 0);
  assert.equal(r.json.result, 'failure');
  assert.equal(r.json.branch_id, 'close-not-yet-terminal');
  assert.deepEqual(r.json.journal_action_tags, ['close-lease-verify-pending']);
  // `{{name}}` should be interpolated from diagnostic_delta (which carries
  // the decode-lease-state output's `name` field).
  assert.equal(r.json.user_message, 'close_lease tx accepted but state is still `LEASE_STATE_PENDING`.');
});

// ------------------------------ Cases 6–7: stdin source resolution ------------------------------

test('case 6: stdin_source: null → verifier receives no stdin (decode-lease-state ignores stdin)', () => {
  const r = drive({
    spec: closeLeaseSpec(),
    payloads: {},
    context: { state_int: '4', lease_uuid: UUID },
  });
  assert.equal(r.status, 0);
  assert.equal(r.json.result, 'success');
});

test('case 7: stdin_source names a present key → driver pipes JSON.stringify(payloads[key])', () => {
  const r = drive({
    spec: domainSpec(),
    payloads: { leases_by_tenant_response: leasesMatch('app.example.com') },
    context: { lease_uuid: UUID, fqdn: 'app.example.com' },
  });
  assert.equal(r.status, 0);
  assert.equal(r.json.result, 'success');
});

// ------------------------------ Case 8: missing payload key ------------------------------

test('case 8: stdin_source names an absent key → exit 1, stderr diagnostic', () => {
  const r = drive({
    spec: domainSpec(),
    payloads: {},
    context: { lease_uuid: UUID, fqdn: 'app.example.com' },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /stdin_source 'leases_by_tenant_response' not present in stdin\.payloads/);
});

// ------------------------------ Case 9–10: catch-all + unclassified ------------------------------

test('case 9: catch-all "other" branch matched when outcome not in named branches', () => {
  // verify-domain-state emits `match` or `mismatch` or `not_found`. The
  // "other" branch is a safety net for future outcomes — here we force
  // it by configuring the spec so `mismatch` falls through to `other`.
  const spec = domainSpec({ other: true });
  delete spec.branches.mismatch;
  const r = drive({
    spec,
    payloads: { leases_by_tenant_response: leasesMismatch('old.example.com') },
    context: { lease_uuid: UUID, fqdn: 'new.example.com' },
  });
  assert.equal(r.status, 0);
  assert.equal(r.json.branch_id, 'catchall');
  assert.deepEqual(r.json.journal_action_tags, ['verify-catchall']);
  assert.equal(r.json.user_message, 'caught by other: mismatch');
});

test('case 10: no "other" branch and unrecognized outcome → unclassified (exit 0)', () => {
  const spec = domainSpec();
  delete spec.branches.mismatch;
  const r = drive({
    spec,
    payloads: { leases_by_tenant_response: leasesMismatch('old.example.com') },
    context: { lease_uuid: UUID, fqdn: 'new.example.com' },
  });
  assert.equal(r.status, 0);
  assert.equal(r.json.branch_id, 'unclassified');
  assert.deepEqual(r.json.journal_action_tags, ['verify-unclassified']);
});

// ------------------------------ Case 11: interpolation ------------------------------

test('case 11: {{var}} interpolation — diagnostic wins on key collision; unmatched left literal', () => {
  // `fqdn` only in context; `actual` only in diagnostic_delta; `nonexistent`
  // in neither → left literal.
  const spec = domainSpec({ expected: 'new.example.com' });
  spec.branches.mismatch.user_message = 'fqdn={{fqdn}} actual={{actual}} missing={{nonexistent}}';
  const r = drive({
    spec,
    payloads: { leases_by_tenant_response: leasesMismatch('old.example.com') },
    context: { lease_uuid: UUID, fqdn: 'new.example.com' },
  });
  assert.equal(r.status, 0);
  assert.equal(r.json.user_message, 'fqdn=new.example.com actual=old.example.com missing={{nonexistent}}');
});

// ------------------------------ Case 12: verifier crash ------------------------------

test('case 12: verifier exits non-zero → driver exits 1, forwards verifier stderr', () => {
  const r = drive({
    spec: domainSpec(),
    payloads: { leases_by_tenant_response: {} },
    // verify-domain-state.cjs requires --expected; force a missing-arg path.
    context: { lease_uuid: UUID, fqdn: 'app.example.com' },
  });
  // Actually domainSpec passes --expected, so the verifier won't fail.
  // Repeat the call with bad UUID via context instead.
  const r2 = drive({
    spec: {
      ...domainSpec(),
      verifier: {
        ...domainSpec().verifier,
        args: ['--lease-uuid', 'not-a-uuid', '--service-name', 'web', '--expected', 'x'],
      },
    },
    payloads: { leases_by_tenant_response: {} },
    context: { lease_uuid: UUID, fqdn: 'app.example.com' },
  });
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /must be a UUID|exited 1/);
});

// ------------------------------ Case 13: bad stdin JSON ------------------------------

test('case 13: stdin not valid JSON → exit 1, stderr diagnostic', () => {
  const { spawnSync } = require('node:child_process');
  const { join: joinPath } = require('node:path');
  const SCRIPTS_DIR = joinPath(__dirname, '..', 'scripts');
  const res = spawnSync(process.execPath, [joinPath(SCRIPTS_DIR, 'verify-recover.cjs')], {
    input: 'not json{',
    encoding: 'utf8',
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /stdin is not valid JSON/);
});

// ------------------------------ Case 14: path traversal ------------------------------

test('case 14a: verifier.script with ".." → exit 1', () => {
  const r = drive({
    spec: { ...domainSpec(), verifier: { script: '../etc/passwd', args: [], stdin_source: null } },
    payloads: {},
    context: {},
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /must be a bare filename/);
});

test('case 14b: verifier.script absolute path → exit 1', () => {
  const r = drive({
    spec: { ...domainSpec(), verifier: { script: '/etc/passwd', args: [], stdin_source: null } },
    payloads: {},
    context: {},
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /must be a bare filename/);
});

test('case 14c: verifier.script with embedded slash → exit 1', () => {
  const r = drive({
    spec: { ...domainSpec(), verifier: { script: 'subdir/verify-domain-state.cjs', args: [], stdin_source: null } },
    payloads: {},
    context: {},
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /must be a bare filename/);
});

// ------------------------------ Cases 15–16: restart-app variants ------------------------------

test('case 15: restart-app success — name == LEASE_STATE_ACTIVE (state 2)', () => {
  const r = drive({
    spec: restartSpec(),
    payloads: {},
    context: { state_int: '2', lease_uuid: UUID },
  });
  assert.equal(r.status, 0);
  assert.equal(r.json.result, 'success');
  assert.equal(r.json.verifier_outcome, 'LEASE_STATE_ACTIVE');
  // diagnostic_delta should carry `terminal` (the non-success field).
  assert.equal(r.json.diagnostic_delta.terminal, false);
});

test('case 16: restart-app failure — CLOSED state (4) → restart-state-not-active', () => {
  const r = drive({
    spec: restartSpec(),
    payloads: {},
    context: { state_int: '4', lease_uuid: UUID },
  });
  assert.equal(r.status, 0);
  assert.equal(r.json.result, 'failure');
  assert.equal(r.json.branch_id, 'restart-state-not-active');
  assert.deepEqual(r.json.journal_action_tags, ['restart-post-verify-not-active']);
  assert.equal(r.json.user_message, 'Restart sent but state is now `LEASE_STATE_CLOSED`.');
});

// ------------------------------ Cases 17–18: fixture verifiers ------------------------------
// These cases need contrived verifier output that no production script
// emits (a denylisted key; a non-object stdout). We use the
// VERIFY_RECOVER_TEST_SCRIPTS_DIR env-var override (documented in
// verify-recover.cjs as test-only) to point at a tmpdir containing a
// fixture verifier.

function withFixtureDir(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-recover-fixture-'));
  const fixturePath = join(dir, 'fixture-verifier.cjs');
  writeFileSync(fixturePath, content, { mode: 0o755 });
  chmodSync(fixturePath, 0o755);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('case 17: denylist-keyed verifier stdout → driver strips matching keys from diagnostic_delta', () => {
  const content = `#!/usr/bin/env node
console.log(JSON.stringify({ outcome: 'ok', api_key: 'should-be-stripped', password: 'also-stripped', actual: 'safe' }));
`;
  withFixtureDir(content, (dir) => {
    const r = drive({
      spec: {
        verifier: { script: 'fixture-verifier.cjs', args: [], stdin_source: null },
        success: { field: 'outcome', values: ['ok'] },
        branches: {},
      },
      payloads: {},
      context: {},
    }, { VERIFY_RECOVER_TEST_SCRIPTS_DIR: dir });
    assert.equal(r.status, 0);
    assert.equal(r.json.result, 'success');
    // Denylisted keys MUST be stripped before emit.
    assert.equal(r.json.diagnostic_delta.api_key, undefined);
    assert.equal(r.json.diagnostic_delta.password, undefined);
    // Non-denylisted keys flow through.
    assert.equal(r.json.diagnostic_delta.actual, 'safe');
    // Driver's emitted JSON must not contain the stripped keys anywhere.
    assert.equal(/api_key/.test(r.stdout), false);
    assert.equal(/password/.test(r.stdout), false);
  });
});

test('case 18a: verifier stdout is JSON array → exit 1, no silent unclassified', () => {
  const content = `#!/usr/bin/env node
console.log(JSON.stringify(['array', 'not', 'object']));
`;
  withFixtureDir(content, (dir) => {
    const r = drive({
      spec: {
        verifier: { script: 'fixture-verifier.cjs', args: [], stdin_source: null },
        success: { field: 'outcome', values: ['ok'] },
        branches: {},
      },
      payloads: {},
      context: {},
    }, { VERIFY_RECOVER_TEST_SCRIPTS_DIR: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /must be a JSON object \(got array\)/);
  });
});

test('case 18b: verifier stdout is JSON null → exit 1', () => {
  const content = `#!/usr/bin/env node
console.log('null');
`;
  withFixtureDir(content, (dir) => {
    const r = drive({
      spec: {
        verifier: { script: 'fixture-verifier.cjs', args: [], stdin_source: null },
        success: { field: 'outcome', values: ['ok'] },
        branches: {},
      },
      payloads: {},
      context: {},
    }, { VERIFY_RECOVER_TEST_SCRIPTS_DIR: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /must be a JSON object/);
  });
});

test('case 18c: verifier stdout is JSON string → exit 1', () => {
  const content = `#!/usr/bin/env node
console.log(JSON.stringify('a scalar'));
`;
  withFixtureDir(content, (dir) => {
    const r = drive({
      spec: {
        verifier: { script: 'fixture-verifier.cjs', args: [], stdin_source: null },
        success: { field: 'outcome', values: ['ok'] },
        branches: {},
      },
      payloads: {},
      context: {},
    }, { VERIFY_RECOVER_TEST_SCRIPTS_DIR: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /must be a JSON object/);
  });
});

test('case 18d: verifier produces empty stdout → exit 1', () => {
  const content = `#!/usr/bin/env node
// emits nothing
`;
  withFixtureDir(content, (dir) => {
    const r = drive({
      spec: {
        verifier: { script: 'fixture-verifier.cjs', args: [], stdin_source: null },
        success: { field: 'outcome', values: ['ok'] },
        branches: {},
      },
      payloads: {},
      context: {},
    }, { VERIFY_RECOVER_TEST_SCRIPTS_DIR: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /produced no stdout/);
  });
});

// ------------------------------ Spec-shape guards ------------------------------

test('spec missing → exit 1', () => {
  const r = drive({ payloads: {}, context: {} });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /stdin\.spec missing/);
});

test('spec.verifier missing → exit 1', () => {
  const r = drive({ spec: { success: { field: 'x', values: [] } } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /spec\.verifier missing/);
});

test('spec.success.field empty → exit 1', () => {
  const r = drive({ spec: { verifier: { script: 'verify-domain-state.cjs', args: [], stdin_source: null }, success: { field: '', values: [] } } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /success\.field must be a non-empty string/);
});

test('spec.success.values not an array → exit 1', () => {
  const r = drive({ spec: { verifier: { script: 'verify-domain-state.cjs', args: [], stdin_source: null }, success: { field: 'outcome', values: 'match' } } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /success\.values must be an array/);
});
