'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = join(__dirname, '..', 'scripts', 'summarize-manifest.cjs');

function runWithDataDir(dataDir, leaseUuid) {
  return spawnSync(process.execPath, [SCRIPT, '--lease-uuid', leaseUuid], {
    encoding: 'utf8',
    env: { ...process.env, MANIFEST_PLUGIN_DATA: dataDir },
  });
}

function withDataDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-summary-test-'));
  mkdirSync(join(dir, 'manifests'), { recursive: true });
  try { return fn(dir); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

const UUID = '11111111-1111-4111-8111-111111111111';

test('redaction: env VALUES never appear in stdout (security-critical)', () => {
  withDataDir((dataDir) => {
    const SECRET = 'super-secret-postgres-password-DO-NOT-LEAK';
    const wrapper = {
      schema_version: 3,
      lease_uuid: UUID,
      image: 'ghcr.io/me/web:v1',
      size: 'small',
      deployed_at_iso: '2026-05-06T12:00:00Z',
      chain_id: 'manifest-ledger-mainnet',
      meta_hash_hex: 'deadbeef',
      format: 'stack',
      manifest_json: JSON.stringify({
        services: {
          web: {
            image: 'ghcr.io/me/web:v1',
            ports: { '80': {} },
            env: {
              DATABASE_URL: `postgres://user:${SECRET}@db/app`,
              API_KEY: 'sk-anotherSecret',
            },
          },
        },
      }),
    };
    writeFileSync(join(dataDir, 'manifests', `${UUID}.json`), JSON.stringify(wrapper));
    const r = runWithDataDir(dataDir, UUID);
    assert.equal(r.status, 0);
    assert.ok(!r.stdout.includes(SECRET), 'env value MUST NOT appear in summary output');
    assert.ok(!r.stdout.includes('sk-anotherSecret'), 'env value MUST NOT appear in summary output');
    // But the keys must appear, since they're harmless and useful for review.
    assert.ok(r.stdout.includes('DATABASE_URL'));
    assert.ok(r.stdout.includes('API_KEY'));
    // And the explicit redaction notice must be there so the reader knows.
    assert.match(r.stdout, /Env \*values\* are intentionally redacted/);
  });
});

test('counts: services and ports tallied accurately', () => {
  withDataDir((dataDir) => {
    const wrapper = {
      schema_version: 3,
      lease_uuid: UUID,
      manifest_json: JSON.stringify({
        services: {
          web: { image: 'a', ports: { '80': {}, '443': {} } },
          db: { image: 'b', ports: { '5432': {} } },
        },
      }),
    };
    writeFileSync(join(dataDir, 'manifests', `${UUID}.json`), JSON.stringify(wrapper));
    const r = runWithDataDir(dataDir, UUID);
    assert.match(r.stdout, /Services:\s+2/);
    assert.match(r.stdout, /Ports exposed:\s+3/);
  });
});

test('v3 wrapper: custom_domain and custom_domain_service_name surface correctly', () => {
  withDataDir((dataDir) => {
    const wrapper = {
      schema_version: 3,
      lease_uuid: UUID,
      custom_domain: 'app.example.com',
      custom_domain_service_name: 'web',
      manifest_json: JSON.stringify({ services: { web: { image: 'a' } } }),
    };
    writeFileSync(join(dataDir, 'manifests', `${UUID}.json`), JSON.stringify(wrapper));
    const r = runWithDataDir(dataDir, UUID);
    assert.match(r.stdout, /Custom domain:\s+app\.example\.com/);
    assert.match(r.stdout, /Domain service:\s+web/);
  });
});

test('v2 wrapper without v3 fields: renders cleanly (no undefined leaks)', () => {
  withDataDir((dataDir) => {
    const wrapper = {
      schema_version: 2,
      lease_uuid: UUID,
      image: 'ghcr.io/me/app:v1',
      manifest_json: JSON.stringify({ services: { web: { image: 'a' } } }),
    };
    writeFileSync(join(dataDir, 'manifests', `${UUID}.json`), JSON.stringify(wrapper));
    const r = runWithDataDir(dataDir, UUID);
    assert.equal(r.status, 0);
    assert.ok(!r.stdout.includes('undefined'));
    assert.ok(!r.stdout.includes('Custom domain'));
  });
});

test('rejects non-UUID lease-uuid arg (path-traversal guard)', () => {
  withDataDir((dataDir) => {
    const r = spawnSync(process.execPath, [SCRIPT, '--lease-uuid', '../../config'], {
      encoding: 'utf8',
      env: { ...process.env, MANIFEST_PLUGIN_DATA: dataDir },
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /must be a UUID/);
  });
});

test('missing wrapper file: reports gracefully (no exception)', () => {
  withDataDir((dataDir) => {
    const r = runWithDataDir(dataDir, UUID);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /no saved manifest for/);
  });
});
