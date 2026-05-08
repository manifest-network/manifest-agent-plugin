'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runScript } = require('./_subprocess.cjs');

const UUID = '11111111-1111-4111-8111-111111111111';

test('empty releases array renders the no-releases marker', () => {
  const r = runScript(
    'render-releases.cjs',
    [],
    JSON.stringify({ lease_uuid: UUID, releases: [] }),
  );
  assert.equal(r.status, 0);
  assert.match(r.stdout, /### Releases for 11111111-1111-4111-8111-111111111111/);
  assert.match(r.stdout, /\(no releases yet\)/);
  assert.doesNotMatch(r.stdout, /\| Version \|/);
});

test('single release renders a one-row table', () => {
  const payload = {
    lease_uuid: UUID,
    releases: [
      { version: 1, image: 'ghcr.io/foo:v1', status: 'active', created_at: '2026-04-01T10:00:00Z' },
    ],
  };
  const r = runScript('render-releases.cjs', [], JSON.stringify(payload));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\| Version \| Image \| Status \| Created \|/);
  assert.match(r.stdout, /\| 1 \| ghcr\.io\/foo:v1 \| active \| 2026-04-01T10:00:00Z \|/);
});

test('multi releases sort by version descending', () => {
  const payload = {
    lease_uuid: UUID,
    releases: [
      { version: 1, image: 'img:v1', status: 'superseded', created_at: '2026-04-01T00:00:00Z' },
      { version: 3, image: 'img:v3', status: 'active', created_at: '2026-04-12T00:00:00Z' },
      { version: 2, image: 'img:v2', status: 'superseded', created_at: '2026-04-10T00:00:00Z' },
    ],
  };
  const r = runScript('render-releases.cjs', [], JSON.stringify(payload));
  assert.equal(r.status, 0);
  const v3idx = r.stdout.indexOf('| 3 |');
  const v2idx = r.stdout.indexOf('| 2 |');
  const v1idx = r.stdout.indexOf('| 1 |');
  assert.ok(v3idx > 0 && v3idx < v2idx && v2idx < v1idx, 'rows must descend by version');
});

test('missing optional fields render as (unknown) without dropping the row', () => {
  const payload = {
    lease_uuid: UUID,
    releases: [{ version: 1 }],
  };
  const r = runScript('render-releases.cjs', [], JSON.stringify(payload));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\| 1 \| \(unknown\) \| \(unknown\) \| \(unknown\) \|/);
});

test('unparseable stdin exits 1', () => {
  const r = runScript('render-releases.cjs', [], 'not json');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not valid JSON/);
});

test('non-object stdin exits 1', () => {
  const r = runScript('render-releases.cjs', [], '"a string"');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /expected a JSON object/);
});

test('array stdin exits 1 (not a JSON object)', () => {
  const r = runScript('render-releases.cjs', [], '[]');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /expected a JSON object/);
});
