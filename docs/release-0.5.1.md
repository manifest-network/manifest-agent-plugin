# 0.5.1 release preparation

Patch release of the four reliability fixes merged after v0.5.0. Node
22.19.0 or later is required; the MCP runtime remains pinned to 0.22.0.

## Release notes

- Registry refresh validates chain IDs, endpoints and gas-token metadata
  before replacing cached files. Failed refreshes preserve usable cached
  metadata and report partial results accurately. ([ENG-1008](https://linear.app/liftedinit/issue/ENG-1008))
- Wallet replacement preserves custom gas settings atomically. Onboarding
  and key import verify the saved configuration and report incomplete
  verification as a partial result. ([ENG-1009](https://linear.app/liftedinit/issue/ENG-1009))
- Config-update diagnostics give actionable recovery steps, and gas-token
  selection uses the refreshed registry data consistently.
  ([ENG-1011](https://linear.app/liftedinit/issue/ENG-1011))
- Secret-file recipes explain Bash setup and separate private data entry
  from shell commands. Env recovery uses the recorded service path, preserves
  supplied files and offers cleanup only for eligible temporary inputs.
  ([ENG-1010](https://linear.app/liftedinit/issue/ENG-1010))

## Release checklist

- [x] Three version manifests and lockfile root agree at 0.5.1.
- [x] Automated tests, installed contracts and documentation examples pass.
- [x] Fresh Claude and Codex terminal evidence reviewed; cleanup verified.
- [x] Upgrade, reinstall, saved-state preservation and runtime repair verified.
- [x] Both hosts' live-testnet lifecycle passes; temporary resources removed.
- [x] Current-source release evidence passes the strict gate; Codex archive eligible.

Publication follows green CI on the merged preparation commit. The
[v0.5.1 release](https://github.com/manifest-network/manifest-agent-plugin/releases/tag/v0.5.1)
and [Release workflow](https://github.com/manifest-network/manifest-agent-plugin/actions/workflows/release.yml)
record publication and attachment of the native Codex archive.

Published v0.5.0 evidence remains historical. Fresh acceptance must reference
the 0.5.1 candidate's source and version. Linux CLI evidence does not establish
GUI behavior or native macOS/Windows credential-store compatibility.

## Acceptance evidence

The frozen candidate is `237fc195a80c21cb8040af265cb6b1370e1f03c2`.
All observations use plugin 0.5.1, MCP 0.22.0 and Node 24.15.0 on Linux.

- [Claude Code 2.1.270](host-evidence/claude-terminal-0.5.1.json) and
  [Codex CLI 0.154.0](host-evidence/codex-terminal-0.5.1.json): nine terminal
  fixture cases each, with verified process and temporary-profile cleanup.
- [Codex CLI 0.153.4 app-server](host-evidence/codex-app-server-0.5.1.json):
  eight fixture cases, five servers and all 14 skills discovered.
- [Native preservation](host-evidence/current-install-preservation-0.5.1.json):
  0.4.0 to 0.5.1 native remove/install under the same plugin identity,
  automatic plaintext-credential migration, current-version reinstall and
  automatic runtime repair. Both hosts preserved seven saved files and the
  credential file, custom gas settings and offline wallet signing across
  six stages. The isolated profiles, keys and caches were removed.
- Local suite: 1,013 passed, zero failed, three PowerShell checks skipped.
  All five executable documentation examples passed, including network
  setup and registry refresh. Installed tool policy, launcher transport,
  both-host contracts, lease-state parity and chain-config parity passed.
- [Live testnet](host-evidence/live-testnet-0.5.1.json): all 11 lifecycle
  checks per host passed. Each host deployed, restarted, managed a disposable
  domain and closed one lease. Both app endpoints shut down; one saved
  deployment and five journal entries per host were verified. All temporary
  profiles and key material were removed after an exact-value secret scan.
- [Validation record](host-evidence/release-validation-0.5.1.json): local
  checks, evidence digests and strict source-matched release eligibility.

Ten successful transactions consumed 1.632190 testnet MFX in fees and
0.400500 testnet PWR in lease costs. The disposable wallet retains 7.5 PWR
and 8.367810 MFX; unused billing credit is 2.099500 PWR. These test tokens and
permanent chain records are distinct from cleaned-up leases, domains and
provider resources. The pinned billing interface has no credit-withdrawal
operation. Codex's first status after restart captured `restarting`; a
later read verified readiness and the new container without another restart.

Native terminals use deterministic local model responses and operator input.
They do not establish autonomous model reasoning or GUI behavior. The
interruption fixtures retain the observed host limits: Claude receives MCP
cancellation but hides the late warning; Codex neither forwards cancellation
within the two-second observation window nor displays the emitted progress.
Neither interruption screen retains the lease identifier. Preservation uses
explicit file credentials and offline fixtures, and does not test marketplace
update-in-place or native macOS/Windows credential stores.

The renderer token contract ([ENG-1029](https://linear.app/liftedinit/issue/ENG-1029)),
scripted env-input ledger ([ENG-1045](https://linear.app/liftedinit/issue/ENG-1045))
and normalized-fragment collision guard remain separate follow-ups.
