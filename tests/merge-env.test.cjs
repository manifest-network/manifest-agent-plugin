'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, chmodSync, rmSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const { renderSkill } = require('../ci/build-packages.cjs');

const ROOT = join(__dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'merge-env.cjs');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const ENTRY_ORDER = /\b[Pp]ress\s+Enter\b(?:e\.g\.|i\.e\.|[^.!?])*?Ctrl\+D\b[\s\S]*prompt\s+returns/;

function section(text, heading) {
  const content = text.split(`### ${heading}\n`)[1]?.split(/\n#{2,3} /)[0];
  assert.ok(content, `missing section: ${heading}`);
  return content;
}

function recoveryChoices(text) {
  const matches = [...section(text, 'Env input recovery').matchAll(/^- \*\*([^*\n]+)\*\* — ([^\n]*(?:\n[ \t]+[^\n]+)*)/gm)];
  assert.equal(matches.length, 5, 'document the five choices across both origin cases');
  const choices = new Map(matches.map(match => [match[1], match[2]]));
  assert.deepEqual([...choices.keys()], ['Re-enter file values', 'Create a new temporary file',
    'I edited my file — retry', 'Continue without file values', 'Cancel']);
  return choices;
}

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
  assert.match(between, ENTRY_ORDER);
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
      const recovery = rendered.match(/If `keys_merged` is empty[\s\S]*?(?=\n\n)/)?.[0];
      assert.ok(recovery, 'handle the empty keys_merged response');
      assert.match(recovery, /\bstop\b/);
      assert.match(recovery, /Keep the input file and draft/);
      assert.match(recovery, /Env input recovery[\s\S]*recorded path and origin flag/);
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

  test(`${host} env recovery keeps origin restrictions and each option's semantics together`, () => {
    const rendered = envInstructions();
    const recovery = section(rendered, 'Env input recovery');
    assert.ok(recovery.includes(host === 'claude' ? '`AskUserQuestion`' : '`request_user_input`'));
    const eligibility = recovery.split('\n- **')[0];
    assert.match(eligibility, /readable,[\s\S]*confirmed temporary input eligible under the mutation rule/);
    assert.match(eligibility, /Otherwise offer[\s\S]*Create a new[\s\S]*temporary file[\s\S]*I edited my file — retry/);
    assert.match(eligibility, /Pre-existing, unknown-origin, conflicting, retained or unreadable inputs\s+must not be offered the Re-enter command/);
    const choices = recoveryChoices(rendered);
    const reenter = choices.get('Re-enter file values');
    assert.match(reenter, /only for an eligible `recipe-created: true`/);
    assert.match(reenter, /recorded file[\s\S]*gated command[\s\S]*retry[\s\S]*before continuing/);
    const create = choices.get('Create a new temporary file');
    assert.match(create, /rerun Step 4's creation recipe/);
    assert.match(create, /Collect\s+the new path and ask its origin question again/);
    assert.match(create, /Keep the old path in\s+`RETAINED_ENV_INPUT_PATHS` and exclude it from cleanup/);
    assert.match(create, /Replace only the affected service's input record[\s\S]*new path[\s\S]*new `recipe-created` flag/);
    assert.match(create, /Preserve earlier `MERGED_ENV_INPUTS` entries/);
    const edited = choices.get('I edited my file — retry');
    assert.match(edited, /user confirms their private edit[\s\S]*retry the merge at the same recorded path/);
    assert.match(edited, /Preserve its\s+origin flag and do not supply a command that writes/);
    const skip = choices.get('Continue without file values');
    assert.match(skip, /remove only that service's input record[\s\S]*preserving any env values/);
    assert.match(skip, /Keep the input file[\s\S]*retained-file recap/);
    assert.match(skip, /exclude that path from cleanup even if another service uses it/);
    const cancel = choices.get('Cancel');
    assert.match(cancel, /Stopping after the draft was saved/);
    assert.match(cancel, /report contributing services and retained paths[\s\S]*warn about saved env\s+values[\s\S]*offer eligible temporary-file cleanup/);
    assert.match(recovery, /recorded `env-file-path`[\s\S]*shell-escaped literal/);
    assert.match(recovery, /Do not use\s+`ENV_INPUT_PATH`/);
    assert.match(recovery, /Keep the existing input record[\s\S]*confirmed `recipe-created: true` flag/);
    assert.match(recovery, ENTRY_ORDER);
    assert.match(recovery, /Do not report the spec as ready while a file\s+input is awaiting/);
    const errors = rendered.match(/If the script errors out[\s\S]*?(?=\n###)/)?.[0];
    assert.match(errors, /Invalid dotenv input and unreadable files use \*\*Env input recovery\*\*[\s\S]*recorded path and origin flag/);
    assert.match(errors, /unknown service[\s\S]*service-name binding[\s\S]*same recorded input path; do not rewrite/);
    assert.match(errors, /recovery is abandoned[\s\S]*Stopping after\s+the draft was saved/);
  });

  test(`${host} every env overwrite or removal example has an adjacent origin gate`, () => {
    const rendered = envInstructions();
    assert.match(rendered, /commands that overwrite or remove an existing\s+env input require `recipe-created: true`/);
    assert.match(rendered, /Apply this rule to every retry,\s+error-recovery and cleanup command/);
    // Scope this rule to env collection/recovery, excluding unrelated draft
    // and journal staging files, which have their own ownership contracts.
    const envText = rendered.slice(rendered.indexOf('**env** —'), rendered.indexOf('**labels**'))
      + rendered.slice(rendered.indexOf('**If the user picked "From a file"'), rendered.indexOf('## Step 8'));
    const commands = [...envText.matchAll(/^([ \t]*)```bash\n([\s\S]*?)^\1```[ \t]*$/gm)];
    let creations = 0, gated = 0;
    for (const block of commands) {
      if (!/\brm\s|>/.test(block[2])) continue;
      if (block[2].includes('ENV_INPUT_PATH=$(mktemp)')) {
        assert.match(block[2], /^umask 077\nENV_INPUT_PATH=\$\(mktemp\)\ncat > "\$ENV_INPUT_PATH"\s*$/);
        creations++;
        continue;
      }
      const intro = envText.slice(0, block.index).trimEnd().split(/\n\s*\n/).at(-1);
      assert.match(intro, /^Only for[\s\S]*`recipe-created: true`/, block[2]);
      gated++;
    }
    assert.equal(creations, 1, 'only the initial capture creates a fresh input');
    assert.equal(gated, 2, 'retry and cleanup both require an origin gate');
  });

  test(`${host} env retry refills the recorded service input without overwriting the last collected file`, () => {
    for (const initialInput of ['', 'INVALID_LINE\n']) withDataDir(dataDir => {
      const commands = envCommands();
      const retry = commands.find(command => command.includes("'ENV_RETRY_FILE'"));
      assert.ok(retry, 'provide a re-entry command with a recorded-path placeholder');
      const merge = commands.find(command => command.includes('scripts/merge-env.cjs'));
      const first = join(dataDir, "first service's $(touch unexpected).env");
      const last = join(dataDir, 'last service.env');
      const firstInput = 'FIRST=first-fixture-value\n';
      const lastInput = 'LAST=last-fixture-value\n';
      // This branch's origin is explicitly confirmed as recipe-created.
      writeFileSync(first, initialInput, { mode: 0o600 });
      writeFileSync(last, lastInput, { mode: 0o600 });
      const specPath = join(dataDir, 'manifests-drafts', 'stack.json');
      writeFileSync(specPath, JSON.stringify({ services: {
        first: { image: 'first', env: { EXISTING: 'keep-fixture' } }, last: { image: 'last' },
      } }));
      const env = { PATH: process.env.PATH, MANIFEST_PLUGIN_ROOT: ROOT,
        MANIFEST_PLUGIN_DATA: dataDir, SAVED_PATH: specPath, ENV_INPUT_PATH: last };
      const mergeService = (name, path, expectedStatus = 0) => {
        const result = spawnSync('bash', ['--noprofile', '--norc', '-c', merge], {
          cwd: dataDir, encoding: 'utf8', env: { ...env, SERVICE_NAME: name, ENV_FILE_PATH: path },
        });
        assert.ifError(result.error);
        assert.equal(result.status, expectedStatus, result.stderr);
        assert.doesNotMatch(result.stdout + result.stderr, /first-fixture-value|last-fixture-value|keep-fixture/);
        if (expectedStatus) {
          assert.match(result.stderr, /missing '='/);
          return;
        }
        return JSON.parse(result.stdout);
      };
      assert.deepEqual(mergeService('last', last).keys_merged, ['LAST']);
      if (initialInput) {
        const before = readFileSync(specPath);
        mergeService('first', first, 1);
        assert.deepEqual(readFileSync(specPath), before, 'failed input preserves the earlier service merge');
      } else assert.deepEqual(mergeService('first', first).keys_merged, []);
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
      const saved = JSON.parse(readFileSync(specPath));
      assert.deepEqual(saved.services.first.env, { EXISTING: 'keep-fixture', FIRST: 'first-fixture-value' });
      assert.deepEqual(saved.services.last.env, { LAST: 'last-fixture-value' });
      assert.equal(existsSync(join(dataDir, 'unexpected')), false);
    });
  });

  test(`${host} replacing pre-existing or unknown-origin input preserves its bytes and mode`, () => {
    for (const origin of ['pre-existing', 'unknown']) withDataDir(dataDir => {
      const rendered = envInstructions();
      const choices = recoveryChoices(rendered);
      assert.match(choices.get('Create a new temporary file'), /new path and ask its origin question again/);
      const supplied = join(dataDir, `${origin}.env.example`);
      const original = '# project template\n# preserve these comments\n';
      writeFileSync(supplied, original);
      chmodSync(supplied, 0o644);
      const specPath = join(dataDir, 'manifests-drafts', 'app.json');
      writeFileSync(specPath, JSON.stringify({ services: { app: { image: 'fixture' } } }));
      const mergeCommand = envCommands().find(command => command.includes('scripts/merge-env.cjs'));
      const merge = path => {
        const result = spawnSync('bash', ['--noprofile', '--norc', '-c', mergeCommand], {
          cwd: dataDir, encoding: 'utf8', env: { PATH: process.env.PATH, MANIFEST_PLUGIN_ROOT: ROOT,
            MANIFEST_PLUGIN_DATA: dataDir, SAVED_PATH: specPath, SERVICE_NAME: 'app', ENV_FILE_PATH: path },
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        assert.doesNotMatch(result.stdout + result.stderr, /value1|value2/);
        return JSON.parse(result.stdout);
      };
      assert.deepEqual(merge(supplied).keys_merged, []);
      // The driver chooses Create for a false/unknown origin, collects the
      // fresh path and supplies the user's new origin confirmation.
      const replacement = captureEnvRecipe(rendered, dataDir);
      assert.notEqual(replacement, supplied);
      assert.deepEqual(merge(replacement).keys_merged, ['KEY1', 'KEY2']);
      assert.deepEqual(JSON.parse(readFileSync(specPath)).services.app.env, { KEY1: 'value1', KEY2: 'value2' });
      assert.equal(statSync(replacement).mode & 0o777, 0o600);
      assert.equal(readFileSync(supplied, 'utf8'), original);
      assert.equal(statSync(supplied).mode & 0o777, 0o644);
    });
  });

  test(`${host} cancellation after a partial merge keeps the draft and failed input while allowing completed-input cleanup`, () => {
    const rendered = envInstructions();
    const stopping = section(rendered, 'Stopping after the draft was saved');
    assert.match(stopping, /On cancellation or any other early stop, keep the draft/);
    assert.match(stopping, /contributing services and input paths from `MERGED_ENV_INPUTS` \(keys\s+only\)/);
    assert.match(stopping, /If env values were saved[\s\S]*do not commit or share this draft[\s\S]*redacting secrets/);
    assert.match(stopping, /Apply \*\*Env input cleanup\*\*[\s\S]*eligible merged temporary inputs/);
    assert.match(stopping, /has not confirmed a completed spec/);
    assert.match(stopping, /Keep pending, failed and retained inputs/);
    assert.match(stopping, /Do not report the draft as ready or give a deployment command/);
    assert.match(section(rendered, 'Env input cleanup'), /On cancellation or another stop[\s\S]*without requiring confirmation of a completed spec/);
    assert.match(section(rendered, 'Revalidate the saved spec'), /If validation fails[\s\S]*Stopping after the draft was saved/);
    withDataDir(dataDir => {
      const completed = join(dataDir, 'completed.env');
      const failed = join(dataDir, 'failed.env');
      writeFileSync(completed, 'SAVED=fixture-saved-value\n', { mode: 0o600 });
      writeFileSync(failed, 'INVALID_LINE\n', { mode: 0o600 });
      const specPath = join(dataDir, 'manifests-drafts', 'partial.json');
      writeFileSync(specPath, JSON.stringify({ services: {
        completed: { image: 'fixture' }, failed: { image: 'fixture' },
      } }));
      const commands = envCommands();
      const mergeCommand = commands.find(command => command.includes('scripts/merge-env.cjs'));
      const env = { PATH: process.env.PATH, MANIFEST_PLUGIN_ROOT: ROOT,
        MANIFEST_PLUGIN_DATA: dataDir, SAVED_PATH: specPath };
      const contributions = [];
      for (const [service, path, status] of [['completed', completed, 0], ['failed', failed, 1]]) {
        const result = spawnSync('bash', ['--noprofile', '--norc', '-c', mergeCommand], {
          cwd: dataDir, encoding: 'utf8', env: { ...env, SERVICE_NAME: service, ENV_FILE_PATH: path },
        });
        assert.ifError(result.error);
        assert.equal(result.status, status, result.stderr);
        assert.doesNotMatch(result.stdout + result.stderr, /fixture-saved-value/);
        if (!status) contributions.push(JSON.parse(result.stdout));
      }
      assert.deepEqual(contributions, [{ service: 'completed', keys_merged: ['SAVED'] }]);
      const beforeCleanup = readFileSync(specPath);
      const cleanup = commands.find(command => command.startsWith('rm -- '));
      // The user accepts cleanup for the completed recipe-created input only.
      const result = spawnSync('bash', ['--noprofile', '--norc', '-c',
        cleanup.replace("'TEMP_ENV_INPUT_FILE'", () => quote(completed))], {
        cwd: dataDir, encoding: 'utf8', env: { PATH: process.env.PATH },
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(completed), false);
      assert.equal(readFileSync(failed, 'utf8'), 'INVALID_LINE\n');
      assert.deepEqual(readFileSync(specPath), beforeCleanup);
      assert.equal(JSON.parse(beforeCleanup).services.completed.env.SAVED, 'fixture-saved-value');
      assert.equal(statSync(specPath).mode & 0o777, 0o600);
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
    assert.match(step7, /Keep the associated service names with each\s+retained path, even after removing or replacing its input record/);
    assert.match(step7, /Use only records with `recipe-created: true`/);
    assert.match(step7, /wait until every service using that file has merged successfully/);
    assert.match(step7, /Preserve\s+the file if its origin confirmations conflict/);
    assert.match(step7, /List the paths of pre-existing or unconfirmed input files/);
    assert.match(step7, /List the paths[\s\S]*conflicting origin confirmations/);
    assert.match(step7, /List the paths[\s\S]*files retained\s+by \*\*Continue without file values\*\*/);
    assert.match(step7, /path shared by\s+a merged service and a skipped service appears in both recaps/);
    const report = rendered.split('## Step 8')[1].split('## Step 9')[0];
    assert.match(report, /Independently list retained input paths;\s+a shared path may appear in both recaps/);
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
