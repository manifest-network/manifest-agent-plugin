# Native upgrade and preservation acceptance for 0.5.0

Claude Code **2.1.270** and Codex CLI **0.154.0** passed a fresh native upgrade,
reinstall, and runtime-repair run on **2026-09-17**, against reviewed source
`4bbd5af14c504ac280fc6dc8c14383c6fff6c832`. The run used plugin **0.5.0**,
MCP **0.22.0**, and Node **24.15.0**. The
[reviewed evidence report](host-evidence/current-install-preservation-0.5.0-reviewed.json)
contains new file measurements, native commands, actual terminal tool results,
offline signing checks, source hashes, and verified cleanup. It replaces no
historical observations.

Both hosts started with a native **0.4.0** installation and a fresh, unfunded
encrypted wallet whose password used the legacy plaintext config field.
Native remove/install under the same plugin identity preserved the saved data;
Claude used `--keep-data`. Production 0.5.0 startup then migrated the password
to an explicitly selected private file credential store and removed it from
config. Only the credential representation and migration metadata changed.
The wallet, address, chain, gas price, custom gas multiplier, and six other
saved files were retained. No legacy-upgrade exemption was used.

| Check | Claude Code | Codex CLI |
| --- | --- | --- |
| Native 0.4.0 → reviewed 0.5.0 and automatic credential migration | Passed | Passed |
| Current-version native remove/reinstall | Passed | Passed |
| Seven saved files and separate credential file | Identical bytes, sizes, and 0600 modes at all six stages | Same checks passed |
| Encrypted-wallet decryption and offline signature verification | Passed at every stage | Passed at every stage |
| Saved-record and journal readers | Both wrapper schemas readable; private canary redacted | Same checks passed |
| Automatic locked runtime repair | Passed | Passed |
| Actual `list_modules` after upgrade, reinstall, and repair | All three passed | All three passed |
| Installed source comparison | 185 files matched the prepared package | 80 files matched the prepared package |

The six snapshots cover baseline after migration, after startup, while
uninstalled, immediately after native installation, after the reinstalled
session, and after runtime repair. The seven files are config, the encrypted
wallet, chain metadata, a draft, schema 2 and 3 saved wrappers, and a historical
journal. Credential-file preservation is measured separately. The original
legacy installation also passed its own actual read-only `list_modules` probe.

Repair removed only
`node_modules/@manifest-network/manifest-mcp-node/package.json`, leaving the
completion record in place. Runtime inspection rejected both damaged installs.
Native startup performed the real locked installation and restored the exact
original dependency-file hash, while all saved state remained unchanged.

Each host used its own disposable home and native persistent data root. The
terminals and published MCP packages were real; a deterministic local model
issued only operator-queued read-only calls, and the operator answered visible
native permissions. Signing remained offline and RPC/REST pointed at disabled
loopback endpoints. The minimal config omitted converter and faucet settings,
so this establishes chain-tool startup and local preservation, not complete
network discovery or all MCP operations. The records were synthetic fixtures;
this run does not establish live deployment behavior, hosted-model reasoning,
GUI behavior, native OS credential-store access, cross-machine portability, or
other operating systems. Version transition used remove/install, not a
marketplace update-in-place.

The report binds the fresh
[reviewed Claude terminal](host-evidence/claude-terminal-0.5.0-reviewed.json) and
[reviewed Codex terminal](host-evidence/codex-terminal-0.5.0-reviewed.json)
reports by digest and source commit. Those reports retain their own permission,
progress, and cancellation limits. Public preservation evidence was scanned
against the generated passwords, encrypted-wallet payloads, and private canary
values. Both local model endpoints closed, all owned processes stopped, and
all temporary profiles, keys, credentials, marketplaces, caches, and saved
records were removed. No chain or provider resources were created.

The report's helper hashes identify the files on disk at report assembly. The
driver changed during the run, and each daemon's loaded revision was not hashed
at launch; those hashes are reproduction references, not proof that every phase
loaded the same driver bytes. The separate 70-file plugin source inventory and
installed-package comparisons retain their frozen-source binding.

## Earlier 0.5.0 run

The [initial preservation report](host-evidence/current-install-preservation-0.5.0.json)
at `c6fcc5656349edb8599febae9f20df988d503df8` remains unchanged. Its first
upgraded Claude session exceeded the native 30-second MCP connection timeout
while automatic runtime setup was running. A fresh session retained that failed
connection state; **`/mcp` → `manifest-chain` → `Reconnect`** restored the
read-only probe. Runtime policy and public startup diagnostics remained visible.
The reviewed replay used a warmed private npm cache and connected without a
native chain reconnect. That success does not invalidate the earlier cold-start
limitation. Historical 0.4.0 reports also remain unchanged.
