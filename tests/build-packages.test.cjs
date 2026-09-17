'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const { renderSkill, mutationPolicy, codexPolicy, writeClaudeSkills, buildCodex, workflowFiles, workflowFragmentFiles } = require('../ci/build-packages.cjs');
const { sourceHashes } = require('../ci/codex-host-smoke.cjs');
const ROOT = resolve(__dirname, '..');

test('both host skills resolve each domain invocation and keep the journal keys stable', () => {
  const source = fs.readFileSync(join(ROOT, 'workflows/deploy-app.md'), 'utf8');
  const claude = renderSkill(source, 'claude', { name: 'deploy-app' });
  const codex = renderSkill(source, 'codex', { name: 'deploy-app' });
  assert.match(claude, /mcp__plugin_manifest-agent_manifest-agent__deploy_app_orchestrated\(\{ spec: SPEC \}\)/);
  assert.match(codex, /mcp__manifest-agent__deploy_app_orchestrated\(\{ spec: SPEC \}\)/);
  assert.match(claude, /\/manifest-agent:author-manifest/);
  assert.match(codex, /\$manifest-agent:author-manifest/);
  for (const text of [claude, codex]) {
    assert.match(text, /mcp__manifest-agent__deploy_app_orchestrated/);
    assert.match(text, /DEPLOY_READINESS_UNCONFIRMED/);
    assert.match(text, /salvage_without_domain/);
    assert.match(text, /check-storage-selection\.cjs/);
    assert.doesNotMatch(text, /\{\{/);
  }
  assert.doesNotMatch(codex, /Claude|PreToolUse|CLAUDE_|allowed-tools|\$ARGUMENTS/);
  for (const name of ['deploy-app', 'manage-domain', 'troubleshoot-deployment']) {
    const text = fs.readFileSync(join(ROOT, 'workflows', `${name}.md`), 'utf8');
    assert.match(renderSkill(text, 'claude', { name }), /PreToolUse events?/);
    assert.doesNotMatch(renderSkill(text, 'codex', { name }), /host\s+host|PreToolUse|restart Codex/);
  }
});

test('generation fails on unknown tokens, tools and cross-skill names instead of asking the model to translate', () => {
  const source = '---\nname: probe\ndescription: test\n---\n\n';
  for (const token of ['{{missing}}', '{{tool:other/tool}}', '{{invoke:missing}}', '{{broken']) {
    assert.throws(() => renderSkill(source + token, 'codex', { name: 'probe' }), /Unknown|Invalid|Unresolved/);
  }
  assert.throws(() => renderSkill(source, 'other'), /Unknown host/);
  assert.throws(() => renderSkill('no metadata', 'codex'), /Invalid skill metadata/);
});

test('the shared journal fragment expands host tools before insertion into every journal workflow', () => {
  const names = workflowFiles().filter((file) => fs.readFileSync(join(ROOT, 'workflows', file), 'utf8').includes('{{journal_write}}'));
  assert.equal(names.length, 10);
  assert.deepEqual(workflowFragmentFiles(), ['journal-write.md']);
  for (const host of ['claude', 'codex']) {
    const fragments = names.map((file) => {
      const rendered = renderSkill(fs.readFileSync(join(ROOT, 'workflows', file), 'utf8'), host, { name: file.slice(0, -3) });
      const fragment = rendered.match(/Create a private temporary directory with `mktemp -d` and capture its returned[\s\S]*?completed work\./)?.[0];
      assert.ok(fragment, `${host}/${file}`);
      assert.match(fragment, host === 'claude' ? /\*\*Write tool\*\*/ : /\*\*apply_patch tool\*\*/);
      assert.match(fragment, /mode `0700`/);
      assert.match(fragment, /\*\*new\*\* file/);
      assert.doesNotMatch(fragment, /\{\{/);
      return fragment;
    });
    assert.equal(new Set(fragments).size, 1, `${host} journal instructions must be identical`);
  }
});

test('fragment expansion rejects unknown and nested fragments instead of silently shipping tokens', (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'manifest-fragment-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'workflows', 'fragments');
  fs.mkdirSync(directory, { recursive: true });
  const source = '---\nname: probe\ndescription: test\n---\n\n{{journal_write}}';
  fs.writeFileSync(join(directory, 'other.md'), 'plain content');
  for (const token of ['{{unknown}}', '{{other}}', '{{journal_write}}', '{{broken']) {
    fs.writeFileSync(join(directory, 'journal-write.md'), token);
    assert.throws(() => renderSkill(source, 'claude', { root, name: 'probe' }), /Unknown|Unresolved/);
  }
});

test('the Claude generated-file check detects a stale file', (t) => {
  assert.equal(writeClaudeSkills({ check: true }).length, 14);
  const root = fs.mkdtempSync(join(tmpdir(), 'manifest-skill-drift-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(join(ROOT, 'workflows'), join(root, 'workflows'), { recursive: true });
  fs.cpSync(join(ROOT, 'hosts'), join(root, 'hosts'), { recursive: true });
  writeClaudeSkills({ root });
  fs.appendFileSync(join(root, 'skills/balance/SKILL.md'), '\nstale');
  assert.throws(() => writeClaudeSkills({ root, check: true }), /Generated skills are stale.*balance/);
});

test('Codex package is relocatable, complete and isolated from Claude component discovery', (t) => {
  const out = fs.mkdtempSync(join(tmpdir(), 'manifest-package-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const plugin = buildCodex({ out });
  const config = JSON.parse(fs.readFileSync(join(plugin, '.mcp.json'), 'utf8'));
  assert.equal(Object.keys(config.mcpServers).length, 5);
  for (const [server, entry] of Object.entries(config.mcpServers)) {
    assert.equal(entry.cwd, './');
    assert.deepEqual(entry.args, ['./scripts/codex-server.cjs', server.slice(9)]);
    assert.ok(entry.startup_timeout_sec >= 90);
    assert.ok(entry.tool_timeout_sec >= 1800);
    assert.equal(entry.default_tools_approval_mode, 'writes');
    for (const name of ['MANIFEST_CREDENTIAL_STORE', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'SystemRoot']) {
      assert.ok(entry.env_vars.includes(name), `${server} must forward ${name} for credential helpers`);
    }
    assert.doesNotMatch(JSON.stringify(entry), /CLAUDE_|\/home\/|\/tmp\//);
  }
  assert.equal(fs.existsSync(join(plugin, 'hooks')), false);
  assert.equal(fs.existsSync(join(plugin, '.claude-plugin')), false);
  assert.equal(fs.existsSync(join(plugin, 'scripts/session-start.sh')), false);
  assert.deepEqual(fs.readFileSync(join(plugin, 'scripts/_wincred.ps1')), fs.readFileSync(join(ROOT, 'scripts/_wincred.ps1')));
  assert.match(fs.readFileSync(join(plugin, 'README.md'), 'utf8'), /\]\(identity\.md\)/);
  assert.deepEqual(fs.readFileSync(join(plugin, 'identity.md')), fs.readFileSync(join(ROOT, 'docs/identity.md')));
  assert.equal(fs.existsSync(join(plugin, 'node_modules')), false);
  assert.equal(fs.readdirSync(join(plugin, 'skills')).length, 14);
  assert.deepEqual(JSON.parse(fs.readFileSync(join(plugin, 'mcp-policy.json'), 'utf8')), mutationPolicy());
  const scopedMutations = Object.entries(JSON.parse(fs.readFileSync(join(plugin, 'mcp-policy.json'))))
    .flatMap(([server, names]) => names.map((name) => `mcp__manifest-${server}__${name}`)).sort();
  assert.deepEqual(scopedMutations, [
    'mcp__manifest-agent__close_lease_orchestrated',
    'mcp__manifest-agent__deploy_app_orchestrated',
    'mcp__manifest-agent__manage_domain_orchestrated',
    'mcp__manifest-chain__cosmos_tx',
    'mcp__manifest-cosmwasm__convert_mfx_to_pwr',
    'mcp__manifest-fred__deploy_app',
    'mcp__manifest-fred__restart_app',
    'mcp__manifest-fred__restore_app',
    'mcp__manifest-fred__update_app',
    'mcp__manifest-lease__close_lease',
    'mcp__manifest-lease__fund_credit',
    'mcp__manifest-lease__set_item_custom_domain',
  ]);
  assert.equal(JSON.parse(fs.readFileSync(join(plugin, '.codex-plugin/plugin.json'), 'utf8')).version, require('../package.json').version);
  const onboarding = fs.readFileSync(join(plugin, 'skills/init-agent/SKILL.md'), 'utf8');
  assert.doesNotMatch(onboarding, /disable-model-invocation:/);
  assert.match(fs.readFileSync(join(plugin, 'skills/init-agent/agents/openai.yaml'), 'utf8'), /allow_implicit_invocation: false/);
  fs.writeFileSync(join(plugin, 'stale-file'), 'old artifact');
  buildCodex({ out });
  assert.equal(fs.existsSync(join(plugin, 'stale-file')), false);
});

test('all generated skill helpers bootstrap a clean shell after relocating a package with spaces and quotes', (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'manifest-skill-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  buildCodex({ out: join(root, 'original') });
  const relocated = join(root, "relocated package's directory");
  fs.renameSync(join(root, 'original'), relocated);
  const plugin = join(relocated, 'plugins/manifest-agent');
  const data = join(root, 'persistent data');
  for (const name of fs.readdirSync(join(plugin, 'skills'))) {
    const cwd = join(plugin, 'skills', name);
    const result = spawnSync('bash', ['-euc', 'source ./env.sh || exit\nnode -e \'process.stdout.write(JSON.stringify({root:process.env.MANIFEST_PLUGIN_ROOT,data:process.env.MANIFEST_PLUGIN_DATA,cwd:process.cwd(),nodePath:process.env.NODE_PATH,host:process.env.MANIFEST_PLUGIN_HOST}))\''], {
      cwd, env: { PATH: process.env.PATH, MANIFEST_CODEX_DATA: data }, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { root: plugin, data, cwd, nodePath: join(data, 'node_modules'), host: 'codex' });
  }
  const failed = spawnSync('bash', ['-c', 'source ./env.sh || exit\nprintf "must-not-run"'], {
    cwd: join(plugin, 'skills/init-agent'), env: { PATH: process.env.PATH, MANIFEST_CODEX_DATA: 'relative', MANIFEST_PLUGIN_ROOT: '/stale' },
    encoding: 'utf8', timeout: 5000,
  });
  assert.notEqual(failed.status, 0);
  assert.equal(failed.stdout, '');
  assert.match(failed.stderr, /absolute path/);
});

test('workflow discovery, package generation and source hashes ignore non-workflow entries', (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'manifest-workflow-files-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['ci', 'scripts', 'hosts', 'hooks', 'workflows', 'package.json', 'package-lock.json', 'docs/codex.md', 'docs/identity.md',
    'tests/fixtures/native-host-fixture.cjs', 'tests/fixtures/json-rpc-peer.cjs']) {
    fs.mkdirSync(require('node:path').dirname(join(root, name)), { recursive: true });
    fs.cpSync(join(ROOT, name), join(root, name), { recursive: true });
  }
  const original = sourceHashes(root);
  for (const name of ['unrelated', 'directory.md']) fs.mkdirSync(join(root, 'workflows', name));
  fs.writeFileSync(join(root, 'workflows/.DS_Store'), 'ignored');
  fs.mkdirSync(join(root, 'workflows/fragments/directory.md'));
  fs.writeFileSync(join(root, 'workflows/fragments/.DS_Store'), 'ignored');
  assert.equal(workflowFiles(root).length, 14);
  assert.deepEqual(sourceHashes(root), original);
  const plugin = buildCodex({ root, out: join(root, 'dist') });
  assert.equal(fs.readdirSync(join(plugin, 'skills')).length, 14);
});

test('each required Codex policy rewrite rejects missing or duplicated canonical wording', (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'manifest-policy-drift-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(join(root, 'scripts'));
  const path = join(root, 'scripts/session-start.sh');
  const original = fs.readFileSync(join(ROOT, 'scripts/session-start.sh'), 'utf8');
  for (const phrase of ['wait for the user to confirm before calling `cosmos_tx`.', 'then wait for confirmation.',
    'The\n  PreToolUse hook still requests host permission; describe the action and\n  wait for textual confirmation,',
    'then get explicit\n  confirmation before invoking it. PreToolUse also requests host permission.',
    'direct invocation skips all of that and\n  surfaces only the raw PreToolUse permission prompt with no\n  preceding fee or action summary, which violates the runtime policy\n  above.']) {
    assert.ok(original.includes(phrase), phrase);
    for (const changed of [original.replace(phrase, 'Reworded policy.'), original.replace(phrase, phrase + phrase)]) {
      fs.writeFileSync(path, changed);
      assert.throws(() => codexPolicy(root), /Runtime policy wording changed/);
    }
  }
});

test('build rejects a repository ancestor or unowned output directory', (t) => {
  assert.throws(() => buildCodex({ out: ROOT }), /cannot contain the source/);
  const out = fs.mkdtempSync(join(tmpdir(), 'manifest-user-files-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  fs.writeFileSync(join(out, 'user-file'), 'preserve');
  assert.throws(() => buildCodex({ out }), /unowned/);
  assert.equal(fs.readFileSync(join(out, 'user-file'), 'utf8'), 'preserve');
});

test('Codex policy shares the fee and recovery rules while describing its actual host boundary', () => {
  const policy = codexPolicy();
  assert.match(policy, /cosmos_estimate_fee/);
  assert.match(policy, /Gas retry/);
  assert.match(policy, /unknown outcome/);
  assert.match(policy, /native form capability/);
  assert.doesNotMatch(policy, /Claude|PreToolUse|dispatches this hook/);
});
