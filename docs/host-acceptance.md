# Host acceptance

The implementation plan is in [eng-894-plan.md](eng-894-plan.md). Compatibility
is measured at three layers: deterministic local fixtures, the real host
protocol, and actual interactive/live workflows. A pass in one layer does
not fill another layer's missing evidence.

## 0.5.0 preparation status

The Linux observations recorded on **2026-09-17** use source
`c6fcc5656349edb8599febae9f20df988d503df8`, plugin **0.5.0**, MCP **0.22.0**,
and Node **24.15.0**:

- [Claude Code 2.1.270 terminal](host-evidence/claude-terminal-0.5.0.json) and
  [Codex CLI 0.154.0 terminal](host-evidence/codex-terminal-0.5.0.json): all nine
  harmless fixture cases, with per-case and suite cleanup verified.
- [Codex CLI 0.153.4 app-server](host-evidence/codex-app-server-0.5.0.json):
  eight marker-fixture cases; no model turn, live signer, or terminal UI.
- [Native upgrade, reinstall and repair](current-install-acceptance-0.5.0.md):
  both hosts migrated a legacy 0.4.0 plaintext credential automatically,
  preserved seven saved files and the new credential file, retained offline
  wallet signing, and passed actual read-only MCP probes. The explicit file
  credential backend was used; no legacy-user exemption was taken.

The first upgraded Claude session exceeded the host's 30-second MCP connection
timeout during runtime installation. Restart retained the failed connection;
`/mcp` → `manifest-chain` → `Reconnect` restored it. Later reinstall and repair
chain probes passed without another reconnect. The version transition used
native remove/install with the same plugin identity, not update-in-place.

Both hosts completed all eleven [live testnet checks](live-testnet-acceptance-0.5.0.md).
Both leases are closed, domain claims cleared, host processes stopped, and
temporary keys/profiles removed after the public archive passed its secret
scan. The full local release gate passed and the Codex archive is eligible.
The [release checklist](release-0.5.0.md) and
[machine-readable gate](host-acceptance-release.json) track validation
and the remaining publication steps. The
[local validation report](host-evidence/release-validation-0.5.0.json) records
734 passing tests, three local PowerShell skips, all five executable doc
examples, and the installed policy/contract/transport checks.
Linux file-storage runs do not establish native macOS Keychain, Windows
Credential Manager/ACL, or GUI compatibility. The older reports below remain
historical 0.4.0 evidence.

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
Every cleanup step is attempted even when the case or another cleanup step
fails. The original case error retains its host/scenario context; additional
cleanup or late model errors are attached as its cause and printed by the CLI.
Process identity parsing handles spaces and parentheses in Linux process names.
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
[0.5.0 preservation evidence](current-install-acceptance-0.5.0.md). A stopped tool can
lose its late result or warning in the host UI; inspect the captured cancellation screen as well as the
fixture event log before claiming that a partial deployment was visible.

The recorded [0.5.0 Claude terminal run](host-evidence/claude-terminal-0.5.0.json) and
[0.5.0 Codex terminal run](host-evidence/codex-terminal-0.5.0.json) each cover all
nine cases at `c6fcc565`, with verified cleanup. They reproduced the
progress/cancellation observations below. Archived reports retain their full source commit;
`--check <report> --require-history` verifies those bytes when the commit is
available. Without that commit, validation explicitly reports metadata-only
verification. A partial `--case` report cannot pass full-matrix validation.

The historical original [Claude](host-evidence/claude-terminal.json) and
[Codex](host-evidence/codex-terminal.json) reports remain unchanged.
The historical [reviewed Claude run](host-evidence/claude-terminal-reviewed.json) and
[reviewed Codex run](host-evidence/codex-terminal-reviewed.json) repeat all nine
cases with the corrected harness at `ba19d43`. These version 2 reports verify
process exit and directory removal for every case and supplied the 0.4.0 release
rows' terminal coverage. The original reports remain historical observations;
their cleanup strings do not prove that their temporary directories stayed
removed. Those reviewed runs also reproduced the progress/cancellation observations below.

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
observations with the version-matched preservation evidence. The historical
0.4.0 live workflow is recorded separately in
[live-testnet-acceptance.md](live-testnet-acceptance.md); it does not complete
the 0.5.0 live rows, which use their own
[fresh live report](live-testnet-acceptance-0.5.0.md).

## 0.5.0 matrix

| Scenario | Claude Code 2.1.270 | Codex CLI 0.154.0 | Scope |
| --- | --- | --- | --- |
| Discovery, 14 skills and 5 servers | Passed | Passed | Harmless terminal fixture |
| Permission, confirmation and pre-mutation decline/cancel | Passed | Passed | Zero markers on denial; one on acceptance |
| Paid partial and post-broadcast cancellation | Observed | Observed | UI limitations in the table above |
| Native 0.4.0 → 0.5.0 migration | Passed with initial connection recovery | Passed | Explicit file credentials; same original wallet |
| Native reinstall and automatic runtime repair | Passed | Passed | Seven saved files plus credential bytes/modes preserved |
| Original wallet and saved-record readers | Passed | Passed | Offline signatures, synthetic schema 2/3 wrappers and journal |
| Read-only MCP before/after reinstall and repair | Passed | Passed | Published `list_modules`; disabled loopback chain endpoints |
| Live testnet lifecycle and cleanup | Passed | Passed | Eleven cases per host; remote and local cleanup verified |
| Full local release gate | Passed | Passed | Version, source, coverage and cleanup checks; Codex archive eligible |
| PR CI | See PR checks | See PR checks | Required on the reviewed commit before merge |

## Historical 0.4.0 matrix

The following matrix describes the earlier ENG-894 observations. Its passed
live rows and legacy-upgrade exemption apply to that release only.

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
[approval-validation.md](approval-validation.md). The fresh 0.5.0 Codex
app-server result is [archived separately](host-evidence/codex-app-server-0.5.0.json).
Historical Codex evidence is recorded in
[codex-app-server.json](host-evidence/codex-app-server.json). This older committed
run is the artifact from [CI run 34865171417](https://github.com/manifest-network/manifest-agent-plugin/actions/runs/34865171417),
with its checkout log recording temporary PR merge commit `5c47db6`. The
archive's `head` uses durable branch commit `d3ffb46`: both commits have the
identical Git tree, recorded in `archiveSource`. Its original results and all
61 source hashes are preserved. The shared provenance verifier derives the
complete source-file scope from the recorded commit's tree, including the
script/workflow globs and generated terminal skills, and checks its package
versions against that commit. Adding or removing files in today's workspace
does not change historical scope. Local diagnostic checks explicitly report
metadata-only verification when history is absent; historical bytes and dynamic
scope remain unverified in that mode. CI and release checks require both.

CI uses full Git history and explicitly runs
`node ci/evidence-check.cjs --fetch-history --require-history` before checking
the archives. This fetches missing recorded commits by their full validated
SHA, including commits outside main's ancestry after squash merging. The
validators themselves never fetch or silently weaken strict checks. Git
source blobs are read in one binary-safe batch after any historical tree lookup.
The release job uses `--codex-release-status --fetch-history`: pending or
different-version archives skip before fetching; complete current records
must pass strict validation after any missing source commits are fetched.

The `codex-host` CI job generates a fresh report and validates it with
`--report codex-host-report.json --require-current` before uploading it. Current
reports must match every source hash, package version and workflow in the
checkout. Routine changes and version bumps do not require a local Codex run
to rewrite the historical report. When archiving a current report, set
`source_status` to `historical` and record its full source commit in `head`;
never refresh hashes without running the harness. Avoid temporary PR merge
commits as archive references. A durable commit with the identical Git tree
may be used while retaining the actual tested checkout and tree equivalence
in the archive metadata.

## Release evidence

Release evidence binds to the source being shipped. Changing any hashed file,
or adding/removing a `scripts/*.cjs`, `scripts/*.ps1`, or `workflows/*.md` file, makes the current
release rows stale even though archived reports remain valid for their recorded
commits. In that source-change PR, set each affected `interactive` and `testnet`
row in [host-acceptance-release.json](host-acceptance-release.json) to
`"status": "pending"`. The four current rows share the same core source scope,
so a change in that scope affects all four. Preserve the historical reports;
do not rewrite their hashes to make them appear current.

Before declaring those rows complete for publication, rerun the affected
acceptance matrix against the intended source, including the funded live-testnet
run for testnet rows, and update the release references with the new evidence.
Ordinary `npm test` runs use a synthetic release fixture to test the validator;
they do not require the active release record to be complete or current.
PR CI checks the real record's JSON, schema version and both hosts' row statuses.
Pending rows and records for another version pass this metadata check;
publication still requires source eligibility.
Pending Codex rows skip its artifact; stale completed rows fail validation.
Before tagging, check the actual record with the same command as the release job:

```bash
node ci/host-acceptance.cjs --codex-release-status --fetch-history
```

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
from [host-acceptance-release.json](host-acceptance-release.json).
For historical 0.4.0, both testnet rows referenced the completed live lifecycle
run. Their cleanup declaration
covers temporary resources and local account data; the separately recorded
unused testnet billing credit was accepted by the user. Its interactive rows
were also complete for the CLI scope: current-version reinstall and runtime
repair preserved config, encrypted wallets, drafts, schema 2/3 saved manifests
and historical journals. The owner excluded legacy-version migration because
there were no existing users of the old plugin. Each 0.4.0 interactive row declared
`legacyUpgradeExemption: "no-existing-users"`; validation therefore required
`reinstall` and `runtime-repair` coverage in place of `upgrade`. Records without
that explicit exemption still require upgrade evidence. The historical 0.4.0
run claimed neither GUI behavior nor version-to-version migration. The fresh
0.5.0 preservation report includes actual legacy migration and uses no exemption;
its live and full-gate status remains tracked separately above.

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
