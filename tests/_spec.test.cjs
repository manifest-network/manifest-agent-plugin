'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isStack, firstImage, normalizeServices } = require('../scripts/_spec.cjs');

test('isStack: true for services-map shape', () => {
  assert.equal(isStack({ services: { web: { image: 'a' } } }), true);
});

test('isStack: false for legacy single-service shape', () => {
  assert.equal(isStack({ image: 'a', port: 80 }), false);
});

test('isStack: false for null / undefined / arrays / non-objects', () => {
  assert.equal(isStack(null), false);
  assert.equal(isStack(undefined), false);
  assert.equal(isStack({ services: [] }), false);
  assert.equal(isStack({ services: 'string' }), false);
});

test('firstImage: returns legacy spec.image when present', () => {
  assert.equal(firstImage({ image: 'ghcr.io/me/app:v1', port: 80 }), 'ghcr.io/me/app:v1');
});

test('firstImage: returns first stack service image when no legacy spec.image', () => {
  const spec = { services: { web: { image: 'ghcr.io/me/web:v1' }, db: { image: 'postgres:16' } } };
  // Object.values preserves insertion order on modern Node — "web" is first.
  assert.equal(firstImage(spec), 'ghcr.io/me/web:v1');
});

test('firstImage: legacy image wins even when services map exists', () => {
  // Defensive: if a spec carries both shapes (malformed), legacy wins to
  // match build_manifest_preview's input contract.
  const spec = { image: 'legacy:v1', services: { web: { image: 'modern:v1' } } };
  assert.equal(firstImage(spec), 'legacy:v1');
});

test('firstImage: returns null when no image present', () => {
  assert.equal(firstImage({}), null);
  assert.equal(firstImage(null), null);
  assert.equal(firstImage({ services: { web: {} } }), null);
});

test('normalizeServices: legacy → single entry with name=null', () => {
  const result = normalizeServices({ image: 'a', port: 80 });
  assert.equal(result.length, 1);
  assert.equal(result[0].name, null);
  assert.equal(result[0].raw.image, 'a');
});

test('normalizeServices: stack → entries keyed by service name', () => {
  const spec = { services: { web: { image: 'w', ports: [80] }, db: { image: 'd' } } };
  const result = normalizeServices(spec);
  assert.equal(result.length, 2);
  const names = result.map((s) => s.name);
  assert.deepEqual(names.sort(), ['db', 'web']);
});

test('normalizeServices: tolerates null spec (returns empty single-entry)', () => {
  const result = normalizeServices(null);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, null);
  assert.deepEqual(result[0].raw, {});
});
