#!/usr/bin/env node
'use strict';

// File entry points work with NODE_OPTIONS=--input-type=module and with Node
// wrappers that close nonstandard descriptors. Stdout is never a data channel:
// env writes the host env file, source returns a status, report writes a file.
const { appendFileSync, readFileSync } = require('node:fs');
const { basename, dirname, resolve } = require('node:path');
const { resolveHost, shellExports } = require('./_host.cjs');
const { atomicWrite } = require('./_io.cjs');

const SKIP_SOURCE = 10;
const MODES = ['startup', 'skip', 'migration-failed', 'migration-invalid'];
class UsageError extends Error {}
class ReportValidationError extends Error {}

function sourceStatus(payload) {
  let source;
  try { source = JSON.parse(payload)?.source; } catch { /* missing/malformed payload means startup */ }
  return typeof source === 'string' && source && source !== 'startup' ? SKIP_SOURCE : 0;
}

function validateReport(report, policy) {
  let output;
  try { output = JSON.parse(report); } catch { throw new ReportValidationError(); }
  const hook = output?.hookSpecificOutput;
  const context = hook?.additionalContext;
  if (!output || Object.keys(output).some(key => !['hookSpecificOutput', 'systemMessage'].includes(key))
    || !hook || Object.keys(hook).sort().join(',') !== 'additionalContext,hookEventName'
    || hook.hookEventName !== 'SessionStart' || typeof context !== 'string' || context.length > 10000
    || !(context === policy || context.startsWith(policy + '\n\n'))
    || (Object.hasOwn(output, 'systemMessage') && (typeof output.systemMessage !== 'string' || output.systemMessage.length > 10000))) {
    throw new ReportValidationError();
  }
  return JSON.stringify(output) + '\n';
}

function errorClass(error) {
  // Never trust error.name/message/stack: a broken reporter or config can put
  // source excerpts and secret values there. These constructor names are local.
  for (const Kind of [UsageError, ReportValidationError, SyntaxError, TypeError, RangeError, ReferenceError, URIError, EvalError]) {
    if (error instanceof Kind) return Kind.name;
  }
  return 'Error';
}

async function main(argv = process.argv.slice(2), { env = process.env, stderr = process.stderr } = {}) {
  let phase = 'arguments';
  try {
    const [command, mode] = argv;
    if (command === 'env' && argv.length === 1) {
      phase = 'environment';
      if (!env.CLAUDE_ENV_FILE) throw new UsageError();
      const host = resolveHost('claude', { env });
      appendFileSync(env.CLAUDE_ENV_FILE, shellExports(host.env), { mode: 0o600 });
      return 0;
    }
    if (command === 'source' && argv.length === 1) {
      phase = 'source input';
      return sourceStatus(readFileSync(0, 'utf8'));
    }
    if (command !== 'report' || argv.length !== 2 || !MODES.includes(mode)) throw new UsageError();
    phase = 'report destination';
    if (!env.MANIFEST_PLUGIN_DATA || !env.MANIFEST_SESSION_REPORT_PATH) throw new UsageError();
    const target = resolve(env.MANIFEST_SESSION_REPORT_PATH);
    if (basename(target) !== 'report.json'
      || dirname(dirname(target)) !== resolve(env.MANIFEST_PLUGIN_DATA)
      || !/^\.session-report\.[a-zA-Z0-9]+$/.test(basename(dirname(target)))) throw new UsageError();
    phase = 'policy input';
    const policy = readFileSync(0, 'utf8').trimEnd();
    phase = 'reporter loading';
    const { reportHook } = require('./session-identity.cjs');
    let report = '';
    phase = 'reporter execution';
    await reportHook({ policy, dataDir: env.MANIFEST_PLUGIN_DATA, skipProbe: mode === 'skip', migrationFailed: mode === 'migration-failed',
      migrationInvalid: mode === 'migration-invalid',
      stdout: { write: value => { report += value; } },
    });
    phase = 'report validation';
    const serialized = validateReport(report, policy);
    phase = 'report write';
    atomicWrite(target, serialized);
    return 0;
  } catch (error) {
    const kind = errorClass(error);
    if (phase === 'arguments') stderr.write('Usage: node session-hook.cjs <env|source|report <startup|skip|migration-failed|migration-invalid>>\n');
    else stderr.write(`manifest-agent: Session hook failed during ${phase} (${kind}).\n`);
    return 1;
  }
}

if (require.main === module) main().then(status => { process.exitCode = status; });
module.exports = { main, sourceStatus, validateReport, errorClass, SKIP_SOURCE };
