'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const { buildCodex } = require('../ci/build-packages.cjs');
const ROOT = resolve(__dirname, '..');
const SECRET = 'fixture-only-secret';
const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
const blocks = (source) => [...source.matchAll(/```bash\n([\s\S]*?)\n```/g)].map((match) => match[1]);

function hostFixture(t, host) {
  const base = fs.mkdtempSync(join(tmpdir(), 'manifest-config-workflow-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = host === 'codex' ? buildCodex({ out: join(base, 'package') }) : join(base, 'package');
  if (host === 'claude') {
    for (const directory of ['scripts', 'skills']) {
      fs.cpSync(join(ROOT, directory), join(root, directory), { recursive: true });
    }
  }
  // Only cryptographic wallet creation is stubbed. Execute the shipped shell
  // pipelines, config writers, credential store, status reads and journal writer.
  const keyFixture = [
    "const fs = require('node:fs');",
    "const { join, basename } = require('node:path');",
    "const data = process.env.MANIFEST_PLUGIN_DATA;",
    "const operation = basename(__filename);",
    "if (operation === 'import-key.cjs' && fs.readFileSync(0, 'utf8') !== '" + SECRET + "') process.exit(1);",
    "const log = join(data, 'wallet-calls');",
    "fs.appendFileSync(log, operation + '\\n');",
    "const count = fs.readFileSync(log, 'utf8').trim().split('\\n').length;",
    "const keyfile = join(data, 'keys', 'wallet-' + count + '.json');",
    "fs.writeFileSync(keyfile, 'encrypted-wallet-fixture');",
    "console.log(JSON.stringify({ keyfile, address: 'manifest1replacement' + count, password: '" + SECRET + "' }));",
  ].join('\n');
  for (const script of ['gen-agent-key.cjs', 'import-key.cjs']) fs.writeFileSync(join(root, 'scripts', script), keyFixture);
  return { base, root, host };
}

function run(f, command, variables = {}) {
  for (const [key, value] of Object.entries(variables)) command = command.replaceAll(quote(key), quote(value));
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c',
    (f.host === 'codex' ? 'source ./env.sh || exit\n' : '') + command], {
    cwd: f.skillDir, env: f.env, encoding: 'utf8', timeout: 10000,
  });
  assert.ifError(result.error);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(SECRET));
  return result;
}

function fixture(host, t, skill, multiplier, fresh = false) {
  const data = fs.mkdtempSync(join(host.base, 'data-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  fs.mkdirSync(join(data, 'chains'));
  fs.mkdirSync(join(data, 'keys'));
  for (const name of ['testnet', 'mainnet']) {
    fs.writeFileSync(join(data, 'chains', name + '.json'), JSON.stringify({
      chainId: 'manifest-ledger-' + name, rpcUrl: 'https://rpc.example.invalid',
      feeTokens: [{ symbol: 'MFX', denom: 'umfx', fixedMinGasPrice: 1 }],
    }));
  }
  const skillDir = join(host.root, 'skills', skill);
  const source = fs.readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
  const env = { PATH: process.env.PATH, MANIFEST_PLUGIN_ROOT: host.root,
    MANIFEST_PLUGIN_DATA: data, MANIFEST_CODEX_DATA: data, MANIFEST_CREDENTIAL_STORE: 'file' };
  const f = { ...host, data, skill, skillDir, source, env, configPath: join(data, 'config.json') };
  if (!fresh) {
    const keyfile = join(data, 'keys', 'previous.json');
    fs.writeFileSync(keyfile, 'previous-encrypted-wallet');
    const seed = spawnSync(process.execPath, [join(host.root, 'scripts/write-config.cjs'),
      '--chain', 'mainnet', '--gas-price', '9umfx'], {
      env, input: JSON.stringify({ keyfile, address: 'manifest1previous', password: SECRET }), encoding: 'utf8', timeout: 10000,
    });
    assert.ifError(seed.error);
    assert.equal(seed.status, 0, seed.stderr);
    const config = JSON.parse(fs.readFileSync(f.configPath));
    if (multiplier !== undefined) config.gasMultiplier = multiplier;
    fs.writeFileSync(f.configPath, JSON.stringify(config));
  }
  f.commands = blocks(source);
  const statusCommands = f.commands.filter((command) => command.includes('update-config.cjs" --status'));
  assert.equal(statusCommands.length, 2, 'capture previous settings and verify final settings separately');
  const walletCommands = f.commands.filter((command) => command.includes('scripts/write-config.cjs'));
  for (const command of walletCommands) {
    assert.ok(f.commands.indexOf(command) > f.commands.indexOf(statusCommands[0]));
    assert.ok(f.commands.indexOf(command) < f.commands.lastIndexOf(statusCommands[1]), 'final status must follow either wallet pipeline');
  }
  assert.equal(f.commands.some((command) => command.includes('--gas-multiplier')), false,
    'preservation must not require a second config mutation');
  f.statusCommand = statusCommands[0];
  f.finalStatus = () => run(f, statusCommands[1]);
  f.status = () => run(f, f.statusCommand);
  f.mnemonicPath = join(data, "input with ' quote.txt");
  fs.writeFileSync(f.mnemonicPath, SECRET, { mode: 0o600 });
  return f;
}

function replaceWallet(f, mode, previous, call = 1) {
  const script = mode === 'generate' ? 'gen-agent-key.cjs' : 'import-key.cjs';
  const pipeline = f.commands.find((command) => command.includes('scripts/' + script)
    && command.includes('scripts/write-config.cjs'));
  assert.ok(pipeline, 'execute the documented wallet pipeline');
  const result = run(f, pipeline, { CHOSEN_CHAIN: 'testnet', GAS_TOKEN: 'MFX',
    ACTIVE_CHAIN: previous?.activeChain, CURRENT_GAS_PRICE: previous?.gasPrice, MNEMONIC_FILE: f.mnemonicPath });
  assert.equal(result.status, 0, result.stderr);
  f.written = JSON.parse(result.stdout);
  assert.equal(f.written.address, 'manifest1replacement' + call);
  return fs.readFileSync(f.configPath);
}

function journal(f, outcome, settings, errors = [], recovery = []) {
  const sketch = /```text\n([\s\S]*?)\n```/.exec(f.source)?.[1];
  assert.ok(sketch, 'workflow must supply a journal record sketch');
  const values = Object.fromEntries(Object.entries(settings).map(([key, value]) => ['<FINAL_SETTINGS.' + key + '>', value]));
  values['<RUN_OUTCOME>'] = outcome;
  const fill = (object, substitutions) => JSON.parse(JSON.stringify(object), (_key, value) =>
    typeof value === 'string' && Object.hasOwn(substitutions, value) ? substitutions[value] : value);
  const record = fill(JSON.parse(sketch), values);
  record.errors = errors.map((error) => fill(record.errors[0], { '<ERROR.class>': error.class, '<ERROR.message>': error.message }));
  record.recovery_actions = recovery;
  record.intent = 'Replace the wallet and retain the gas multiplier';
  record.plan_summary = outcome === 'cancelled' ? 'Cancelled before wallet replacement' : 'Wallet replacement preserving gas settings';
  const staging = fs.mkdtempSync(join(f.data, 'journal-stage-'));
  fs.writeFileSync(join(staging, 'journal.json'), JSON.stringify(record), { mode: 0o600 });
  const command = f.commands.find((value) => value.includes('scripts/journal-write.cjs'));
  assert.ok(command, 'execute the generated safe file-to-stdin journal command');
  const result = run({ ...f, env: { ...f.env, JOURNAL_DIR: staging } }, command);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(staging), false);
  const saved = JSON.parse(fs.readFileSync(result.stdout.trim(), 'utf8').trim().split('\n').at(-1));
  assert.equal(saved.outcome, outcome);
  assert.equal(saved.active_chain, settings.activeChain);
  assert.ok(['testnet', 'mainnet', null].includes(saved.active_chain), 'journal chain must satisfy its documented schema');
  assert.equal(saved.signer_address, settings.address);
  for (const [field, key] of [['address', 'address'], ['active_chain', 'activeChain'], ['gas_price', 'gasPrice'], ['gas_multiplier', 'gasMultiplier']]) {
    assert.equal(saved.final_state[field], settings[key]);
  }
  assert.deepEqual(saved.errors, errors);
  assert.deepEqual(saved.recovery_actions, recovery);
  assert.doesNotMatch(JSON.stringify(saved), new RegExp(SECRET));
}

for (const host of ['claude', 'codex']) {
  for (const [skill, mode] of [['init-agent', 'generate'], ['init-agent', 'import'], ['import-key', 'import']]) {
    test(host + ' ' + skill + '/' + mode + ' atomically preserves gas settings and verifies without another wallet', async (t) => {
      const packageFixture = hostFixture(t, host);
      const cases = [
        { label: 'integer', multiplier: 2 }, { label: 'fractional', multiplier: 2.25 },
        { label: 'numeric string', multiplier: '2' },
        { label: 'absent' }, { label: 'null', multiplier: null },
        ...(skill === 'init-agent' ? [{ label: 'fresh', fresh: true }] : []),
      ];
      for (const item of cases) {
        await t.test(item.label, (t) => {
          const f = fixture(packageFixture, t, skill, item.multiplier, item.fresh);
          const before = f.status();
          assert.equal(before.status, item.fresh ? 1 : 0, before.stderr);
          const previous = item.fresh ? null : JSON.parse(before.stdout);
          const written = replaceWallet(f, mode, previous);
          assert.equal(JSON.parse(written).gasMultiplier, item.multiplier ?? undefined,
            'the wallet write itself must retain gas settings before any follow-up command');
          const finalStatus = f.finalStatus();
          assert.equal(finalStatus.status, 0, finalStatus.stderr);
          const final = JSON.parse(finalStatus.stdout);
          assert.equal(final.gasMultiplier, item.multiplier ?? null);
          assert.equal(final.activeChain, skill === 'init-agent' ? 'testnet' : previous.activeChain);
          assert.equal(final.gasPrice, skill === 'init-agent' ? '1umfx' : previous.gasPrice);
          assert.deepEqual(fs.readFileSync(f.configPath), written, 'verification must be read-only');
          assert.equal(fs.readFileSync(join(f.data, 'wallet-calls'), 'utf8'),
            (mode === 'generate' ? 'gen-agent-key.cjs' : 'import-key.cjs') + '\n');
          journal(f, 'success', final);
        });
      }
      await t.test('a new invocation after interruption still reads and preserves the saved multiplier', (t) => {
        const f = fixture(packageFixture, t, skill, 2.25);
        const previous = JSON.parse(f.status().stdout);
        const written = replaceWallet(f, mode, previous);
        assert.equal(JSON.parse(written).gasMultiplier, 2.25);
        // Stop after the wallet write, before verification/journaling. A later
        // invocation gets its inputs from disk instead of the first run's memory.
        const next = JSON.parse(f.status().stdout);
        assert.equal(next.gasMultiplier, 2.25);
        const rerun = replaceWallet(f, mode, next, 2);
        assert.equal(JSON.parse(rerun).gasMultiplier, 2.25);
        assert.equal(JSON.parse(f.finalStatus().stdout).gasMultiplier, 2.25);
      });
      await t.test('failed final status retains the confirmed identity and recovers with only a read', (t) => {
        const f = fixture(packageFixture, t, skill, 2.25);
        const previous = JSON.parse(f.status().stdout);
        const written = replaceWallet(f, mode, previous);
        const walletCalls = fs.readFileSync(join(f.data, 'wallet-calls'));
        const keys = fs.readdirSync(join(f.data, 'keys'));
        const credentials = fs.readdirSync(join(f.data, 'credentials'));
        fs.renameSync(f.configPath, f.configPath + '.backup');
        fs.mkdirSync(f.configPath);
        const failed = f.finalStatus();
        assert.equal(failed.status, 1);
        const partial = { ...f.written, gasPrice: 'unknown', gasMultiplier: 'unknown' };
        const errors = [{ class: 'config_status_failed', message: failed.stderr.trim() }];
        journal(f, 'partial', partial, errors, ['Repair config access and retry only status']);
        assert.deepEqual(fs.readFileSync(f.configPath + '.backup'), written);
        fs.rmdirSync(f.configPath);
        fs.renameSync(f.configPath + '.backup', f.configPath);
        const recovered = f.finalStatus();
        assert.equal(recovered.status, 0, recovered.stderr);
        assert.equal(JSON.parse(recovered.stdout).gasMultiplier, 2.25);
        assert.deepEqual(fs.readFileSync(f.configPath), written);
        assert.deepEqual(fs.readFileSync(join(f.data, 'wallet-calls')), walletCalls);
        assert.deepEqual(fs.readdirSync(join(f.data, 'keys')), keys);
        assert.deepEqual(fs.readdirSync(join(f.data, 'credentials')), credentials);
        journal(f, 'success', JSON.parse(recovered.stdout), errors, ['Retried only status; verification succeeded']);
      });
      if (skill === 'init-agent') {
        for (const observed of [false, true]) {
          await t.test(`cancellation ${observed ? 'after' : 'before'} status uses the previous identity or null`, (t) => {
            const f = fixture(packageFixture, t, skill, 2.25, !observed);
            const before = observed ? fs.readFileSync(f.configPath) : null;
            const settings = observed ? JSON.parse(f.status().stdout)
              : { address: null, activeChain: null, gasPrice: 'unknown', gasMultiplier: 'unknown' };
            journal(f, 'cancelled', settings);
            assert.equal(fs.existsSync(join(f.data, 'wallet-calls')), false);
            if (observed) assert.deepEqual(fs.readFileSync(f.configPath), before);
            else assert.equal(fs.existsSync(f.configPath), false);
          });
        }
      }
    });
  }
}
