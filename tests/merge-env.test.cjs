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
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

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

function captureEnvRecipe(text, dataDir) {
  const blocks = [...text.matchAll(/^([ \t]*)```bash\n([\s\S]*?)^\1```[ \t]*$/gm)];
  const recipe = blocks.filter(match => match[2].includes('ENV_INPUT_PATH'));
  assert.equal(recipe.length, 2, 'capture and path display are separate blocks');
  assert.equal(recipe[0][2].trimEnd().split('\n').at(-1), 'cat > "$ENV_INPUT_PATH"');
  const between = text.slice(recipe[0].index + recipe[0][0].length, recipe[1].index);
  assert.match(between, /KEY=VALUE/);
  assert.match(between, /no prompt/);
  assert.match(between, /\b[Pp]ress\s+Enter\b[^.!?]*Ctrl\+D\b[\s\S]*prompt\s+returns/);
  const payload = 'KEY1=value1\nKEY2=value2\n';
  // The user sends values to the waiting cat, then runs the path-display block.
  // Neither values nor instructions may be part of the shell command blocks.
  const capture = spawnSync('bash', ['--noprofile', '--norc', '-c', recipe.map(match => match[2]).join('\n')], {
    input: payload, encoding: 'utf8', env: { PATH: process.env.PATH, TMPDIR: dataDir },
  });
  assert.ifError(capture.error);
  assert.equal(capture.status, 0, capture.stderr);
  const inputPath = capture.stdout.trim();
  assert.equal(statSync(inputPath).mode & 0o777, 0o600);
  assert.equal(readFileSync(inputPath, 'utf8'), payload);
  assert.doesNotMatch(capture.stdout + capture.stderr, /value1|value2/);
  return inputPath;
}

test('README env recipe separates shell commands from private stdin entry', () => {
  withDataDir(dataDir => captureEnvRecipe(readFileSync(join(ROOT, 'README.md'), 'utf8'), dataDir));
});

for (const host of ['claude', 'codex']) {
  function envInstructions() {
    const source = readFileSync(join(ROOT, 'workflows/author-manifest.md'), 'utf8');
    return renderSkill(source, host, { name: 'author-manifest' });
  }

  function envCommands() {
    return [...envInstructions().matchAll(/^([ \t]*)```bash\n([\s\S]*?)^\1```[ \t]*$/gm)].map(match => match[2].trimEnd());
  }

  test(`${host} generated env recipe separates shell commands from private stdin entry and merges the values`, () => {
    withDataDir(dataDir => {
      const commands = envCommands();
      const inputPath = captureEnvRecipe(envInstructions(), dataDir);
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
      assert.deepEqual(JSON.parse(merge.stdout).keys_merged, ['KEY1', 'KEY2']);
      assert.doesNotMatch(merge.stdout + merge.stderr, /value1|value2/);
    });
  });

  test(`${host} empty env input offers recorded-path retry or skip and preserves existing values`, () => {
    withDataDir(dataDir => {
      const rendered = envInstructions();
      const recovery = rendered.match(/If `keys_merged` is empty[\s\S]*?(?=\nIf the script errors out)/)?.[0];
      assert.ok(recovery, 'handle the empty keys_merged response');
      assert.match(recovery, /\bstop\b/);
      assert.match(recovery, /Keep the input\s+file and draft/);
      assert.ok(recovery.includes(host === 'claude' ? '`AskUserQuestion`' : '`request_user_input`'));
      for (const choice of ['Re-enter file values', 'Continue without file values', 'Cancel']) {
        assert.ok(recovery.includes(`**${choice}**`), choice);
      }
      assert.match(recovery, /cat > 'ENV_RETRY_FILE'/);
      assert.match(recovery, /recorded `env-file-path`[\s\S]*shell-escaped literal/);
      assert.match(recovery, /retry[\s\S]*before continuing/);
      assert.match(recovery, /Keep the existing input record[\s\S]*`recipe-created` flag/);
      assert.match(recovery, /no prompt[\s\S]*press Enter[^.!?]*Ctrl\+D[\s\S]*prompt\s+returns/);
      assert.match(recovery, /remove only that service's input record[\s\S]*preserving any env values/);
      assert.match(recovery, /Keep the input file[\s\S]*retained-file recap/);
      assert.match(recovery, /exclude that path from cleanup even if another service uses it/);
      const specPath = join(dataDir, 'manifests-drafts', 'app.json');
      const inputPath = join(dataDir, 'empty.env');
      for (const initialEnv of [undefined, { EXISTING: 'fixture-only' }]) for (const input of ['', '# comment only\n\n']) {
        const service = { image: 'fixture', ...(initialEnv && { env: initialEnv }) };
        writeFileSync(specPath, JSON.stringify({ services: { app: service } }));
        writeFileSync(inputPath, input, { mode: 0o600 });
        const result = spawnSync('bash', ['--noprofile', '--norc', '-c', envCommands().find(command => command.includes('scripts/merge-env.cjs'))], {
          encoding: 'utf8', env: { PATH: process.env.PATH, MANIFEST_PLUGIN_ROOT: ROOT,
            MANIFEST_PLUGIN_DATA: dataDir, SAVED_PATH: specPath, SERVICE_NAME: 'app', ENV_FILE_PATH: inputPath },
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), { service: 'app', keys_merged: [] });
        // Even an empty merge rewrites the draft and creates env: {} if absent.
        assert.deepEqual(JSON.parse(readFileSync(specPath)), {
          services: { app: { ...service, env: initialEnv || {} } },
        });
        assert.equal(statSync(specPath).mode & 0o777, 0o600);
        assert.equal(readFileSync(inputPath, 'utf8'), input);
        assert.doesNotMatch(result.stdout + result.stderr, /fixture-only/);
      }
    });
  });

  test(`${host} env retry refills the recorded service input without overwriting the last collected file`, () => {
    withDataDir(dataDir => {
      const commands = envCommands();
      const retry = commands.find(command => command.includes("'ENV_RETRY_FILE'"));
      assert.ok(retry, 'provide a re-entry command with a recorded-path placeholder');
      const merge = commands.find(command => command.includes('scripts/merge-env.cjs'));
      const first = join(dataDir, "first service's $(touch unexpected).env");
      const last = join(dataDir, 'last service.env');
      const firstInput = 'FIRST=first-fixture-value\n';
      const lastInput = 'LAST=last-fixture-value\n';
      writeFileSync(first, '', { mode: 0o600 });
      writeFileSync(last, lastInput, { mode: 0o600 });
      const specPath = join(dataDir, 'manifests-drafts', 'stack.json');
      writeFileSync(specPath, JSON.stringify({ services: {
        first: { image: 'first', env: { EXISTING: 'keep-fixture' } }, last: { image: 'last' },
      } }));
      const env = { PATH: process.env.PATH, MANIFEST_PLUGIN_ROOT: ROOT,
        MANIFEST_PLUGIN_DATA: dataDir, SAVED_PATH: specPath, ENV_INPUT_PATH: last };
      const mergeService = (name, path) => {
        const result = spawnSync('bash', ['--noprofile', '--norc', '-c', merge], {
          encoding: 'utf8', env: { ...env, SERVICE_NAME: name, ENV_FILE_PATH: path },
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        assert.doesNotMatch(result.stdout + result.stderr, /first-fixture-value|last-fixture-value|keep-fixture/);
        return JSON.parse(result.stdout);
      };
      assert.deepEqual(mergeService('first', first).keys_merged, []);
      const refill = spawnSync('bash', ['--noprofile', '--norc', '-c',
        retry.replace("'ENV_RETRY_FILE'", () => quote(first))], {
        cwd: dataDir, input: firstInput, encoding: 'utf8', env,
      });
      assert.ifError(refill.error);
      assert.equal(refill.status, 0, refill.stderr);
      assert.equal(refill.stdout + refill.stderr, '');
      assert.equal(readFileSync(first, 'utf8'), firstInput);
      assert.equal(readFileSync(last, 'utf8'), lastInput);
      assert.equal(statSync(first).mode & 0o777, 0o600);
      assert.equal(existsSync(join(dataDir, 'unexpected')), false);
      assert.deepEqual(mergeService('first', first).keys_merged, ['FIRST']);
      assert.deepEqual(mergeService('last', last).keys_merged, ['LAST']);
      const saved = JSON.parse(readFileSync(specPath));
      assert.deepEqual(saved.services.first.env, { EXISTING: 'keep-fixture', FIRST: 'first-fixture-value' });
      assert.deepEqual(saved.services.last.env, { LAST: 'last-fixture-value' });
    });
  });

  test(`${host} env file origin confirmation is carried into cleanup eligibility and the retained-file recap`, () => {
    const rendered = envInstructions();
    const origin = rendered.match(/For each path they type back[\s\S]*?(?=\nYou may combine)/)?.[0];
    assert.ok(origin, 'ask after offering the recipe, without assuming where the file came from');
    const ask = host === 'claude' ? 'AskUserQuestion' : 'request_user_input';
    assert.ok(origin.includes('`' + ask + '`: "Did you create'));
    for (const label of ['Yes, created with this recipe', 'No, existing file', 'Not sure']) {
      assert.ok(origin.replace(/\s+/g, ' ').includes(`**${label}**`), label);
    }
    assert.match(origin, /`recipe-created` to true only for an explicit Yes/);
    assert.match(origin, /false for an\s+existing file, No, Not sure, or missing\/unclear confirmation/);
    const record = '(service-name, env-file-path, recipe-created)';
    assert.ok(origin.includes(record));
    const step7 = rendered.split('## Step 7')[1].split('## Step 8')[0];
    assert.ok(step7.includes(record));
    assert.match(step7, /Use only records with `recipe-created: true`/);
    assert.match(step7, /wait until every service using that file has merged successfully/);
    assert.match(step7, /Preserve\s+the file if its origin confirmations conflict/);
    assert.match(step7, /List the paths of pre-existing or unconfirmed input files/);
    assert.match(step7, /List the paths[\s\S]*conflicting origin confirmations/);
    assert.match(step7, /List the paths[\s\S]*files retained by \*\*Continue without\s+file values\*\*/);
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
