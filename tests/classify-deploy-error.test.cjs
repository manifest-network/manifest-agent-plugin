'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runScript } = require('./_subprocess.cjs');

function classify(errEnvelope, extraArgs = []) {
  return runScript('classify-deploy-error.cjs', extraArgs, JSON.stringify(errEnvelope)).json;
}

const VALID_UUID = '11111111-1111-4111-8111-111111111111';

test('partial-success: extracts lease_uuid from details when present', () => {
  const r = classify({
    message: `Deploy partially succeeded: lease ${VALID_UUID} was created but subsequent steps failed.`,
    details: { lease_uuid: VALID_UUID },
  });
  assert.equal(r.outcome, 'partially_succeeded');
  assert.equal(r.lease_uuid, VALID_UUID);
});

test('partial-success: falls back to UUID extracted from message text', () => {
  // Some upstream paths emit the partial-success message without populating
  // details.lease_uuid. The classifier must still recover the UUID via the
  // message text — orphaning a billing lease is the worst outcome here.
  const r = classify({
    message: `Deploy partially succeeded: lease ${VALID_UUID} was created but subsequent steps failed. Close this lease with close_lease if needed. Error: set-domain failed`,
    details: {},
  });
  assert.equal(r.outcome, 'partially_succeeded');
  assert.equal(r.lease_uuid, VALID_UUID);
});

test('partial-success: tolerates {error: {...}} wrapping (some SDK shapes)', () => {
  const r = classify({
    error: {
      message: `Deploy partially succeeded: lease ${VALID_UUID} was created.`,
      details: { lease_uuid: VALID_UUID },
    },
  });
  assert.equal(r.outcome, 'partially_succeeded');
  assert.equal(r.lease_uuid, VALID_UUID);
});

test('non-partial error → outcome: failed (no lease to clean up)', () => {
  const r = classify({ message: 'broadcast rejected: insufficient funds' });
  assert.equal(r.outcome, 'failed');
  assert.equal(r.lease_uuid, undefined);
  assert.match(r.reason, /insufficient funds/);
});

test('looser prefix is NOT classified as partial-success', () => {
  // Defense against false-positive: a message containing "partially
  // succeeded" but not at the start (e.g. nested in a wrapping error)
  // must not trigger the cleanup branch.
  const r = classify({ message: 'Wrapped error: Deploy partially succeeded was the inner cause but...' });
  assert.equal(r.outcome, 'failed');
});

test('expected-custom-domain is echoed back when provided', () => {
  const r = classify(
    { message: `Deploy partially succeeded: lease ${VALID_UUID}`, details: { lease_uuid: VALID_UUID } },
    ['--expected-custom-domain', 'app.example.com'],
  );
  assert.equal(r.requested_custom_domain, 'app.example.com');
});

test('empty error envelope produces a deterministic failed result', () => {
  const r = classify({});
  assert.equal(r.outcome, 'failed');
  assert.match(r.reason, /empty error/);
});

test('malformed JSON stdin → outcome: failed (always exits 0 for branchability)', () => {
  const r = runScript('classify-deploy-error.cjs', [], 'not json{');
  assert.equal(r.status, 0);
  assert.equal(r.json.outcome, 'failed');
  assert.match(r.json.reason, /not valid JSON/);
});
