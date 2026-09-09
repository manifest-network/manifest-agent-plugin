#!/usr/bin/env node
'use strict';

// Bind current Claude-host evidence to the checked-out source. Historical
// terminal runs describe their recorded commit, never the current workspace.
const { createHash } = require('node:crypto');
const { readdirSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const SOURCE_FILES = [
  'hooks/hooks.json',
  'scripts/pre-tool-use.cjs',
  'scripts/pre-tool-use.sh',
  'ci/claude-hook-smoke.cjs',
  'tests/fixtures/claude-host-mcp.cjs',
];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

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
