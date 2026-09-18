'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const { renderSkill } = require('../ci/build-packages.cjs');

const ROOT = join(__dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'merge-env.cjs');

function withDataDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-merge-env-test-'));
  mkdirSync(join(dir, 'manifests-drafts'), { recursive: true });
  try { return fn(dir); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

function runMerge(specFile, dotenv, dataDir, extraArgs = []) {
  return spawnSync(process.execPath, [SCRIPT, '--spec-file', specFile, ...extraArgs], {
    encoding: 'utf8',
    input: dotenv,
    env: { ...process.env, MANIFEST_PLUGIN_DATA: dataDir },
  });
}

for (const host of ['claude', 'codex']) {
  function envCommands() {
    const source = readFileSync(join(ROOT, 'workflows/author-manifest.md'), 'utf8');
    const rendered = renderSkill(source, host, { name: 'author-manifest' });
    return [...rendered.matchAll(/^([ \t]*)```bash\n([\s\S]*?)^\1```[ \t]*$/gm)].map(match => match[2].trimEnd());
  }

  test(`${host} generated env recipe creates a private input and merges its sample without EOF-marker errors`, () => {
    withDataDir(dataDir => {
      const commands = envCommands();
      const recipe = commands.find(command => command.includes('ENV_INPUT_PATH=$(mktemp)'));
      const payload = recipe.match(/^cat > "\$ENV_INPUT_PATH"\n([\s\S]*?)(?=^printf )/m)?.[1];
      assert.ok(payload, 'locate the text the user types into cat');
      // Supply interactive input through stdin, then let cat observe EOF.
      // Keep the recipe's EOF instruction in that input to catch a literal ^D.
      const capture = spawnSync('bash', ['--noprofile', '--norc', '-c', recipe.replace(payload, '')], {
        input: payload, encoding: 'utf8', env: { PATH: process.env.PATH, TMPDIR: dataDir },
      });
      assert.ifError(capture.error);
      assert.equal(capture.status, 0, capture.stderr);
      const inputPath = capture.stdout.trim();
      assert.equal(statSync(inputPath).mode & 0o777, 0o600);
      assert.equal(readFileSync(inputPath, 'utf8'), payload);
      const specPath = join(dataDir, 'manifests-drafts', 'app.json');
      writeFileSync(specPath, JSON.stringify({ services: { app: { image: 'fixture' } } }));
      const mergeCommand = commands.find(command => command.includes('scripts/merge-env.cjs'));
      assert.ok(mergeCommand, 'execute the generated stdin merge command');
      const merge = spawnSync('bash', ['--noprofile', '--norc', '-c', mergeCommand], {
        encoding: 'utf8', env: { PATH: process.env.PATH, MANIFEST_PLUGIN_ROOT: ROOT,
          MANIFEST_PLUGIN_DATA: dataDir, SAVED_PATH: specPath, SERVICE_NAME: 'app', ENV_FILE_PATH: inputPath },
      });
      assert.ifError(merge.error);
      assert.equal(merge.status, 0, merge.stderr);
      assert.deepEqual(JSON.parse(readFileSync(specPath)).services.app.env, { KEY1: 'value1', KEY2: 'value2' });
      assert.equal(statSync(specPath).mode & 0o777, 0o600);
      assert.doesNotMatch(capture.stdout + capture.stderr + merge.stdout + merge.stderr, /value1|value2/);
    });
  });

  test(`${host} generated env cleanup removes recipe temporaries and preserves supplied input files`, () => {
    withDataDir(dataDir => {
      const rendered = renderSkill(readFileSync(join(ROOT, 'workflows/author-manifest.md'), 'utf8'), host, { name: 'author-manifest' });
      assert.match(rendered, /delete only[^.]*recipe/i);
      assert.match(rendered, /preserve[^.]*pre-existing[^.]*unknown/i);
      const cleanup = envCommands().find(command => command.startsWith('rm -- '));
      assert.ok(cleanup, 'provide an explicit command for each recipe-created env-file path');
      const inputs = ["first service's $(touch unexpected).env", 'second service.env'].map(name => join(dataDir, name));
      for (const path of inputs) writeFileSync(path, 'fixture-only', { mode: 0o600 });
      const supplied = ['project.env', 'unknown-origin.env'].map(name => join(dataDir, name));
      const specPath = join(dataDir, 'manifests-drafts', 'app.json');
      writeFileSync(specPath, JSON.stringify({ services: { app: { image: 'fixture' } } }));
      for (const path of supplied) {
        writeFileSync(path, 'VALUE=fixture-only\n', { mode: 0o600 });
        const merge = spawnSync('bash', ['--noprofile', '--norc', '-c', envCommands().find(command => command.includes('scripts/merge-env.cjs'))], {
          encoding: 'utf8', env: { PATH: process.env.PATH, MANIFEST_PLUGIN_ROOT: ROOT,
            MANIFEST_PLUGIN_DATA: dataDir, SAVED_PATH: specPath, SERVICE_NAME: 'app', ENV_FILE_PATH: path },
        });
        assert.ifError(merge.error);
        assert.equal(merge.status, 0, merge.stderr);
        assert.doesNotMatch(merge.stdout + merge.stderr, /fixture-only/);
      }
      const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
      // The workflow driver supplies the known recipe-created paths only.
      const command = inputs.map(path => cleanup.replace("'TEMP_ENV_INPUT_FILE'", () => quote(path))).join('\n');
      const result = spawnSync('bash', ['--noprofile', '--norc', '-c', command], {
        cwd: dataDir, encoding: 'utf8', env: { PATH: process.env.PATH, ENV_INPUT_PATH: inputs.at(-1) },
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      for (const path of inputs) assert.equal(existsSync(path), false, path);
      for (const path of supplied) assert.equal(readFileSync(path, 'utf8'), 'VALUE=fixture-only\n');
      assert.equal(JSON.parse(readFileSync(specPath)).services.app.env.VALUE, 'fixture-only');
      assert.equal(existsSync(join(dataDir, 'unexpected')), false);
      assert.equal(result.stdout + result.stderr, '');
    });
  });
}

test('merge: dotenv → spec.env (legacy flat shape)', () => {
  withDataDir((dataDir) => {
    const specPath = join(dataDir, 'manifests-drafts', 'app.json');
    writeFileSync(specPath, JSON.stringify({ image: 'a', port: 80 }));
    const r = runMerge(specPath, 'FOO=bar\nBAZ=qux\n', dataDir);
    assert.equal(r.status, 0);
    const merged = JSON.parse(readFileSync(specPath, 'utf8'));
    assert.deepEqual(merged.env, { FOO: 'bar', BAZ: 'qux' });
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.keys_merged.sort(), ['BAZ', 'FOO']);
    // Critical: the script's stdout must contain only KEYS, never VALUES.
    assert.ok(!r.stdout.includes('bar'));
    assert.ok(!r.stdout.includes('qux'));
  });
});

test('merge: dotenv → spec.services.<name>.env (stack)', () => {
  withDataDir((dataDir) => {
    const specPath = join(dataDir, 'manifests-drafts', 'stack.json');
    writeFileSync(specPath, JSON.stringify({ services: { web: { image: 'a' } } }));
    const r = runMerge(specPath, 'DB=secret\n', dataDir, ['--service-name', 'web']);
    assert.equal(r.status, 0);
    const merged = JSON.parse(readFileSync(specPath, 'utf8'));
    assert.equal(merged.services.web.env.DB, 'secret');
  });
});

test('merge: quoted values are unwrapped', () => {
  withDataDir((dataDir) => {
    const specPath = join(dataDir, 'manifests-drafts', 'app.json');
    writeFileSync(specPath, JSON.stringify({ image: 'a' }));
    const r = runMerge(specPath, 'A="hello world"\nB=\'has spaces\'\n', dataDir);
    assert.equal(r.status, 0);
    const merged = JSON.parse(readFileSync(specPath, 'utf8'));
    assert.equal(merged.env.A, 'hello world');
    assert.equal(merged.env.B, 'has spaces');
  });
});

test('merge: comments and blank lines are ignored', () => {
  withDataDir((dataDir) => {
    const specPath = join(dataDir, 'manifests-drafts', 'app.json');
    writeFileSync(specPath, JSON.stringify({ image: 'a' }));
    const r = runMerge(specPath, '# comment\n\nFOO=bar\n  # indented comment is also ignored\n', dataDir);
    assert.equal(r.status, 0);
    const merged = JSON.parse(readFileSync(specPath, 'utf8'));
    assert.deepEqual(merged.env, { FOO: 'bar' });
  });
});

test('reject: invalid env key with line number', () => {
  withDataDir((dataDir) => {
    const specPath = join(dataDir, 'manifests-drafts', 'app.json');
    writeFileSync(specPath, JSON.stringify({ image: 'a' }));
    const r = runMerge(specPath, 'A=ok\n2BAD_KEY=nope\n', dataDir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /line 2.*invalid env key/);
  });
});

test('reject: missing = is reported with line number', () => {
  withDataDir((dataDir) => {
    const specPath = join(dataDir, 'manifests-drafts', 'app.json');
    writeFileSync(specPath, JSON.stringify({ image: 'a' }));
    const r = runMerge(specPath, 'NO_EQUALS_HERE\n', dataDir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /line 1.*missing '='/);
  });
});

test('reject: spec file outside allowlist (refuses to downgrade mode)', () => {
  withDataDir((dataDir) => {
    // Use a path that is clearly NOT in tmpdir() and NOT in the data dir's
    // drafts subdir. The data dir itself sits under tmpdir() (mkdtempSync),
    // so any path inside `dataDir` would falsely pass the allowlist check.
    // /etc/no-such-spec.json is a guaranteed-outside path; the script must
    // refuse before attempting to read the (nonexistent) file.
    const outsidePath = '/etc/no-such-spec.json';
    const r = runMerge(outsidePath, 'FOO=bar\n', dataDir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /must live under.*manifests-drafts.*system tmpdir/);
  });
});

test('reject: relative spec file path', () => {
  withDataDir((dataDir) => {
    const r = runMerge('./relative.json', 'FOO=bar\n', dataDir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /must be absolute/);
  });
});

test('written file is mode 0o600 (secrets-handling discipline)', () => {
  withDataDir((dataDir) => {
    const specPath = join(dataDir, 'manifests-drafts', 'app.json');
    writeFileSync(specPath, JSON.stringify({ image: 'a' }));
    const r = runMerge(specPath, 'FOO=bar\n', dataDir);
    assert.equal(r.status, 0);
    const mode = statSync(specPath).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});
