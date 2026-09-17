# Native upgrade and preservation acceptance for 0.5.0

Claude Code **2.1.270** and Codex CLI **0.154.0** passed saved-data preservation,
native reinstall, and automatic runtime-repair checks on **2026-09-17**.
The tested source was `c6fcc5656349edb8599febae9f20df988d503df8`, using plugin
**0.5.0**, MCP **0.22.0**, and Node **24.15.0**.
[The evidence report](host-evidence/current-install-preservation-0.5.0.json)
contains file hashes, permissions, native commands, actual terminal tool
results, source verification, migration observations, and verified cleanup.

This run also exercised a native **0.4.0 → 0.5.0** transition with a legacy
plaintext wallet password. It does not use the earlier release's
`no-existing-users` exemption. Both hosts automatically moved the password to
an explicitly selected private file credential store, removed it from
`config.json`, and retained the original encrypted wallet and address. The only
config changes were the credential reference and migration metadata; the other
six saved files remained identical. Offline signature generation and
cryptographic verification passed before and after migration.

| Check | Claude Code | Codex CLI |
| --- | --- | --- |
| Native version transition | Uninstall with `--keep-data`, install 0.5.0 under the same plugin identity | Remove, add 0.5.0 under the same plugin identity |
| Automatic legacy migration | Passed; cold-start connection recovery described below | Passed |
| Current-version native reinstall | Passed | Passed |
| Seven saved files and credential file | Identical bytes, sizes, and 0600 permissions | Identical bytes, sizes, and 0600 permissions |
| Original encrypted wallet | Offline signing verified at every saved-state stage | Offline signing verified at every saved-state stage |
| Saved-record readers | Chain, gas price, draft, schema 2/3 wrappers, and journal preserved; canary redacted | Same checks passed |
| Automatic dependency repair | Passed | Passed |
| Actual `list_modules` | Passed before reinstall, after reinstall, and after repair | Same three probes passed |

The first upgraded Claude session exceeded the host's **30-second MCP
connection timeout** while automatic runtime installation and initialization
were running. Its runtime policy, public identity, and startup diagnostic
remained visible. A fresh session retained the failed connection state.
**`/mcp` → `manifest-chain` → `Reconnect`** restored the connection, after which
the actual read-only probe passed. This observation limits the cold-start
claim: completing migration and installing dependencies did not guarantee
immediate tool availability in that first session. The later reinstall and
repair probes passed without another chain reconnect.

The six current-version snapshots were taken after successful migration:
baseline, after startup, while uninstalled, immediately after native install,
after the reinstalled session, and after runtime repair. They cover config,
the encrypted key file, chain metadata, a draft, two saved-manifest schemas,
and a historical journal. The new credential file is recorded separately from
the seven categories required by the existing validator. Readers and offline
signing were checked at each stage, using the prepared release helpers even
while the plugin was uninstalled.

Repair removed only
`node_modules/@manifest-network/manifest-mcp-node/package.json`, leaving the
completion record intact. Production runtime inspection detected the damage;
native startup ran the real locked installation and restored the original
dependency-file hash. Installed plugin files were also compared byte for byte
with the prepared release packages: 173 Claude files and 80 Codex files.

Each host used a separate disposable home and its native persistent data root.
The CLI terminals and published MCP packages were real; a local model driver
selected only operator-requested read-only calls. Wallets were fresh and
unfunded, signing stayed offline, and RPC/REST used disabled loopback endpoints.
The minimal config omitted converter and faucet settings. This run establishes
chain-tool startup and local preservation; it does not establish full network
discovery, other MCP operations, live deployments, OS credential-store access,
cross-machine migration, GUI behavior, or hosted-model reasoning. The tested
version transition used native remove/install, not marketplace update-in-place.

The report binds the separate fresh
[Claude terminal](host-evidence/claude-terminal-0.5.0.json) and
[Codex terminal](host-evidence/codex-terminal-0.5.0.json) evidence by digest and
source commit. Those reports retain their own permission, progress, and
cancellation limits. Historical 0.4.0 evidence remains unchanged.

Public evidence was scanned for the generated passwords, encrypted wallet
payloads, and private canary values. All disposable host processes and model
endpoints were stopped, then profiles, wallets, credentials, marketplaces,
caches, and saved test records were removed. This run created no chain or
provider resources.
