# Live testnet acceptance — 2026-09-14

Both CLI hosts completed the live application lifecycle against
`manifest-ledger-testnet` using a fresh random, faucet-funded account. All
temporary leases, domain assignments, provider applications and local account
files were removed. The public receipts and terminal excerpts are in
[live-testnet.json](host-evidence/live-testnet.json).

The tested source was `9963fe3f70acd755dacb5ce67921f30e84689c0d`, with plugin
0.4.0, MCP/agent-core 0.22.0, Node 24.15.0, Codex CLI 0.154.0 and Claude Code
2.1.270. The evidence retains the source hashes; later documentation edits do
not change which source was tested.

## Method and scope

The actual Claude and Codex terminals ran in tmux with isolated configuration
and data directories, the shipped launchers/hooks, normal permission handling,
and the real pinned MCP runtime. A deterministic local HTTP model driver
selected tool calls. The operator authored the spec, answered the visible
confirmation forms, checked public HTTPS, and invoked the repository's saved
manifest and journal helpers. This exercises live host/runtime integration;
it does not validate hosted-model reasoning or GUI behavior.

The account was generated with the repository's key/config helpers and funded
through `request_faucet`. Its public address is
`manifest1ufc9he9syy0ap985tclsskxcrs3zducksp2v4w`. The selected provider was
`019dc0d6-446d-7000-992a-8dd25efe6328`, using compute SKU
`019dc0d6-6e71-7000-92b9-9588beb7c209` (`docker-micro`, 1.8 PWR/hour).

Each deployment contained one `app` service running
`docker.io/nginxinc/nginx-unprivileged:alpine`, with public ingress on port
8080 and tmpfs mounts at `/var/cache/nginx` and `/var/run`. There was no
persistent storage or application secret. An initial preview correctly
rejected `/tmp` as a backend-managed tmpfs path; the corrected spec validated
before either deployment.

| Check | Codex | Claude |
| --- | --- | --- |
| Provider discovery and manifest preview | Passed | Passed |
| Plan/connectivity confirmation and active deployment | Passed | Passed |
| Public HTTPS and status | HTTP 200; running container | HTTP 200; running container |
| Troubleshooting | Active lease and correct provider | Active lease and correct provider |
| Restart | New container ID; HTTP 200 | New container ID; HTTP 200 |
| Domain set, reverse lookup, clear | Passed | Passed |
| Credit/balance query | Passed | Passed |
| Saved manifest and journal helpers | One manifest; five records | One manifest; five records |
| Close and provider teardown | Closed; no instances; old URL HTTP 418 | Closed; no instances; old URL HTTP 418 |

Domain checks used disposable `.test` names. Both reverse lookups identified
the correct lease while assigned and returned `null` after clearing. DNS
delegation and custom-domain certificate issuance were outside this run.

| Host | Lease UUID | Domain, subsequently cleared |
| --- | --- | --- |
| Codex | `01a0a063-d8fa-7059-a853-7318cb36f64b` | `eng894-codex-648d623a.test` |
| Claude | `01a0a070-7dee-705a-a26a-9378b32e03a4` | `eng894-claude-6d1f4790.test` |

## Costs and cleanup

| Token | Faucet received | Returned to original faucet sender | Spent | Remaining |
| --- | ---: | ---: | ---: | ---: |
| Test MFX | 10 | 8.252377 | 1.747623 transaction fees | 0 in wallet |
| Test PWR | 10 | 6 | 0.4565 lease charges | 3.5435 billing credit |

The Codex lease settled 0.3125 PWR and Claude settled 0.144 PWR. Funding,
deployment, domain, close and refund transaction hashes, fees and events are
retained in the JSON evidence. Refund recipients were verified against the
original faucet transfers.

One MFX refund failed with chain code 5: its fee had been estimated for the
full balance, then the transfer amount was reduced without re-estimating.
The changed amount produced a higher fee. The confirmed failure charged
0.077342 MFX and transferred no tokens. Re-estimating the exact adjusted
amount allowed the final refund to empty the wallet. That failed transaction
is included in the fee total and evidence.

Final checks found zero active/pending leases, no reserved credit, no domain
claims, no provider instances, and an empty wallet. Both former public URLs
returned HTTP 418 without the nginx page. Both host processes were stopped;
temporary keys, configs, runtimes, manifests, journals, sessions and driver
files were deleted after preserving public evidence. The archive was checked
against the temporary credential/encryption values before deletion.

The billing interface exposes provider earnings withdrawal, but no tenant
credit withdrawal. The remaining 3.5435 test PWR and permanent public chain
records remain on-chain. The user accepted remaining test tokens; release
cleanup records distinguish this ledger balance from temporary resource
residue. The refunds had already completed when that instruction arrived.

## Observations and remaining coverage

The Codex deployment crossed the local driver's `exec` yield boundary while
operator confirmations were pending. Its completed MCP result was recovered
from the same Codex session, then checked against the chain and provider.
No replacement deployment was submitted.

This run did not induce paid partials or cancellation of live deployments.
Those boundaries and the terminal visibility limitations remain documented
in [host-acceptance.md](host-acceptance.md). Both interactive release rows now
include completed [current-install preservation](current-install-acceptance.md),
with native reinstall and runtime repair replacing legacy-version migration
under the repository owner's explicit no-existing-users exemption.
