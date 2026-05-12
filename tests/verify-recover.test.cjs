'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, chmodSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

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

test('case 14d: verifier.script === "." resolves to scripts/ itself → exit 1 (not a regular file)', () => {
  // `.` passes the string-pattern check (contains no `..`, `/`, or `\`),
  // joins to SCRIPTS_DIR, realpath resolves to SCRIPTS_DIR_REAL itself.
  // Containment check allows resolved === SCRIPTS_DIR_REAL. Without the
  // isFile() guard the driver would spawn `node <SCRIPTS_DIR>` and produce
  // an opaque Node error. With the guard, the driver fails fast with a
  // clean diagnostic.
  const r = drive({
    spec: { ...domainSpec(), verifier: { script: '.', args: [], stdin_source: null } },
    payloads: {},
    context: {},
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is not a regular file inside scripts\//);
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

test('case 17a: top-level denylist-keyed verifier stdout → driver strips matching keys from diagnostic_delta', () => {
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
    }, { NODE_ENV: 'test', VERIFY_RECOVER_TEST_SCRIPTS_DIR: dir });
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

test('case 17b: NESTED denylist-keyed verifier stdout → driver strips recursively (deep walk)', () => {
  // The `_journal.validateRecord` writer-side check walks the entire
  // record tree and fail-closes on a denylisted key at any depth. The
  // driver's stdout (which feeds skill prose verbatim, including
  // user_message print) must match that posture: top-level stripping
  // alone would leak nested denylisted values through `diagnostic_delta`
  // even though the journal record itself would be rejected.
  const content = `#!/usr/bin/env node
console.log(JSON.stringify({
  outcome: 'ok',
  details: { api_key: 'nested-leak-1', deeper: { password: 'nested-leak-2', safe_field: 'kept' } },
  auth_token: 'top-level-strip',
  list: [{ private_key: 'in-array-leak', other: 'kept' }, 'string-element'],
  actual: 'kept-top-level'
}));
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
    }, { NODE_ENV: 'test', VERIFY_RECOVER_TEST_SCRIPTS_DIR: dir });
    assert.equal(r.status, 0);
    assert.equal(r.json.result, 'success');

    // No denylisted key, at any depth, may appear in the emitted JSON.
    assert.equal(/api_key/.test(r.stdout), false, 'nested api_key leaked');
    assert.equal(/password/.test(r.stdout), false, 'nested password leaked');
    assert.equal(/private_key/.test(r.stdout), false, 'array-nested private_key leaked');
    assert.equal(/auth_token/.test(r.stdout), false, 'auth_token-shape key leaked');

    // Surviving non-denylisted keys are still reachable.
    assert.equal(r.json.diagnostic_delta.actual, 'kept-top-level');
    assert.equal(r.json.diagnostic_delta.details.deeper.safe_field, 'kept');
    assert.equal(r.json.diagnostic_delta.list[0].other, 'kept');
    assert.equal(r.json.diagnostic_delta.list[1], 'string-element');
    // The nested objects themselves remain (only the denylisted keys inside them
    // are removed).
    assert.deepEqual(Object.keys(r.json.diagnostic_delta.details), ['deeper']);
    assert.deepEqual(Object.keys(r.json.diagnostic_delta.details.deeper), ['safe_field']);
  });
});

test('case 17c: prototype-pollution keys in verifier stdout → driver skips them (no prototype mutation)', () => {
  // `JSON.parse` materializes `__proto__`, `constructor`, and `prototype` as
  // regular own properties on the resulting object. Without explicit
  // skipping, `out[k] = …` with `k === "__proto__"` would re-set the
  // prototype of the local `out` object — a textbook prototype-pollution
  // sink. This test asserts the driver's strip skips all three keys at
  // every depth and emits a clean object.
  const content = `#!/usr/bin/env node
console.log(JSON.stringify({
  outcome: 'ok',
  __proto__: { polluted_top: 'should-not-survive' },
  constructor: { polluted_via_constructor: 'should-not-survive' },
  prototype: { polluted_via_prototype: 'should-not-survive' },
  nested: { __proto__: { polluted_nested: 'should-not-survive' }, safe: 'kept' },
  list: [{ __proto__: { polluted_in_array_elem: 'should-not-survive' }, item_safe: 'kept' }],
  actual: 'kept-top-level'
}));
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
    }, { NODE_ENV: 'test', VERIFY_RECOVER_TEST_SCRIPTS_DIR: dir });
    assert.equal(r.status, 0);
    assert.equal(r.json.result, 'success');

    // None of the prototype-pollution payload strings may appear anywhere
    // in the driver's emitted JSON (no own properties; no leaked values).
    assert.equal(/polluted_top/.test(r.stdout), false, 'top-level __proto__ payload leaked');
    assert.equal(/polluted_via_constructor/.test(r.stdout), false, 'constructor payload leaked');
    assert.equal(/polluted_via_prototype/.test(r.stdout), false, 'prototype payload leaked');
    assert.equal(/polluted_nested/.test(r.stdout), false, 'nested __proto__ payload leaked');
    assert.equal(/polluted_in_array_elem/.test(r.stdout), false, 'array-elem __proto__ payload leaked');

    // The local diagnostic_delta object must not have its prototype
    // mutated — `Object.getPrototypeOf` returns Object.prototype, and the
    // polluted keys are not reachable via property access on the parsed
    // result (which is itself the product of JSON.stringify on the driver
    // side; this asserts the wire format is clean).
    assert.equal(Object.getPrototypeOf(r.json.diagnostic_delta), Object.prototype);
    assert.equal(r.json.diagnostic_delta.polluted_top, undefined);
    assert.equal(r.json.diagnostic_delta.polluted_via_constructor, undefined);
    assert.equal(r.json.diagnostic_delta.polluted_via_prototype, undefined);

    // Surviving non-prototype keys still flow through.
    assert.equal(r.json.diagnostic_delta.actual, 'kept-top-level');
    assert.equal(r.json.diagnostic_delta.nested.safe, 'kept');
    assert.equal(r.json.diagnostic_delta.list[0].item_safe, 'kept');
    assert.deepEqual(Object.keys(r.json.diagnostic_delta.nested), ['safe']);
    assert.deepEqual(Object.keys(r.json.diagnostic_delta.list[0]), ['item_safe']);
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
    }, { NODE_ENV: 'test', VERIFY_RECOVER_TEST_SCRIPTS_DIR: dir });
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
    }, { NODE_ENV: 'test', VERIFY_RECOVER_TEST_SCRIPTS_DIR: dir });
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
    }, { NODE_ENV: 'test', VERIFY_RECOVER_TEST_SCRIPTS_DIR: dir });
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
    }, { NODE_ENV: 'test', VERIFY_RECOVER_TEST_SCRIPTS_DIR: dir });
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

test('spec.branches === null → exit 1 (typeof null === "object" trap)', () => {
  // Without the explicit null check, branches: null would pass the
  // `typeof !== 'object'` guard and fall through to selectBranch, which
  // would silently synthesize an `unclassified` branch — defeating the
  // fail-fast posture the other spec-shape guards establish.
  const r = drive({
    spec: {
      verifier: { script: 'decode-lease-state.cjs', args: ['--state', '4', '--json'], stdin_source: null },
      success: { field: 'terminal', values: [true] },
      branches: null,
    },
    payloads: {},
    context: {},
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /spec\.branches must be an object when present/);
});

// ------------------------------ C2: missing success.field key ------------------------------

test('case 19: verifier stdout missing success.field key → exit 1 (no silent unclassified routing)', () => {
  // Verifier emits a valid JSON object but the spec.success.field key
  // ("outcome") is missing entirely. Without the hasOwnProperty check the
  // driver would compute `outcome = undefined`, fall into the failure
  // path, match `branches.other` (or synthesize `unclassified`), and exit
  // 0 — silently classifying a drifted verifier output as a recovery
  // branch. The check forces exit 1 so the drift surfaces.
  const content = `#!/usr/bin/env node
console.log(JSON.stringify({ unrelated: 'shape drift', actual: 'whatever' }));
`;
  withFixtureDir(content, (dir) => {
    const r = drive({
      spec: {
        verifier: { script: 'fixture-verifier.cjs', args: [], stdin_source: null },
        success: { field: 'outcome', values: ['ok'] },
        branches: {
          other: { branch_id: 'should-not-match', journal_action_tag: 'should-not-fire', user_message: 'should not see this' },
        },
      },
      payloads: {},
      context: {},
    }, { NODE_ENV: 'test', VERIFY_RECOVER_TEST_SCRIPTS_DIR: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /missing required field 'outcome'/);
  });
});

// ------------------------------ C1: env-var override gating ------------------------------

test('case 20: VERIFY_RECOVER_TEST_SCRIPTS_DIR ignored when NODE_ENV !== "test"', () => {
  // Fixture verifier in tmpdir. Without NODE_ENV=test the override must
  // be silently ignored, so the driver looks for 'fixture-verifier.cjs'
  // inside the production scripts/ directory — where it does NOT exist —
  // and fails with the realpath-resolution error from sanitizeScriptName.
  // (Not the "must be a bare filename" error, since the filename itself is
  // valid; the failure mode is "cannot resolve" because the file isn't in
  // scripts/.)
  const content = `#!/usr/bin/env node
console.log(JSON.stringify({ outcome: 'ok' }));
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
    }, {
      // NOTE: deliberately NO NODE_ENV=test here; the override must be ignored.
      NODE_ENV: 'production',
      VERIFY_RECOVER_TEST_SCRIPTS_DIR: dir,
    });
    assert.equal(r.status, 1);
    // The driver should have looked in the production scripts/ dir, found
    // no 'fixture-verifier.cjs' there, and failed at realpath resolution.
    assert.match(r.stderr, /could not be resolved|symlink escape/);
  });
});

test('case 21: VERIFY_RECOVER_TEST_SCRIPTS_DIR ignored when NODE_ENV is unset', () => {
  // Same as case 20 but NODE_ENV is unset entirely (the most common
  // production posture). The override must still be ignored.
  const content = `#!/usr/bin/env node
console.log(JSON.stringify({ outcome: 'ok' }));
`;
  withFixtureDir(content, (dir) => {
    // Strip NODE_ENV from the spawned child's env so the gate sees
    // `process.env.NODE_ENV === undefined`. Cannot do this via the env
    // spread used elsewhere because that inherits process.env.
    const { spawnSync } = require('node:child_process');
    const { join: joinPath } = require('node:path');
    const SCRIPTS_DIR = joinPath(__dirname, '..', 'scripts');
    const childEnv = { ...process.env, VERIFY_RECOVER_TEST_SCRIPTS_DIR: dir };
    delete childEnv.NODE_ENV;
    const res = spawnSync(process.execPath, [joinPath(SCRIPTS_DIR, 'verify-recover.cjs')], {
      input: JSON.stringify({
        spec: {
          verifier: { script: 'fixture-verifier.cjs', args: [], stdin_source: null },
          success: { field: 'outcome', values: ['ok'] },
          branches: {},
        },
        payloads: {},
        context: {},
      }),
      encoding: 'utf8',
      env: childEnv,
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /could not be resolved|symlink escape/);
  });
});
