# Wallet credentials and session identity

Version 0.5.0 stores the wallet password in an OS credential store. The encrypted
wallet stays under the host's persistent data directory; `config.json` contains
`agent.keyFile`, `agent.address`, and a nonsecret `agent.keyPasswordRef` with a
backend and entry ID. Claude and Codex retain their separate identities.

## Desktop setup

| System | Default store | Requirement |
| --- | --- | --- |
| Linux | Secret Service through libsecret | `secret-tool` on PATH and an unlocked Secret Service session, such as GNOME Keyring |
| macOS | Keychain | Built-in `/usr/bin/security` and an unlocked login keychain |
| Windows | Credential Manager | Windows PowerShell and access to the current user's credential store |

On Debian/Ubuntu, `secret-tool` is supplied by `libsecret-tools`; install the
package and start the host inside your desktop/keyring session. A missing D-Bus
session or a locked keyring cannot be repaired by reinstalling npm dependencies.
Unlock the store and reconnect the MCP servers. The Windows helper uses a
process-scoped execution-policy override for its bundled script; organization
Group Policy still takes precedence. Backend diagnostics do not print
the password or native command output.

Codex forwards `MANIFEST_CREDENTIAL_STORE`, `DBUS_SESSION_BUS_ADDRESS` and
`XDG_RUNTIME_DIR` to each MCP launcher so setup and server processes use the same
Linux credential service. `SystemRoot` locates the Windows helper. The PowerShell
bridge reads UTF-8 explicitly, including non-ASCII paths in the file fallback;
ACL operations do not compile the native Credential Manager bridge.

Initialization and key import pipe their secret output directly to
`write-config.cjs`. The writer stores a new credential and verifies a readback
before updating config. Passwords never appear in command arguments or the
writer's output. The launcher resolves the reference at startup and passes the
password to the MCP child in memory through its environment, as required by the
pinned runtime. This does not isolate the signer from other processes running
as the same user.

## Headless and CI fallback

Prefer an unlocked Secret Service session when available. Otherwise explicitly
select file storage in the environment that launches the host:

```bash
export MANIFEST_CREDENTIAL_STORE=file
```

Use the same export in setup shells that generate or import a wallet. This
fallback stores recoverable passwords in a separate `credentials/` directory
under `$MANIFEST_PLUGIN_DATA`, with directory mode 0700 and file mode 0600 on
POSIX. It is **not encryption** and offers no protection against an account
compromise or a backup containing those files. On Windows, the fallback applies a current-user-only ACL to the credential
directory before writing and to credential files before reading. The default
remains Credential Manager.

The selection applies to new entries and legacy migration. Existing references
always use their recorded backend, even if the environment changes. An
unavailable keychain or missing entry never causes a silent downgrade, a new
password, or a fallback to an inherited wallet/password environment variable.

## Existing installs

The first Claude SessionStart after upgrade migrates a plaintext
`agent.keyPassword`. All MCP launchers also migrate before loading the wallet,
which covers Codex and launchers that run before the hook. Config-changing
scripts use the same migration and lock; `update-config.cjs --status` stays
read-only.

Migration holds the config lock, stores and reads back the password, then
atomically replaces config with the reference and a `credentialMigration`
breadcrumb (`version`, backend and completion time). It prints one migration
notice on stderr. Retrying an already migrated config does not create another
entry or notice. A store failure leaves the original config intact and stops
wallet startup; unlock the keychain or explicitly select the headless fallback,
then reconnect. Runtime policy injection still happens if migration fails.

The exclusive `.config.lock` file uses an owner token and Linux process start
time to distinguish stale records from reused PIDs. Waiters stop after 20 seconds
and name the lock path in the diagnostic. Stale recovery is serialized by
`.config.lock.reclaim`; a crashed recovery process can leave this guard behind.
The guard is never automatically stolen. If its timeout diagnostic appears,
stop all configuration writers and MCP launchers, verify none remain running,
then remove only `$MANIFEST_PLUGIN_DATA/.config.lock.reclaim` and reconnect.
Never remove a recovery guard while a configuration process is active.

A native-store migration failure
creates `.credential-migration-failure.json`, a private marker containing only
the backend, config hash and failure time. Matching launchers fail promptly with
a retry delay for up to 30 seconds, preventing repeated prompts from the five servers.
Changing config or selecting the file fallback allows an immediate retry; a
successful migration removes the marker. No failure cache applies to file storage.

Atomic replacement removes the plaintext field from the current config; it
cannot erase copies in backups, snapshots or filesystem history. Do not restore
an old plaintext config as a routine dependency repair.

For a manual migration, load the host environment first, then run:

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/migrate-credentials.cjs"
```

If an older Codex package cannot forward the headless selection, run the migration
from a plain shell after selecting the intended host data directory:

```bash
MANIFEST_CREDENTIAL_STORE=file node "$MANIFEST_PLUGIN_ROOT/scripts/migrate-credentials.cjs"
```

This is an explicit choice of private file storage for legacy plaintext config.
Existing keychain references still require access to their original store.

## Startup balance and faucet guidance

On a new Claude session, the hook delivers the agent address, active chain and
chain ID, gas denom, balance and faucet guidance through structured
`hookSpecificOutput.additionalContext` for the model and `systemMessage` for
the user. Successful-hook stderr is a debug diagnostic channel, so the hook
does not rely on it for this report. It initializes the chain MCP server and
calls only `cosmos_query` with `module: bank`, `subcommand: balance`, and the
address and denom. It does not send transactions or request faucet funds.
An unavailable credential/launcher is distinguished from a failed chain query.
Failures do not prevent the session policy from loading, and migration failure
guidance is included in the visible message and model context.

The pinned MCP requires wallet resolution and decryption even for a public
balance query, so this probe adds a keychain lookup and server startup work.
The five-second query budget can expire on a slow machine. Resume, fork, clear
and compaction still receive policy and environment exports but skip the balance
probe; no RPC latency or repeated decrypt is added on those events.

For testnet, a balance below `ceil(gas price × 200,000 × 2)` prompts the user to
request faucet funds. A zero balance always produces the hint, including when
the configured gas price is zero. Mainnet never gets a faucet hint. This is a
gas-funding advisory, not a deployment cost estimate; credit requirements and
actual transaction fees are checked by their normal workflows.

Codex migrates through the shared launcher and has no SessionStart hook. After
loading its skill environment, the same report can be run manually:

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/session-identity.cjs"
```

The manual command writes its report to stderr and rejects additional arguments.
Its hook-report flags are internal to the SessionStart integration.

## Backup and recovery

Keep the original mnemonic in your own secure backup. A config plus encrypted
keyfile alone is no longer a complete wallet backup: recovery also needs the
referenced OS keychain entry, or `credentials/` for the file fallback. Preserve
the full data directory and back up the OS credential store using the platform's
supported procedures. Do not print or paste a credential into conversation.

Replacing the active wallet creates a separate credential entry and retains
the old encrypted keyfile and credential. Back up the old config as well if you
need its reference later; re-keying does not move the old wallet's funds.
The plugin does not garbage-collect keychain entries during re-keying or uninstall.
Restoring a copied data directory on another machine requires restoring its
referenced credential or explicitly importing the original mnemonic.

An unreadable or malformed existing config is never silently overwritten. Its
diagnostic names the path: repair the JSON privately to recover any legacy
password, or move the file aside as a private backup before running initialization.
Protect that backup like a password file (0600 on POSIX); do not paste it into
chat. Missing or invalid legacy wallet fields follow the same recovery path.
If credential storage fails after key generation/import, the writer reports the
retained keyfile. It never deletes an arbitrary supplied path, which could be the
active wallet; repeated attempts may leave unused encrypted keyfiles.

Automated tests exercise platform command contracts and isolated file storage.
An isolated Linux D-Bus/GNOME Keyring session verified real libsecret storage,
readback, fresh config creation and plaintext migration without accessing the user's keychain. Live
macOS Keychain and Windows Credential Manager acceptance remains unverified;
Windows ACL and helper invocation checks use mocks.
