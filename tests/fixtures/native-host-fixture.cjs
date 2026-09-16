#!/usr/bin/env node
'use strict';

// Harmless transport fixture for both host adapters. Its only mutation is a
// marker in temporary plugin data. It has no SDK, signer or network client.
const fs = require('node:fs');
const { join } = require('node:path');
const { createInterface } = require('node:readline');

const TOOLS = {
  chain: ['cosmos_query', 'cosmos_tx', 'request_faucet'],
  lease: ['query_leases', 'fund_credit', 'close_lease', 'set_item_custom_domain'],
  fred: ['app_status', 'app_releases', 'restart_app', 'deploy_app', 'restore_app', 'update_app'],
  cosmwasm: ['convert_mfx_to_pwr'],
  agent: ['deploy_app_orchestrated', 'manage_domain_orchestrated', 'close_lease_orchestrated', 'lookup_custom_domain_orchestrated', 'troubleshoot_deployment_orchestrated'],
};
const READS = new Set(['cosmos_query', 'query_leases', 'app_status', 'app_releases', 'lookup_custom_domain_orchestrated', 'troubleshoot_deployment_orchestrated']);
const LEASE = '11111111-1111-4111-8111-111111111111';

function serve(server) {
  const data = process.env.MANIFEST_PLUGIN_DATA;
  const pending = new Map();
  const active = new Map();
  let sequence = 0;
  const record = (event) => fs.appendFileSync(join(data, 'fixture-events.jsonl'), JSON.stringify({ server, ...event }) + '\n');
  const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
  const result = (id, value) => send({ id, result: value });
  const done = (call, value, isError = false) => {
    active.delete(call.id);
    result(call.id, { isError, content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
  };
  const progress = (call, phase) => {
    record({ kind: 'progress', phase });
    send({ method: 'notifications/progress', params: { progressToken: call.params._meta?.progressToken || `fixture-${call.id}`, progress: ++sequence, message: phase } });
    send({ method: 'notifications/message', params: { level: 'info', logger: 'manifest-native-fixture', data: { phase, lease_uuid: LEASE } } });
  };
  const elicit = (call, phase) => {
    const id = `fixture-${++sequence}`;
    pending.set(id, { call, phase });
    record({ kind: 'elicitation', phase });
    send({ id, method: 'elicitation/create', params: { mode: 'form',
      message: phase === 'recovery' ? `Harmless partial deployment ${LEASE}. Keep this fixture record?` : 'Approve a harmless fixture operation? No chain or provider is contacted.',
      requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean', default: false } }, required: ['confirm'] },
    } });
  };
  const mutate = (call) => {
    record({ kind: 'mutation', tool: call.params.name });
    progress(call, 'broadcast_complete');
    const scenario = call.params.arguments?.fixture_scenario;
    if (scenario === 'partial') elicit(call, 'recovery');
    else if (scenario === 'wait_after_broadcast') active.set(call.id, call);
    else done(call, { status: 'complete', leaseState: 'LEASE_STATE_ACTIVE', lease_uuid: LEASE });
  };
  record({ kind: 'started', host: process.env.MANIFEST_PLUGIN_HOST, data,
    credentialEnvironment: Object.fromEntries(['MANIFEST_CREDENTIAL_STORE', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'SystemRoot']
      .filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]])) });
  createInterface({ input: process.stdin }).on('line', (line) => {
    const call = JSON.parse(line);
    if (!call.method) {
      const entry = pending.get(call.id);
      if (!entry) return;
      pending.delete(call.id);
      const accepted = call.result?.action === 'accept' && call.result.content?.confirm === true;
      record({ kind: 'elicitation_result', phase: entry.phase, action: call.result?.action, accepted });
      if (entry.phase === 'recovery') done(entry.call, { status: 'partial', lease_uuid: LEASE, broadcast: true, domainVerified: false, recoveryAccepted: accepted });
      else if (accepted) mutate(entry.call);
      else done(entry.call, { code: 'OPERATION_CANCELLED', broadcast: false });
      return;
    }
    if (call.method === 'notifications/cancelled') {
      record({ kind: 'cancellation' });
      for (const [id, entry] of pending) if (entry.call.id === call.params.requestId) {
        pending.delete(id);
        send({ method: 'notifications/cancelled', params: { requestId: id } });
        done(entry.call, { code: 'OPERATION_CANCELLED', broadcast: false });
      }
      const entry = active.get(call.params.requestId);
      if (entry) {
        record({ kind: 'cancelled_after_broadcast', lease_uuid: LEASE });
        send({ method: 'notifications/message', params: { level: 'warning', data: { kind: 'deploy_cancelled_after_broadcast', lease_uuid: LEASE, partial: true } } });
        done(entry, { code: 'OPERATION_CANCELLED', partial: true, lease_uuid: LEASE }, true);
      }
      return;
    }
    if (call.id === undefined) return;
    record({ kind: 'request', method: call.method, tool: call.params?.name });
    if (call.method === 'initialize') result(call.id, { protocolVersion: call.params.protocolVersion, instructions: `Upstream fixture ${server} instructions.`, capabilities: { tools: {}, logging: {} }, serverInfo: { name: `fixture-${server}`, version: '1.0.0' } });
    else if (call.method === 'tools/list') result(call.id, { tools: TOOLS[server].map((name) => ({ name, description: 'Harmless local host acceptance fixture.',
      inputSchema: { type: 'object', properties: { fixture_scenario: { type: 'string' } } },
      annotations: { readOnlyHint: READS.has(name), destructiveHint: !READS.has(name), openWorldHint: false, idempotentHint: READS.has(name) },
    })) });
    else if (call.method === 'tools/call') {
      if (!TOOLS[server].includes(call.params.name)) throw new Error('Unknown fixture tool');
      if (READS.has(call.params.name) && call.params.arguments?.fixture_scenario === 'final_large_frame') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: {
          content: [{ type: 'text', text: 'x'.repeat(2 * 1024 * 1024) }],
        } }) + '\n', () => {
          record({ kind: 'final_frame_written' });
          process.stdin.destroy();
        });
      } else if (READS.has(call.params.name)) done(call, { status: 'read_only', lease_uuid: LEASE });
      else if (server === 'agent') { progress(call, 'plan_ready'); elicit(call, 'plan'); }
      else mutate(call);
    } else if (call.method === 'resources/list') result(call.id, { resources: [] });
    else if (call.method === 'prompts/list') result(call.id, { prompts: [] });
    else result(call.id, {});
  });
}

async function prepareFixture({ pluginRoot, dataDir, legacyCredential = false }) {
  const { setupRuntime } = require('../../scripts/setup-runtime.cjs');
  const { storePassword } = require('../../scripts/_credentials.cjs');
  const dependencies = { '@manifest-network/manifest-mcp-node': '0.0.0-fixture' };
  fs.writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ dependencies }));
  fs.writeFileSync(join(pluginRoot, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
    '': { dependencies }, 'node_modules/@manifest-network/manifest-mcp-node': { version: '0.0.0-fixture' },
  } }));
  await setupRuntime({ pluginRoot, dataDir, install: async (target) => {
    const pkg = join(target, 'node_modules/@manifest-network/manifest-mcp-node');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(join(pkg, 'package.json'), JSON.stringify({ version: '0.0.0-fixture' }));
    fs.copyFileSync(__filename, join(pkg, 'fixture.cjs'));
    fs.mkdirSync(join(target, 'node_modules/.bin'), { recursive: true });
    for (const server of Object.keys(TOOLS)) fs.writeFileSync(join(target, 'node_modules/.bin', `manifest-mcp-${server}`),
      `#!/usr/bin/env node\nrequire('../@manifest-network/manifest-mcp-node/fixture.cjs').serve(${JSON.stringify(server)});\n`, { mode: 0o755 });
  } });
  fs.writeFileSync(join(dataDir, 'fixture-wallet.json'), '{}', { mode: 0o600 });
  // The real host smoke starts with plaintext so its actual MCP environment
  // must forward the explicit file selector before the launcher can migrate.
  const credential = legacyCredential ? { keyPassword: 'public-fixture' } : {
    keyPasswordRef: storePassword(dataDir, 'fixture-wallet.json', 'public-fixture', {
      env: { MANIFEST_CREDENTIAL_STORE: 'file' },
    }),
  };
  fs.writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ activeChain: 'testnet', gasPrice: '0.025umfx', chains: {
    testnet: { chainId: 'manifest-fixture-testnet', rpcUrl: 'http://127.0.0.1:1', converterAddress: 'manifest1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqjpzgn4' },
  }, agent: { keyFile: 'fixture-wallet.json', ...credential } }), { mode: 0o600 });
}

module.exports = { prepareFixture, serve, TOOLS, LEASE };
