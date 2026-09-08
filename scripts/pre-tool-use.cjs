#!/usr/bin/env node
'use strict';

// Claude calls this before the outer tools/call, not for the SDK functions
// that an MCP server invokes internally. No runtime dependencies or secrets
// are needed to decide whether to request host permission.
const { readFileSync } = require('node:fs');
const hooks = require('../hooks/hooks.json');
const matchers = hooks.hooks.PreToolUse.map(({ matcher }) => new RegExp(matcher));
const AGENT_PREFIX = 'mcp__plugin_manifest-agent_manifest-agent__';

function decision(permissionDecision, permissionDecisionReason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason } };
}

function decidePermission(event) {
  if (!event || event.hook_event_name !== 'PreToolUse' || typeof event.tool_name !== 'string') {
    throw new Error('Invalid hook event');
  }
  if (!matchers.some((matcher) => matcher.test(event.tool_name))) return null;

  // In the pinned 0.10.0 server this one tool also has a read-only lookup
  // branch. Omit a decision; never return "allow" and override host policy.
  // Invalid/missing actions remain gated and are validated by the server.
  if (event.tool_name === `${AGENT_PREFIX}manage_domain_orchestrated`
      && event.tool_input?.action === 'lookup') return null;

  if (event.tool_name.startsWith(AGENT_PREFIX)) {
    return decision('ask', 'Allow this Manifest operation to start? The server will then request confirmation before changing remote state.');
  }
  return decision('ask', 'This Manifest operation can change remote state. Review the requested action and any applicable fee estimate before approving.');
}

if (require.main === module) {
  try {
    const result = decidePermission(JSON.parse(readFileSync(0, 'utf8')));
    if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    // Do not echo the event, parser errors, arguments, or secret-bearing data.
    process.stderr.write('manifest-agent permission hook received an invalid event; denying this operation\n');
    process.stdout.write(`${JSON.stringify(decision('deny', 'Manifest permission hook could not validate this event. Repair the plugin before retrying.'))}\n`);
  }
}

module.exports = { decidePermission };
