'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
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

function withFiles(specRaw, catalogRaw, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'storage-selection-'));
  const specPath = join(dir, 'spec.json');
  const catalogPath = join(dir, 'catalog.json');
  writeFileSync(specPath, specRaw, { mode: 0o600 });
  writeFileSync(catalogPath, catalogRaw, { mode: 0o600 });
  try { return fn({ dir, specPath, catalogPath }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

function run(payload, catalogRaw) {
  let spec = payload;
  let catalog;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    ({ catalog, ...spec } = payload);
  }
  return withFiles(JSON.stringify(spec), catalogRaw ?? JSON.stringify(catalog ?? null), ({ specPath }) =>
    runScript('check-storage-selection.cjs', ['--spec-file', specPath],
      catalogRaw ?? JSON.stringify(catalog ?? null)));
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
  fails(run(input(), `{ ${SECRET}\n`), /catalog on stdin is not valid JSON/);
  fails(run(input(), ''), /catalog on stdin is not valid JSON/);
  withFiles(`{ ${SECRET}\n`, '{}', ({ specPath }) => {
    fails(runScript('check-storage-selection.cjs', ['--spec-file', specPath], '{}'), /spec file is not valid JSON/);
  });
});

test('requires a readable spec file with a JSON object', () => {
  for (const value of [null, [], 42, SECRET]) fails(run(value), /spec must be a JSON object/);
  for (const args of [[], ['--spec-file'], ['--unknown', 'x'], ['--spec-file', 'x', '--extra']]) {
    fails(runScript('check-storage-selection.cjs', args, '{}'), /usage:/);
  }
  withFiles('{}', '{}', ({ specPath }) => {
    rmSync(specPath);
    fails(runScript('check-storage-selection.cjs', ['--spec-file', specPath], '{}'), /could not read spec file/);
  });
});

test('storage must be a non-empty name', () => {
  for (const storage of [undefined, null, '', ' ', 1, {}]) {
    fails(run(input({ storage })), /storage must be/);
  }
});

test('storage name whitespace is trimmed for lookup as it is upstream', () => {
  const result = run(input({ storage: ' \tstorage-small\n' }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.storage, 'storage-small');
});

test('selected free-form labels retain internal whitespace as escaped JSON', () => {
  const storage = 'storage\nsmall';
  const result = run(input({ storage, catalog: { skus: [sku({ name: storage })] } }));
  assert.equal(result.status, 0);
  assert.equal(result.json.storage, storage);
  assert.equal(result.stdout.trim().split('\n').length, 1);
});

test('missing or invalid identity metadata rejects without a name-only fallback', () => {
  for (const field of ['storageSkuUuid', 'storageProviderUuid']) {
    for (const value of [undefined, null, '', SECRET, 1, {}, ` ${STORAGE}`, `${STORAGE}\n`]) {
      fails(run(input({ [field]: value })), new RegExp(`${field} must be a UUID`));
    }
  }
  fails(run({ storage: 'storage-small', catalog: { providers: [], skus: [sku()] } }), /metadata is incomplete/);
});

test('recorded storage provider must match the compute provider', () => {
  fails(run(input({ providerUuid: OTHER_PROVIDER })), /does not match the selected compute providerUuid/);
});

test('compute SKU alone determines the provider without name inference', () => {
  const result = run(input({
    providerUuid: undefined,
    skuUuid: ` ${OTHER_SKU} `,
    catalog: { skus: [sku(), sku({ sku_uuid: OTHER_SKU, name: 'docker-micro' })] },
  }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.providerUuid, PROVIDER);
});

test('missing, inactive, or mismatched compute identity rejects', () => {
  fails(run(input({ providerUuid: undefined })), /spec must identify the compute provider/);
  fails(run(input({ skuUuid: OTHER_SKU })), /compute SKU UUID is missing or inactive/);
  const compute = sku({ sku_uuid: OTHER_SKU, name: 'docker-micro', provider_uuid: OTHER_PROVIDER });
  fails(run(input({ skuUuid: OTHER_SKU, catalog: { skus: [sku(), compute] } })), /compute SKU UUID belongs to a different provider/);
  fails(run(input({ skuUuid: OTHER_SKU, catalog: { skus: [sku(), { ...compute, active: false }] } })), /compute SKU UUID is missing or inactive/);
});

test('compute aliases use the orchestrated contract; blank camelCase suppresses alias', () => {
  const result = run(input({ providerUuid: undefined, provider_uuid: ` ${PROVIDER} ` }));
  assert.equal(result.status, 0, result.stderr);
  fails(run(input({ providerUuid: '', provider_uuid: PROVIDER })), /spec must identify the compute provider/);
});

test('catalog must carry the browse_catalog SKU array', () => {
  for (const catalog of [undefined, null, [], SECRET, {}, { providers: [] },
    { providers: [], skus: {} }]) {
    fails(run(input({ catalog })), /catalog must be a browse_catalog response/);
  }
});

test('malformed selected or unrelated SKU identity rows reject', () => {
  for (const bad of [null, [], SECRET, {}, sku({ name: null }), sku({ name: 123 }),
    sku({ sku_uuid: undefined, uuid: STORAGE }),
    sku({ provider_uuid: null }), sku({ active: undefined }), sku({ active: 'true' })]) {
    fails(run(input({ catalog: { providers: [], skus: [bad] } })), /malformed SKU identity/);
    fails(run(input({ catalog: { providers: [], skus: [sku(), bad] } })), /malformed SKU identity/);
  }
});

test('unrelated string identifiers and duplicate unrelated rows do not block storage', () => {
  const unrelated = sku({ sku_uuid: 'foreign-sku', provider_uuid: 'foreign-provider' });
  const result = run(input({ catalog: { skus: [sku(), unrelated, unrelated] } }));
  assert.equal(result.status, 0, result.stderr);
});

test('UUID equality follows the case-sensitive upstream resolver', () => {
  const lower = 'abcdefab-cdef-4abc-8abc-abcdefabcdef';
  const upper = lower.toUpperCase();
  fails(run(input({ storageSkuUuid: upper, catalog: { skus: [sku({ sku_uuid: lower })] } })), /UUID is missing or inactive/);
  const matching = run(input({ storageSkuUuid: upper, catalog: { skus: [sku({ sku_uuid: upper })] } }));
  assert.equal(matching.status, 0, matching.stderr);
});

test('duplicate UUID records reject instead of selecting the first', () => {
  for (const duplicate of [sku(), sku({ active: false }), sku({ provider_uuid: OTHER_PROVIDER })]) {
    fails(run(input({ catalog: { providers: [], skus: [sku(), duplicate] } })), /duplicate storage SKU UUID records/);
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

test('file transport preserves hostile catalog names without executing shell content or exposing env values', () => {
  withFiles('{}', '{}', ({ dir, specPath, catalogPath }) => {
    const marker = join(dir, 'unexpected-shell-execution');
    const storage = `storage "quoted" \\ label\nSTORAGE_EOF\ntouch '${marker}'\n$(touch '${marker}')\n\`touch '${marker}'\`\nend`;
    const spec = { ...input({ storage }), env: { PASSWORD: SECRET } };
    delete spec.catalog;
    const specRaw = JSON.stringify(spec);
    writeFileSync(specPath, specRaw);
    writeFileSync(catalogPath, JSON.stringify({ skus: [sku({ name: storage })] }));
    // Execute the actual skill's command, so a prose regression to raw
    // interpolation cannot pass a separate, safely rewritten test command.
    const pluginRoot = join(__dirname, '..');
    const skill = readFileSync(join(pluginRoot, 'skills', 'deploy-app', 'SKILL.md'), 'utf8');
    const command = [...skill.matchAll(/```bash\n([\s\S]*?)```/g)]
      .map((match) => match[1]).find((block) => block.includes('check-storage-selection.cjs'));
    assert.ok(command, 'storage check command must be documented');
    const result = spawnSync('bash', ['-e', '-c', command], {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, MANIFEST_PLUGIN_ROOT: pluginRoot,
        SPEC_PATH: specPath, CATALOG_PATH: catalogPath },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).storage, storage);
    assert.equal(existsSync(marker), false);
    assert.equal(readFileSync(specPath, 'utf8'), specRaw);
    assert.ok(!result.stdout.includes(SECRET));
    assert.equal(result.stderr, '');
  });
});
