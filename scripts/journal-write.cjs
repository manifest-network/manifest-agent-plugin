#!/usr/bin/env node
'use strict';

/**
 * Append one operation-journal record to today's
 * `$MANIFEST_PLUGIN_DATA/journal/<YYYY-MM-DD>.jsonl` (UTC).
 *
 * Stdin: a JSON object (the record). Schema lives in `_journal.cjs`. Skills
 * build the record from data already in scope at the end of their run, then
 * pipe it here. The writer:
 *
 *   1. Auto-fills `timestamp_iso`, `timestamp_unix`, `schema_version` if
 *      absent (lets skills omit boilerplate).
 *   2. Auto-fills `session_id` from $MANIFEST_SESSION_ID when present and
 *      the field is absent. The SessionStart hook captures Claude Code's
 *      session id from the hook payload and exports it.
 *   3. Runs `validateRecord` — refuses (exit 1) if any key in the tree
 *      matches `_journal.SECRET_KEY_DENYLIST` (the canonical list of
 *      credential-shaped key names that must never appear in a record).
 *      Defense in depth: callers should already redact via
 *      `_journal.redactArgs`. The writer is fail-closed, not strip-and-
 *      continue — a record with a denylisted key never lands on disk.
 *   4. Calls `_journal.appendRecord` (best-effort non-interleaving append
 *      via `O_APPEND`; oversized records replaced with a `journal_truncated`
 *      marker so realistic concurrent writes stay in the single-`write(2)`
 *      regime — see `_journal.cjs`'s header for the concurrency model).
 *
 * Usage:
 *   echo '<record-json>' | node journal-write.cjs [--dry-run]
 *
 * Stdout (success): the journal file path that was appended to (mirrors
 *   the UX of save-manifest.cjs).
 * Stdout (--dry-run): the line that *would* be appended, on its own line,
 *   without touching disk. The journal file path is also printed so callers
 *   can assert against it in tests.
 *
 * Exit codes:
 *   0 — appended (or dry-run printed).
 *   1 — argv error, stdin parse error, validation failure, or IO failure.
 */

const { readFileSync } = require('node:fs');
const {
  SCHEMA_VERSION,
  appendRecord,
  validateRecord,
  journalFilePath,
} = require('./_journal.cjs');

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--dry-run') {
      args.dryRun = true;
    } else {
      console.error(`Unknown argument: ${flag}`);
      process.exit(1);
    }
  }
  return args;
}

(async () => {
  const args = parseArgs(process.argv);

  const raw = readFileSync(0, 'utf8');
  if (raw.trim().length === 0) {
    console.error('stdin is empty; expected a JSON record');
    process.exit(1);
  }
  let record;
  try {
    record = JSON.parse(raw);
  } catch (err) {
    console.error(`stdin is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    console.error('stdin must be a JSON object (the journal record)');
    process.exit(1);
  }

  // Auto-fill convenience fields if the caller omitted them.
  const now = new Date();
  if (record.timestamp_iso === undefined) {
    record.timestamp_iso = now.toISOString();
  }
  if (record.timestamp_unix === undefined) {
    record.timestamp_unix = Math.floor(now.getTime() / 1000);
  }
  if (record.schema_version === undefined) {
    record.schema_version = SCHEMA_VERSION;
  }
  if (record.session_id === undefined) {
    record.session_id = process.env.MANIFEST_SESSION_ID || null;
  }

  // Defense in depth: refuse to append if any forbidden key is present.
  // Callers should have already redacted via `_journal.redactArgs`; this is
  // a safety net for skill-prose mistakes.
  try {
    validateRecord(record);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  if (args.dryRun) {
    process.stdout.write(JSON.stringify(record) + '\n');
    process.stdout.write(journalFilePath() + '\n');
    return;
  }

  const file = appendRecord(record);
  process.stdout.write(file + '\n');
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
