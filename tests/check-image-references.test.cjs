'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const { runScript } = require('./_subprocess.cjs');
const { buildCodex } = require('../ci/build-packages.cjs');
const ROOT = join(__dirname, '..');

test('checker reports malformed digests with exit 1 and does not rewrite the file', (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'image-ref-check-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const specPath = join(dir, 'spec.json');
  const raw = JSON.stringify({ image: 'nginx@sha256:abc', env: { PASSWORD: 'PRIVATE_VALUE' } });
  fs.writeFileSync(specPath, raw);
  const result = runScript('check-image-references.cjs', ['--spec-file', specPath]);
  assert.equal(result.status, 1);
  assert.deepEqual(result.json, { valid: false, images: [
    { service: null, image: 'nginx@sha256:abc', status: 'malformed-digest' },
  ] });
  assert.match(result.stderr, /malformed image digest/);
  assert.equal((result.stdout + result.stderr).includes('PRIVATE_VALUE'), false);
  assert.equal(fs.readFileSync(specPath, 'utf8'), raw);
});

test('checker rejects usage, read, parse, and shape errors without echoing input', (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'image-ref-errors-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const specPath = join(dir, 'spec.json');
  for (const args of [[], ['--spec-file'], ['--unknown', specPath], ['--spec-file', specPath, '--extra'],
    ['--spec-file', join(dir, 'missing')]]) {
    const result = runScript('check-image-references.cjs', args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /usage:|could not read spec file/);
  }
  for (const raw of ['{ PRIVATE_VALUE', '"PRIVATE_VALUE"', '{"env":{"PASSWORD":"PRIVATE_VALUE"}}']) {
    fs.writeFileSync(specPath, raw);
    const result = runScript('check-image-references.cjs', ['--spec-file', specPath]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim().split('\n').length, 1);
    assert.equal(result.stderr.includes('PRIVATE_VALUE'), false);
  }
});

test('both hosts execute the authoring and deploy workflow checks with full references and no shell interpolation', (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'image-ref-workflows-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const codexRoot = buildCodex({ out: join(dir, 'codex') });
  const specPath = join(dir, 'spec with spaces.json');
  const marker = join(dir, 'unexpected-shell-command');
  const image = `registry.example:5443/team/web:stable@sha256:${'abcdef01'.repeat(8)}`;
  for (const pluginRoot of [ROOT, codexRoot]) {
    for (const skill of ['author-manifest', 'deploy-app']) {
      const skillDir = join(pluginRoot, 'skills', skill);
      const source = fs.readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
      const commands = [...source.matchAll(/```bash\n([\s\S]*?)```/g)]
        .map((match) => match[1]).filter((block) => block.includes('scripts/check-image-references.cjs'));
      // Exercise the actual shipped collection/report/deployment commands.
      // This pins the executable gates, not the surrounding prompt wording.
      assert.equal(commands.length, skill === 'author-manifest' ? 2 : 1);
      for (const command of commands) {
        for (const malformed of [false, true]) {
          const spec = { services: {
            web: { image, env: { PASSWORD: 'PRIVATE_VALUE' } },
            worker: { image: malformed ? `busybox@$(touch '${marker}')` : 'busybox:latest' },
          } };
          const raw = JSON.stringify(spec);
          fs.writeFileSync(specPath, raw, { mode: 0o600 });
          const result = spawnSync('bash', ['-e', '-c', command], {
            cwd: skillDir, encoding: 'utf8', timeout: 5000,
            env: { ...process.env, MANIFEST_PLUGIN_ROOT: pluginRoot,
              MANIFEST_CODEX_DATA: join(dir, 'data'),
              IMAGE_SPEC_PATH: specPath, SAVED_PATH: specPath, SPEC_PATH: specPath },
          });
          assert.equal(result.status, malformed ? 1 : 0, result.stderr);
          const report = JSON.parse(result.stdout);
          assert.equal(report.valid, !malformed);
          assert.deepEqual(report.images.map((entry) => entry.image), [image, spec.services.worker.image]);
          assert.deepEqual(report.images.map((entry) => entry.status), ['digest', malformed ? 'malformed-digest' : 'tag']);
          assert.equal((result.stdout + result.stderr).includes('PRIVATE_VALUE'), false);
          assert.equal(fs.existsSync(marker), false);
          assert.equal(fs.readFileSync(specPath, 'utf8'), raw);
        }
      }
    }
  }
});
