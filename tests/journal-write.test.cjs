'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const _journal = require('../scripts/_journal.cjs');

const SCRIPT = join(__dirname, '..', 'scripts', 'journal-write.cjs');

function withDataDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-journal-write-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runWrite(dataDir, recordJson, extraArgs = [], extraEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...extraArgs], {
    encoding: 'utf8',
    input: typeof recordJson === 'string' ? recordJson : JSON.stringify(recordJson),
    env: { ...process.env, MANIFEST_PLUGIN_DATA: dataDir, ...extraEnv },
  });
}

function makeRecord(overrides = {}) {
  return {
    skill: 'set-gas-price',
    active_chain: 'testnet',
    signer_address: 'manifest1abc',
    intent: 'change gas price',
    plan_summary: 'set gas_multiplier=1.6',
    tool_calls: [],
    outcome: 'success',
    final_state: { gas_multiplier: 1.6 },
    errors: [],
    recovery_actions: [],
    ...overrides,
  };
}

// Returns the current UTC date in `YYYY-MM-DD`. Called inside each test
// (rather than captured at module load) so the date matches what the
// journal-write.cjs subprocess computes when it runs. Without this, a
// test suite started just before UTC midnight could assert against
// `2026-05-07.jsonl` while the subprocess writes to `2026-05-08.jsonl`.
function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

test('happy path: appends a record and returns the journal file path', () => {
  withDataDir((dataDir) => {
    const r = runWrite(dataDir, makeRecord(), [], { MANIFEST_SESSION_ID: '' });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const filePath = r.stdout.trim();
    assert.ok(filePath.endsWith(`${todayUtc()}.jsonl`));
    assert.equal(existsSync(filePath), true);
    const lines = readFileSync(filePath, 'utf8').trimEnd().split('\n');
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.skill, 'set-gas-price');
    assert.equal(record.outcome, 'success');
  });
});

test('deploy skill journal command reads serialized records without interpreting spec text', () => {
  withDataDir((dataDir) => {
    const pluginRoot = join(__dirname, '..');
    const skill = readFileSync(join(pluginRoot, 'skills', 'deploy-app', 'SKILL.md'), 'utf8');
    const journalBlock = [...skill.matchAll(/```bash\n([\s\S]*?)\n```/g)]
      .find((match) => match[1].includes('scripts/journal-write.cjs'));
    assert.ok(journalBlock, 'deploy skill must include a journal-write bash command');

    const markerPath = join(dataDir, 'shell-marker');
    const size = `small"\\\nJOURNAL_EOF\ntouch '${markerPath}'\n$(touch '${markerPath}')\n\`touch '${markerPath}'\``;
    const secret = 'private-deploy-environment-value';
    const tool = 'mcp__manifest-agent__deploy_app_orchestrated';
    const argsRedacted = _journal.redactArgs(tool, {
      spec: { image: 'nginx:1.27', port: 80, size, env: { API_KEY: secret } },
    });
    const recordJson = JSON.stringify(makeRecord({
      skill: 'deploy-app',
      intent: 'deploy nginx',
      plan_summary: 'deploy single spec',
      tool_calls: [{ tool, args_redacted: argsRedacted, outcome: 'ok', result_summary: {} }],
      final_state: {},
    }));
    assert.equal(recordJson.includes(secret), false, 'reduce environment values before serialization');
    const journalPath = join(dataDir, 'journal record.json');
    writeFileSync(journalPath, recordJson, { mode: 0o600 });

    // Execute the documented command, so returning to an interpolated heredoc
    // breaks this regression even when the journal writer itself is unchanged.
    const r = spawnSync('bash', ['-c', journalBlock[1]], {
      encoding: 'utf8',
      env: {
        ...process.env,
        MANIFEST_PLUGIN_ROOT: pluginRoot,
        MANIFEST_PLUGIN_DATA: dataDir,
        MANIFEST_SESSION_ID: '',
        JOURNAL_PATH: journalPath,
      },
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const filePath = join(dataDir, 'journal', `${todayUtc()}.jsonl`);
    assert.equal(r.stdout.trim(), filePath, 'stdout must contain only the journal path');
    const contents = readFileSync(filePath, 'utf8');
    const lines = contents.trimEnd().split('\n');
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.skill, 'deploy-app');
    assert.deepEqual(record.tool_calls[0].args_redacted, argsRedacted);
    assert.equal(record.tool_calls[0].args_redacted.size, size);
    assert.deepEqual(record.tool_calls[0].args_redacted.summary.env_keys, ['API_KEY']);
    assert.equal(existsSync(markerPath), false, 'spec text must never execute as shell commands');
    for (const output of [contents, r.stdout, r.stderr]) {
      assert.equal(output.includes(secret), false, 'environment values must not reach journal output');
    }
    assert.equal(statSync(filePath).mode & 0o777, 0o600);
  });
});

test('auto-fills timestamp_iso, timestamp_unix, schema_version when absent', () => {
  withDataDir((dataDir) => {
    const r = runWrite(dataDir, makeRecord(), [], { MANIFEST_SESSION_ID: '' });
    assert.equal(r.status, 0);
    const record = JSON.parse(readFileSync(r.stdout.trim(), 'utf8').trimEnd());
    assert.match(record.timestamp_iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    assert.equal(typeof record.timestamp_unix, 'number');
    assert.equal(record.schema_version, 1);
  });
});

test('auto-fills session_id from $MANIFEST_SESSION_ID when absent', () => {
  withDataDir((dataDir) => {
    const r = runWrite(dataDir, makeRecord(), [], { MANIFEST_SESSION_ID: 'sess-xyz' });
    assert.equal(r.status, 0);
    const record = JSON.parse(readFileSync(r.stdout.trim(), 'utf8').trimEnd());
    assert.equal(record.session_id, 'sess-xyz');
  });
});

test('session_id falls back to null when $MANIFEST_SESSION_ID is empty', () => {
  withDataDir((dataDir) => {
    // Set the env var to an empty string. process.env reads this back as "",
    // which the writer's `||` fallback coerces to null.
    const r = runWrite(dataDir, makeRecord(), [], { MANIFEST_SESSION_ID: '' });
    assert.equal(r.status, 0);
    const record = JSON.parse(readFileSync(r.stdout.trim(), 'utf8').trimEnd());
    assert.equal(record.session_id, null);
  });
});

test('session_id falls back to null when $MANIFEST_SESSION_ID is genuinely unset', () => {
  withDataDir((dataDir) => {
    // Don't pass MANIFEST_SESSION_ID at all in the subprocess env. Start
    // from a clean parent env (delete from a copy) so any value the
    // current shell happens to have set doesn't leak through.
    const env = { ...process.env, MANIFEST_PLUGIN_DATA: dataDir };
    delete env.MANIFEST_SESSION_ID;
    const r = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      input: JSON.stringify(makeRecord()),
      env,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const record = JSON.parse(readFileSync(r.stdout.trim(), 'utf8').trimEnd());
    assert.equal(record.session_id, null);
  });
});

test('caller-supplied session_id is preserved', () => {
  withDataDir((dataDir) => {
    const r = runWrite(dataDir, makeRecord({ session_id: 'caller-id' }), [], {
      MANIFEST_SESSION_ID: 'env-id',
    });
    assert.equal(r.status, 0);
    const record = JSON.parse(readFileSync(r.stdout.trim(), 'utf8').trimEnd());
    assert.equal(record.session_id, 'caller-id');
  });
});

test('rejects record containing a forbidden key (defense in depth)', () => {
  withDataDir((dataDir) => {
    const bad = makeRecord({ final_state: { password: 'leak' } });
    const r = runWrite(dataDir, bad);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /secret-key denylist/);
    // No journal file should have been created.
    const file = join(dataDir, 'journal', `${todayUtc()}.jsonl`);
    assert.equal(existsSync(file), false);
  });
});

test('rejects empty stdin', () => {
  withDataDir((dataDir) => {
    const r = runWrite(dataDir, '');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /stdin is empty/);
  });
});

test('rejects non-JSON stdin', () => {
  withDataDir((dataDir) => {
    const r = runWrite(dataDir, 'not json');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not valid JSON/);
  });
});

test('rejects array stdin (record must be an object)', () => {
  withDataDir((dataDir) => {
    const r = runWrite(dataDir, '[]');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /must be a JSON object/);
  });
});

test('--dry-run does not write to disk; prints the would-be line and path', () => {
  withDataDir((dataDir) => {
    const r = runWrite(dataDir, makeRecord(), ['--dry-run'], { MANIFEST_SESSION_ID: '' });
    assert.equal(r.status, 0);
    const lines = r.stdout.trimEnd().split('\n');
    assert.equal(lines.length, 2);
    const record = JSON.parse(lines[0]);
    assert.equal(record.skill, 'set-gas-price');
    assert.ok(lines[1].endsWith(`${todayUtc()}.jsonl`));
    // Nothing on disk.
    assert.equal(existsSync(join(dataDir, 'journal')), false);
  });
});

test('rejects unknown argv flag', () => {
  withDataDir((dataDir) => {
    const r = runWrite(dataDir, makeRecord(), ['--bogus']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Unknown argument/);
  });
});

test('journal file is mode 0600 and parent dir is mode 0700', () => {
  withDataDir((dataDir) => {
    const r = runWrite(dataDir, makeRecord(), [], { MANIFEST_SESSION_ID: '' });
    assert.equal(r.status, 0);
    const filePath = r.stdout.trim();
    assert.equal(statSync(filePath).mode & 0o777, 0o600);
    assert.equal(statSync(join(dataDir, 'journal')).mode & 0o777, 0o700);
  });
});

test('errors when MANIFEST_PLUGIN_DATA is unset and the writer needs it', () => {
  // Spawn without MANIFEST_PLUGIN_DATA in env.
  const env = { ...process.env };
  delete env.MANIFEST_PLUGIN_DATA;
  delete env.MANIFEST_SESSION_ID;
  const r = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    input: JSON.stringify(makeRecord()),
    env,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /MANIFEST_PLUGIN_DATA/);
});

test('integration: orchestrated-tool records append cleanly and survive the secret-key denylist', () => {
  // Post-ENG-130 every state-changing skill writes ONE tool_calls[] entry
  // per orchestrated invocation. Confirm the four new reducer output
  // shapes round-trip through the writer (no denylist false positives,
  // no shape-validation rejections, no truncation under the 4 KiB cap).
  withDataDir((dataDir) => {
    const record = makeRecord({
      skill: 'deploy-app',
      plan_summary: 'deploy single spec via orchestrated tool, image=nginx:1.27',
      tool_calls: [
        {
          tool: 'mcp__manifest-agent__deploy_app_orchestrated',
          args_redacted: {
            summary: {
              format: 'single',
              service_count: 1,
              port_count: 1,
              env_count: 1,
              env_keys: ['LOG_LEVEL'],
              images: ['nginx:1.27'],
            },
            customDomain: 'integ.example.com',
            serviceName: 'web',
            size: 'small',
          },
          outcome: 'ok',
          result_summary: {
            lease_uuid: '11111111-1111-4111-8111-111111111111',
            url: 'https://integ.example.com',
          },
        },
      ],
      final_state: {
        lease_uuid: '11111111-1111-4111-8111-111111111111',
        custom_domain: 'integ.example.com',
      },
    });
    const r = runWrite(dataDir, record, [], { MANIFEST_SESSION_ID: 'integ-sess' });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const line = readFileSync(r.stdout.trim(), 'utf8').trimEnd();
    const parsed = JSON.parse(line);
    assert.equal(parsed.outcome, 'success');
    assert.equal(parsed.tool_calls[0].tool, 'mcp__manifest-agent__deploy_app_orchestrated');
    assert.equal(parsed.tool_calls[0].args_redacted.customDomain, 'integ.example.com');
    assert.deepEqual(parsed.tool_calls[0].args_redacted.summary.env_keys, ['LOG_LEVEL']);
  });
});
