# Host acceptance for ENG-894

The implementation plan is in [eng-894-plan.md](eng-894-plan.md). Compatibility
is measured at three layers: deterministic local fixtures, the real host
protocol, and actual interactive/live workflows. A pass in one layer does
not fill another layer's missing evidence.

## Reproduce the automated checks

```bash
npm run build:skills
npm run build:codex
INSTALL_DIR=$(mktemp -d)
MANIFEST_PLUGIN_DATA="$INSTALL_DIR" node scripts/setup-runtime.cjs
NODE_PATH="$INSTALL_DIR/node_modules" npm test
node ci/mcp-tool-policy.cjs --data-dir "$INSTALL_DIR"
node ci/host-contracts.cjs --data-dir "$INSTALL_DIR"
node ci/codex-host-smoke.cjs --out /tmp/codex-host.json
node ci/host-acceptance.cjs --report /tmp/codex-host.json --require-current
```

The Codex harness requires CLI 0.153.4, installs into an isolated temporary
Codex home, uses the real generated package and launchers, and replaces the
dependency/runtime layer with a marker-only fixture. It creates no wallet
or live resource. Temporary home, marketplace and data are removed in
`finally`. Its report retains versions, source hashes, prompts and marker
counts. It calls the app-server directly; it does not exercise a model turn,
the outer host approval UI, or progress rendering in a terminal/desktop UI.

`host-contracts.cjs` initializes every published server through both launchers
with network access blocked. Tool inventories must match. Every shared
workflow's concrete MCP reference must exist in the pinned inventory. It
also exercises the published agent server's schemas, callback elicitation,
progress and error mapping using the SDK and injected harmless orchestrators.
Its callback cases cover unavailable elicitation, decline, cancel, complete
success, declined paid-partial recovery and cancellation after broadcast.
These fixtures do not test the real provider/chain orchestration itself.

## Matrix

| Scenario | Local CI | Real Claude host | Real Codex host | Live testnet |
| --- | --- | --- | --- | --- |
| Clean discovery, 14 skills, 5 servers | Generated package and launcher checks | Existing install path retained | App-server fixture recorded | Pending |
| Runtime repair/upgrade preserves records | Setup tests and concurrent host-process test | Existing hook/bootstrap tests | Reinstall preserves fixture config | Pending |
| Author/validate and shared tool names | Existing draft/spec tests; pinned inventory | Full workflow pending | Full workflow pending | Pending |
| Decline before mutation | All 12 reviewed mutations gated; zero markers | Existing 14-case host report and historical terminal report | Direct + orchestrated form decline, zero markers | Pending |
| Complete/active deployment | Native transport and pinned callback cases | Full workflow pending | App-server fixture | Pending |
| Cancel before execution | Adapter and pinned callback cases | Recorded host cancel | App-server form cancel | Pending |
| Paid partial and post-broadcast cancellation | Identifiers, progress and warning preserved | Current full UI observation pending | Partial app-server result; cancellation/progress UI pending | Pending |
| Status, troubleshoot, domain, restart, balance, providers | Existing helpers; pinned tool references; native restart fixture | Full sequence pending | Full sequence pending | Pending |
| Saved records and journals | Existing v2/v3 readers; isolated concurrent persistence | Real record sequence pending | Real record sequence pending | Pending |

Claude evidence and its precise limitations remain in
[approval-validation.md](approval-validation.md). Codex evidence is recorded
in [codex-app-server.json](host-evidence/codex-app-server.json). This committed
run is historical evidence for `8d05aad`; its original observations and hashes
are preserved. `ci/host-acceptance.cjs` checks historical hashes against the
full recorded commit when available. Shallow or squashed checkouts explicitly
report metadata-only validation when that commit is absent; `--require-history`
requires the old source bytes. Historical records never claim current coverage.

The `codex-host` CI job generates a fresh report and validates it with
`--report codex-host-report.json --require-current` before uploading it. Current
reports must match every source hash, package version and workflow in the
checkout. Routine changes and version bumps do not require a local Codex run
to rewrite the historical report. When archiving a current report, set
`source_status` to `historical` and record its full source commit in `head`;
never refresh hashes without running the harness.

## Remaining release evidence

Run the following in each intended interactive host surface with exact host,
Node, plugin and upstream versions recorded. Keep transcripts free of wallet
passwords, mnemonics, private keys and application secret values.

1. Fresh install and upgrade an existing data directory. Record discovery,
   initial setup diagnostics, selected chain and wallet address, and record
   preservation. Run Claude and Codex concurrently using their isolated roots.
2. With harmless fixtures, visibly decline permission/elicitation before a
   mutation and prove zero markers. Observe progress, success, cancellation,
   recovery decline and the paid-partial result. Record UI inputs and whether
   a late post-broadcast cancellation warning remains visible. If a host
   cannot surface forms, document it as read-only/noninteractive.
3. On the agreed testnet with an explicitly funded test wallet and a known
   provider, author and preview a complete spec, deploy, check active status,
   troubleshoot, manage a disposable domain, restart, inspect balance/providers,
   and read the saved record/journal. Distinguish active success, paid partial,
   and unknown outcomes. Do not induce a duplicate deployment to simulate an
   uncertain result.
4. Close every test lease and remove disposable domain assignments. Record
   chain ID, public wallet address, lease IDs, transaction hashes, costs,
   verification results and final cleanup state (including any residue).

Record completed UI/live runs in repository evidence files and reference them
from [host-acceptance-release.json](host-acceptance-release.json). Pending
entries are intentional: no live funds, provider or domain was selected for
this implementation run. Tagged releases create the existing GitHub release
first. A separate Codex artifact job uses `--codex-release-status`: pending
Codex rows or evidence for another version skip the archive successfully.
Complete Codex rows must pass source, coverage and cleanup validation. The
job then runs and validates fresh host fixtures before attaching the archive.
Claude's pending rows do not gate that Codex artifact or the existing release.
Malformed completed Codex evidence fails the artifact job; the existing
GitHub release remains available.

To check the full compatibility matrix explicitly, run
`node ci/host-acceptance.cjs --report /tmp/codex-host.json --release` after a
fresh harness run. This requires both hosts' interactive and testnet rows for
the current package. A maintainer must review the evidence's contents; the
gate checks declared coverage and provenance, not the truth of a transcript.
