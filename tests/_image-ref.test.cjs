'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { digestStatus, checkImageReferences } = require('../scripts/_image-ref.cjs');
const DIGEST = `sha256:${'0123456789abcdef'.repeat(4)}`;

test('classifies supplied SHA-256 digests without rewriting references', () => {
  for (const image of [`nginx@${DIGEST}`, `docker.io/library/nginx@${DIGEST}`,
    `registry.example:5443/team/web:stable@${DIGEST}`]) {
    assert.equal(digestStatus(image), 'digest');
    assert.deepEqual(checkImageReferences({ image }), {
      valid: true, images: [{ service: null, image, status: 'digest' }],
    });
  }
});

test('classifies explicit and implicit mutable tags without resolving them', () => {
  for (const image of ['nginx', 'postgres:16', 'registry.example:5443/team/web', 'busybox:latest']) {
    assert.equal(digestStatus(image), 'tag');
  }
});

test('digest-shaped but malformed inputs never become pins or mutable tags', () => {
  for (const image of ['nginx@', 'nginx@sha256:abc', `nginx@sha256:${'a'.repeat(63)}`,
    `nginx@sha256:${'a'.repeat(65)}`, `nginx@sha256:${'A'.repeat(64)}`,
    `nginx@sha256:${'g'.repeat(64)}`, `nginx@sha512:${'a'.repeat(128)}`,
    `nginx@SHA256:${'a'.repeat(64)}`, `@${DIGEST}`, `nginx@@${DIGEST}`,
    `nginx@old@${DIGEST}`, `nginx@${DIGEST}\n`, `nginx@${DIGEST} `,
    ` nginx@${DIGEST}`, `nginx\u0000@${DIGEST}`]) {
    assert.equal(digestStatus(image), 'malformed-digest', JSON.stringify(image));
    assert.equal(checkImageReferences({ image }).valid, false);
  }
});

test('reports every service with full references, without env values or spec mutation', () => {
  const spec = { size: 'small', services: {
    web: { image: `registry.example:5443/team/web:stable@${DIGEST}`, env: { PASSWORD: 'PRIVATE_ENV_VALUE' } },
    worker: { image: 'busybox:latest' },
    broken: { image: 'nginx@sha256:abc' },
  } };
  const before = structuredClone(spec);
  const result = checkImageReferences(spec);
  assert.deepEqual(result, { valid: false, images: [
    { service: 'web', image: spec.services.web.image, status: 'digest' },
    { service: 'worker', image: 'busybox:latest', status: 'tag' },
    { service: 'broken', image: 'nginx@sha256:abc', status: 'malformed-digest' },
  ] });
  assert.equal(JSON.stringify(result).includes('PRIVATE_ENV_VALUE'), false);
  assert.deepEqual(spec, before);
});

test('rejects absent or ambiguous shapes and missing image strings', () => {
  for (const spec of [null, [], 'private', {}, { image: 'nginx', services: {} },
    { services: null }, { services: [] }, { services: {} }, { services: { app: null } },
    { services: { app: { image: 123 } } }, { image: '' }]) {
    assert.throws(() => checkImageReferences(spec));
  }
  for (const image of [null, {}, [], 42, '', ' ', 'nginx\n:latest', 'nginx\u001b:latest']) {
    assert.throws(() => digestStatus(image));
  }
});
