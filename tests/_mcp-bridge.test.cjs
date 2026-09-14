'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBridge, supportsForms } = require('../scripts/_mcp-bridge.cjs');
const { mutationPolicy } = require('../ci/build-packages.cjs');
const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });

function fixture(t, { serverName = 'fred', caps = { elicitation: { form: {} } } } = {}) {
  const client = [], server = [], timers = new Set();
  const bridge = createBridge({ serverName, mutations: mutationPolicy()[serverName], instructions: 'fixture policy',
    sendClient: (message) => client.push(message), sendServer: (message) => server.push(message),
    setTimer: (fn) => { timers.add(fn); return fn; }, clearTimer: (fn) => timers.delete(fn),
  });
  t.after(bridge.close);
  bridge.fromClient(request(1, 'initialize', { capabilities: caps }));
  server.length = 0;
  return { bridge, client, server, timers };
}

test('only MCP form capability or the legacy empty elicitation object supports confirmation', () => {
  for (const caps of [{ elicitation: {} }, { elicitation: { form: {} } }, { elicitation: { form: {}, url: {} } }]) assert.equal(supportsForms(caps), true);
  for (const caps of [undefined, {}, { elicitation: null }, { elicitation: true }, { elicitation: [] }, { elicitation: { url: {} } }, { elicitation: { form: null } }]) assert.equal(supportsForms(caps), false);
});

test('all reviewed mutations fail before forwarding when native form confirmation is unavailable', (t) => {
  for (const [serverName, names] of Object.entries(mutationPolicy())) {
    const f = fixture(t, { serverName, caps: { elicitation: { url: {} } } });
    for (const name of names) {
      f.bridge.fromClient(request(2, 'tools/call', { name, arguments: {} }));
      assert.equal(f.server.length, 0, `${serverName}/${name}`);
      const error = JSON.parse(f.client.at(-1).result.content[0].text);
      assert.equal(error.code, 'CONFIRMATION_UNAVAILABLE');
      assert.equal(error.details.broadcast, false);
    }
  }
});

test('direct mutation waits for a native accept and forwards exact arguments once without leaking secrets', (t) => {
  const f = fixture(t);
  const call = request(2, 'tools/call', { name: 'restart_app', arguments: {
    lease_uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', env: { SECRET: 'must-not-be-shown' },
  } });
  f.bridge.fromClient(call);
  assert.equal(f.server.length, 0);
  const prompt = f.client[0];
  assert.equal(prompt.method, 'elicitation/create');
  assert.match(prompt.params.message, /aaaaaaaa-bbbb/);
  assert.doesNotMatch(JSON.stringify(prompt), /must-not-be-shown|SECRET/);
  f.bridge.fromClient({ jsonrpc: '2.0', id: prompt.id, result: { action: 'accept', content: { confirm: true } } });
  assert.deepEqual(f.server, [call]);
  assert.equal(f.timers.size, 0);
});

test('decline, cancel, false, malformed/error replies and timeout never forward a pending write', (t) => {
  for (const response of [{ result: { action: 'decline' } }, { result: { action: 'cancel' } },
    { result: { action: 'accept', content: { confirm: false } } }, { result: { action: 'accept', content: { confirm: 'true' } } }, { error: { code: -32601 } }]) {
    const f = fixture(t);
    f.bridge.fromClient(request(2, 'tools/call', { name: 'restart_app' }));
    f.bridge.fromClient({ jsonrpc: '2.0', id: f.client[0].id, ...response });
    assert.equal(f.server.length, 0);
    assert.equal(f.timers.size, 0);
    assert.match(f.client.at(-1).result.content[0].text, /OPERATION_CANCELLED/);
  }
  const f = fixture(t);
  f.bridge.fromClient(request(2, 'tools/call', { name: 'restart_app' }));
  [...f.timers][0]();
  assert.equal(f.server.length, 0);
  assert.match(f.client.at(-1).result.content[0].text, /timed out before execution/);
});

test('host cancellation withdraws a pending confirmation and a late acceptance does not execute the call', (t) => {
  const f = fixture(t);
  f.bridge.fromClient(request(2, 'tools/call', { name: 'restart_app' }));
  const id = f.client[0].id;
  f.bridge.fromClient({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } });
  assert.deepEqual(f.client[1], { jsonrpc: '2.0', method: 'notifications/cancelled', params: {
    requestId: id, reason: 'Operation cancelled before execution; no mutation was sent.',
  } });
  f.bridge.fromClient({ jsonrpc: '2.0', id, result: { action: 'accept', content: { confirm: true } } });
  assert.equal(f.server.filter((message) => message.method === 'tools/call').length, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.client.length, 2, 'Withdraw the prompt without responding to the retired tool request');
});

test('upstream prompt cancellation uses the client-visible ID and late responses stay retired', (t) => {
  const f = fixture(t, { serverName: 'agent' });
  f.bridge.fromServer(request(91, 'elicitation/create', { message: 'Plan' }));
  const id = f.client[0].id;
  f.bridge.fromServer({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 91 } });
  assert.equal(f.client.at(-1).params.requestId, id);
  f.bridge.fromClient({ jsonrpc: '2.0', id, result: { action: 'accept' } });
  assert.equal(f.server.length, 0);
  f.bridge.close();
  f.bridge.fromClient(request(2, 'tools/call', { name: 'deploy_app_orchestrated' }));
  f.bridge.fromServer(request(92, 'elicitation/create', { message: 'Late' }));
  assert.equal(f.server.length, 0);
  assert.equal(f.client.length, 2);
});

test('orchestrated calls, their schema/elicitation replies, progress, cancellation and partial errors pass through', (t) => {
  const f = fixture(t, { serverName: 'agent' });
  const call = request(3, 'tools/call', { name: 'deploy_app_orchestrated', arguments: { spec: { size: 'small', image: 'fixture' } }, _meta: { progressToken: 0 } });
  f.bridge.fromClient(call);
  assert.deepEqual(f.server, [call]);
  assert.equal(f.client.length, 0);
  const prompt = request(3, 'elicitation/create', { mode: 'form', message: 'Exact upstream plan', requestedSchema: { type: 'object' } });
  f.bridge.fromServer(prompt);
  assert.notEqual(f.client[0].id, prompt.id);
  assert.deepEqual(f.client[0].params, prompt.params);
  const response = { jsonrpc: '2.0', id: f.client[0].id, result: { action: 'accept', content: { choice: 'salvage_without_domain' } } };
  f.bridge.fromClient(response);
  assert.deepEqual(f.server.at(-1), { ...response, id: prompt.id });
  const progress = { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 0, progress: 1, message: 'lease-created' } };
  f.bridge.fromServer(progress);
  assert.deepEqual(f.client.at(-1), progress);
  const cancel = { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } };
  f.bridge.fromClient(cancel);
  assert.deepEqual(f.server.at(-1), cancel);
  const error = { jsonrpc: '2.0', id: 3, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'DEPLOY_READINESS_UNCONFIRMED', details: { partial: true, lease_uuid: 'paid-lease', tx_hash: 'tx-hash' } }) }] } };
  f.bridge.fromServer(error);
  assert.deepEqual(f.client.at(-1), error);
});

test('read-only calls and the faucet need no form capability; initialization preserves upstream instructions', (t) => {
  const f = fixture(t, { serverName: 'chain', caps: {} });
  for (const name of ['request_faucet', 'cosmos_query']) f.bridge.fromClient(request(2, 'tools/call', { name }));
  assert.equal(f.server.length, 2);
  f.bridge.fromServer({ jsonrpc: '2.0', id: 1, result: { instructions: 'upstream', capabilities: { tools: {} } } });
  assert.equal(f.client[0].result.instructions, 'upstream\n\nfixture policy');
  assert.throws(() => f.bridge.fromClient(null), /Invalid MCP/);
  assert.throws(() => f.bridge.fromServer({}), /Invalid MCP/);
});
