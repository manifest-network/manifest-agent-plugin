'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { checkWorkflowTools } = require('../ci/host-contracts.cjs');

test('workflow contract check fails on missing tools and a tool advertised by the wrong server', (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'manifest-workflow-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(join(root, 'workflows'));
  fs.mkdirSync(join(root, 'workflows/fragments'));
  fs.mkdirSync(join(root, 'workflows/directory.md'));
  fs.writeFileSync(join(root, 'workflows/.DS_Store'), '{{tool:fred/ignored}}');
  fs.writeFileSync(join(root, 'workflows/probe.md'), 'Call {{tool:fred/app_status}}, then {{tool:agent/deploy_app_orchestrated}}.');
  const inventory = [{ serverName: 'manifest-fred', tools: [{ name: 'app_status' }] },
    { serverName: 'manifest-agent', tools: [{ name: 'deploy_app_orchestrated' }] }];
  assert.equal(checkWorkflowTools(inventory, root), 2);
  assert.throws(() => checkWorkflowTools(inventory.slice(0, 1), root), /unavailable pinned tool agent\/deploy_app/);
  inventory[1].serverName = 'manifest-fred';
  assert.throws(() => checkWorkflowTools(inventory, root), /unavailable pinned tool/);
});
