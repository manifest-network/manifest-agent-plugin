'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runScript } = require('./_subprocess.cjs');

const UUID = '11111111-1111-4111-8111-111111111111';

function verify(args, payload) {
  return runScript('verify-domain-state.cjs', args, JSON.stringify(payload));
}

test('match: actual customDomain equals expected (set-mode)', () => {
  const payload = { leases: [{ uuid: UUID, items: [{ serviceName: 'web', customDomain: 'app.example.com' }] }] };
  const r = verify(['--lease-uuid', UUID, '--service-name', 'web', '--expected', 'app.example.com'], payload);
  assert.equal(r.status, 0);
  assert.equal(r.json.outcome, 'match');
  assert.equal(r.json.actual, 'app.example.com');
});

test('mismatch: actual differs from expected (set-mode)', () => {
  const payload = { leases: [{ uuid: UUID, items: [{ serviceName: 'web', customDomain: 'old.example.com' }] }] };
  const r = verify(['--lease-uuid', UUID, '--service-name', 'web', '--expected', 'new.example.com'], payload);
  assert.equal(r.json.outcome, 'mismatch');
  assert.equal(r.json.actual, 'old.example.com');
});

test('clear-mode: --expected "" matches when customDomain is empty', () => {
  const payload = { leases: [{ uuid: UUID, items: [{ serviceName: 'web', customDomain: '' }] }] };
  const r = verify(['--lease-uuid', UUID, '--service-name', 'web', '--expected', ''], payload);
  assert.equal(r.json.outcome, 'match');
  assert.equal(r.json.actual, '');
});

test('clear-mode: --expected "" mismatches when customDomain is still set', () => {
  const payload = { leases: [{ uuid: UUID, items: [{ serviceName: 'web', customDomain: 'leftover.example.com' }] }] };
  const r = verify(['--lease-uuid', UUID, '--service-name', 'web', '--expected', ''], payload);
  assert.equal(r.json.outcome, 'mismatch');
  assert.equal(r.json.actual, 'leftover.example.com');
});

test('not_found: lease UUID not in tenant payload', () => {
  const r = verify(['--lease-uuid', UUID, '--expected', 'app.example.com'], { leases: [] });
  assert.equal(r.json.outcome, 'not_found');
  assert.match(r.json.reason, /lease UUID not in tenant leases/);
});

test('not_found: multi-item lease but --service-name omitted', () => {
  const payload = {
    leases: [{ uuid: UUID, items: [
      { serviceName: 'web', customDomain: '' },
      { serviceName: 'db', customDomain: '' },
    ] }],
  };
  const r = verify(['--lease-uuid', UUID, '--expected', ''], payload);
  assert.equal(r.json.outcome, 'not_found');
  assert.match(r.json.reason, /multiple items but --service-name was not supplied/);
});

test('single-item lease with no serviceName: --service-name not required', () => {
  const payload = { leases: [{ uuid: UUID, items: [{ customDomain: 'app.example.com' }] }] };
  const r = verify(['--lease-uuid', UUID, '--expected', 'app.example.com'], payload);
  assert.equal(r.json.outcome, 'match');
});

test('rejects missing --expected (no default — explicit empty string required for clear)', () => {
  const r = runScript('verify-domain-state.cjs', ['--lease-uuid', UUID], '{}');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Missing required flag: --expected/);
});

test('rejects non-UUID --lease-uuid', () => {
  const r = runScript('verify-domain-state.cjs', ['--lease-uuid', '../etc/passwd', '--expected', ''], '{}');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /must be a UUID/);
});
