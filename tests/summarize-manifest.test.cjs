'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = join(__dirname, '..', 'scripts', 'summarize-manifest.cjs');
const LIST_SCRIPT = join(__dirname, '..', 'scripts', 'list-saved-manifests.cjs');

function runWithDataDir(dataDir, leaseUuid) {
  return spawnSync(process.execPath, [SCRIPT, '--lease-uuid', leaseUuid], {
    encoding: 'utf8',
    env: { ...process.env, MANIFEST_PLUGIN_DATA: dataDir },
  });
}

function listWithDataDir(dataDir) {
  return spawnSync(process.execPath, [LIST_SCRIPT], {
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
const SKU_UUID = '22222222-2222-4222-8222-222222222222';
const PROVIDER_UUID = '33333333-3333-4333-8333-333333333333';

test('saved compute UUIDs distinguish identically named SKUs, including within one provider', () => {
  withDataDir((dataDir) => {
    const identities = [
      { lease_uuid: UUID, sku_uuid: SKU_UUID, provider_uuid: PROVIDER_UUID },
      {
        lease_uuid: '44444444-4444-4444-8444-444444444444',
        sku_uuid: '55555555-5555-4555-8555-555555555555',
        provider_uuid: PROVIDER_UUID,
      },
      {
        lease_uuid: '66666666-6666-4666-8666-666666666666',
        sku_uuid: '77777777-7777-4777-8777-777777777777',
        provider_uuid: '88888888-8888-4888-8888-888888888888',
      },
    ];
    for (const identity of identities) {
      // Reader compatibility fixture only: the pinned upstream writer
      // still emits v3 without these optional identifiers.
      writeFileSync(join(dataDir, 'manifests', `${identity.lease_uuid}.json`), JSON.stringify({
        schema_version: 4,
        ...identity,
        size: 'small',
      }));
      const summary = runWithDataDir(dataDir, identity.lease_uuid);
      assert.equal(summary.status, 0, summary.stderr);
      assert.match(summary.stdout, /Size:\s+small/);
      assert.match(summary.stdout, new RegExp(`SKU UUID:\\s+${identity.sku_uuid}`));
      assert.match(summary.stdout, new RegExp(`Provider UUID:\\s+${identity.provider_uuid}`));
    }

    const listing = listWithDataDir(dataDir);
    assert.equal(listing.status, 0, listing.stderr);
    assert.deepEqual(JSON.parse(listing.stdout), identities.map((identity) => ({
      ...identity, size: 'small', schema_version: 4,
    })));
  });
});

test('unknown newer wrappers expose known UUIDs while keeping env values and unknown fields private', () => {
  withDataDir((dataDir) => {
    const secret = 'do-not-leak-new-wrapper-env-value';
    writeFileSync(join(dataDir, 'manifests', `${UUID}.json`), JSON.stringify({
      schema_version: 999,
      lease_uuid: UUID,
      size: 'small',
      sku_uuid: SKU_UUID,
      provider_uuid: PROVIDER_UUID,
      future_metadata: { credential: secret },
      manifest_json: JSON.stringify({
        services: { web: { env: { DATABASE_URL: secret }, ports: { '80': {} } } },
      }),
    }));
    const summary = runWithDataDir(dataDir, UUID);
    assert.equal(summary.status, 0, summary.stderr);
    assert.match(summary.stdout, /Schema version:\s+999/);
    assert.match(summary.stdout, new RegExp(`SKU UUID:\\s+${SKU_UUID}`));
    assert.match(summary.stdout, new RegExp(`Provider UUID:\\s+${PROVIDER_UUID}`));
    assert.match(summary.stdout, /Env keys:\s+DATABASE_URL/);
    assert.ok(!summary.stdout.includes(secret));

    const listing = listWithDataDir(dataDir);
    assert.equal(listing.status, 0, listing.stderr);
    assert.deepEqual(JSON.parse(listing.stdout), [{
      lease_uuid: UUID, size: 'small', sku_uuid: SKU_UUID,
      provider_uuid: PROVIDER_UUID, schema_version: 999,
    }]);
    assert.ok(!listing.stdout.includes(secret));
  });
});

for (const version of [2, 3]) {
  test(`v${version} wrappers without compute UUIDs retain their summary and listing output`, () => {
    withDataDir((dataDir) => {
      const wrapper = {
        schema_version: version,
        lease_uuid: UUID,
        image: 'ghcr.io/me/app:v1',
        size: 'small',
        deployed_at_iso: '2026-05-06T12:00:00Z',
        chain_id: 'manifest-ledger-mainnet',
        meta_hash_hex: 'deadbeef',
        format: 'stack',
        ...(version === 3 ? { custom_domain: 'app.example.com', custom_domain_service_name: 'web' } : {}),
      };
      writeFileSync(join(dataDir, 'manifests', `${UUID}.json`), JSON.stringify(wrapper));
      const summary = runWithDataDir(dataDir, UUID);
      assert.equal(summary.status, 0, summary.stderr);
      assert.equal(summary.stdout, [
        `Lease UUID:       ${UUID}`,
        'Image:            ghcr.io/me/app:v1',
        'Size:             small',
        'Deployed at:      2026-05-06T12:00:00Z',
        'Chain:            manifest-ledger-mainnet',
        'meta_hash_hex:    deadbeef',
        'Format:           stack',
        `Schema version:   ${version}`,
        ...(version === 3 ? ['Custom domain:    app.example.com', 'Domain service:   web'] : []),
        '',
      ].join('\n'));

      const listing = listWithDataDir(dataDir);
      assert.equal(listing.status, 0, listing.stderr);
      assert.deepEqual(JSON.parse(listing.stdout), [wrapper]);
    });
  });
}

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
