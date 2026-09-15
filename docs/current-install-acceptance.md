# Current-install acceptance for ENG-894

Claude Code **2.1.270** and Codex CLI **0.154.0** passed native reinstall and
automatic runtime-repair checks on **2026-09-14**, using plugin **0.4.0**,
MCP/agent-core **0.22.0**, and Node **24.15.0**. The tested plugin source is
`6d5a841107ec752a3967ba3461932efe6abdb3b6`.
[The evidence](host-evidence/current-install-preservation.json) records public
wallet addresses, file hashes and permissions, native plugin commands, rendered
terminal screens, MCP results, and cleanup.

The repository owner excluded legacy-version migration because nobody uses
the old plugin. These checks cover reinstalling the current version and
repairing its dependencies. They do not establish a version-to-version upgrade
path. Release rows declare this exemption explicitly and require both
`reinstall` and `runtime-repair` coverage instead of `upgrade`.

| Check | Claude Code | Codex CLI |
| --- | --- | --- |
| Native remove/reinstall | `plugin uninstall … --keep-data`, then `plugin install …` | `plugin remove …`, then `plugin add …` |
| Seven saved files | Identical SHA-256, sizes and 0600 permissions | Identical SHA-256, sizes and 0600 permissions |
| Original encrypted wallet | Decryption and offline signing passed at every stage | Decryption and offline signing passed at every stage |
| Config and saved-record readers | Selected chain, gas price, both manifest schemas and old journal retained | Selected chain, gas price, both manifest schemas and old journal retained |
| Secret redaction | Manifest summaries retained the environment key and hid its private value | Manifest summaries retained the environment key and hid its private value |
| Damaged runtime | SessionStart restored the removed dependency metadata | Native adapters restored the removed dependency metadata |
| Read-only MCP operation | `list_modules` succeeded before reinstall, after reinstall and after repair | `list_modules` succeeded before reinstall, after reinstall and after repair |

Each profile contained a fresh random encrypted wallet, config, chain metadata,
a draft, synthetic schema 2/3 saved-manifest wrappers, and a historical journal.
Hashes were captured before starting either host, then compared after startup,
while uninstalled, after native installation, after the next host session,
and after runtime repair. Repair was triggered by removing only
`node_modules/@manifest-network/manifest-mcp-node/package.json`, leaving the
completion record intact. Runtime inspection rejected the missing file;
automatic setup restored its original hash and the locked runtime.

Both hosts ran concurrently in separate temporary homes. Claude used its
native persistent plugin-data directory; Codex used its default
`$HOME/.local/share/manifest-agent/codex` root. Deliberately inherited variables
pointing at the other host's data did not redirect those roots. No user profile
was changed.

The terminals and published MCP packages were real; a local model driver
selected the read-only tool call. The wallets were unfunded and signing was
offline. RPC/REST pointed at disabled loopback endpoints. The minimal config
omitted the converter address and faucet URL, so CosmWasm appeared unavailable
and the faucet tool was absent. This preservation run does not claim full
network discovery, GUI coverage, model reasoning, or live deployments. The
separate [live-testnet evidence](live-testnet-acceptance.md) covers the provider
lifecycle and actual saved deployment records.

The original terminal fixtures retain their commit, hashes and observations.
The [reviewed Claude](host-evidence/claude-terminal-reviewed.json) and
[reviewed Codex](host-evidence/codex-terminal-reviewed.json) runs at `ba19d43`
repeat all nine cases with verified process cleanup. The preservation report's
terminal links now bind those transcripts by digest and commit, retaining the
superseded links as metadata. No preservation measurements changed. All 61
core runtime source hashes still match. The documented limits remain: Codex did not display MCP
phase messages or forward cancellation within two seconds; Claude discarded
the late cancellation warning; neither final interruption screen retained the
lease identifier. This acceptance does not claim those host behaviors changed.

Public evidence was checked against the private wallet passwords, encrypted
wallet payloads and environment canaries before archiving. All temporary host
sessions, local model endpoints, wallets, configs, caches and test records were
removed afterward. No chain or provider resources were created by this run.
