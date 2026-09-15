'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, dirname, isAbsolute } = require('node:path');
const { spawnSync } = require('node:child_process');

const IDENTITY = {
  size: 'small',
  skuUuid: '11111111-1111-4111-8111-111111111111',
  providerUuid: '22222222-2222-4222-8222-222222222222',
  storage: 'ssd-20',
  storageSkuUuid: '33333333-3333-4333-8333-333333333333',
  storageProviderUuid: '22222222-2222-4222-8222-222222222222',
};

function withDataDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-save-draft-test-'));
  try { return fn(dir); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

function runScript(script, args, input, dataDir) {
  return spawnSync(process.execPath, [join(__dirname, '..', 'scripts', script), ...args], {
    encoding: 'utf8',
    input,
    env: { ...process.env, MANIFEST_PLUGIN_DATA: dataDir },
  });
}

const scenarios = [
  {
    name: 'authored one-service map',
    serviceName: 'app',
    spec: {
      ...IDENTITY,
      services: {
        app: {
          image: 'nginx:1.27',
          ports: { '80/tcp': { ingress: true } },
          env: { LOG_LEVEL: 'info', API_KEY: 'old-private-value' },
        },
      },
    },
  },
  {
    name: 'authored multi-service map',
    serviceName: 'db',
    spec: {
      ...IDENTITY,
      services: {
        web: {
          image: 'nginx:1.27',
          ports: { '80/tcp': { ingress: true } },
          env: { DATABASE_HOST: 'db' },
          depends_on: ['db'],
        },
        db: { image: 'postgres:16', env: { LOG_LEVEL: 'info', API_KEY: 'old-private-value' } },
      },
    },
  },
  {
    name: 'legacy flat spec without identity',
    serviceName: null,
    spec: { image: 'nginx:1.27', port: 80, size: 'small', env: { LOG_LEVEL: 'info', API_KEY: 'old-private-value' } },
  },
  {
    name: 'digest-pinned one-service map',
    serviceName: 'app',
    spec: {
      ...IDENTITY,
      services: {
        app: {
          image: `docker.io/library/nginx@sha256:${'a'.repeat(64)}`,
          ports: { '80/tcp': { ingress: true } },
        },
      },
    },
  },
  {
    name: 'stack with a registry port, tag-plus-digest, and mutable opt-outs',
    serviceName: 'web',
    spec: {
      ...IDENTITY,
      services: {
        web: {
          image: `registry.example.com:5443/team/web:stable@sha256:${'b'.repeat(64)}`,
          ports: { '8080/tcp': { ingress: true } },
        },
        db: { image: 'postgres:16' },
        worker: { image: 'busybox' },
      },
    },
  },
  {
    name: 'digest-pinned legacy flat spec',
    serviceName: null,
    spec: { size: 'small', image: `nginx@sha256:${'c'.repeat(64)}`, port: 80 },
  },
];

for (const { name, serviceName, spec } of scenarios) {
  test(`save and env merge preserve the full ${name}`, () => {
    withDataDir((dataDir) => {
      const saved = runScript('save-manifest-draft.cjs', [], JSON.stringify(spec), dataDir);
      assert.equal(saved.status, 0, saved.stderr);
      assert.equal(saved.stderr, '');
      const specPath = saved.stdout.trimEnd();
      assert.ok(isAbsolute(specPath));
      assert.equal(dirname(specPath), join(dataDir, 'manifests-drafts'));
      assert.equal(saved.stdout, `${specPath}\n`, 'save stdout contains only the draft path');
      assert.equal(statSync(specPath).mode & 0o777, 0o600);
      assert.equal(statSync(dirname(specPath)).mode & 0o777, 0o700);
      assert.deepEqual(JSON.parse(readFileSync(specPath, 'utf8')), spec);

      const envPath = join(dataDir, 'app.env');
      const mergedEnv = { API_KEY: 'merged-private-api-value', DATABASE_URL: 'postgres://private-connection-value@db/app' };
      writeFileSync(envPath, `API_KEY=${mergedEnv.API_KEY}\nDATABASE_URL=${mergedEnv.DATABASE_URL}\n`, { mode: 0o600 });
      const args = ['--spec-file', specPath];
      if (serviceName !== null) args.push('--service-name', serviceName);
      const merged = runScript('merge-env.cjs', args, readFileSync(envPath, 'utf8'), dataDir);
      assert.equal(merged.status, 0, merged.stderr);
      assert.equal(merged.stderr, '');
      assert.deepEqual(JSON.parse(merged.stdout), { service: serviceName, keys_merged: ['API_KEY', 'DATABASE_URL'] });
      for (const secret of ['old-private-value', ...Object.values(mergedEnv)]) {
        assert.ok(!saved.stdout.includes(secret), 'save stdout must exclude env values');
        assert.ok(!merged.stdout.includes(secret), 'merge stdout must exclude env values');
      }

      const expected = structuredClone(spec);
      const target = serviceName === null ? expected : expected.services[serviceName];
      target.env = { ...target.env, ...mergedEnv };
      // Full equality covers SKU/storage names and UUIDs, unrelated services,
      // existing env keys, exact image references (pins and mutable opt-outs),
      // and legacy specs that never had identity fields. Filename sanitization
      // must not strip a digest or a registry port from the saved image.
      assert.deepEqual(JSON.parse(readFileSync(specPath, 'utf8')), expected);
      assert.equal(statSync(specPath).mode & 0o777, 0o600);
    });
  });
}

test('save refuses to overwrite a draft with a different selected SKU', () => {
  withDataDir((dataDir) => {
    const specPath = join(dataDir, 'manifests-drafts', 'selected.json');
    const original = scenarios[0].spec;
    const saved = runScript('save-manifest-draft.cjs', ['--path', specPath], JSON.stringify(original), dataDir);
    assert.equal(saved.status, 0, saved.stderr);
    assert.equal(saved.stdout, `${specPath}\n`);
    const before = readFileSync(specPath, 'utf8');
    const replacement = { ...original, skuUuid: '44444444-4444-4444-8444-444444444444' };
    const refused = runScript('save-manifest-draft.cjs', ['--path', specPath], JSON.stringify(replacement), dataDir);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /Refusing to overwrite existing file/);
    assert.equal(refused.stdout, '');
    assert.equal(readFileSync(specPath, 'utf8'), before);
    assert.equal(statSync(specPath).mode & 0o777, 0o600);
  });
});
