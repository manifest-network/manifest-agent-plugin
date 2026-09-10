'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isStack, firstImage, normalizeServices, skuIdentity } = require('../scripts/_spec.cjs');

const SKU_UUID = '11111111-1111-4111-8111-111111111111';
const PROVIDER_UUID = '22222222-2222-4222-8222-222222222222';

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

test('skuIdentity: projects top-level identity from flat and stack specs', () => {
  for (const shape of [
    { image: 'nginx', port: 80, env: { API_KEY: 'private-env-value' } },
    { services: { web: { image: 'nginx', env: { API_KEY: 'private-env-value' } } } },
  ]) {
    assert.deepEqual(skuIdentity({
      ...shape,
      skuUuid: SKU_UUID,
      providerUuid: PROVIDER_UUID,
      size: 'small',
      skuName: 'small',
    }), { skuUuid: SKU_UUID, providerUuid: PROVIDER_UUID });
  }
});

test('skuIdentity: accepts snake_case aliases and prefers string camelCase values', () => {
  assert.deepEqual(skuIdentity({ sku_uuid: SKU_UUID, provider_uuid: PROVIDER_UUID }), {
    skuUuid: SKU_UUID,
    providerUuid: PROVIDER_UUID,
  });
  assert.deepEqual(skuIdentity({
    skuUuid: SKU_UUID,
    sku_uuid: 'other-sku',
    providerUuid: PROVIDER_UUID,
    provider_uuid: 'other-provider',
  }), { skuUuid: SKU_UUID, providerUuid: PROVIDER_UUID });
  assert.deepEqual(skuIdentity({
    skuUuid: { value: 'private-value' },
    sku_uuid: SKU_UUID,
    providerUuid: false,
    provider_uuid: PROVIDER_UUID,
  }), { skuUuid: SKU_UUID, providerUuid: PROVIDER_UUID });
});

test('skuIdentity: absent or malformed identity produces an empty projection', () => {
  for (const spec of [
    null, undefined, false, 7, 'small', [], {},
    { image: 'nginx', port: 80, size: 'small', skuName: 'small' },
    { skuUuid: null, sku_uuid: [], providerUuid: 7, provider_uuid: {} },
    { services: { web: { image: 'nginx', skuUuid: SKU_UUID, providerUuid: PROVIDER_UUID } } },
  ]) {
    assert.deepEqual(skuIdentity(spec), {});
  }
});

test('skuIdentity: preserves each available string field without inventing its counterpart', () => {
  assert.deepEqual(skuIdentity({ skuUuid: SKU_UUID, providerUuid: {} }), { skuUuid: SKU_UUID });
  assert.deepEqual(skuIdentity({ provider_uuid: PROVIDER_UUID }), { providerUuid: PROVIDER_UUID });
  // This is a projection, not UUID validation: match the journal's string-only whitelist.
  assert.deepEqual(skuIdentity({ skuUuid: '', sku_uuid: SKU_UUID }), { skuUuid: '' });
});
