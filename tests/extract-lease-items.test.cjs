'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runScript } = require('./_subprocess.cjs');

const UUID = '11111111-1111-4111-8111-111111111111';

test('found: false when lease UUID not in tenant payload', () => {
  const r = runScript(
    'extract-lease-items.cjs',
    ['--lease-uuid', UUID],
    JSON.stringify({ leases: [] }),
  );
  assert.equal(r.status, 0);
  assert.equal(r.json.found, false);
  assert.deepEqual(r.json.items, []);
});

test('found + single_item flag set for one-item lease with no serviceName', () => {
  const payload = {
    leases: [{ uuid: UUID, items: [{ customDomain: 'app.example.com' }] }],
  };
  const r = runScript('extract-lease-items.cjs', ['--lease-uuid', UUID], JSON.stringify(payload));
  assert.equal(r.json.found, true);
  assert.equal(r.json.single_item, true);
  assert.equal(r.json.items[0].serviceName, '');
  assert.equal(r.json.items[0].customDomain, 'app.example.com');
});

test('multi-service stack does NOT set single_item', () => {
  const payload = {
    leases: [{ uuid: UUID, items: [
      { serviceName: 'web', customDomain: 'web.example.com' },
      { serviceName: 'db', customDomain: '' },
    ] }],
  };
  const r = runScript('extract-lease-items.cjs', ['--lease-uuid', UUID], JSON.stringify(payload));
  assert.equal(r.json.found, true);
  assert.equal(r.json.single_item, false);
  assert.equal(r.json.items.length, 2);
});

test('rejects non-UUID lease-uuid arg', () => {
  const r = runScript('extract-lease-items.cjs', ['--lease-uuid', '../../etc/passwd'], '{}');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /must be a UUID/);
});

test('rejects missing lease-uuid arg', () => {
  const r = runScript('extract-lease-items.cjs', [], '{}');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Missing required flag: --lease-uuid/);
});

test('case-insensitive UUID match (chain returns lowercase, agent may pass mixed)', () => {
  const payload = { leases: [{ uuid: UUID, items: [{ serviceName: 'web' }] }] };
  const r = runScript(
    'extract-lease-items.cjs',
    ['--lease-uuid', UUID.toUpperCase()],
    JSON.stringify(payload),
  );
  assert.equal(r.json.found, true);
});

test('snake_case fields are normalized to camelCase', () => {
  const payload = {
    leases: [{ uuid: UUID, items: [{ service_name: 'web', custom_domain: 'app.example.com' }] }],
  };
  const r = runScript('extract-lease-items.cjs', ['--lease-uuid', UUID], JSON.stringify(payload));
  assert.equal(r.json.found, true);
  assert.equal(r.json.items[0].serviceName, 'web');
  assert.equal(r.json.items[0].customDomain, 'app.example.com');
});
