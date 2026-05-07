'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { UUID_RE, UUID_PATTERN, isUuid } = require('../scripts/_uuid.cjs');

const VALID_V4 = '11111111-1111-4111-8111-111111111111';
const VALID_V7 = '01931a72-d4c0-7000-9000-2e3a4b5c6d7e';

test('UUID_RE accepts canonical 8-4-4-4-12 hex shape', () => {
  assert.equal(UUID_RE.test(VALID_V4), true);
});

test('UUID_RE is lenient on the version byte (accepts v7)', () => {
  assert.equal(UUID_RE.test(VALID_V7), true);
});

test('UUID_RE accepts uppercase (case-insensitive flag)', () => {
  assert.equal(UUID_RE.test(VALID_V4.toUpperCase()), true);
});

test('UUID_RE rejects path-traversal attempts', () => {
  assert.equal(UUID_RE.test('../../config'), false);
  assert.equal(UUID_RE.test('/etc/passwd'), false);
  assert.equal(UUID_RE.test('../foo'), false);
});

test('UUID_RE rejects extra surrounding text (anchored)', () => {
  assert.equal(UUID_RE.test(' ' + VALID_V4), false);
  assert.equal(UUID_RE.test(VALID_V4 + ' '), false);
  assert.equal(UUID_RE.test('lease-' + VALID_V4), false);
});

test('UUID_RE rejects malformed shapes', () => {
  assert.equal(UUID_RE.test(''), false);
  assert.equal(UUID_RE.test('not-a-uuid'), false);
  // Wrong group lengths
  assert.equal(UUID_RE.test('1111111-1111-1111-1111-111111111111'), false);
  assert.equal(UUID_RE.test('11111111-1111-1111-1111-1111111111111'), false);
  // Missing dashes
  assert.equal(UUID_RE.test('11111111111141118111111111111111'), false);
});

test('UUID_PATTERN extracts a UUID embedded in a longer string', () => {
  const msg = `Deploy partially succeeded: lease ${VALID_V4} was created but subsequent steps failed.`;
  const m = msg.match(UUID_PATTERN);
  assert.ok(m);
  assert.equal(m[0], VALID_V4);
});

test('isUuid is a thin wrapper that handles non-strings', () => {
  assert.equal(isUuid(VALID_V4), true);
  assert.equal(isUuid(null), false);
  assert.equal(isUuid(undefined), false);
  assert.equal(isUuid(12345), false);
  assert.equal(isUuid({}), false);
});
