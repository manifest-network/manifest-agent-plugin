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

## Interactive terminal fixtures

On Linux with Claude Code **2.1.270**, Codex CLI **0.154.0**, and tmux installed:

```bash
node ci/terminal-host-smoke.cjs --host claude --out /tmp/claude-terminal.json
node ci/terminal-host-smoke.cjs --host codex --out /tmp/codex-terminal.json
node ci/terminal-host-smoke.cjs --check /tmp/claude-terminal.json --require-current
node ci/terminal-host-smoke.cjs --check /tmp/codex-terminal.json --require-current
```

The harness runs actual interactive terminals, sends scripted keystrokes,
and captures rendered screens at each permission boundary. Local deterministic
model responses request one harmless MCP operation; the model never supplies
approval answers. The shipped hooks, launchers, policy, skills and generated
Codex package are exercised with the dependency runtime replaced by a fixture
whose only mutation is a temporary marker. No chain, provider, funded wallet,
real API credentials or GUI is involved. Temporary homes, tmux sessions and
the loopback API are cleaned up after each case. Cleanup waits for processes
carrying the run's exact temporary home to exit before removing the directory,
then checks that it stays absent. Version 2 reports retain these measurements
per case; a historical version 1 cleanup string is not verified cleanup.
The CLI versions are checked
before execution; review menu and prompt behavior before changing the pins.

Each host covers fresh discovery, outer denial, direct mutation acceptance
and decline, orchestrated acceptance, decline and cancellation, declined
paid-partial recovery, and cancellation after a simulated broadcast. Reports
retain source hashes, exact versions, keys, rendered screens, MCP events and
marker counts before and after confirmation. `--case <name>` runs one case
for diagnosis and produces only partial evidence.

The Claude fixture uses `--plugin-dir` and its production SessionStart hook.
Claude assigns inline plugin data to
`<CLAUDE_CONFIG_DIR>/plugins/data/manifest-agent-inline`; the harmless runtime
is prepared there before launch. Codex installs through a temporary local
marketplace. Both hosts must discover all five servers before the first
prompt is submitted. Claude's exact test tool is preallowed so the visible
outer prompt proves that the plugin's hook still requests permission.

Terminal results use a scripted summary of the actual returned tool output;
they do not validate model reasoning or the full deployment workflow.
Reinstall and saved-record preservation have their own
[current-install evidence](current-install-acceptance.md). A stopped tool can
lose its late result or warning in the host UI; inspect the captured cancellation screen as well as the
fixture event log before claiming that a partial deployment was visible.

The recorded [Claude terminal run](host-evidence/claude-terminal.json) and
[Codex terminal run](host-evidence/codex-terminal.json) each cover all nine
cases. The reports are historical snapshots of their full source commit;
`--check <report> --require-history` verifies those bytes when the commit is
available. Without that commit, validation explicitly reports metadata-only
verification. A partial `--case` report cannot pass full-matrix validation.

The [reviewed Claude run](host-evidence/claude-terminal-reviewed.json) and
[reviewed Codex run](host-evidence/codex-terminal-reviewed.json) repeat all nine
cases with the corrected harness at `ba19d43`. These version 2 reports verify
process exit and directory removal for every case and now supply the release
rows' terminal coverage. The original reports remain historical observations;
their cleanup strings do not prove that their temporary directories stayed
removed. The new runs reproduced the progress/cancellation observations below.

| Observed behavior | Claude Code 2.1.270 | Codex CLI 0.154.0 |
| --- | --- | --- |
| Outer denial | No MCP tool call, zero markers | No MCP tool call, zero markers |
| Native decline | MCP action `decline`, zero markers | Default `False` submits action `accept` with `confirm: false`, zero markers |
| Native cancellation | MCP action `cancel`, zero markers | MCP action `cancel`, zero markers |
| Accepted direct/orchestrated operation | Exactly one marker | Exactly one marker |
| Declined recovery after simulated payment | `partial` and fixture lease ID visible | `partial` and fixture lease ID visible |
| In-flight progress | `plan_ready` and `broadcast_complete` visible | Calling/working indicator; phase notifications not visible |
| Escape after simulated broadcast | MCP cancellation received; late warning emitted but absent from final screen | Terminal interrupted; no MCP cancellation observed in the two-second window |

Neither host retained the fixture lease ID on its final interruption screen.
These observations leave post-broadcast outcomes uncertain from the terminal
alone. Preserve identifiers and inspect existing records before retrying an
interrupted deployment. The interactive release rows combine these terminal
observations with the current-install evidence. The live workflow is recorded
separately in [live-testnet-acceptance.md](live-testnet-acceptance.md).

## Matrix

| Scenario | Local CI | Real Claude host | Real Codex host | Live testnet |
| --- | --- | --- | --- | --- |
| Clean discovery, 14 skills, 5 servers | Generated package and launcher checks | Terminal skill menu and 5 servers | Terminal skill menu and 5 servers; full inventory in app-server fixture | Fresh isolated runtime and host startup |
| Runtime repair/reinstall preserves records | Setup tests and concurrent host-process test | Native reinstall with `--keep-data`; automatic repair; seven files and wallet verified | Native remove/add; automatic repair; seven files and wallet verified | Legacy upgrade excluded; current-install checks offline |
| Author/validate and shared tool names | Existing draft/spec tests; pinned inventory | Real preview of operator-authored spec | Real preview of operator-authored spec | Passed with local model driver |
| Decline before mutation | All 12 reviewed mutations gated; zero markers | Terminal direct + orchestrated denial, zero markers | Terminal direct + orchestrated denial, zero markers | Fixture only |
| Complete/active deployment | Native transport and pinned callback cases | Native forms; active live app; HTTPS 200 | Native forms; active live app; HTTPS 200 | Passed |
| Cancel before execution | Adapter and pinned callback cases | Terminal native cancel | Terminal native cancel | Fixture only |
| Paid partial and post-broadcast cancellation | Identifiers, progress and warning preserved | Partial result visible; late warning lost on interruption | Partial result visible; cancellation/phase visibility limitations above | Not induced |
| Status, troubleshoot, domain, restart, balance, providers | Existing helpers; pinned tool references; native restart fixture | Live sequence passed | Live sequence passed | On-chain domain set/clear; no custom DNS/TLS |
| Saved records and journals | Existing v2/v3 readers; isolated concurrent persistence | Helpers read one live manifest and five journal records | Helpers read one live manifest and five journal records | Operator invoked repository helpers |
| Cleanup | Fixture roots removed | Closed lease; no provider instances or domain claim | Closed lease; no provider instances or domain claim | Empty wallet; local keys/data removed; accepted test credit remains |

The [2026-09-14 live acceptance report](live-testnet-acceptance.md) records both
hosts' real MCP/chain/provider operations at source commit `9963fe3`, with
public transaction receipts, terminal excerpts, costs and cleanup evidence in
[live-testnet.json](host-evidence/live-testnet.json). The model driver was local;
authoring and journal invocation were performed by the acceptance operator.

Claude evidence and its precise limitations remain in
[approval-validation.md](approval-validation.md). Codex evidence is recorded
in [codex-app-server.json](host-evidence/codex-app-server.json). This committed
run is the artifact from [CI run 34865171417](https://github.com/manifest-network/manifest-agent-plugin/actions/runs/34865171417),
with its checkout log binding the observations to `5c47db6`. Its original
results and all 61 source hashes are preserved. The shared provenance verifier
requires the complete source-file scope for each report kind and checks its
package versions against the recorded commit. Local diagnostic checks can
explicitly report metadata-only verification when history is absent; CI and
release checks require the actual commit bytes.

CI uses full Git history and explicitly runs
`node ci/evidence-check.cjs --fetch-history --require-history` before checking
the archives. This fetches missing recorded commits by their full validated
SHA, including commits outside main's ancestry after squash merging. The
validators themselves never fetch or silently weaken strict checks. Git
objects are read in one binary-safe batch per report.
The release job uses `--codex-release-status --fetch-history`: pending or
different-version archives skip before fetching; complete current records
must pass strict validation after any missing source commits are fetched.

The `codex-host` CI job generates a fresh report and validates it with
`--report codex-host-report.json --require-current` before uploading it. Current
reports must match every source hash, package version and workflow in the
checkout. Routine changes and version bumps do not require a local Codex run
to rewrite the historical report. When archiving a current report, set
`source_status` to `historical` and record its full source commit in `head`;
never refresh hashes without running the harness.

## Release evidence

Run the following in each intended interactive host surface with exact host,
Node, plugin and upstream versions recorded. Keep transcripts free of wallet
passwords, mnemonics, private keys and application secret values.

1. Fresh install and upgrade an existing data directory. When the repository
   owner confirms there are no legacy users, record that exemption and verify
   current-version native reinstall and automatic runtime repair instead.
   Record discovery, initial setup diagnostics, selected chain and wallet address, and record
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
from [host-acceptance-release.json](host-acceptance-release.json). Both testnet
rows now reference the completed live lifecycle run. Their cleanup declaration
covers temporary resources and local account data; the separately recorded
unused testnet billing credit was accepted by the user. Both interactive rows
are also complete for the CLI scope: current-version reinstall and runtime
repair preserved config, encrypted wallets, drafts, schema 2/3 saved manifests
and historical journals. The owner excluded legacy-version migration because
there are no existing users of the old plugin. Each interactive row declares
`legacyUpgradeExemption: "no-existing-users"`; validation then requires
`reinstall` and `runtime-repair` coverage in place of `upgrade`. Records without
that explicit exemption still require upgrade evidence. No GUI or
version-to-version migration is claimed.

Tagged releases create the existing GitHub release first. A separate Codex
artifact job uses `--codex-release-status`: pending
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
gate checks source provenance and evidence structure, not the truth of a
transcript. Interactive rows must bind both the preservation report and the
terminal report: their paths, digest, host, source commit, core source hashes
and case coverage must agree. Preservation validation compares the six saved
file snapshots and verifies the recorded signing, readers, reinstall commands,
runtime repair and cleanup. Terminal validation checks anchored model summaries,
recovery responses and cancellation observations against the captured events
and screens, with verified process cleanup required for release eligibility.
