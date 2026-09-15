#!/usr/bin/env node
'use strict';

// Usage: check-image-references.cjs --spec-file <path>
// Reads either spec shape (size is not required) and emits only full image
// references and their syntax statuses. No environment values or network I/O.
// Exit 0: valid=true. Exit 1 with a JSON report: malformed-digest entries.
// Usage/read/JSON/shape errors: exit 1, diagnostic only, no input excerpts.
const { readFileSync } = require('node:fs');
const { checkImageReferences } = require('./_image-ref.cjs');

try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--spec-file' || !args[1]) {
    throw new Error('usage: check-image-references.cjs --spec-file <path>');
  }
  let raw;
  try { raw = readFileSync(args[1], 'utf8'); }
  catch { throw new Error('could not read spec file'); }
  let spec;
  try { spec = JSON.parse(raw); }
  catch { throw new Error('spec file is not valid JSON'); }
  const result = checkImageReferences(spec);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.valid) {
    throw new Error('malformed image digest; expected sha256:<64 lowercase hex characters>');
  }
} catch (error) {
  console.error(`Image reference check failed: ${error.message}`);
  process.exitCode = 1;
}
