'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { spawn } = require('node:child_process');
const { buildCodex } = require('../ci/build-packages.cjs');
const { prepareFixture } = require('./fixtures/native-host-fixture.cjs');
const { inspectRuntime } = require('../scripts/_runtime.cjs');
const ROOT = resolve(__dirname, '..');

test('concurrent Claude and Codex processes upgrade isolated runtimes without migrating config, keys or saved records', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'manifest-host-upgrade-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pluginRoot = buildCodex({ out: join(root, 'package') });
  const dirs = { claude: join(root, 'claude-persistent'), codex: join(root, 'codex-persistent') };
  const records = ['config.json', 'fixture-wallet.json', 'keys/wallet.json', 'manifests-drafts/draft.json', 'manifests/saved.json', 'journal/previous.jsonl'];
  const snapshots = {};
  for (const [host, dataDir] of Object.entries(dirs)) {
    await prepareFixture({ pluginRoot, dataDir });
    for (const name of records.slice(2)) {
      fs.mkdirSync(join(dataDir, name, '..'), { recursive: true });
      fs.writeFileSync(join(dataDir, name), JSON.stringify({ host, saved: true }) + '\n', { mode: 0o600 });
    }
    const config = JSON.parse(fs.readFileSync(join(dataDir, 'config.json')));
    config.fixtureHost = host;
    fs.writeFileSync(join(dataDir, 'config.json'), JSON.stringify(config));
    snapshots[host] = records.map((file) => fs.readFileSync(join(dataDir, file)));
  }
  // A changed package definition forces setup rather than a cached no-op.
  const pkg = JSON.parse(fs.readFileSync(join(pluginRoot, 'package.json')));
  fs.writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ ...pkg, description: 'fixture upgrade' }));
  const runner = join(root, 'upgrade.cjs');
  fs.writeFileSync(runner, [
    "'use strict';",
    `const { resolveHost } = require(${JSON.stringify(join(ROOT, 'scripts/_host.cjs'))});`,
    `const { setupRuntime } = require(${JSON.stringify(join(ROOT, 'scripts/setup-runtime.cjs'))});`,
    `const { appendRecord } = require(${JSON.stringify(join(ROOT, 'scripts/_journal.cjs'))});`,
    `const host = resolveHost(process.argv[2], { pluginRoot: ${JSON.stringify(pluginRoot)} });`,
    'Object.assign(process.env, host.env);',
    'setupRuntime({ ...host, install: async () => { await new Promise(resolve => setTimeout(resolve, 75)); } })',
    `.then(() => appendRecord({ schema_version: 1, operation: 'host-upgrade-fixture', host: process.argv[2], session_id: process.env.MANIFEST_SESSION_ID }))`,
    '.catch(error => { console.error(error); process.exitCode = 1; });',
  ].join('\n'));
  const run = (host) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, host], { env: { PATH: process.env.PATH,
      CLAUDE_PLUGIN_DATA: dirs.claude, MANIFEST_CODEX_DATA: dirs.codex,
      MANIFEST_PLUGIN_DATA: dirs.claude, MANIFEST_SESSION_ID: 'claude-session', CODEX_THREAD_ID: 'codex-session' },
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  });
  await Promise.all([run('claude'), run('codex'), run('codex')]);
  for (const [host, dataDir] of Object.entries(dirs)) {
    assert.equal(inspectRuntime(dataDir, pluginRoot).ready, true);
    records.forEach((file, i) => assert.deepEqual(fs.readFileSync(join(dataDir, file)), snapshots[host][i], `${host}/${file}`));
    const today = new Date().toISOString().slice(0, 10);
    const journal = fs.readFileSync(join(dataDir, `journal/${today}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(journal.length, host === 'codex' ? 2 : 1);
    for (const event of journal) {
      assert.equal(event.host, host);
      assert.equal(event.session_id, `${host}-session`);
    }
  }
  assert.equal(fs.existsSync(join(pluginRoot, 'config.json')), false);
});
