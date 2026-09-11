'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { renderSkill, mutationPolicy, codexPolicy, writeClaudeSkills, buildCodex } = require('../ci/build-packages.cjs');
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
});

test('generation fails on unknown tokens, tools and cross-skill names instead of asking the model to translate', () => {
  const source = '---\nname: probe\ndescription: test\n---\n\n';
  for (const token of ['{{missing}}', '{{tool:other/tool}}', '{{invoke:missing}}', '{{broken']) {
    assert.throws(() => renderSkill(source + token, 'codex', { name: 'probe' }), /Unknown|Invalid|Unresolved/);
  }
  assert.throws(() => renderSkill(source, 'other'), /Unknown host/);
  assert.throws(() => renderSkill('no metadata', 'codex'), /Invalid skill metadata/);
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
    assert.doesNotMatch(JSON.stringify(entry), /CLAUDE_|\/home\/|\/tmp\//);
  }
  assert.equal(fs.existsSync(join(plugin, 'hooks')), false);
  assert.equal(fs.existsSync(join(plugin, '.claude-plugin')), false);
  assert.equal(fs.existsSync(join(plugin, 'scripts/session-start.sh')), false);
  assert.equal(fs.existsSync(join(plugin, 'node_modules')), false);
  assert.equal(fs.readdirSync(join(plugin, 'skills')).length, 14);
  assert.deepEqual(JSON.parse(fs.readFileSync(join(plugin, 'mcp-policy.json'), 'utf8')), mutationPolicy());
  assert.equal(JSON.parse(fs.readFileSync(join(plugin, '.codex-plugin/plugin.json'), 'utf8')).version, require('../package.json').version);
  const onboarding = fs.readFileSync(join(plugin, 'skills/init-agent/SKILL.md'), 'utf8');
  assert.doesNotMatch(onboarding, /disable-model-invocation:/);
  assert.match(fs.readFileSync(join(plugin, 'skills/init-agent/agents/openai.yaml'), 'utf8'), /allow_implicit_invocation: false/);
  fs.writeFileSync(join(plugin, 'stale-file'), 'old artifact');
  buildCodex({ out });
  assert.equal(fs.existsSync(join(plugin, 'stale-file')), false);
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
