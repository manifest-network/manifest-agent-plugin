#!/usr/bin/env node
'use strict';

// Claude calls this before the outer tools/call, not for the SDK functions
// that an MCP server invokes internally. No runtime dependencies or secrets
// are needed to decide whether to request host permission.
const { readFileSync } = require('node:fs');
const hooks = require('../hooks/hooks.json');
const entries = hooks?.hooks?.PreToolUse;
if (!Array.isArray(entries) || entries.length === 0) throw new Error('Missing PreToolUse matchers');
const matchers = entries.map((entry) => {
  if (typeof entry?.matcher !== 'string' || !entry.matcher.trim()) {
    throw new Error('Missing PreToolUse matcher');
  }
  return new RegExp(entry.matcher);
});
const AGENT_PREFIX = 'mcp__plugin_manifest-agent_manifest-agent__';

// Private protocol consumed by pre-tool-use.sh, which owns the host JSON.
function decidePermission(event) {
  if (!event || event.hook_event_name !== 'PreToolUse' || typeof event.tool_name !== 'string') {
    throw new Error('Invalid hook event');
  }
  if (!matchers.some((matcher) => matcher.test(event.tool_name))) return 'defer';

  return event.tool_name.startsWith(AGENT_PREFIX) ? 'ask-orchestrated' : 'ask-direct';
}

if (require.main === module) {
  try {
    const result = decidePermission(JSON.parse(readFileSync(0, 'utf8')));
    process.stdout.write(`${result}\n`);
  } catch {
    // Do not echo the event, parser errors, arguments, or secret-bearing data.
    process.stderr.write('manifest-agent permission hook received an invalid event; denying this operation\n');
    process.exitCode = 1; // The shell emits its constant deny response.
  }
}

module.exports = { decidePermission };
