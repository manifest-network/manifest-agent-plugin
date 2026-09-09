#!/usr/bin/env node
'use strict';

// Harmless fixtures for ci/claude-hook-smoke.cjs. No SDK, wallet, RPC, or
// provider dependency: a "mutation" only appends a marker to a temp log.
const { appendFileSync, readFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
const { spawnSync } = require('node:child_process');

function record(event) {
  appendFileSync(process.env.MANIFEST_HOST_FIXTURE_LOG, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

if (process.argv[2] === 'hook') {
  const raw = readFileSync(0, 'utf8');
  const event = JSON.parse(raw);
  let output;
  if (process.env.MANIFEST_HOST_FIXTURE_POLICY) {
    const result = spawnSync('bash', [process.env.MANIFEST_HOST_FIXTURE_POLICY], {
      input: raw, encoding: 'utf8', timeout: 5000,
      // Pollute only the project hook's Node startup; fixture tracing and
      // harmless MCP servers still run with the clean, explicit Node path.
      env: process.env.MANIFEST_HOST_FIXTURE_NODE_SHIM
        ? { ...process.env, PATH: `${process.env.MANIFEST_HOST_FIXTURE_NODE_SHIM}:${process.env.PATH || ''}` }
        : process.env,
    });
    if (result.error || result.status !== 0) throw new Error('Project permission hook failed');
    output = result.stdout;
  } else {
    output = JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: 'Harmless characterization fixture gate.',
    } });
  }
  const parsed = output.trim() ? JSON.parse(output) : {};
  record({ kind: 'hook', event: event.hook_event_name, tool: event.tool_name,
    decision: parsed.hookSpecificOutput?.permissionDecision ?? null });
  // Negative control: a banner before valid deny JSON prevents this host from
  // reading the decision. The recorded decision is what the fixture emitted.
  if (process.env.MANIFEST_HOST_FIXTURE_STDOUT_NOISE === '1') process.stdout.write('fixture hook startup noise\n');
  if (output) process.stdout.write(output);
} else if (process.argv[2] === 'server') {
  const server = process.argv[3];
  const names = server === 'chain' ? ['cosmos_tx'] : ['deploy_app_orchestrated', 'manage_domain_orchestrated'];
  const pending = new Map();
  const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const result = (id, value) => send({ id, result: value });
  const done = (id, text) => result(id, { content: [{ type: 'text', text }] });
  function mutate(id, tool) {
    record({ kind: server === 'chain' ? 'direct_mutation_marker' : 'internal_mutation_marker', server, tool });
    done(id, 'Harmless fixture marker written. No real transaction.');
  }
  createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line);
    if (!message.method) {
      const call = pending.get(message.id);
      if (!call) throw new Error('Unexpected elicitation response');
      pending.delete(message.id);
      const action = message.result?.action;
      record({ kind: 'elicitation_result', action: action ?? null });
      if (action === 'accept' && message.result.content?.confirm === true) mutate(call.id, call.tool);
      else done(call.id, `Fixture stopped: ${action || 'elicitation error'}. No mutation.`);
      return;
    }
    record({ kind: 'mcp_request', server, method: message.method, tool: message.params?.name });
    if (message.id === undefined) return;
    if (message.method === 'initialize') {
      result(message.id, { protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} }, serverInfo: { name: `harmless-${server}`, version: '1.0.0' } });
    } else if (message.method === 'tools/list') {
      result(message.id, { tools: names.map((name) => ({ name,
        description: 'Harmless test fixture. Only records markers; never contacts a chain.',
        inputSchema: name === 'manage_domain_orchestrated'
          ? { type: 'object', properties: { action: { type: 'string', enum: ['lookup', 'set', 'clear'] } }, required: ['action'], additionalProperties: false }
          : { type: 'object', properties: {}, additionalProperties: false },
      })) });
    } else if (message.method === 'tools/call') {
      const tool = message.params.name;
      if (!names.includes(tool)) throw new Error('Unexpected fixture tool');
      if (tool === 'manage_domain_orchestrated' && message.params.arguments?.action === 'lookup') {
        record({ kind: 'read_only_marker', server, tool });
        done(message.id, 'Harmless lookup complete. No mutation.');
      } else if (process.env.MANIFEST_HOST_FIXTURE_ELICIT === '1') {
        const id = 'fixture-elicitation';
        pending.set(id, { id: message.id, tool });
        record({ kind: 'elicitation_request' });
        send({ id, method: 'elicitation/create', params: { mode: 'form',
          message: 'Approve one harmless test marker? No wallet or chain is involved.',
          requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean', title: 'Approve marker' } }, required: ['confirm'] },
        } });
      } else mutate(message.id, tool);
    } else if (message.method === 'resources/list') result(message.id, { resources: [] });
    else if (message.method === 'prompts/list') result(message.id, { prompts: [] });
    else result(message.id, {});
  });
} else throw new Error('Usage: claude-host-mcp.cjs <hook|server chain|server agent>');
