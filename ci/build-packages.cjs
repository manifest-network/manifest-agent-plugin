#!/usr/bin/env node
'use strict';

// Maintained domain instructions live in workflows/. Resolve host vocabulary
// here, not at execution time. The Claude checkout remains installable; the
// Codex package has its own root to avoid automatic Claude hook discovery.
const fs = require('node:fs');
const { join, resolve, relative, isAbsolute } = require('node:path');

const ROOT = resolve(__dirname, '..');
const SERVERS = ['chain', 'lease', 'fred', 'cosmwasm', 'agent'];
const CODEX_SETUP = `## Codex environment

In **each** exec_command call, use Bash and set workdir to the directory
containing this SKILL.md, using its installed path supplied by Codex. Start
the shell command by sourcing the helper beside this file:

\`\`\`bash
source ./env.sh || exit
\`\`\`

The helper resolves MANIFEST_PLUGIN_ROOT, the data directory and NODE_PATH
without a lifecycle hook or pre-existing environment variables. If sourcing
fails, report the error and stop that command; do not continue with stale paths.
Use its returned paths; do not read config.json to discover the wallet.
SKILL_INPUT means the text or path supplied with this skill invocation; it is
not an environment variable. For choices, use request_user_input when available;
otherwise ask a concise question in chat and wait before the dependent action.
Use exec_command to read files and apply_patch to write JSON as literal data.
Never put untrusted catalog, result or secret content into shell source.
Read [the runtime policy](../../references/runtime-policy.md) before using MCP.
Only interactive hosts that can present native MCP form elicitation support
mutations. If a tool is unavailable, report it; do not call a similarly named
tool from another plugin or bypass the native confirmation.

`;

function workflowFiles(root = ROOT) {
  return fs.readdirSync(join(root, 'workflows'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md')).map((entry) => entry.name).sort();
}

function workflowFragmentFiles(root = ROOT) {
  const directory = join(root, 'workflows', 'fragments');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md')).map((entry) => entry.name).sort();
}

function renderSkill(source, host, { root = ROOT, name } = {}) {
  if (!['claude', 'codex'].includes(host)) throw new Error(`Unknown host: ${host}`);
  const knownSkills = new Set(workflowFiles(root).map((file) => file.slice(0, -3)));
  const values = {
    host: host === 'claude' ? 'Claude Code' : 'Codex',
    ask: host === 'claude' ? 'AskUserQuestion' : 'request_user_input',
    arguments: host === 'claude' ? '$ARGUMENTS' : 'SKILL_INPUT',
    read_tool: host === 'claude' ? 'Read' : 'exec_command',
    write_tool: host === 'claude' ? 'Write' : 'apply_patch',
    shell_tool: host === 'claude' ? 'Bash' : 'exec_command',
    tool_prefix: host === 'claude' ? 'mcp__plugin_manifest-agent_manifest-*' : 'mcp__manifest-*',
    environment_recovery: host === 'claude'
      ? 'tell the user to restart Claude Code so the SessionStart hook runs, then stop'
      : 'source ./env.sh from this skill\'s installed directory as described above; if it fails, report the error and stop (reinstall the plugin if the helper is missing)',
    tool_event: host === 'claude' ? 'PreToolUse' : 'host tool',
    outer_permission: host === 'claude'
      ? 'Claude Code evaluates the PreToolUse hook before this outer invocation starts. A denied call does not reach the MCP server.'
      : 'Codex applies its configured tool approval policy to the outer invocation. The adapter refuses mutations without native MCP form elicitation; the orchestrator owns the action and recovery prompts.',
    direct_permission: host === 'claude'
      ? 'The PreToolUse hook requests host permission before execution. Step 4 supplies the action recap; the hook cannot verify that prose or the user\'s response.'
      : 'Codex applies its tool approval policy before execution. The adapter requests native MCP form confirmation for this direct mutation and forwards it only after acceptance. Decline, cancellation, timeout or missing form support stops before the provider call.',
    restart_confirmation: name === 'restart-app' ? fs.readFileSync(join(root, 'hosts', host, 'restart-confirmation.md'), 'utf8').trimEnd() : '',
  };
  const replaceToken = (_, token) => {
    if (token.startsWith('tool:')) {
      const [, server, tool] = /^tool:([a-z]+)\/([a-z_]+)$/.exec(token) || [];
      if (!SERVERS.includes(server) || !tool) throw new Error(`Invalid tool token: ${token}`);
      return host === 'claude' ? `mcp__plugin_manifest-agent_manifest-${server}__${tool}` : `mcp__manifest-${server}__${tool}`;
    }
    if (token.startsWith('invoke:')) {
      const skill = token.slice(7);
      if (!knownSkills.has(skill)) throw new Error(`Unknown skill invocation: ${skill}`);
      return `${host === 'claude' ? '/' : '$'}manifest-agent:${skill}`;
    }
    if (!(token in values)) throw new Error(`Unknown workflow token: ${token}`);
    return values[token];
  };
  // Fragments may use host vocabulary, but cannot include other fragments.
  // Render them first: String.replace does not expand tokens in replacements.
  const fragments = Object.fromEntries(workflowFragmentFiles(root).map((file) => {
    const fragment = fs.readFileSync(join(root, 'workflows', 'fragments', file), 'utf8').trimEnd();
    const rendered = fragment.replace(/\{\{([^{}]+)\}\}/g, replaceToken);
    if (/\{\{|\}\}/.test(rendered)) throw new Error(`Unresolved fragment template token: ${file}`);
    return [file.slice(0, -3).replaceAll('-', '_'), rendered];
  }));
  for (const [token, fragment] of Object.entries(fragments)) {
    if (token in values) throw new Error(`Duplicate workflow token: ${token}`);
    values[token] = fragment;
  }
  let rendered = source.replace(/\{\{([^{}]+)\}\}/g, replaceToken);
  if (/\{\{|\}\}/.test(rendered)) throw new Error('Unresolved workflow template token.');
  if (host === 'codex') {
    rendered = rendered.replace(/^allowed-tools:.*\n/gm, '');
    rendered = rendered.replace(/^disable-model-invocation:.*\n/gm, '');
    // Names below are local file tools, not domain logic.
    rendered = rendered.replace(/\bBash\b/g, 'exec_command');
    rendered = rendered.replace(/\bWrite tool\b/g, 'apply_patch tool');
    rendered = rendered.replace(/SessionStart hook/g, 'environment adapter');
    rendered = rendered.replace(/scripts\/session-start\.sh/g, 'references/runtime-policy.md');
    rendered = rendered.replace(/PreToolUse permission prompt/g, 'native confirmation prompt');
    rendered = rendered.replace(/The PreToolUse hook still requests host permission/g, 'The Codex adapter requests native form confirmation');
    rendered = rendered.replace(/textual confirmation/g, 'native confirmation');
  }
  const frontmatter = /^---\n([\s\S]*?)\n---\n\n/.exec(rendered);
  if (!frontmatter || !/^name: [a-z0-9-]+$/m.test(frontmatter[1]) || !/^description:/m.test(frontmatter[1])) {
    throw new Error(`Invalid skill metadata: ${name}`);
  }
  if (name && /^name: ([a-z0-9-]+)$/m.exec(frontmatter[1])[1] !== name) throw new Error(`Invalid skill metadata name: ${name}`);
  const banner = `<!-- Generated from workflows/${name}.md by ci/build-packages.cjs. -->\n\n`;
  return rendered.slice(0, frontmatter[0].length) + banner + (host === 'codex' ? CODEX_SETUP : '') + rendered.slice(frontmatter[0].length);
}

function mutationPolicy(root = ROOT) {
  const { matcherNames } = require('./mcp-tool-policy.cjs');
  const names = matcherNames(JSON.parse(fs.readFileSync(join(root, 'hooks/hooks.json'), 'utf8')));
  const policy = Object.fromEntries(SERVERS.map((name) => [name, []]));
  for (const name of names) {
    const match = /^mcp__plugin_manifest-agent_manifest-([a-z]+)__([a-z_]+)$/.exec(name);
    if (!match || !policy[match[1]]) throw new Error(`Unknown mutation identity: ${name}`);
    policy[match[1]].push(match[2]);
  }
  for (const names of Object.values(policy)) names.sort();
  return policy;
}

function codexPolicy(root = ROOT) {
  const shell = fs.readFileSync(join(root, 'scripts/session-start.sh'), 'utf8');
  const policy = /cat <<'POLICY'\n([\s\S]*?)\nPOLICY/.exec(shell)?.[1];
  if (!policy) throw new Error('Missing canonical transaction policy.');
  // The shared safety/domain policy remains sourced from the Claude runtime
  // policy. Host-hook paragraphs are replaced at this boundary explicitly.
  const start = policy.indexOf('- For a mutating operation, the PreToolUse hook');
  const end = policy.indexOf('- The server requests confirmation', start);
  const hookSection = policy.indexOf('## ', policy.indexOf('## ') + 3);
  if (start < 0 || end < 0 || hookSection < 0) throw new Error('Runtime policy structure changed; review the Codex adapter.');
  let result = policy.slice(0, start)
    + '- Codex applies its tool approval policy to the outer call. The adapter\n  requires native form elicitation for mutations before forwarding them.\n'
    + policy.slice(end);
  // The concluding section is specifically a Claude host characterization.
  const footer = result.indexOf('## Enforcement note');
  if (footer < 0) throw new Error('Runtime policy enforcement section changed; review the Codex adapter.');
  result = result.slice(0, footer) + `## Codex confirmation boundary

The shipped MCP configuration uses the host's writes approval policy. The
adapter separately checks native form capability before forwarding any
reviewed mutation. Direct mutations request a native form; orchestrated
mutations retain upstream plan, mainnet and recovery elicitations. Decline,
cancel, missing form support and confirmation timeout never authorize a write.
After a call has started, cancellation or a transport loss can leave a paid
partial or unknown outcome. Preserve lease/transaction identifiers and query
the existing lease before proposing a retry. The adapter forwards progress
and cancellation; it does not roll back chain or provider operations.

Read-only tools and the testnet faucet do not require adapter confirmation.
Noninteractive clients may decline prompts automatically. Never substitute
a model-written answer for the user or fall back to a direct mutation when
native confirmation fails.
`;
  result = result.replace(/mcp__plugin_manifest-agent_manifest-/g, 'mcp__manifest-');
  result = result.replace(/Claude Code/g, 'Codex').replace(/PreToolUse hooks?/g, 'host tool approvals').replace(/PreToolUse/g, 'host tool approval');
  result = result.replace(/textual confirmation/g, 'native confirmation').replace(/textual-confirm/g, 'native-confirm');
  const replaceRequired = (before, after, expected = 1) => {
    const count = result.split(before).length - 1;
    if (count !== expected) throw new Error(`Runtime policy wording changed (${count}/${expected} matches for ${JSON.stringify(before)}); review the Codex adapter.`);
    result = result.replaceAll(before, after);
  };
  replaceRequired('wait for the user to confirm before calling `cosmos_tx`.',
    'invoke `cosmos_tx` to request native form confirmation.');
  replaceRequired('then wait for confirmation.', 'then invoke the tool for native form confirmation.', 2);
  replaceRequired('The\n  host tool approvals still requests host permission; describe the action and\n  wait for native confirmation,',
    'Describe the action, then invoke the tool\n  to request the adapter\'s native form confirmation,');
  replaceRequired('then get explicit\n  confirmation before invoking it. host tool approval also requests host permission.',
    'then invoke it to request\n  native form confirmation from the Codex adapter.');
  replaceRequired('direct invocation skips all of that and\n  surfaces only the raw host tool approval permission prompt with no\n  preceding fee or action summary, which violates the runtime policy\n  above.',
    'direct invocation requires a separate action/fee recap before\n  invoking the tool for the adapter\'s native form confirmation.');
  return 'Consumers: all Codex skills and the Codex MCP adapter. Variables in scope:\nMANIFEST_PLUGIN_ROOT and MANIFEST_PLUGIN_DATA from host-env.cjs.\n\n' + result.trimEnd() + '\n';
}

function writeClaudeSkills({ root = ROOT, check = false } = {}) {
  const files = workflowFiles(root);
  const failures = [];
  for (const file of files) {
    const name = file.slice(0, -3);
    const output = renderSkill(fs.readFileSync(join(root, 'workflows', file), 'utf8'), 'claude', { root, name });
    const target = join(root, 'skills', name, 'SKILL.md');
    if (check) {
      if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== output) failures.push(target);
    } else {
      fs.mkdirSync(join(root, 'skills', name), { recursive: true });
      fs.writeFileSync(target, output);
    }
  }
  if (failures.length) throw new Error(`Generated skills are stale: ${failures.join(', ')}. Run npm run build:skills.`);
  return files;
}

function buildCodex({ root = ROOT, out = join(root, 'dist', 'codex') } = {}) {
  const target = resolve(out);
  const relation = relative(target, root);
  if (relation === '' || (!relation.startsWith('..') && !isAbsolute(relation))) throw new Error('Build output cannot contain the source repository.');
  const marker = join(target, '.manifest-build.json');
  if (fs.existsSync(target)) {
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error('Build output must not be a symlink.');
    if (fs.readdirSync(target).length) {
      if (!fs.existsSync(marker) || JSON.parse(fs.readFileSync(marker, 'utf8')).kind !== 'manifest-codex-build') throw new Error('Refusing to overwrite an unowned build directory.');
      // This tree is explicitly generated output, never plugin runtime data.
      fs.rmSync(target, { recursive: true });
    }
  }
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ kind: 'manifest-codex-build', schema: 1 }) + '\n');
  const plugin = join(target, 'plugins', 'manifest-agent');
  fs.mkdirSync(plugin, { recursive: true });
  for (const entry of ['.codex-plugin', '.mcp.json']) fs.cpSync(join(root, 'hosts/codex/manifest-agent', entry), join(plugin, entry), { recursive: true });
  for (const file of ['package.json', 'package-lock.json']) fs.copyFileSync(join(root, file), join(plugin, file));
  fs.copyFileSync(join(root, 'docs/codex.md'), join(plugin, 'README.md'));
  fs.copyFileSync(join(root, 'docs/identity.md'), join(plugin, 'identity.md'));
  fs.mkdirSync(join(plugin, 'scripts'), { recursive: true });
  for (const script of fs.readdirSync(join(root, 'scripts')).filter((name) => /\.(cjs|ps1)$/.test(name) && name !== 'pre-tool-use.cjs')) {
    fs.copyFileSync(join(root, 'scripts', script), join(plugin, 'scripts', script));
  }
  fs.writeFileSync(join(plugin, 'mcp-policy.json'), JSON.stringify(mutationPolicy(root), null, 2) + '\n');
  fs.mkdirSync(join(plugin, 'references'), { recursive: true });
  fs.writeFileSync(join(plugin, 'references/runtime-policy.md'), codexPolicy(root));
  for (const file of workflowFiles(root)) {
    const name = file.slice(0, -3);
    fs.mkdirSync(join(plugin, 'skills', name), { recursive: true });
    const source = fs.readFileSync(join(root, 'workflows', file), 'utf8');
    fs.writeFileSync(join(plugin, 'skills', name, 'SKILL.md'), renderSkill(source, 'codex', { root, name }));
    fs.copyFileSync(join(root, 'hosts/codex/env.sh'), join(plugin, 'skills', name, 'env.sh'));
    if (/^disable-model-invocation: true$/m.test(source)) {
      fs.mkdirSync(join(plugin, 'skills', name, 'agents'), { recursive: true });
      const display = name.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join(' ');
      fs.writeFileSync(join(plugin, 'skills', name, 'agents/openai.yaml'),
        `interface:\n  display_name: ${JSON.stringify(display)}\n  short_description: ${JSON.stringify(`Manifest ${name} workflow for Codex.`)}\npolicy:\n  allow_implicit_invocation: false\n`);
    }
  }
  const catalog = { name: 'manifest', interface: { displayName: 'Manifest' }, plugins: [{ name: 'manifest-agent',
    source: { source: 'local', path: './plugins/manifest-agent' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity',
  }] };
  fs.mkdirSync(join(target, '.agents/plugins'), { recursive: true });
  fs.writeFileSync(join(target, '.agents/plugins/marketplace.json'), JSON.stringify(catalog, null, 2) + '\n');
  return plugin;
}

function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && ['--check', '--write-skills'].includes(argv[0])) {
    const files = writeClaudeSkills({ check: argv[0] === '--check' });
    console.log(`shared skills: ${files.length} ${argv[0] === '--check' ? 'verified' : 'generated'}`);
  } else if (argv.length === 0 || (argv.length === 2 && argv[0] === '--out')) {
    writeClaudeSkills({ check: true });
    console.log(`Codex package: ${buildCodex({ out: argv[1] || join(ROOT, 'dist/codex') })}`);
  } else throw new Error('Usage: node ci/build-packages.cjs [--check|--write-skills|--out <directory>]');
}
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { renderSkill, mutationPolicy, codexPolicy, writeClaudeSkills, buildCodex, workflowFiles, workflowFragmentFiles };
