#!/usr/bin/env node
'use strict';

// Bind current Claude-host evidence to the checked-out source. Historical
// terminal runs describe their recorded commit, never the current workspace.
const { createHash } = require('node:crypto');
const { readdirSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
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

function readHistoricalSources(root, commit) {
  // Squashed PR source commits need not exist in a shallow checkout, or even
  // in main's full ancestry. No network fetch is hidden inside this check.
  const options = { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 };
  const probe = spawnSync('git', ['-C', root, 'cat-file', '-t', commit], options);
  if (probe.error) throw new Error(`Cannot inspect historical source: ${probe.error.message}`);
  if (probe.status !== 0) return null;
  if (probe.stdout.trim() !== 'commit') throw new Error('Historical head must identify a commit.');
  return Object.fromEntries(SOURCE_FILES.map((file) => {
    const source = spawnSync('git', ['-C', root, 'show', `${commit}:${file}`], {
      ...options, encoding: null,
    });
    if (source.error || source.status !== 0) throw new Error(`Cannot read historical source ${commit}:${file}.`);
    return [file, source.stdout];
  }));
}

function validateMetadata(record) {
  if (!record || !['current', 'historical'].includes(record.source_status)) {
    throw new Error('source_status must explicitly be current or historical.');
  }
  const hashes = record.files_sha256;
  if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes)
      || JSON.stringify(Object.keys(hashes).sort()) !== JSON.stringify([...SOURCE_FILES].sort())) {
    throw new Error('files_sha256 must cover exactly the five hook and Claude fixture source files.');
  }
  if (Object.values(hashes).some((hash) => typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash))) {
    throw new Error('files_sha256 values must be lowercase SHA-256 hashes.');
  }
  if (record.sourceFiles !== undefined && (!Array.isArray(record.sourceFiles)
      || JSON.stringify([...record.sourceFiles].sort()) !== JSON.stringify([...SOURCE_FILES].sort()))) {
    throw new Error('sourceFiles must agree with files_sha256 without omissions or duplicates.');
  }
  if (record.source_status === 'historical' && !/^[0-9a-f]{40}$/.test(record.head || '')) {
    throw new Error('Historical evidence requires its full recorded head commit.');
  }
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
      validateMetadata(record);
      validateObservations(record);
      if (record.source_status === 'current') {
        currentCount++;
        for (const file of SOURCE_FILES) {
          if (sha256(readFileSync(join(root, file))) !== record.files_sha256[file]) {
            throw new Error(`Current evidence is stale for ${file}; rerun the host checks before replacing its hashes.`);
          }
        }
        records.push({ filename, status: 'current', verification: 'workspace' });
      } else {
        const source = historicalSources(root, record.head);
        if (source === null && requireHistory) {
          throw new Error(`Historical source commit ${record.head} is unavailable; fetch it before --require-history validation.`);
        }
        if (source !== null) {
          for (const file of SOURCE_FILES) {
            if (sha256(source[file]) !== record.files_sha256[file]) {
              throw new Error(`Historical hash differs from recorded commit ${record.head}: ${file}.`);
            }
          }
        }
        const workspaceDrift = SOURCE_FILES.filter((file) => {
          try { return sha256(readFileSync(join(root, file))) !== record.files_sha256[file]; }
          catch { return true; }
        });
        records.push({ filename, status: 'historical', head: record.head,
          verification: source === null ? 'metadata-only' : 'commit', workspaceDrift });
      }
    } catch (error) { failures.push(`${filename}: ${error.message}`); }
  }
  if (currentCount === 0) failures.push('At least one current Claude-host evidence record is required.');
  return { records, failures };
}

if (require.main === module) {
  try {
    if (process.argv.slice(2).some((arg) => arg !== '--require-history')) {
      throw new Error('Usage: node ci/evidence-check.cjs [--require-history]');
    }
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

module.exports = { SOURCE_FILES, sha256, readHistoricalSources, checkEvidence };
