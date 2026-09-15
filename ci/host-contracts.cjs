#!/usr/bin/env node
'use strict';

// Pinned-runtime contracts, independent of either host UI. Server discovery
// runs through both real launchers under the existing network-denying guard.
// Callback cases use the published AgentMCPServer and MCP SDK with injected
// orchestrators/runtime (no wallet, chain or provider). They are not live E2E.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const { buildCodex, workflowFiles } = require('./build-packages.cjs');
const { probeLaunchers } = require('./launcher-transport.cjs');
const { NETWORK_GUARD } = require('./mcp-tool-policy.cjs');
const ROOT = resolve(__dirname, '..');
const LEASE = '11111111-1111-4111-8111-111111111111';

function checkWorkflowTools(inventory, root = ROOT) {
  const names = new Set(inventory.flatMap(({ serverName, tools }) => tools.map((tool) => `${serverName.slice(9)}/${tool.name}`)));
  let checked = 0;
  for (const file of workflowFiles(root)) {
    const source = fs.readFileSync(join(root, 'workflows', file), 'utf8');
    for (const [, name] of source.matchAll(/\{\{tool:([^}]+)\}\}/g)) {
      assert.ok(names.has(name), `${file} references unavailable pinned tool ${name}`);
      checked++;
    }
  }
  return checked;
}

async function probeCallbacks(dataDir) {
  const modulePath = (pkg, file = 'index.js') => pathToFileURL(join(dataDir, 'node_modules/@manifest-network', pkg, 'dist', file)).href;
  const { AgentMCPServer } = await import(modulePath('manifest-mcp-agent'));
  const { ManifestMCPError } = await import(modulePath('manifest-mcp-core'));
  const { buildManifestPreview } = await import(modulePath('manifest-mcp-fred'));
  const { connectClientWithElicitation } = await import(modulePath('manifest-mcp-core', '__test-utils__/callToolWithElicitation.js'));
  const { LoggingMessageNotificationSchema } = await import(pathToFileURL(join(dataDir, 'node_modules/@modelcontextprotocol/sdk/dist/esm/types.js')).href);
  const cases = [];
  for (const scenario of ['no-elicitation', 'decline', 'cancel', 'complete', 'paid-partial', 'cancel-after-broadcast']) {
    const spec = scenario === 'complete' ? {
      size: 'small',
      services: {
        web: { image: `registry.example.com:5443/team/web:stable@sha256:${'a'.repeat(64)}` },
        db: { image: `postgres@sha256:${'b'.repeat(64)}` },
        worker: { image: 'busybox:latest' },
      },
    } : { image: 'fixture:v1', size: 'small' };
    if (scenario === 'complete') {
      // Exercise the published manifest builder before the real MCP boundary.
      // Pins and explicit mutable choices must survive both; this does not
      // claim registry resolution or exercise the injected deployer's upload.
      const preview = await buildManifestPreview({ services: spec.services });
      assert.equal(preview.validation.valid, true, JSON.stringify(preview.validation.errors));
      const manifest = JSON.parse(preview.manifest_json);
      for (const [name, service] of Object.entries(spec.services)) {
        assert.equal(manifest.services[name].image, service.image);
      }
    }
    let writes = 0;
    let calls = 0;
    const prompts = [];
    const progress = [];
    const logs = [];
    const abort = new AbortController();
    let partialLogged;
    const logArrived = new Promise((resolve) => { partialLogged = resolve; });
    const app = new AgentMCPServer({ config: { chainId: 'manifest-fixture', rpcUrl: 'http://127.0.0.1:1', gasPrice: '0.025umfx' },
      walletProvider: { getAddress: async () => { throw new Error('No fixture wallet access allowed'); } },
      orchestrators: { deployApp: async (_spec, callbacks, options) => {
        calls++;
        assert.deepEqual(_spec, spec, 'MCP must forward exact per-service image references');
        callbacks.onProgress({ kind: 'deployment_plan_rendered', block: { text: 'Pinned-runtime fixture plan' } });
        const verdict = await callbacks.onPlan({ summary: {} });
        if (verdict !== 'confirm') throw new ManifestMCPError('OPERATION_CANCELLED', 'Fixture plan cancelled');
        assert.equal(await callbacks.onConfirm({ text: 'Pinned-runtime fixture mainnet confirmation' }), 'yes');
        writes++;
        callbacks.onProgress({ kind: 'fixture_broadcast_complete', lease_uuid: LEASE });
        if (scenario === 'paid-partial') {
          const choice = await callbacks.onFailure({ outcome: 'partially_succeeded', leaseUuid: LEASE, reason: 'Fixture domain verification failed' }, [
            { id: 'salvage_without_domain', label: 'Keep paid lease', description: 'Preserve the fixture lease' },
            { id: 'close_lease', label: 'Close', description: 'Close the fixture lease' },
          ]);
          assert.equal(choice.id, 'salvage_without_domain');
          throw new ManifestMCPError('OPERATION_CANCELLED', 'Fixture paid partial retained', { partial: true, lease_uuid: LEASE, recovery_outcome: 'salvaged' });
        }
        if (scenario === 'cancel-after-broadcast') {
          await new Promise((resolve) => {
            if (options.signal.aborted) resolve();
            else options.signal.addEventListener('abort', resolve, { once: true });
          });
          throw new ManifestMCPError('OPERATION_CANCELLED', 'Fixture readiness cancelled', { partial: true, lease_uuid: LEASE, readiness_unconfirmed: true });
        }
        return { leaseUuid: LEASE, providerUuid: LEASE, leaseState: 'LEASE_STATE_ACTIVE', urls: ['https://fixture.invalid'], manifestPath: '/fixture/saved.json' };
      } },
    });
    // Deliberately replace network-backed runtime construction in this test.
    // Tool schemas, callback translation, error mapping and SDK are published.
    app.runtimePromise = Promise.resolve({});
    app.denomMapPromise = Promise.resolve(new Map());
    const connection = await connectClientWithElicitation(app.getServer(), { respond: async (request) => {
      prompts.push(request.params);
      if (scenario === 'decline' || scenario === 'cancel') return { action: scenario };
      if (request.params.requestedSchema.properties.choice) return { action: 'decline' };
      const plan = request.params.requestedSchema.properties.verdict.enum.includes('confirm');
      return { action: 'accept', content: { verdict: plan ? 'confirm' : 'yes' } };
    } }, [], scenario !== 'no-elicitation');
    connection.client.setNotificationHandler(LoggingMessageNotificationSchema, (message) => {
      logs.push(message.params);
      if (message.params.data?.kind === 'deploy_cancelled_after_broadcast') partialLogged();
    });
    try {
      const pending = connection.client.callTool({ name: 'deploy_app_orchestrated', arguments: { spec } }, undefined, {
        signal: abort.signal, timeout: 5000,
        onprogress: (event) => {
          progress.push(event);
          if (scenario === 'cancel-after-broadcast' && event.message.includes('fixture_broadcast_complete')) abort.abort();
        },
      });
      if (scenario === 'cancel-after-broadcast') {
        await assert.rejects(pending);
        let timer;
        try { await Promise.race([logArrived, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Missing paid cancellation log')), 2000); })]); }
        finally { clearTimeout(timer); }
        assert.ok(logs.some((entry) => entry.data?.lease_uuid === LEASE));
      } else {
        const result = await pending;
        const value = JSON.parse(result.content[0].text);
        if (scenario === 'complete') assert.equal(value.leaseState, 'LEASE_STATE_ACTIVE');
        else {
          assert.equal(result.isError, true);
          assert.equal(value.code, scenario === 'no-elicitation' ? 'INVALID_CONFIG' : 'OPERATION_CANCELLED');
          if (scenario === 'paid-partial') {
            assert.equal(value.details.lease_uuid, LEASE);
            assert.equal(value.details.recovery_outcome, 'salvaged');
            assert.ok(logs.some((entry) => entry.data?.kind === 'recovery_dismissed'));
          }
        }
      }
      assert.equal(writes, ['complete', 'paid-partial', 'cancel-after-broadcast'].includes(scenario) ? 1 : 0);
      if (scenario === 'no-elicitation') assert.equal(calls, 0);
      else assert.ok(progress.length >= 1);
      cases.push({ scenario, writes, prompts: prompts.length, progress: progress.length, passed: true });
    } finally { await connection.close(); app.disconnect(); }
  }
  return cases;
}

async function runContracts(dataDir) {
  const temp = fs.mkdtempSync(join(tmpdir(), 'manifest-host-contracts-'));
  try {
    const pluginRoot = buildCodex({ out: join(temp, 'package') });
    const claude = await probeLaunchers({ dataDir, includeFaucet: true });
    const codex = await probeLaunchers({ dataDir, root: pluginRoot, host: 'codex', includeFaucet: true });
    assert.deepEqual(codex, claude);
    const references = checkWorkflowTools(codex);
    const cases = await probeCallbacks(dataDir);
    return { servers: codex.length, references, cases };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || argv[0] !== '--data-dir') throw new Error('Usage: node ci/host-contracts.cjs --data-dir <locked-runtime-directory>');
  const dataDir = resolve(argv[1]);
  if (process.env.MANIFEST_CONTRACT_WORKER !== '1') {
    const temp = fs.mkdtempSync(join(tmpdir(), 'manifest-contract-guard-'));
    try {
      const guard = join(temp, 'deny-network.cjs');
      fs.writeFileSync(guard, NETWORK_GUARD);
      const result = spawnSync(process.execPath, ['--require', guard, __filename, '--data-dir', dataDir], {
        env: { PATH: process.env.PATH, HOME: process.env.HOME, MANIFEST_CONTRACT_WORKER: '1' }, stdio: 'inherit', timeout: 90000,
      });
      if (result.error || result.status !== 0) throw new Error(`Pinned host contracts failed: ${result.error?.message || result.signal || result.status}`);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  } else {
    const result = await runContracts(dataDir);
    console.log(`host-contracts: ${result.servers} pinned servers match in both hosts; ${result.references} workflow tool references and ${result.cases.length} callback cases passed; no network`);
  }
}
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { checkWorkflowTools, probeCallbacks, runContracts };
