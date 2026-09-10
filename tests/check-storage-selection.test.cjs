'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runScript } = require('./_subprocess.cjs');

const STORAGE = '11111111-1111-4111-8111-111111111111';
const PROVIDER = '22222222-2222-4222-8222-222222222222';
const OTHER_SKU = '33333333-3333-4333-8333-333333333333';
const OTHER_PROVIDER = '44444444-4444-4444-8444-444444444444';
const SECRET = 'PRIVATE_VALUE_MUST_NOT_APPEAR';

function sku(overrides = {}) {
  return {
    name: 'storage-small',
    sku_uuid: STORAGE,
    provider_uuid: PROVIDER,
    provider_url: 'https://provider.example',
    price: '12',
    unit: 'upwr',
    active: true,
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    storage: 'storage-small',
    storageSkuUuid: STORAGE,
    storageProviderUuid: PROVIDER,
    providerUuid: PROVIDER,
    catalog: { providers: [], skus: [sku()] },
    ...overrides,
  };
}

function run(payload) {
  return runScript('check-storage-selection.cjs', [], JSON.stringify(payload));
}

function fails(result, diagnostic) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, diagnostic);
  assert.equal(result.stderr.trim().split('\n').length, 1);
  assert.doesNotMatch(result.stderr, new RegExp(SECRET));
}

test('checks a matching observed identity and emits only the safe summary', () => {
  const result = run(input({
    env: { PASSWORD: SECRET },
    catalog: { providers: [{ debug: SECRET }], skus: [sku({ extra: SECRET, provider_url: SECRET })] },
  }));
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(result.json, {
    checked: true,
    storage: 'storage-small',
    storageSkuUuid: STORAGE,
    storageProviderUuid: PROVIDER,
    providerUuid: PROVIDER,
  });
  assert.doesNotMatch(result.stdout, new RegExp(SECRET));
});

test('the same active name on another provider is unambiguous', () => {
  const result = run(input({ catalog: { providers: [], skus: [
    sku({ sku_uuid: OTHER_SKU, provider_uuid: OTHER_PROVIDER }), sku(),
  ] } }));
  assert.equal(result.status, 0);
  assert.equal(result.json.storageSkuUuid, STORAGE);
});

test('unused provider and pricing data are not required for identity checks', () => {
  const result = run(input({ catalog: { skus: [sku({ price: null, unit: null, provider_url: null })] } }));
  assert.equal(result.status, 0);
});

test('a different active UUID with the same name on the selected provider rejects', () => {
  fails(run(input({ catalog: { providers: [], skus: [
    sku(), sku({ sku_uuid: OTHER_SKU }),
  ] } })), /storage name is ambiguous/);
});

test('inactive same-name rows and other active names do not create ambiguity', () => {
  const result = run(input({ catalog: { providers: [], skus: [
    sku(), sku({ sku_uuid: OTHER_SKU, active: false }),
    sku({ sku_uuid: OTHER_PROVIDER, name: 'storage-large' }),
  ] } }));
  assert.equal(result.status, 0);
});

test('unrelated SKU names can be empty, padded, or contain control characters', () => {
  for (const name of ['', ' storage-small ', `storage\n${SECRET}`]) {
    const result = run(input({ catalog: { skus: [sku(), sku({ sku_uuid: OTHER_SKU, name })] } }));
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, new RegExp(SECRET));
  }
});

test('malformed JSON diagnostics do not echo parser excerpts', () => {
  fails(runScript('check-storage-selection.cjs', [], `{ ${SECRET}\n`), /stdin is not valid JSON/);
  fails(runScript('check-storage-selection.cjs', [], ''), /stdin is not valid JSON/);
});

test('non-object input rejects', () => {
  for (const value of [null, [], 42, SECRET]) fails(run(value), /expected a JSON object/);
});

test('storage must be a non-empty name unaffected by upstream trimming', () => {
  for (const storage of [undefined, null, '', ' ', ' storage-small', 'storage-small ', 1, {}]) {
    fails(run(input({ storage })), /storage must be/);
  }
});

test('selected free-form labels retain internal whitespace as escaped JSON', () => {
  const storage = 'storage\nsmall';
  const result = run(input({ storage, catalog: { skus: [sku({ name: storage })] } }));
  assert.equal(result.status, 0);
  assert.equal(result.json.storage, storage);
  assert.equal(result.stdout.trim().split('\n').length, 1);
});

test('missing or invalid identity metadata rejects without a name-only fallback', () => {
  for (const field of ['storageSkuUuid', 'storageProviderUuid', 'providerUuid']) {
    for (const value of [undefined, null, '', SECRET, 1, {}, ` ${STORAGE}`, `${STORAGE}\n`]) {
      fails(run(input({ [field]: value })), new RegExp(`${field} must be a UUID`));
    }
  }
  fails(run({ storage: 'storage-small', catalog: { providers: [], skus: [sku()] } }), /metadata is incomplete/);
});

test('recorded storage provider must match the compute provider', () => {
  fails(run(input({ providerUuid: OTHER_PROVIDER })), /does not match the selected compute providerUuid/);
});

test('catalog must carry the browse_catalog SKU array', () => {
  for (const catalog of [undefined, null, [], SECRET, {}, { providers: [] },
    { providers: [], skus: {} }]) {
    fails(run(input({ catalog })), /catalog must be a browse_catalog response/);
  }
});

test('malformed selected or unrelated SKU identity rows reject', () => {
  for (const bad of [null, [], SECRET, {}, sku({ name: null }), sku({ name: 123 }),
    sku({ sku_uuid: SECRET }), sku({ sku_uuid: undefined, uuid: STORAGE }),
    sku({ provider_uuid: null }), sku({ active: undefined }), sku({ active: 'true' })]) {
    fails(run(input({ catalog: { providers: [], skus: [bad] } })), /malformed SKU identity/);
    fails(run(input({ catalog: { providers: [], skus: [sku(), bad] } })), /malformed SKU identity/);
  }
});

test('duplicate UUID records reject instead of selecting the first', () => {
  for (const duplicate of [sku(), sku({ active: false }), sku({ provider_uuid: OTHER_PROVIDER })]) {
    fails(run(input({ catalog: { providers: [], skus: [sku(), duplicate] } })), /duplicate SKU UUID records/);
  }
});

test('missing or inactive selected UUID rejects even when another same-name row exists', () => {
  for (const skus of [[], [sku({ sku_uuid: OTHER_SKU })], [sku({ active: false })],
    [sku({ active: false }), sku({ sku_uuid: OTHER_SKU })]]) {
    fails(run(input({ catalog: { providers: [], skus } })), /UUID is missing or inactive/);
  }
});

test('selected UUID cannot move provider or be replaced by a same-name row', () => {
  fails(run(input({ catalog: { providers: [], skus: [
    sku({ provider_uuid: OTHER_PROVIDER }), sku({ sku_uuid: OTHER_SKU }),
  ] } })), /UUID belongs to a different provider/);
});

test('selected UUID cannot be renamed or be replaced by a same-name row', () => {
  fails(run(input({ catalog: { providers: [], skus: [
    sku({ name: SECRET }), sku({ sku_uuid: OTHER_SKU }),
  ] } })), /UUID has a different name/);
});
