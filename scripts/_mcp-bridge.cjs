'use strict';

// A transport boundary, not an orchestrator: forwards upstream results,
// requests, progress and cancellation unchanged. Direct writes receive a native
// form confirmation. Orchestrated writes retain their upstream plan/recovery
// prompts. No form capability means no mutation is forwarded.
const { randomUUID } = require('node:crypto');

function supportsForms(capabilities) {
  const elicitation = capabilities?.elicitation;
  if (!elicitation || typeof elicitation !== 'object' || Array.isArray(elicitation)) return false;
  return Object.keys(elicitation).length === 0
    || (elicitation.form !== null && typeof elicitation.form === 'object' && !Array.isArray(elicitation.form));
}

function createBridge({ serverName, mutations, sendClient, sendServer, instructions = '',
  confirmationTimeoutMs = 600000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let forms = false;
  let closed = false;
  let initializeId;
  const confirmations = new Map();
  const upstreamRequests = new Map();
  const errors = (call, code, message) => sendClient({ jsonrpc: '2.0', id: call.id, result: {
    isError: true, content: [{ type: 'text', text: JSON.stringify({ error: true, code, message,
      details: { phase: 'before_execution', broadcast: false } }) }],
  } });
  const cancel = (entry, message = 'Operation cancelled before execution; no mutation was sent.', withdraw = false) => {
    clearTimer(entry.timer);
    confirmations.delete(entry.id);
    if (withdraw) sendClient({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: entry.id, reason: message } });
    errors(entry.call, 'OPERATION_CANCELLED', message);
  };

  function fromClient(message) {
    if (closed) return;
    if (!message || message.jsonrpc !== '2.0') throw new Error('Invalid MCP client message.');
    if (message.method === 'initialize') {
      initializeId = message.id;
      forms = supportsForms(message.params?.capabilities);
    }
    if (!message.method && confirmations.has(message.id)) {
      const entry = confirmations.get(message.id);
      if (message.result?.action === 'accept' && message.result.content?.confirm === true) {
        clearTimer(entry.timer);
        confirmations.delete(message.id);
        sendServer(entry.call);
      } else cancel(entry);
      return;
    }
    if (!message.method && upstreamRequests.has(message.id)) {
      const id = upstreamRequests.get(message.id);
      upstreamRequests.delete(message.id);
      sendServer({ ...message, id });
      return;
    }
    // A response can arrive after cancellation or a timeout. It cannot
    // authorize a retired call, and its bridge-only ID has no upstream peer.
    if (!message.method && typeof message.id === 'string'
      && /^manifest-(confirm|upstream)-/.test(message.id)) return;
    if (message.method === 'notifications/cancelled') {
      for (const entry of confirmations.values()) {
        if (entry.call.id === message.params?.requestId) { cancel(entry, undefined, true); return; }
      }
    }
    if (message.method === 'tools/call' && mutations.includes(message.params?.name)) {
      if (!forms) {
        errors(message, 'CONFIRMATION_UNAVAILABLE', 'This operation needs interactive MCP form elicitation. Use an interactive Codex host; no mutation was sent.');
        return;
      }
      // The three mutating agent orchestrators enforce their own native
      // action/plan confirmations. Do not invent another plan or answer it.
      if (serverName !== 'agent') {
        const id = `manifest-confirm-${randomUUID()}`;
        const entry = { id, call: message };
        entry.timer = setTimer(() => cancel(entry, 'Confirmation timed out before execution; no mutation was sent.', true), confirmationTimeoutMs);
        confirmations.set(id, entry);
        // Only a short allowlisted identity recap; raw arguments can contain
        // mnemonics, contract payloads or application environment secrets.
        const args = message.params.arguments || {};
        const lease = typeof args.lease_uuid === 'string' && /^[0-9a-f-]{36}$/i.test(args.lease_uuid)
          ? `\nLease: ${args.lease_uuid}` : '';
        sendClient({ jsonrpc: '2.0', id, method: 'elicitation/create', params: { mode: 'form',
          message: `Allow Manifest ${message.params.name}?${lease}\nThis starts the requested mutation. Review the action and any applicable fee recap before confirming.`,
          requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean', title: 'Allow this operation', default: false } }, required: ['confirm'] },
        } });
        return;
      }
    }
    sendServer(message);
  }

  function fromServer(message) {
    if (closed) return;
    if (!message || message.jsonrpc !== '2.0') throw new Error('Invalid MCP server message.');
    if (message.method === 'notifications/cancelled') {
      const request = [...upstreamRequests].find(([, id]) => id === message.params?.requestId);
      if (request) {
        upstreamRequests.delete(request[0]);
        sendClient({ ...message, params: { ...message.params, requestId: request[0] } });
      } else sendClient(message);
    } else if (message.method && message.id !== undefined) {
      const id = `manifest-upstream-${randomUUID()}`;
      upstreamRequests.set(id, message.id);
      sendClient({ ...message, id });
    } else if (initializeId !== undefined && message.id === initializeId && message.result) {
      initializeId = undefined;
      sendClient({ ...message, result: { ...message.result,
        instructions: [message.result.instructions, instructions].filter(Boolean).join('\n\n'),
      } });
    } else sendClient(message);
  }

  function close() {
    closed = true;
    for (const entry of confirmations.values()) clearTimer(entry.timer);
    confirmations.clear();
    upstreamRequests.clear();
  }
  return { fromClient, fromServer, close };
}

module.exports = { supportsForms, createBridge };
