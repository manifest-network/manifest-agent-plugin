'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = join(__dirname, '..', 'scripts', 'journal-read.cjs');

function withDataDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-journal-read-test-'));
  mkdirSync(join(dir, 'journal'), { recursive: true });
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runRead(dataDir, argv = []) {
  return spawnSync(process.execPath, [SCRIPT, ...argv], {
    encoding: 'utf8',
    env: { ...process.env, MANIFEST_PLUGIN_DATA: dataDir },
  });
}

function seedJournal(dataDir, date, records) {
  const file = join(dataDir, 'journal', `${date}.jsonl`);
  const lines = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(file, lines, { mode: 0o600 });
  return file;
}

const UUID_A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const UUID_B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';

const SEED_TODAY = [
  {
    schema_version: 1,
    timestamp_iso: '2026-05-08T10:00:00Z',
    timestamp_unix: 1778234400,
    session_id: 'sess-1',
    skill: 'deploy-app',
    active_chain: 'testnet',
    signer_address: 'manifest1abc',
    intent: 'deploy nginx',
    plan_summary: 'single-service',
    tool_calls: [{ tool: 'mcp__manifest-fred__deploy_app', outcome: 'ok' }],
    outcome: 'success',
    final_state: { lease_uuid: UUID_A, image: 'nginx:1.27' },
  },
  {
    schema_version: 1,
    timestamp_iso: '2026-05-08T11:00:00Z',
    timestamp_unix: 1778238000,
    session_id: 'sess-1',
    skill: 'manage-domain',
    active_chain: 'testnet',
    signer_address: 'manifest1xyz',
    intent: 'set domain',
    plan_summary: 'set fqdn',
    tool_calls: [
      {
        tool: 'mcp__manifest-lease__set_item_custom_domain',
        args_redacted: { lease_uuid: UUID_B, custom_domain: 'app.example.com' },
        outcome: 'ok',
      },
    ],
    outcome: 'failed',
    final_state: { lease_uuid: UUID_B, action: 'set', verified: false },
  },
  {
    schema_version: 1,
    timestamp_iso: '2026-05-08T12:00:00Z',
    timestamp_unix: 1778241600,
    session_id: 'sess-2',
    skill: 'deploy-app',
    active_chain: 'mainnet',
    signer_address: 'manifest1abc',
    intent: 'deploy db',
    plan_summary: 'stack',
    tool_calls: [],
    outcome: 'partial',
    final_state: { lease_uuid: UUID_A, what_failed: 'set-domain' },
  },
];

// Helper: returns the current UTC date in `YYYY-MM-DD`. Called inside
// each test (rather than captured at module load) so the date matches
// what `journal-read.cjs` computes when the subprocess runs. Without
// this, a test suite started just before UTC midnight could seed
// `2026-05-07.jsonl` and then run a subprocess that defaults to
// `2026-05-08.jsonl`, missing the seeded data.
function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

test('default markdown output for today; renders all seeded records', () => {
  withDataDir((dataDir) => {
    seedJournal(dataDir, todayUtc(), SEED_TODAY);
    const r = runRead(dataDir);
    assert.equal(r.status, 0);
    // 3 section headers expected.
    const headerCount = r.stdout.match(/^### /gm) || [];
    assert.equal(headerCount.length, 3);
    assert.match(r.stdout, /deploy-app/);
    assert.match(r.stdout, /manage-domain/);
  });
});

test('jsonl output round-trips; one line per record; sorted newest-first', () => {
  withDataDir((dataDir) => {
    seedJournal(dataDir, todayUtc(), SEED_TODAY);
    const r = runRead(dataDir, ['--format', 'jsonl']);
    assert.equal(r.status, 0);
    const lines = r.stdout.trimEnd().split('\n');
    assert.equal(lines.length, 3);
    const ts = lines.map((l) => JSON.parse(l).timestamp_unix);
    // Newest first: 12:00 > 11:00 > 10:00.
    assert.deepEqual(ts, [1778241600, 1778238000, 1778234400]);
  });
});

test('--skill filter reduces to matching records', () => {
  withDataDir((dataDir) => {
    seedJournal(dataDir, todayUtc(), SEED_TODAY);
    const r = runRead(dataDir, ['--skill', 'deploy-app', '--format', 'jsonl']);
    assert.equal(r.status, 0);
    const lines = r.stdout.trimEnd().split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    for (const l of lines) assert.equal(JSON.parse(l).skill, 'deploy-app');
  });
});

test('--outcome filter reduces to matching records', () => {
  withDataDir((dataDir) => {
    seedJournal(dataDir, todayUtc(), SEED_TODAY);
    const r = runRead(dataDir, ['--outcome', 'failed', '--format', 'jsonl']);
    assert.equal(r.status, 0);
    const lines = r.stdout.trimEnd().split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).outcome, 'failed');
  });
});

test('--lease matches both final_state and tool_calls.args_redacted scopes', () => {
  withDataDir((dataDir) => {
    seedJournal(dataDir, todayUtc(), SEED_TODAY);
    // UUID_A appears in two records' final_state.
    const ra = runRead(dataDir, ['--lease', UUID_A, '--format', 'jsonl']);
    assert.equal(ra.status, 0);
    assert.equal(ra.stdout.trimEnd().split('\n').filter(Boolean).length, 2);
    // UUID_B appears only in tool_calls of the manage-domain record.
    const rb = runRead(dataDir, ['--lease', UUID_B, '--format', 'jsonl']);
    assert.equal(rb.status, 0);
    const lines = rb.stdout.trimEnd().split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).skill, 'manage-domain');
  });
});

test('--lease matches when UUID is buried inside cosmos_estimate_fee args[]', () => {
  // Catches the case where a tool's args_redacted has the UUID only as a
  // positional element (e.g. cosmos_estimate_fee for set-item-custom-domain),
  // not as a top-level lease_uuid key. The filter must recurse into nested
  // structures so future tool shapes don't silently fall out of the query.
  const UUID_C = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';
  const record = {
    schema_version: 1,
    timestamp_iso: '2026-05-08T15:00:00Z',
    timestamp_unix: 1778252400,
    skill: 'manage-domain',
    active_chain: 'testnet',
    signer_address: 'manifest1xyz',
    intent: 'set domain',
    plan_summary: 'set fqdn',
    tool_calls: [
      {
        tool: 'mcp__manifest-chain__cosmos_estimate_fee',
        args_redacted: {
          module: 'billing',
          subcommand: 'set-item-custom-domain',
          args: [UUID_C, 'app.example.com'],
        },
        outcome: 'ok',
      },
    ],
    outcome: 'success',
    // Intentionally missing final_state.lease_uuid and any top-level
    // lease_uuid in args_redacted — UUID is reachable ONLY via args[0].
    final_state: { action: 'set', verified: true },
  };
  withDataDir((dataDir) => {
    seedJournal(dataDir, todayUtc(), [record]);
    const r = runRead(dataDir, ['--lease', UUID_C, '--format', 'jsonl']);
    assert.equal(r.status, 0);
    const lines = r.stdout.trimEnd().split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).skill, 'manage-domain');
  });
});

test('--signer filter matches signer_address exactly', () => {
  withDataDir((dataDir) => {
    seedJournal(dataDir, todayUtc(), SEED_TODAY);
    const r = runRead(dataDir, ['--signer', 'manifest1abc', '--format', 'jsonl']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trimEnd().split('\n').filter(Boolean).length, 2);
  });
});

test('--limit caps the number of records returned (newest first)', () => {
  withDataDir((dataDir) => {
    seedJournal(dataDir, todayUtc(), SEED_TODAY);
    const r = runRead(dataDir, ['--limit', '1', '--format', 'jsonl']);
    assert.equal(r.status, 0);
    const lines = r.stdout.trimEnd().split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).timestamp_unix, 1778241600);
  });
});

test('trailing torn line on last record is silently dropped', () => {
  withDataDir((dataDir) => {
    const file = seedJournal(dataDir, todayUtc(), SEED_TODAY);
    // Append a partial line WITHOUT a trailing newline (simulates power-loss).
    appendFileSync(file, '{"timestamp_iso":"2026-05-08T13:00:00Z","skil');
    const r = runRead(dataDir, ['--format', 'jsonl']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    // No stderr noise about the torn line.
    assert.equal(r.stderr, '');
    const lines = r.stdout.trimEnd().split('\n').filter(Boolean);
    assert.equal(lines.length, 3);
  });
});

test('mid-file unparseable line is skipped with a stderr breadcrumb (rest still processed)', () => {
  withDataDir((dataDir) => {
    const file = join(dataDir, 'journal', `${todayUtc()}.jsonl`);
    const ok1 = JSON.stringify(SEED_TODAY[0]);
    const garbage = 'this is not JSON';
    const ok2 = JSON.stringify(SEED_TODAY[1]);
    writeFileSync(file, [ok1, garbage, ok2].join('\n') + '\n');
    const r = runRead(dataDir, ['--format', 'jsonl']);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /line 2 .* unparseable/);
    const lines = r.stdout.trimEnd().split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
  });
});

test('non-object JSON lines are skipped (null, primitive, array)', () => {
  withDataDir((dataDir) => {
    const file = join(dataDir, 'journal', `${todayUtc()}.jsonl`);
    const ok = JSON.stringify(SEED_TODAY[0]);
    // Mix in a null, a number, a string, and an array — all valid JSON
    // but not the object shape readRecordsForDate expects. Without the
    // shape guard, recordMatches would crash on `null.skill`.
    writeFileSync(file, [ok, 'null', '42', '"a string"', '[1,2,3]', ok].join('\n') + '\n');
    const r = runRead(dataDir, ['--format', 'jsonl']);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /not a JSON object/);
    const lines = r.stdout.trimEnd().split('\n').filter(Boolean);
    // Only the two `ok` records survive.
    assert.equal(lines.length, 2);
    for (const l of lines) assert.equal(JSON.parse(l).skill, 'deploy-app');
  });
});

test('empty result on a date with no journal file: markdown placeholder, jsonl empty', () => {
  withDataDir((dataDir) => {
    const md = runRead(dataDir, ['--date', '2025-01-01']);
    assert.equal(md.status, 0);
    assert.match(md.stdout, /no records match/);
    const jl = runRead(dataDir, ['--date', '2025-01-01', '--format', 'jsonl']);
    assert.equal(jl.status, 0);
    assert.equal(jl.stdout, '');
  });
});

test('--since/--until reads multiple dated files in range', () => {
  withDataDir((dataDir) => {
    seedJournal(dataDir, '2026-05-06', [SEED_TODAY[0]]);
    seedJournal(dataDir, '2026-05-07', [SEED_TODAY[1]]);
    seedJournal(dataDir, '2026-05-08', [SEED_TODAY[2]]);
    const r = runRead(dataDir, [
      '--since', '2026-05-06',
      '--until', '2026-05-08',
      '--format', 'jsonl',
    ]);
    assert.equal(r.status, 0);
    const lines = r.stdout.trimEnd().split('\n').filter(Boolean);
    assert.equal(lines.length, 3);
  });
});

test('--date and --since/--until are mutually exclusive', () => {
  withDataDir((dataDir) => {
    const r = runRead(dataDir, ['--date', '2026-05-08', '--since', '2026-05-01', '--until', '2026-05-08']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /mutually exclusive/);
  });
});

test('--since requires --until', () => {
  withDataDir((dataDir) => {
    const r = runRead(dataDir, ['--since', '2026-05-01']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /must be passed together/);
  });
});

test('rejects malformed --date', () => {
  withDataDir((dataDir) => {
    const r = runRead(dataDir, ['--date', 'May 8 2026']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /must be YYYY-MM-DD/);
  });
});

test('rejects calendar-invalid --date (e.g. Feb 30) instead of silently normalizing', () => {
  // JS's `new Date("2026-02-30T00:00:00Z")` normalizes to March 2 rather
  // than returning NaN, so a shape-only regex check would let this pass.
  // The round-trip validator rejects it.
  withDataDir((dataDir) => {
    const r = runRead(dataDir, ['--date', '2026-02-30']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not a valid calendar date/);
  });
});

test('rejects calendar-invalid --since / --until', () => {
  withDataDir((dataDir) => {
    const r = runRead(dataDir, ['--since', '2026-04-31', '--until', '2026-05-01']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not a valid calendar date/);
  });
});

test('rejects non-UUID --lease value (path-traversal-class guard)', () => {
  withDataDir((dataDir) => {
    const r = runRead(dataDir, ['--lease', '../../etc/passwd']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /must be a UUID/);
  });
});

test('rejects unknown --outcome value', () => {
  withDataDir((dataDir) => {
    const r = runRead(dataDir, ['--outcome', 'maybe']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /must be one of/);
  });
});

test('rejects --limit edge cases (zero, negative, non-integer, non-numeric)', () => {
  withDataDir((dataDir) => {
    for (const bad of ['0', '-1', '1.5', 'abc']) {
      const r = runRead(dataDir, ['--limit', bad]);
      assert.equal(r.status, 1, `--limit ${bad} should be rejected`);
      assert.match(r.stderr, /must be a positive integer/);
    }
  });
});

test('rejects unknown --format value', () => {
  withDataDir((dataDir) => {
    const r = runRead(dataDir, ['--format', 'yaml']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /must be markdown or jsonl/);
  });
});

test('returns "no records match" when journal directory does not exist', () => {
  // No journal/ subdir created. (mkdtempSync gives us a fresh dir, then we
  // skip mkdir on journal/ for this case.)
  const dir = mkdtempSync(join(tmpdir(), 'manifest-journal-empty-test-'));
  try {
    const r = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, MANIFEST_PLUGIN_DATA: dir },
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /no records match/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
