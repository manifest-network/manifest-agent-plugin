# 0.5.0 live testnet acceptance

The 2026-09-17 run exercised the actual Linux terminals and pinned MCP 0.22.0
runtime at source `c6fcc5656349edb8599febae9f20df988d503df8`. The
[machine-readable report](host-evidence/live-testnet-0.5.0.json) retains tool
results, native confirmation excerpts, original capture hashes, public
transaction receipts, and cleanup observations. The earlier
[0.4.0 report](host-evidence/live-testnet.json) remains historical and unchanged.

| Host | Version | Temporary lease |
| --- | --- | --- |
| Claude Code | 2.1.270 | `01a0af76-39a0-7060-ad40-3be1b99c461e` |
| Codex CLI | 0.154.0 | `01a0af86-f4af-7063-a58a-18f7e71dcec2` |

Both hosts used separate temporary profiles and data directories with the
explicit file credential backend. One newly generated, faucet-funded wallet
was copied into those isolated roots; remote writes ran sequentially. Its
public address is `manifest14ymhdmzrkcs05j76zqr2rfytprtg9dudtgjwn7` on
`manifest-ledger-testnet`.

## Observed coverage

Each host exercised authoring and draft persistence, manifest validation,
deployment, status, troubleshooting, domain management, restart, balance,
provider listing, saved records, and cleanup. The operator selected a single
`docker-micro` service using
`docker.io/nginxinc/nginx-unprivileged:alpine`, public port `8080/tcp`, and
temporary filesystems. No persistent storage was requested. Both previews
validated and returned manifest hash
`7732b90b396f26d696d1c8e194ea0abb3df03ad669d2646cccb891e09d03f4ee`.

Native plan and intent confirmations preceded deployment. Both leases became
ACTIVE and their provider HTTPS endpoints served the nginx welcome page with
HTTP 200. Restart changed the running container identifier on each lease;
subsequent status and HTTP checks remained healthy. Disposable `.test` domain
claims were set, resolved back to the expected leases, cleared, and verified
unclaimed. The shipped balance/provider renderers, saved-manifest listing and
summary helpers, and journal writer/readers processed the actual results.
Claude recorded five successful lifecycle mutations plus its cancelled plan;
Codex recorded five successful lifecycle mutations.

An initial Claude plan was cancelled while navigating its optional fields.
The tool explicitly reported cancellation at the plan step; an independent
transaction query still showed only the earlier credit-funding transaction.
The subsequent deployment used a distinct call identifier. Codex's first
provider listing returned HTTP 502 and its read-only retry succeeded. A public
receipt read also timed out once and succeeded on retry. These observations
remain in the evidence rather than being counted as successful first attempts.

## Costs and cleanup

All ten outgoing chain transactions completed with code 0. Restart used the
provider API and created no additional chain transaction.

| Quantity | Amount |
| --- | --- |
| Faucet receipts | 10 PWR and 10 MFX |
| Tenant credit funded | 4 PWR |
| Claude lease charge | 0.3315 PWR |
| Codex lease charge | 0.334 PWR |
| Total transaction fees | 1.623357 MFX |
| Remaining wallet funds | 6 PWR and 8.376643 MFX |
| Remaining available tenant credit | 3.3345 PWR |

Both leases are CLOSED; public queries show zero active or pending leases,
no credit reservations, and both domains unclaimed. The providers report
CLOSED with `payload_received=false`, and both former application endpoints
return HTTP 418 with empty bodies. Closed `app_status` responses omit running
connection details; this is not an independent container inventory.

Both isolated hosts and local model drivers were stopped. The public archive
was checked against the temporary credential values, encrypted wallet payloads,
mnemonic segments, and private driver tokens before all temporary profiles,
wallets, passwords, and caches were removed. The report retains those checks.
The pinned billing interface exposes no tenant-credit withdrawal. Remaining
faucet tokens, tenant credit, and permanent public chain records are ledger
residue; the deployment/domain resource residue is zero.

## Scope and limits

A local deterministic model driver requested exact MCP calls, while the
operator reviewed and answered the actual host confirmations. Draft authoring
and journal/helper invocation were operator-driven. This verifies the host,
launcher, confirmation, runtime, and live service path; autonomous model
reasoning and complete free-form skill execution remain outside this run.

The mutable image tag was an explicit operator choice. Automatic image digest
resolution, custom DNS/TLS, live chain switching, GUI behavior, native macOS
Keychain, and Windows Credential Manager/ACL acceptance were not exercised.
Domain/close prompts showed the target and intent without a fee recap; the
deployment plans showed estimated fees. The close prompt reported the stack
image as unrecorded. Claude collapsed longer confirmation text in the terminal;
the full request was inspected in its diagnostic log. See the separate
[terminal fixtures](host-acceptance.md#interactive-terminal-fixtures) for
progress and cancellation visibility limits, and
[native upgrade evidence](current-install-acceptance-0.5.0.md) for preservation
and the cold-start reconnect observation.
