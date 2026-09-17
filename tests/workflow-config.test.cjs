'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const ROOT = resolve(__dirname, '..');

test('import workflow restores the previous multiplier without replacing the newly configured wallet', (t) => {
  const data = fs.mkdtempSync(join(tmpdir(), 'manifest-import-workflow-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  fs.mkdirSync(join(data, 'chains'));
  fs.mkdirSync(join(data, 'keys'));
  fs.writeFileSync(join(data, 'chains/testnet.json'), JSON.stringify({
    chainId: 'manifest-ledger-testnet', rpcUrl: 'https://rpc.example.invalid',
    feeTokens: [{ symbol: 'MFX', denom: 'umfx', fixedMinGasPrice: 1 }],
  }));
  const env = { PATH: process.env.PATH, MANIFEST_PLUGIN_ROOT: ROOT,
    MANIFEST_PLUGIN_DATA: data, MANIFEST_CREDENTIAL_STORE: 'file' };
  const node = (script, args, input) => spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...args],
    { env, input, encoding: 'utf8', timeout: 10000 });
  const write = (name) => {
    const keyfile = join(data, 'keys', name + '.json');
    fs.writeFileSync(keyfile, 'disposable encrypted-wallet stand-in');
    const result = node('write-config.cjs', ['--chain', 'testnet', '--gas-price', '1umfx'],
      JSON.stringify({ keyfile, address: `manifest1${name}`, password: 'fixture-only-password' }));
    assert.equal(result.status, 0, result.stderr);
  };
  write('old');
  assert.equal(node('update-config.cjs', ['--gas-multiplier', '2.25']).status, 0);
  const previous = JSON.parse(node('update-config.cjs', ['--status']).stdout);
  write('imported');
  const configPath = join(data, 'config.json');
  const imported = fs.readFileSync(configPath);
  assert.equal(JSON.parse(imported).gasMultiplier, undefined, 'config writer requires the follow-up restoration');
  const source = fs.readFileSync(join(ROOT, 'workflows/import-key.md'), 'utf8');
  const command = [...source.matchAll(/```bash\n([\s\S]*?)\n```/g)]
    .find((match) => match[1].includes("--gas-multiplier 'PREVIOUS_GAS_MULTIPLIER'"))?.[1];
  assert.ok(command, 'workflow must include a separate restoration command');
  const restore = (value) => spawnSync('bash', ['-ec', command.replace("'PREVIOUS_GAS_MULTIPLIER'", `'${value}'`)],
    { env, encoding: 'utf8', timeout: 10000 });
  const failed = restore('invalid');
  assert.equal(failed.status, 1);
  assert.deepEqual(fs.readFileSync(configPath), imported, 'failed restoration preserves the imported identity');
  const restored = restore(previous.gasMultiplier);
  assert.equal(restored.status, 0, restored.stderr);
  const final = JSON.parse(fs.readFileSync(configPath));
  assert.deepEqual(final, { ...JSON.parse(imported), gasMultiplier: previous.gasMultiplier });
  assert.equal(JSON.parse(restored.stdout).gasMultiplier, 2.25);
  assert.deepEqual(fs.readdirSync(join(data, 'keys')).sort(), ['imported.json', 'old.json']);
});
