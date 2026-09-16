'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const ROOT = resolve(__dirname, '..');
const available = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'],
  { encoding: 'utf8', timeout: 10000 }).status === 0;

test('PowerShell parser accepts shipped scripts and rejects a syntax error without executing it', {
  skip: !available && 'pwsh is unavailable locally; Ubuntu CI runs the parser gate',
}, (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'manifest-powershell-parser-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (args = []) => spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', join(ROOT, 'ci/check-powershell.ps1'), ...args],
    { encoding: 'utf8', timeout: 10000 });
  const valid = run();
  assert.equal(valid.status, 0, valid.stderr);
  const broken = join(dir, 'broken.ps1');
  fs.writeFileSync(broken, "throw 'PARSER_MUST_NOT_EXECUTE_THIS'\nif ($true) {\n");
  const invalid = run(['-Path', broken]);
  assert.equal(invalid.status, 1, invalid.stderr);
  assert.match(invalid.stderr, /broken\.ps1/);
  assert.doesNotMatch(invalid.stderr, /PARSER_MUST_NOT_EXECUTE_THIS/);
});

test('Windows helper reads Unicode JSON from redirected UTF-8 stdin before any Windows API', {
  skip: !available && 'pwsh is unavailable locally; Ubuntu CI runs this transport check',
}, (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'manifest-powershell-stdin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const helper = fs.readFileSync(join(ROOT, 'scripts/_wincred.ps1'), 'utf8');
  const boundary = "    if ($request.operation -eq 'protect-directory' -or $request.operation -eq 'protect-file') {";
  assert.equal(helper.split(boundary).length, 2);
  // Execute the shipped request reader, returning at the ACL boundary so this
  // verifies the wire encoding on Linux without claiming Windows API coverage.
  const probe = join(dir, 'request-reader.ps1');
  fs.writeFileSync(probe, '[Console]::InputEncoding = [Text.Encoding]::ASCII\n'
    + helper.replace(boundary, `    [Console]::Out.Write([string]$request.target)\n    exit 0\n${boundary}`));
  const target = 'C:\\Users\\José\\钱包\\credentials';
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', probe], {
    input: JSON.stringify({ operation: 'protect-directory', target }), encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, target);
});
