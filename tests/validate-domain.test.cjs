'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runScript } = require('./_subprocess.cjs');

function validate(domain) {
  return runScript('validate-domain.cjs', ['--domain', domain]).json;
}

test('valid two-label FQDN passes', () => {
  const r = validate('app.example.com');
  assert.equal(r.valid, true);
  assert.deepEqual(r.reasons, []);
});

test('uppercase rejected (RFC 1035 lowercase requirement)', () => {
  const r = validate('App.Example.com');
  assert.equal(r.valid, false);
  assert.ok(r.reasons.some((s) => /lowercase/.test(s)));
});

test('label exceeding 63 chars is rejected', () => {
  const long = 'a'.repeat(64);
  const r = validate(`${long}.example.com`);
  assert.equal(r.valid, false);
  assert.ok(r.reasons.some((s) => /exceeds 63 characters/.test(s)));
});

test('numeric TLD is rejected', () => {
  const r = validate('app.example.123');
  assert.equal(r.valid, false);
  assert.ok(r.reasons.some((s) => /must not be entirely numeric/.test(s)));
});

test('consecutive dots produce empty-label reason', () => {
  const r = validate('app..example.com');
  assert.equal(r.valid, false);
  assert.ok(r.reasons.some((s) => /empty/.test(s)));
});

test('leading / trailing dot is rejected', () => {
  assert.equal(validate('.example.com').valid, false);
  assert.equal(validate('example.com.').valid, false);
});

test('whitespace anywhere is rejected', () => {
  assert.equal(validate('app .example.com').valid, false);
  assert.equal(validate('app.example.com ').valid, false);
});

test('underscore is rejected (only letters/digits/dots/hyphens allowed)', () => {
  const r = validate('app_one.example.com');
  assert.equal(r.valid, false);
  assert.ok(r.reasons.some((s) => /only lowercase letters, digits, dots, and hyphens/.test(s)));
});

test('label starting/ending with hyphen is rejected', () => {
  assert.equal(validate('-app.example.com').valid, false);
  assert.equal(validate('app-.example.com').valid, false);
});

test('single-label (no dot) is rejected', () => {
  const r = validate('localhost');
  assert.equal(r.valid, false);
  assert.ok(r.reasons.some((s) => /at least one dot/.test(s)));
});

test('empty string is rejected', () => {
  // The CLI requires --domain to have a value, so we test via empty result
  const r = runScript('validate-domain.cjs', ['--domain', '']);
  // The hand-rolled parseArgs in this script uses truthy check, so empty
  // string is treated as missing → exit 1 with stderr. Document the actual
  // behavior so it's not silently changed.
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Missing required flag: --domain/);
});

test('domain over 253 chars is rejected (length cap)', () => {
  // 250 chars in label, so total > 253. Separately tests the cap, since
  // any single label over 63 also fires the per-label rule.
  const labels = ['abcdefghij', 'abcdefghij', 'abcdefghij', 'abcdefghij', 'abcdefghij'];
  // 5 × 10 + 4 dots = 54. Build something deliberately > 253 across many short labels.
  const big = Array.from({ length: 30 }, () => 'abcdefgh').join('.') + '.com';
  // 30 × 8 + 29 + 4 = 273
  const r = validate(big);
  assert.equal(r.valid, false);
  assert.ok(r.reasons.some((s) => /exceeds 253 characters/.test(s)));
});
