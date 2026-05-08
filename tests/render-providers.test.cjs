'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runScript } = require('./_subprocess.cjs');

test('empty providers array renders the no-providers marker', () => {
  const r = runScript('render-providers.cjs', [], JSON.stringify({ providers: [] }));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /### Providers \(0\)/);
  assert.match(r.stdout, /\(no providers registered\)/);
  assert.doesNotMatch(r.stdout, /\| UUID \|/);
});

test('single provider renders a one-row table with active=yes', () => {
  const payload = {
    providers: [{
      uuid: '01931e60-a3b3-7000-9999-000000000001',
      address: 'manifest1providerxxx',
      payoutAddress: 'manifest1payoutxxx',
      metaHash: 'unused',
      active: true,
      apiUrl: 'https://provider.example.com',
    }],
  };
  const r = runScript('render-providers.cjs', [], JSON.stringify(payload));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /### Providers \(1\)/);
  assert.match(r.stdout, /\| UUID \| Address \| API URL \| Active \|/);
  assert.match(r.stdout, /\| 01931e60-a3b3-7000-9999-000000000001 \| manifest1providerxxx \| https:\/\/provider\.example\.com \| yes \|/);
  assert.doesNotMatch(r.stdout, /payoutAddress|metaHash/);
});

test('multi providers render in chain order', () => {
  const payload = {
    providers: [
      { uuid: 'aaa', address: 'addr-a', apiUrl: 'https://a', active: true },
      { uuid: 'bbb', address: 'addr-b', apiUrl: 'https://b', active: true },
      { uuid: 'ccc', address: 'addr-c', apiUrl: 'https://c', active: true },
    ],
  };
  const r = runScript('render-providers.cjs', [], JSON.stringify(payload));
  assert.equal(r.status, 0);
  const aIdx = r.stdout.indexOf('| aaa |');
  const bIdx = r.stdout.indexOf('| bbb |');
  const cIdx = r.stdout.indexOf('| ccc |');
  assert.ok(aIdx > 0 && aIdx < bIdx && bIdx < cIdx, 'rows must preserve chain order');
});

test('mixed active/inactive renders yes and no', () => {
  const payload = {
    providers: [
      { uuid: 'a', address: 'addr-a', apiUrl: 'https://a', active: true },
      { uuid: 'b', address: 'addr-b', apiUrl: 'https://b', active: false },
    ],
  };
  const r = runScript('render-providers.cjs', [], JSON.stringify(payload));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\| a \| addr-a \| https:\/\/a \| yes \|/);
  assert.match(r.stdout, /\| b \| addr-b \| https:\/\/b \| no \|/);
});

test('missing optional fields render as (unknown) without dropping the row', () => {
  const payload = { providers: [{ uuid: 'a' }] };
  const r = runScript('render-providers.cjs', [], JSON.stringify(payload));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\| a \| \(unknown\) \| \(unknown\) \| \(unknown\) \|/);
});

test('rejects unparseable stdin', () => {
  const r = runScript('render-providers.cjs', [], 'not json');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not valid JSON/);
});
