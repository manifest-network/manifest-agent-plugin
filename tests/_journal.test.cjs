'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, readFileSync, statSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const _journal = require('../scripts/_journal.cjs');

function withDataDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-journal-test-'));
  const prev = process.env.MANIFEST_PLUGIN_DATA;
  process.env.MANIFEST_PLUGIN_DATA = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.MANIFEST_PLUGIN_DATA;
    else process.env.MANIFEST_PLUGIN_DATA = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeRecord(overrides = {}) {
  return {
    schema_version: _journal.SCHEMA_VERSION,
    timestamp_iso: '2026-05-08T12:00:00.000Z',
    timestamp_unix: 1778241600,
    session_id: 'sess-abc',
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

test('SCHEMA_VERSION is 1', () => {
  assert.equal(_journal.SCHEMA_VERSION, 1);
});

test('appendRecord writes JSONL line at mode 0600 with parent dir 0700', () => {
  withDataDir((dir) => {
    const file = _journal.appendRecord(makeRecord());
    assert.equal(existsSync(file), true);
    const fileMode = statSync(file).mode & 0o777;
    assert.equal(fileMode, 0o600, 'journal file must be 0600');
    const dirMode = statSync(_journal.journalDir()).mode & 0o777;
    assert.equal(dirMode, 0o700, 'journal directory must be 0700');
    const content = readFileSync(file, 'utf8');
    assert.ok(content.endsWith('\n'), 'JSONL line must end in newline');
    const parsed = JSON.parse(content.trimEnd());
    assert.equal(parsed.skill, 'set-gas-price');
    assert.equal(parsed.outcome, 'success');
  });
});

test('two consecutive appends produce two lines', () => {
  withDataDir(() => {
    _journal.appendRecord(makeRecord({ intent: 'first' }));
    const file = _journal.appendRecord(makeRecord({ intent: 'second' }));
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).intent, 'first');
    assert.equal(JSON.parse(lines[1]).intent, 'second');
  });
});

test('appendRecord uses UTC date for the file name', () => {
  withDataDir(() => {
    const file = _journal.appendRecord(makeRecord());
    const expected = _journal.journalFilePath();
    assert.equal(file, expected);
    const today = new Date().toISOString().slice(0, 10);
    assert.ok(file.endsWith(`${today}.jsonl`), `file path should end in ${today}.jsonl, got ${file}`);
  });
});

test('redactArgs(deploy_app, ...) reduces spec to summary; env values absent', () => {
  const SECRET = 'super-secret-postgres-password-DO-NOT-LEAK';
  const rawArgs = {
    services: {
      web: {
        image: 'ghcr.io/me/web:v1',
        ports: { '80': {} },
        env: {
          DATABASE_URL: `postgres://user:${SECRET}@db/app`,
          API_KEY: 'sk-anotherSecret',
        },
      },
    },
    customDomain: 'app.example.com',
    serviceName: 'web',
    size: 'small',
  };
  const out = _journal.redactArgs('mcp__manifest-fred__deploy_app', rawArgs);
  const json = JSON.stringify(out);
  assert.ok(!json.includes(SECRET), 'env value MUST NOT appear in args_redacted');
  assert.ok(!json.includes('sk-anotherSecret'), 'env value MUST NOT appear in args_redacted');
  // Keys are safe to capture and aid auditability.
  assert.ok(json.includes('DATABASE_URL'));
  assert.ok(json.includes('API_KEY'));
  // Whitelisted top-level fields preserved.
  assert.equal(out.customDomain, 'app.example.com');
  assert.equal(out.serviceName, 'web');
  assert.equal(out.size, 'small');
  assert.equal(out.summary.format, 'stack');
  assert.equal(out.summary.service_count, 1);
  assert.deepEqual(out.summary.env_keys, ['API_KEY', 'DATABASE_URL']);
  assert.deepEqual(out.summary.images, ['ghcr.io/me/web:v1']);
});

test('redactArgs(build_manifest_preview, ...) accepts the {spec: ...} call shape', () => {
  const out = _journal.redactArgs('mcp__manifest-fred__build_manifest_preview', {
    spec: { image: 'nginx:1.27', port: 80 },
  });
  assert.equal(out.summary.format, 'single');
  assert.equal(out.summary.service_count, 1);
  assert.deepEqual(out.summary.images, ['nginx:1.27']);
});

test('redactArgs preserves wrapper-shape passthrough fields at the top level', () => {
  // Defensive shape: caller wraps the spec and puts customDomain/etc. at
  // the wrapper level rather than inside spec. Without the rawArgs
  // fallback, these would be silently dropped.
  const out = _journal.redactArgs('mcp__manifest-fred__deploy_app', {
    spec: { image: 'nginx:1.27', port: 80 },
    customDomain: 'app.example.com',
    serviceName: 'web',
    size: 'small',
  });
  assert.equal(out.customDomain, 'app.example.com');
  assert.equal(out.serviceName, 'web');
  assert.equal(out.size, 'small');
  // Spec-level fields still take precedence when both are set.
  const out2 = _journal.redactArgs('mcp__manifest-fred__deploy_app', {
    spec: { image: 'nginx:1.27', port: 80, customDomain: 'inner.example.com' },
    customDomain: 'outer.example.com',
  });
  assert.equal(out2.customDomain, 'inner.example.com');
});

test('redactArgs(cosmos_estimate_fee, ...) preserves billing-module CLI args verbatim', () => {
  const out = _journal.redactArgs('mcp__manifest-chain__cosmos_estimate_fee', {
    module: 'billing',
    subcommand: 'create-lease',
    args: ['--meta-hash', 'deadbeef', 'sku-uuid:1:web'],
    gas_multiplier: 1.5,
  });
  assert.equal(out.module, 'billing');
  assert.equal(out.subcommand, 'create-lease');
  assert.equal(out.gas_multiplier, 1.5);
  assert.deepEqual(out.args, ['--meta-hash', 'deadbeef', 'sku-uuid:1:web']);
});

test('redactArgs for safe-tool prefix passes through known fields', () => {
  const out = _journal.redactArgs('mcp__manifest-lease__set_item_custom_domain', {
    lease_uuid: '11111111-1111-4111-8111-111111111111',
    custom_domain: 'app.example.com',
    service_name: 'web',
  });
  assert.equal(out.lease_uuid, '11111111-1111-4111-8111-111111111111');
  assert.equal(out.custom_domain, 'app.example.com');
  assert.equal(out.service_name, 'web');
});

test('redactArgs for unknown tool redacts suspect-keyed values', () => {
  const out = _journal.redactArgs('mcp__some-future-tool__do_thing', {
    lease_uuid: '11111111-1111-4111-8111-111111111111',
    api_token: 'sk-very-secret-token',
    note: 'safe',
  });
  assert.equal(out.lease_uuid, '11111111-1111-4111-8111-111111111111');
  // Either api_token or any TOKEN-bearing key gets redacted.
  assert.equal(out.api_token, '<redacted>');
  assert.equal(out.note, 'safe');
});

test('redactArgs for unknown tool replaces long string values with marker', () => {
  const longSecret = 'A'.repeat(300);
  const out = _journal.redactArgs('mcp__some-future-tool__do_thing', {
    note: longSecret,
  });
  assert.equal(out.note, '<redacted-long-string>');
});

test('redactArgs routes array rawArgs through the unknown-tool fallback', () => {
  // None of today's MCP tools pass a bare array as rawArgs (the schema
  // describes args_redacted as a JSON object), but if a hypothetical
  // future tool does, the array must still get key + long-string
  // redaction rather than passing through unchanged.
  const longSecret = 'B'.repeat(300);
  const out = _journal.redactArgs('mcp__some-future-tool__do_thing', [
    { lease_uuid: '11111111-1111-4111-8111-111111111111' },
    { api_token: 'sk-leak' },
    longSecret,
  ]);
  assert.ok(Array.isArray(out));
  assert.equal(out[0].lease_uuid, '11111111-1111-4111-8111-111111111111');
  // Suspect key inside an array element is redacted.
  assert.equal(out[1].api_token, '<redacted>');
  // Long string inside the array is redacted.
  assert.equal(out[2], '<redacted-long-string>');
});

test('validateRecord throws on a record containing a "password" key anywhere', () => {
  const bad = makeRecord({
    tool_calls: [
      { tool: 'x', args_redacted: { credentials: { password: 'leak' } } },
    ],
  });
  assert.throws(() => _journal.validateRecord(bad), /secret-key denylist/);
});

test('validateRecord throws on a "mnemonic" key', () => {
  const bad = makeRecord({ final_state: { mnemonic: 'twelve word phrase here' } });
  assert.throws(() => _journal.validateRecord(bad), /secret-key denylist/);
});

test('validateRecord does NOT throw on the word "password" in an intent value', () => {
  const ok = makeRecord({ intent: 'rotate my password please' });
  assert.doesNotThrow(() => _journal.validateRecord(ok));
});

test('validateRecord does NOT throw on a key named "passcode" or "key_id"', () => {
  // The denylist matches credential-shaped substrings (mnemonic, password,
  // private_key, secret_key, api_key, auth_token, bearer_token), but NOT
  // bare "key", "code", or "id" — so legitimate field names like `key_id`
  // (e.g. metadata identifiers) and `passcode` continue to pass through.
  const ok = makeRecord({ final_state: { key_id: '123', passcode: 'ok' } });
  assert.doesNotThrow(() => _journal.validateRecord(ok));
});

test('appendRecord refuses to write a record with a forbidden key', () => {
  withDataDir(() => {
    const bad = makeRecord({ final_state: { password: 'secret' } });
    assert.throws(() => _journal.appendRecord(bad), /secret-key denylist/);
    // Nothing should have been written.
    assert.equal(existsSync(_journal.journalFilePath()), false);
  });
});

test('validateRecord rejects array roots (typeof [] === "object" pitfall)', () => {
  // The CLI in journal-write.cjs already guards against array stdin; this
  // test pins that a direct sibling caller using _journal.appendRecord
  // can't sneak an array past the helper. Without the explicit
  // Array.isArray check, the bare `typeof !== 'object'` guard would let
  // arrays through and the reader's non-object filter would later skip
  // them — an invisible audit gap.
  withDataDir(() => {
    assert.throws(() => _journal.validateRecord([]), /must be a JSON object/);
    assert.throws(() => _journal.validateRecord([{ skill: 'x' }]), /must be a JSON object/);
    assert.throws(() => _journal.appendRecord([]), /must be a JSON object/);
    assert.equal(existsSync(_journal.journalFilePath()), false);
  });
});

test('oversized records produce a journal_truncated marker (never a torn line)', () => {
  withDataDir(() => {
    // Build a record whose JSON > 4 KiB. Stuff a long intent string.
    const huge = makeRecord({ intent: 'X'.repeat(5000) });
    const file = _journal.appendRecord(huge);
    const content = readFileSync(file, 'utf8').trimEnd();
    const parsed = JSON.parse(content);
    assert.equal(parsed.outcome, 'journal_truncated');
    assert.equal(parsed.skill, 'set-gas-price');
    assert.equal(parsed.session_id, 'sess-abc');
    assert.ok(parsed.original_size_bytes > 4096);
    // The marker itself must fit comfortably under the cap.
    assert.ok(Buffer.byteLength(content, 'utf8') + 1 <= _journal.MAX_RECORD_BYTES);
  });
});

test('SECRET_KEY_DENYLIST is case-insensitive substring on key names', () => {
  assert.match('Password', _journal.SECRET_KEY_DENYLIST);
  assert.match('MANIFEST_KEY_PASSWORD', _journal.SECRET_KEY_DENYLIST);
  assert.match('userMnemonic', _journal.SECRET_KEY_DENYLIST);
  // Credential-shaped suffixes (added to catch skill-author mistakes
  // outside args_redacted, e.g. accidentally putting an api key in
  // final_state).
  assert.match('api_key', _journal.SECRET_KEY_DENYLIST);
  assert.match('apiKey', _journal.SECRET_KEY_DENYLIST);
  assert.match('private_key', _journal.SECRET_KEY_DENYLIST);
  assert.match('secret_key', _journal.SECRET_KEY_DENYLIST);
  assert.match('auth_token', _journal.SECRET_KEY_DENYLIST);
  assert.match('bearer-token', _journal.SECRET_KEY_DENYLIST);
  // Negative cases.
  assert.doesNotMatch('intent', _journal.SECRET_KEY_DENYLIST);
  assert.doesNotMatch('lease_uuid', _journal.SECRET_KEY_DENYLIST);
  // Legitimate blockchain terms — must NOT trip the denylist.
  assert.doesNotMatch('gas_token', _journal.SECRET_KEY_DENYLIST);
  assert.doesNotMatch('fee_token', _journal.SECRET_KEY_DENYLIST);
  assert.doesNotMatch('token_id', _journal.SECRET_KEY_DENYLIST);
  assert.doesNotMatch('token_symbol', _journal.SECRET_KEY_DENYLIST);
  assert.doesNotMatch('secret_share', _journal.SECRET_KEY_DENYLIST);
  assert.doesNotMatch('chain_id', _journal.SECRET_KEY_DENYLIST);
});

test('appendRecord allows legitimate blockchain field names', () => {
  withDataDir(() => {
    // gas_token is a legitimate non-sensitive field used in set-gas-price
    // journal records — must round-trip cleanly.
    const ok = makeRecord({ final_state: { gas_token: 'MFX', gas_multiplier: 1.6 } });
    assert.doesNotThrow(() => _journal.appendRecord(ok));
  });
});

test('validateRecord rejects api_key, private_key, etc. anywhere in the tree', () => {
  for (const key of ['api_key', 'apiKey', 'private_key', 'secret_key', 'auth_token', 'bearer_token']) {
    const bad = makeRecord({ final_state: { [key]: 'leak' } });
    assert.throws(
      () => _journal.validateRecord(bad),
      /secret-key denylist/,
      `expected '${key}' to trip the denylist`,
    );
  }
});
