#!/usr/bin/env node
'use strict';

// Bind current Claude-host evidence to the checked-out source. Historical
// terminal runs describe their recorded commit, never the current workspace.
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const { readdirSync, readFileSync, existsSync } = require('node:fs');
const { join, resolve, isAbsolute } = require('node:path');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');

const SOURCE_FILES = [
  'hooks/hooks.json',
  'scripts/pre-tool-use.cjs',
  'scripts/pre-tool-use.sh',
  'ci/claude-hook-smoke.cjs',
  'tests/fixtures/claude-host-mcp.cjs',
];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const DIRECT = 'mcp__plugin_manifest-agent_manifest-chain__cosmos_tx';
const OUTER = 'mcp__plugin_manifest-agent_manifest-agent__deploy_app_orchestrated';
// The committed current report is the complete 14-case run. These expectations
// mirror CASES and the summary assertions in claude-hook-smoke.cjs, including
// its deliberately failing-boundary negative controls. Never infer success
// solely from passed:true, or count a partial --case run as the complete run.
const HOST_CASES = [
  { name: 'bare-name-misses', mutations: 1 },
  { name: 'scoped-deny', mutations: 0, tool: DIRECT, decision: 'deny' },
  { name: 'polluted-deny-drops-decision', mutations: 1, tool: DIRECT, decision: 'deny' },
  { name: 'inner-only-misses-outer', mutations: 1 },
  { name: 'scoped-outer-deny', mutations: 0, tool: OUTER, decision: 'deny' },
  { name: 'project-direct-ask', mutations: 0, tool: DIRECT, decision: 'ask' },
  { name: 'project-stdout-pollution', mutations: 0, tool: DIRECT, decision: 'deny' },
  { name: 'project-direct-ask-bypass', mutations: 0, tool: DIRECT, decision: 'ask', mode: 'bypassPermissions' },
  { name: 'scoped-deny-bypass', mutations: 0, tool: DIRECT, decision: 'deny', mode: 'bypassPermissions' },
  { name: 'project-outer-ask', mutations: 0, tool: OUTER, decision: 'ask' },
  { name: 'project-lookup', mutations: 0, reads: 1 },
  { name: 'elicitation-decline', mutations: 0, tool: OUTER, decision: 'ask', elicitation: true },
  { name: 'elicitation-cancel', mutations: 0, tool: OUTER, decision: 'ask', elicitation: true },
  { name: 'elicitation-accept', mutations: 1, tool: OUTER, decision: 'ask', elicitation: true },
];
const TERMINAL_CASES = ['outer-permission-deny', 'elicitation-cancel', 'elicitation-decline', 'elicitation-accept'];
const hookEvent = (tool, decision) => ({ kind: 'hook', event: 'PreToolUse', tool, decision });

function expectValue(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`${label} does not match the expected recorded outcome.`);
}

function caseRecords(value, names, label) {
  if (!Array.isArray(value) || value.length !== names.length
      || value.some((item) => !item || typeof item.name !== 'string')
      || !isDeepStrictEqual(value.map((item) => item.name).sort(), [...names].sort())) {
    throw new Error(`${label} must contain exactly the ${names.length} expected named cases, without omissions or duplicates.`);
  }
  return new Map(value.map((item) => [item.name, item]));
}

function validateObservations(record) {
  for (const field of ['date', 'claudeVersion', 'scope']) {
    if (typeof record[field] !== 'string' || !record[field].trim()) {
      throw new Error(`Evidence requires its recorded ${field}.`);
    }
  }
  if (record.source_status === 'current') {
    const results = caseRecords(record.results, HOST_CASES.map(({ name }) => name), 'Current results');
    for (const expected of HOST_CASES) {
      const result = results.get(expected.name);
      const fields = { passed: true, exitCode: 0, timedOut: false, apiCalls: 2,
        permissionMode: expected.mode || 'manual', mutations: expected.mutations, reads: expected.reads || 0,
        hooks: expected.decision ? [hookEvent(expected.tool, expected.decision)] : [],
        controlEvents: expected.elicitation ? [
          { subtype: 'can_use_tool', tool: OUTER },
          { subtype: 'elicitation', server: 'plugin:manifest-agent:manifest-agent' },
        ] : [],
      };
      for (const [field, value] of Object.entries(fields)) expectValue(result[field], value, `${expected.name}.${field}`);
      // The summary records the ordered control requests and marker counts.
      // It does not retain elicitation_result actions; do not invent those.
    }
  } else {
    const cases = caseRecords(record.cases, TERMINAL_CASES, 'Historical terminal cases');
    expectValue(record.permissionMode, 'manual', 'Historical permissionMode');
    expectValue(record.toolPreallowed, true, 'Historical toolPreallowed');
    expectValue(record.tool, OUTER, 'Historical tool');
    for (const [name, result] of cases) {
      const denied = name === 'outer-permission-deny';
      const accepted = name === 'elicitation-accept';
      const sequence = [hookEvent(OUTER, 'ask')];
      if (!denied) sequence.push(
        { kind: 'mcp_request', server: 'agent', method: 'tools/call', tool: 'deploy_app_orchestrated' },
        { kind: 'elicitation_request' },
        { kind: 'elicitation_result', action: name.slice('elicitation-'.length) },
      );
      if (accepted) sequence.push({ kind: 'internal_mutation_marker', server: 'agent', tool: 'deploy_app_orchestrated' });
      expectValue(result.sequence, sequence, `${name}.sequence`);
      expectValue(result.toolCalls, denied ? 0 : 1, `${name}.toolCalls`);
      expectValue(result.mutationMarkers, accepted ? 1 : 0, `${name}.mutationMarkers`);
      expectValue(result.beforeOuterPermissionAnswer, { toolCalls: 0, mutationMarkers: 0 }, `${name}.beforeOuterPermissionAnswer`);
      if (!denied) expectValue(result.atNativeElicitationBeforeAnswer, { toolCalls: 1, mutationMarkers: 0 }, `${name}.atNativeElicitationBeforeAnswer`);
      if (!Array.isArray(result.keys) || result.keys.length === 0
          || result.keys.some((key) => typeof key !== 'string' || !key.trim())) {
        throw new Error(`${name}.keys must retain the recorded terminal input.`);
      }
    }
  }
}

function readHistoricalSources(root, commit, files = SOURCE_FILES) {
  // Source blobs use one binary-safe batch, with no implicit network fetch. Commits may
  // need an explicit fetch after the source PR was squash-merged.
  assert.match(commit, /^[a-f0-9]{40}$/);
  if (typeof files === 'function') {
    // Resolve globbed scope from this commit, independently of both the
    // report's hash keys and files added or removed in today's workspace.
    if (!readHistoricalSources(root, commit, [])) return null;
    const tree = spawnSync('git', ['-C', root, 'ls-tree', '-r', '-z', '--full-tree', commit], {
      encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024,
    });
    if (tree.error || tree.status !== 0) throw new Error('Cannot inspect historical source tree with git ls-tree.');
    files = files(tree.stdout.split('\0').filter(Boolean).map((entry) => {
      const tab = entry.indexOf('\t');
      assert.ok(tab > 0, 'Invalid git tree entry');
      const [mode, type] = entry.slice(0, tab).split(' ');
      return { path: entry.slice(tab + 1), mode, type };
    }));
  }
  assert.ok(files.every(safeSourcePath), 'Invalid historical source path');
  const result = spawnSync('git', ['-C', root, 'cat-file', '--batch'], {
    input: [commit, ...files.map((file) => `${commit}:${file}`)].join('\n') + '\n',
    timeout: 10000, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error('Cannot inspect historical source with git cat-file.');
  let offset = 0;
  const next = () => {
    const end = result.stdout.indexOf(10, offset);
    assert.ok(end >= offset, 'Truncated git object header');
    const header = result.stdout.subarray(offset, end).toString('utf8');
    offset = end + 1;
    if (header.endsWith(' missing')) return null;
    const match = /^[a-f0-9]+ (commit|blob|tree|tag) (\d+)$/.exec(header);
    assert.ok(match, 'Invalid git object header');
    const size = Number(match[2]), bytes = result.stdout.subarray(offset, offset + size);
    assert.ok(bytes.length === size && result.stdout[offset + size] === 10, 'Truncated git object');
    offset += size + 1;
    return { type: match[1], bytes };
  };
  const head = next();
  if (!head) return null;
  assert.equal(head.type, 'commit', 'Historical head must identify a commit.');
  const sources = Object.fromEntries(files.map((file) => {
    const source = next();
    assert.ok(source?.type === 'blob', `Cannot read historical source ${commit}:${file}.`);
    return [file, source.bytes];
  }));
  assert.equal(offset, result.stdout.length, 'Unexpected trailing git objects');
  return sources;
}

const safeSourcePath = (file) => typeof file === 'string' && /^[a-zA-Z0-9_./-]+$/.test(file)
  && !isAbsolute(file) && !file.split('/').includes('..');

function hostSourceFiles(tree, { terminal = false } = {}) {
  // The schema 1 app-server / schema 1-2 terminal inventory rules match the
  // original emitters. A parity test protects this contract as emitters evolve.
  const workflows = tree.filter((e) => ['100644', '100755'].includes(e.mode) && /^workflows\/[^/]+\.md$/.test(e.path))
    .map((e) => e.path);
  const files = ['ci/build-packages.cjs', 'ci/codex-host-smoke.cjs', 'tests/fixtures/native-host-fixture.cjs', 'tests/fixtures/json-rpc-peer.cjs',
    'hosts/codex/manifest-agent/.mcp.json', 'hosts/codex/manifest-agent/.codex-plugin/plugin.json',
    ...tree.filter((e) => /^scripts\/[^/]+\.(cjs|ps1)$/.test(e.path)).map((e) => e.path),
    'scripts/session-start.sh', 'scripts/pre-tool-use.sh', 'hooks/hooks.json', 'package.json', 'package-lock.json', 'docs/codex.md',
    ...workflows, 'hosts/codex/env.sh', 'hosts/codex/restart-confirmation.md', 'hosts/claude/restart-confirmation.md'];
  if (terminal) files.push('ci/terminal-host-smoke.cjs', 'tests/fixtures/terminal-model.cjs', '.mcp.json', '.claude-plugin/plugin.json',
    ...workflows.map((file) => `skills/${file.slice(10, -3)}/SKILL.md`));
  return files.sort();
}

function verifyProvenance(record, { root, files, currentHashes, requireCurrent = false,
  requireHistory = false, historicalScope, historicalSources = readHistoricalSources, upstreamField = 'upstreamPin' }) {
  assert.ok(record && ['current', 'historical'].includes(record.source_status), 'source_status must explicitly be current or historical.');
  if (requireCurrent) assert.equal(record.source_status, 'current', 'Fresh current evidence is required');
  const hashes = record.sourceHashes;
  assert.ok(hashes && typeof hashes === 'object' && !Array.isArray(hashes), 'Missing source hashes');
  assert.ok(Object.keys(hashes).every(safeSourcePath), 'Invalid source path');
  assert.ok(Object.values(hashes).every((hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)), 'Source hashes must be lowercase SHA-256');
  if (record.sourceFiles !== undefined) {
    assert.ok(Array.isArray(record.sourceFiles), 'sourceFiles must be an array');
    assert.deepEqual([...record.sourceFiles].sort(), Object.keys(hashes).sort(), 'sourceFiles must agree with source hashes without omissions or duplicates');
  }
  const checkScope = () => assert.deepEqual(Object.keys(hashes).sort(), [...files].sort(), 'Source hashes must cover exactly the expected files');
  let sources, verification;
  if (record.source_status === 'current') {
    checkScope();
    const expected = currentHashes || Object.fromEntries(files.map((file) => [file, sha256(readFileSync(join(root, file)))]));
    for (const file of files) assert.equal(hashes[file], expected[file], `Current evidence is stale for ${file}`);
    verification = 'workspace';
  } else {
    assert.match(record.head || '', /^[a-f0-9]{40}$/, 'Historical evidence needs its full recorded commit in head');
    sources = historicalSources(root, record.head, historicalScope || files);
    if (requireHistory) assert.ok(sources, `Historical source commit unavailable: ${record.head}; fetch it before strict validation`);
    verification = sources ? 'commit' : 'metadata-only';
    if (historicalScope) files = sources ? Object.keys(sources) : [];
    // Without history a dynamic inventory cannot be verified. Such reports
    // remain explicitly metadata-only and cannot satisfy CI/release checks.
    if (sources || !historicalScope) checkScope();
    if (sources) for (const file of files) assert.equal(sha256(sources[file]), hashes[file], `Historical source differs from recorded commit ${record.head}: ${file}`);
  }
  let pkg;
  if (files.includes('package.json') && verification !== 'metadata-only') {
    pkg = JSON.parse(sources ? sources['package.json'] : readFileSync(join(root, 'package.json')));
    assert.equal(record.pluginVersion, pkg.version, 'Evidence plugin version differs from its source');
    assert.equal(record[upstreamField], pkg.dependencies['@manifest-network/manifest-mcp-node'], 'Evidence upstream version differs from its source');
  }
  return { status: record.source_status, verification, pkg };
}

function fetchEvidenceHistory(root, run = spawnSync) {
  const heads = new Set();
  for (const dir of ['docs/evidence', 'docs/host-evidence']) {
    if (!existsSync(join(root, dir))) continue;
    for (const file of readdirSync(join(root, dir)).filter((name) => name.endsWith('.json'))) {
      const record = JSON.parse(readFileSync(join(root, dir, file)));
      if (record.source_status !== 'historical') continue;
      assert.match(record.head || '', /^[a-f0-9]{40}$/, `Missing historical head: ${dir}/${file}`);
      heads.add(record.head);
    }
  }
  for (const head of heads) {
    const options = { encoding: 'utf8', timeout: 30000 };
    const probe = run('git', ['-C', root, 'cat-file', '-e', `${head}^{commit}`], options);
    if (probe.error) throw probe.error;
    if (probe.status === 0) continue;
    const fetch = run('git', ['-C', root, 'fetch', '--no-tags', 'origin', head], options);
    if (fetch.error || fetch.status !== 0) throw new Error(`Cannot fetch recorded source commit ${head}`);
  }
  return heads.size;
}

function checkEvidence(root, { requireHistory = false, historicalSources = readHistoricalSources } = {}) {
  const records = [];
  const failures = [];
  let filenames;
  try { filenames = readdirSync(join(root, 'docs/evidence')).filter((name) => name.endsWith('.json')).sort(); }
  catch (error) { return { records, failures: [`Cannot read docs/evidence: ${error.message}`] }; }
  let currentCount = 0;
  for (const filename of filenames) {
    try {
      const record = JSON.parse(readFileSync(join(root, 'docs/evidence', filename), 'utf8'));
      const result = verifyProvenance({ ...record, sourceHashes: record.files_sha256 }, {
        root, files: SOURCE_FILES, requireHistory, historicalSources,
      });
      validateObservations(record);
      if (record.source_status === 'current') {
        currentCount++;
        records.push({ filename, status: 'current', verification: result.verification });
      } else {
        const workspaceDrift = SOURCE_FILES.filter((file) => {
          try { return sha256(readFileSync(join(root, file))) !== record.files_sha256[file]; }
          catch { return true; }
        });
        records.push({ filename, status: 'historical', head: record.head,
          verification: result.verification, workspaceDrift });
      }
    } catch (error) { failures.push(`${filename}: ${error.message}`); }
  }
  if (currentCount === 0) failures.push('At least one current Claude-host evidence record is required.');
  return { records, failures };
}

if (require.main === module) {
  try {
    if (process.argv.slice(2).some((arg) => !['--require-history', '--fetch-history'].includes(arg))) {
      throw new Error('Usage: node ci/evidence-check.cjs [--require-history] [--fetch-history]');
    }
    if (process.argv.includes('--fetch-history')) fetchEvidenceHistory(resolve(__dirname, '..'));
    const result = checkEvidence(resolve(__dirname, '..'), { requireHistory: process.argv.includes('--require-history') });
    for (const record of result.records) {
      if (record.status === 'current') console.log(`evidence-check: ${record.filename}: current source hashes match`);
      else console.log(`evidence-check: ${record.filename}: historical ${record.head}; ${record.verification === 'commit'
        ? 'hashes match recorded commit'
        : 'metadata only; source commit unavailable locally, historical bytes NOT verified'}; ${record.workspaceDrift.length}/${SOURCE_FILES.length} source files differ from workspace (expected historical drift)`);
    }
    for (const failure of result.failures) console.error(`evidence-check: ${failure}`);
    if (result.failures.length) process.exitCode = 1;
  } catch (error) {
    console.error(`evidence-check: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { SOURCE_FILES, sha256, readHistoricalSources, hostSourceFiles, verifyProvenance, fetchEvidenceHistory, checkEvidence };
