'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractRunningEndpoints,
  formatEndpointAsIngress,
  formatEndpointAsUrl,
  hasRunningInstances,
} = require('../scripts/_connection.cjs');

test('extractRunningEndpoints: top-level instances shape (single-service)', () => {
  const conn = {
    instances: [
      { status: 'running', fqdn: 'app.example.com' },
      { status: 'pending', fqdn: 'pending.example.com' },
    ],
  };
  assert.deepEqual(extractRunningEndpoints(conn), [{ fqdn: 'app.example.com' }]);
});

test('extractRunningEndpoints: per-service instances shape (stack)', () => {
  const conn = {
    services: {
      web: { instances: [{ status: 'running', fqdn: 'web.example.com' }] },
      db: { instances: [{ status: 'running', fqdn: 'db.example.com' }] },
    },
  };
  const out = extractRunningEndpoints(conn);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((e) => e.fqdn).sort(), ['db.example.com', 'web.example.com']);
});

test('extractRunningEndpoints: dedupes duplicate FQDNs across shapes', () => {
  const conn = {
    instances: [{ status: 'running', fqdn: 'app.example.com' }],
    services: {
      web: { instances: [{ status: 'running', fqdn: 'app.example.com' }] },
    },
  };
  assert.deepEqual(extractRunningEndpoints(conn), [{ fqdn: 'app.example.com' }]);
});

test('extractRunningEndpoints: skips non-running instances', () => {
  const conn = {
    instances: [
      { status: 'pending', fqdn: 'a.example.com' },
      { status: 'failed', fqdn: 'b.example.com' },
    ],
  };
  assert.deepEqual(extractRunningEndpoints(conn), []);
});

test('extractRunningEndpoints: skips running instances without fqdn (internal-only)', () => {
  const conn = { instances: [{ status: 'running' }] };
  assert.deepEqual(extractRunningEndpoints(conn), []);
});

test('extractRunningEndpoints: empty / null connection returns []', () => {
  assert.deepEqual(extractRunningEndpoints(null), []);
  assert.deepEqual(extractRunningEndpoints(undefined), []);
  assert.deepEqual(extractRunningEndpoints({}), []);
});

test('hasRunningInstances: true when any instance is running, even without fqdn', () => {
  // Internal-only deploys: lease is healthy but no public URL is exposed.
  // classify-deploy-response uses this to avoid misclassifying as needs_wait.
  const conn = { services: { worker: { instances: [{ status: 'running' }] } } };
  assert.equal(hasRunningInstances(conn), true);
  assert.equal(extractRunningEndpoints(conn).length, 0); // no FQDN to surface
});

test('hasRunningInstances: false when all instances pending', () => {
  const conn = { instances: [{ status: 'pending', fqdn: 'a' }] };
  assert.equal(hasRunningInstances(conn), false);
});

test('hasRunningInstances: false on null / empty', () => {
  assert.equal(hasRunningInstances(null), false);
  assert.equal(hasRunningInstances({}), false);
});

test('formatEndpointAsIngress / formatEndpointAsUrl', () => {
  const ep = { fqdn: 'app.example.com' };
  assert.equal(formatEndpointAsIngress(ep), 'app.example.com');
  assert.equal(formatEndpointAsUrl(ep), 'https://app.example.com/');
  assert.equal(formatEndpointAsIngress({}), null);
  assert.equal(formatEndpointAsUrl(null), null);
});
