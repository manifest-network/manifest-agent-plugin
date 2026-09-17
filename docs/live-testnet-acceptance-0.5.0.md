# 0.5.0 live testnet acceptance

The reviewed 2026-09-17 replay uses actual Linux terminals and the pinned MCP
0.22.0 runtime at source `4bbd5af14c504ac280fc6dc8c14383c6fff6c832`.
Both hosts passed all 11 live checks, with resource and local cleanup verified.
The [reviewed machine-readable report](host-evidence/live-testnet-0.5.0-reviewed.json)
retains actual tool results, native confirmation captures, public receipts,
source hashes, and cleanup observations. The strict source-matched release gate
passed; merge, CI on the commit to tag, and publication remain separate steps.

| Host | Version | Temporary lease |
| --- | --- | --- |
| Claude Code | 2.1.270 | `01a0afe8-384f-7064-8ff1-a454b041360e` |
| Codex CLI | 0.154.0 | `01a0b000-9a19-7065-ac85-72d7ddd61b8f` |

Both hosts used isolated temporary profiles and data directories with the
explicit file credential backend. The same newly generated, faucet-funded
wallet was copied into those roots; remote writes ran sequentially on
`manifest-ledger-testnet`. Its public address is
`manifest14rt8yqlf62f2u2l3jqddxxf9059fajlmv50gk8`.

## Observed coverage

Both hosts exercised operator authoring and draft persistence, manifest
validation, deployment, status, troubleshooting, domain management, restart,
balance, provider listing, saved-record readers, and native lease closure.
Each host retained a five-record lifecycle journal covering deployment, restart,
domain set, domain clear, and closure.

The operator selected one `docker-micro` service using
`docker.io/nginxinc/nginx-unprivileged:alpine`, public port `8080/tcp`, and
temporary filesystems. No persistent storage was requested. Both previews
validated and returned manifest hash
`7732b90b396f26d696d1c8e194ea0abb3df03ad669d2646cccb891e09d03f4ee`.

Native plan and intent confirmations preceded deployment. Both leases became
ACTIVE and their provider HTTPS endpoints served the nginx welcome page with
HTTP 200. Restart changed each running container identifier; subsequent status
and public HTTP checks remained healthy. Each disposable `.test` claim was
set, looked up against its lease, cleared, and verified unclaimed. The shipped
balance/provider renderers and saved-manifest readers processed actual results.

The first Codex troubleshooting request used `leaseUuid` instead of the
required `lease_uuid`; schema validation rejected this read-only call before
execution. Its failure is retained. The operator queued a separate corrected
read-only call, which succeeded. No mutation was repeated for this correction.

## Startup and recovery observations

The fresh replay encountered runtime bootstrap and MCP connection recovery.
Copied dependency completion records did not validate at the new data paths;
the operator stopped the isolated hosts, performed real locked setup, and
relaunched them. Claude still needed native `/mcp` reconnects before the queued
catalog request found the server. Its startup report showed the address,
selected chain, and gas denom, with a bounded balance-query timeout diagnostic.
The later live balance calls succeeded. These observations do not establish
that initial bootstrap connects without operator recovery.

## Costs and cleanup

All ten outgoing chain transactions completed with code 0: two credit funding,
two deployments, four domain changes, and two closures. Restart used the
provider API and created no additional chain transaction. Fees below come from
the acceptance wallet's receipts; incoming faucet senders paid their own fees.

| Quantity | Amount |
| --- | --- |
| Faucet receipts | 10 PWR and 10 MFX |
| Tenant credit funded | 2.5 PWR |
| Claude lease charge | 0.339 PWR |
| Codex lease charge | 0.5235 PWR |
| Total transaction fees | 1.625765 MFX |
| Remaining wallet funds | 7.5 PWR and 8.374235 MFX |
| Remaining available tenant credit | 1.6375 PWR |

Both leases are CLOSED. Public queries show zero active or pending leases,
no credit reservations, and both domains unclaimed. Providers report CLOSED
with `payload_received=false`; both former application endpoints return HTTP
418 with empty bodies. Closed `app_status` omits running connection details;
this is not an independent container inventory.

Both isolated hosts and model drivers stopped with zero owned processes. The
operator scanned 192 public repository files against 23 generated private
values, with no matches, then removed all temporary profiles, wallet keys,
passwords and caches. An in-memory rescan of the finalized archive passed after
removal. This checks the exact values and their JSON-escaped forms, not every
possible encoding.

The pinned billing interface exposes no tenant-credit withdrawal. Remaining
faucet tokens, tenant credit, and permanent public chain records are ledger
residue; deployment/domain resource and local temporary-data residue is zero.

## Scope and limits

A deterministic loopback model requested exact operator-queued MCP calls.
The operator inspected and answered actual native host permissions and forms.
Draft authoring, journal writes, and helper invocation were operator-driven.
This verifies the recorded host, launcher, confirmation, runtime, and live
service path; autonomous model reasoning and complete free-form skill execution
remain outside the run.

Operator-helper hashes identify files on disk at report assembly. Earlier
daemon starts did not record a loaded-code hash, so these hashes do not attest
which driver revision every earlier phase loaded. The separate 70-file plugin
source inventory binds the released package to the frozen source commit.

The mutable image tag was an explicit operator choice. Automatic image digest
resolution, custom DNS/TLS, live chain switching, GUI behavior, native macOS
Keychain, and Windows Credential Manager/ACL acceptance were not exercised.
Codex's close confirmation identified the lease but displayed
`Image: (image not recorded)` and no fee recap; its deployment plan showed an
estimated fee. This is an observation from the reviewed replay.
See the separate [terminal fixtures](host-acceptance.md#interactive-terminal-fixtures)
for progress and cancellation visibility limits, and
[native upgrade evidence](current-install-acceptance-0.5.0.md) for preservation.

## Earlier 0.5.0 run

The [initial live report](host-evidence/live-testnet-0.5.0.json) at
`c6fcc5656349edb8599febae9f20df988d503df8` remains unchanged. That earlier run
recorded a cancelled Claude deployment plan, a transient Codex provider-list
HTTP 502, and a retried public receipt timeout. Those observations belong to
that earlier run; they are not fresh failures in this reviewed replay. Its
different wallet, leases, fees, and cleanup results remain in the historical
report. The [0.4.0 report](host-evidence/live-testnet.json) is also unchanged.
