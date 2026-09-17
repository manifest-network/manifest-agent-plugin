'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const { sourceStatus, validateReport, errorClass } = require('../scripts/session-hook.cjs');

const POLICY = '# trusted fixture policy';
const SECRET = 'SECRET_DIAGNOSTIC_MUST_NOT_ESCAPE';

function fixture(t, reporter) {
  const dir = mkdtempSync(join(tmpdir(), 'manifest session hook helper '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const scripts = join(dir, 'plugin/scripts');
  const data = join(dir, 'data');
  const reportDir = join(data, '.session-report.fixture');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(reportDir, { recursive: true });
  for (const name of ['session-hook.cjs', '_host.cjs', '_io.cjs']) cpSync(join(__dirname, '../scripts', name), join(scripts, name));
  writeFileSync(join(scripts, 'session-identity.cjs'), reporter || `exports.reportHook = async ({ policy, dataDir, stdout }) => {
    require('node:assert/strict').equal(dataDir, ${JSON.stringify(data)});
    stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: policy }, systemMessage: 'Public message' }));
  };`);
  const target = join(reportDir, 'report.json');
  const envFile = join(dir, 'host env');
  const env = { PATH: process.env.PATH, CLAUDE_PLUGIN_DATA: data, CLAUDE_ENV_FILE: envFile,
    MANIFEST_PLUGIN_DATA: data, MANIFEST_SESSION_REPORT_PATH: target };
  const run = (args, extra = {}, input = POLICY) => spawnSync(process.execPath, [join(scripts, 'session-hook.cjs'), ...args], {
    env: { ...env, ...extra }, input, encoding: 'utf8', timeout: 3000,
  });
  return { run, target, reportDir, data, scripts, envFile, env };
}

test('report CLI atomically publishes one validated private file without stdout', (t) => {
  const f = fixture(t);
  const result = f.run(['report', 'startup'], { NODE_OPTIONS: '--input-type=module' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(readFileSync(f.target, 'utf8')).hookSpecificOutput.additionalContext, POLICY);
  assert.deepEqual(readdirSync(f.reportDir), ['report.json']);
  assert.equal(statSync(f.target).mode & 0o777, 0o600);
});

test('env CLI appends pure quoted exports and leaves ordinary stdout untouched', (t) => {
  const f = fixture(t);
  writeFileSync(f.envFile, "export PREEXISTING='retained'\n");
  const preload = join(f.scripts, 'preload.cjs');
  writeFileSync(preload, 'console.log("LOAD_BANNER"); process.on("exit", () => console.log("EXIT_BANNER"));');
  const result = f.run(['env'], { NODE_OPTIONS: `--input-type=module --require ${JSON.stringify(preload)}` });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'LOAD_BANNER\nEXIT_BANNER\n');
  const content = readFileSync(f.envFile, 'utf8');
  assert.match(content, /^export PREEXISTING='retained'\n/);
  assert.match(content, /export MANIFEST_PLUGIN_HOST='claude'/);
  assert.ok(content.includes(`export MANIFEST_PLUGIN_DATA='${f.data}'`));
  assert.doesNotMatch(content, /BANNER/);
});

for (const [input, expected] of [
  ['', 0], ['not JSON', 0], ['null', 0], ['{}', 0], ['{"source":null}', 0], ['{"source":123}', 0],
  ['{"source":""}', 0], ['{"source":"startup"}', 0], ['{"source":"resume"}', 10],
  ['{"source":"clear"}', 10], ['{"source":"compact"}', 10], ['{"source":"fork"}', 10],
]) {
  test(`source CLI returns status ${expected} for ${JSON.stringify(input)}`, (t) => {
    const f = fixture(t);
    const result = f.run(['source'], {}, input);
    assert.equal(result.status, expected, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(sourceStatus(input), expected);
  });
}

for (const args of [[], ['unknown'], ['env', 'extra'], ['source', 'extra'], ['report'], ['report', 'unknown'], ['report', 'skip', 'extra']]) {
  test(`helper rejects invalid arguments ${JSON.stringify(args)} without publishing`, (t) => {
    const f = fixture(t);
    const result = f.run(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^Usage: node session-hook.cjs/);
    assert.equal(existsSync(f.target), false);
  });
}

test('environment failures emit one sanitized stage/class diagnostic', (t) => {
  const f = fixture(t);
  const result = f.run(['env'], { CLAUDE_PLUGIN_DATA: SECRET, MANIFEST_PLUGIN_DATA: '' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^manifest-agent: Session hook failed during environment \(Error\)\.\n$/);
  assert.doesNotMatch(result.stderr, new RegExp(SECRET));
  assert.equal(existsSync(f.envFile), false);
});

test('report rejects absent or non-private destinations before loading the reporter', (t) => {
  const f = fixture(t, `throw new Error(${JSON.stringify(SECRET)});`);
  for (const target of ['', join(f.data, 'config.json'), join(f.reportDir, 'other.json'), join(f.data, 'ordinary/report.json')]) {
    const result = f.run(['report', 'skip'], { MANIFEST_SESSION_REPORT_PATH: target });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /report destination \(UsageError\)/);
    assert.doesNotMatch(result.stderr, new RegExp(SECRET));
    assert.equal(existsSync(f.target), false);
  }
});

test('atomic report write failure removes its unfinished sibling file', (t) => {
  const f = fixture(t);
  mkdirSync(f.target);
  const result = f.run(['report', 'skip']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /report write \(Error\)/);
  assert.deepEqual(readdirSync(f.reportDir), ['report.json']);
});

test('error classification ignores spoofed names and constructors', () => {
  const error = new Error(SECRET);
  error.name = SECRET;
  error.constructor = { name: SECRET };
  assert.equal(errorClass(error), 'Error');
  assert.equal(errorClass(new SyntaxError(SECRET)), 'SyntaxError');
  assert.equal(errorClass({ name: SECRET }), 'Error');
});

test('validator accepts the exact field limits and requires the full original policy', () => {
  const context = POLICY + '\n\n' + 'x'.repeat(10000 - POLICY.length - 2);
  const report = JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context }, systemMessage: 'x'.repeat(10000) });
  assert.equal(validateReport(report, POLICY), report + '\n');
  assert.throws(() => validateReport(report, 'different policy'));
  assert.throws(() => validateReport('null', POLICY));
  assert.throws(() => validateReport(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 42 } }), POLICY));
});
