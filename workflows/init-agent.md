---
name: init-agent
description: >
  Set up the Manifest agent's chain configuration and keypair. Run this once
  after installing the plugin (or to re-key); it picks a chain, generates or
  imports a wallet, and writes config.json. User-invoked only — not for
  {{host}} to auto-discover.
allowed-tools: Bash(*), Write
disable-model-invocation: true
---

# Initialize Manifest Agent

You are interactively setting up a Manifest blockchain agent. Follow these steps
exactly, asking the user questions where indicated.

**For all user choices, use the `{{ask}}` tool.**

**Do not narrate the skill's internal structure in your chat output.**
Step numbers (e.g. "Step 3", "Step 5") are scaffolding for skill authors
only. To the user, just describe what you're doing in plain language —
e.g. "Now I'll generate your wallet keypair", not "Now in Step 5 the key
generation". Skip phrases like "Now in Step N"; describe the action itself.

## Step 0 — Verify environment

Run:
```bash
echo "$MANIFEST_PLUGIN_ROOT"
```

If empty, `$MANIFEST_PLUGIN_ROOT` is not set; {{environment_recovery}}.

Ensure the locked runtime is installed before running helpers that need it:

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/setup-runtime.cjs"
```

This is also the repair command for an interrupted install or missing dependencies.
It preserves configuration, keys, drafts, and saved deployments. If it fails,
report its diagnostic and stop; fix Node (22.19.0+) or the installation failure
before continuing. Re-keying is not a dependency repair.

Wallet passwords use the OS credential store: Linux needs `secret-tool` (libsecret)
and an unlocked Secret Service session; macOS uses Keychain; Windows uses Credential
Manager through Windows PowerShell. In a headless environment without that service,
explain that `MANIFEST_CREDENTIAL_STORE=file` stores a recoverable secret in private
files under the data directory. Use this fallback only if the user chooses it;
set it in the environment launching the host and in each setup shell. Never silently
switch backends after a keychain error, or put passwords into config or command args.
If credential setup fails, report the diagnostic and stop before claiming success.
After the user restores credential-store access, run
`node "$MANIFEST_PLUGIN_ROOT/scripts/migrate-credentials.cjs"` to retry any legacy
migration immediately. Automatic startup attempts pause briefly after a store
failure; this manual command and explicit config writes bypass that pause.

For a repair-only request, run `update-config.cjs --status` after setup. If
an existing agent is configured, report that dependencies are repaired and
ask the user to reconnect the MCP servers or restart {{host}}, then stop.
Do not continue into chain selection or key generation. If config is absent
or invalid, explain that separately and continue onboarding only when the
user's request includes initial setup or configuration repair. An existing invalid
config must first be repaired privately or moved aside as a private backup; it may
still hold a recoverable legacy password. Do not treat that file as absent.

## Step 1 — Fetch chain registry data

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/fetch-chain-registry.cjs"
```

Check the exit status and parse the JSON output. Each present network key
identifies data successfully fetched and saved; omitted networks were not
refreshed. On nonzero exit or no successful networks, report the diagnostic
and stop before creating a key or writing config. Preserve partial-refresh
diagnostics and do not claim both networks were refreshed when only one was.

## Step 2 — Choose chain

Use {{ask}} to ask which chain to use, with these options:

- **testnet** — manifest-ledger-testnet (recommended for development)
- **mainnet** — manifest-ledger-mainnet (real assets, use with care)

Store the answer as `CHOSEN_CHAIN` (`testnet` or `mainnet`). Require that key
in the successful Step 1 output before continuing. If it is absent, report
that the selected network was not refreshed and stop before creating a key
or writing config; an older cached file is not proof of a fresh fetch.

## Step 3 — Choose gas fee token

Look at the `feeTokens` array for the chosen chain from the Step 1 output.
Each fee token has a `symbol` (human-readable name like "MFX" or "PWR") and
a `fixedMinGasPrice`.

Use {{ask}} to ask which token to use for gas fees, showing the
**symbol** and **min gas price** for each. For example:

- **MFX** (min gas price: 1)
- **PWR** (min gas price: 0.37)

Store the user's choice as `GAS_TOKEN` (the symbol). The script handles the
denom resolution and gas-price string composition; do NOT compose it inline.

## Step 4 — Check for existing agent

Run:
```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --status
```

On a successful status read, capture `gasMultiplier` as
`PREVIOUS_GAS_MULTIPLIER` before either wallet path writes config. Preserve the
exact integer or fractional value. If it is absent/null, or config is absent
for first-time setup, use null so the default remains `1.5`. Keep this value in
workflow memory for the checked restoration after the wallet/config pipeline.

If the command succeeds and the JSON output has a non-null `address` field,
warn the user:

> An agent key already exists with address `<address>`.
> Proceeding will replace the active wallet. Back up its config, encrypted
> keyfile and OS credential store (or the explicitly selected credential files)
> first if you need to restore this identity later. Existing funds stay at the old address.

Confirm via `{{ask}}` (Yes / No) before continuing. Stop on No.

If the command fails, check whether `$MANIFEST_PLUGIN_DATA/config.json` exists
without reading its contents. If it is absent, proceed with initial setup. If it
exists, show the sanitized diagnostic and stop before generating a key. The user
can repair the JSON privately to retain a legacy password, or move it aside as a
private backup before starting initialization again. Do not delete it or ask the
user to paste its contents. A successful status with no address also needs this
configuration-repair check before replacing the file.

**IMPORTANT**: Do NOT read `$MANIFEST_PLUGIN_DATA/config.json` directly — legacy copies may contain
the key password. Always use `update-config.cjs --status` to read safe fields.

## Step 5 — Generate or import key and write config

Use {{ask}} to ask the user:

- **Generate a new key** — create a fresh keypair
- **Import an existing mnemonic** — use a key you already have

### If generating a new key:

The key script pipes directly into write-config so the password never enters the
conversation:

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/gen-agent-key.cjs" --prefix manifest | node "$MANIFEST_PLUGIN_ROOT/scripts/write-config.cjs" --chain 'CHOSEN_CHAIN' --gas-token 'GAS_TOKEN'
```

Replace `CHOSEN_CHAIN` with the user's choice from Step 2 and `GAS_TOKEN`
with the symbol they chose in Step 3 (e.g., `MFX`), using properly shell-escaped
literals including any apostrophes. Registry symbols are data, not shell code.

Parse the JSON output from stdout to get `address` and `activeChain`.

If the pipeline fails, stop and show the sanitized diagnostic. A credential-store
failure can leave a new encrypted keyfile without selecting it in config; the
writer identifies the retained path. Do not delete that file automatically or
generate another key until the credential/config problem has been resolved.

### If importing an existing mnemonic:

This branch uses the same file-pipe pattern as the standalone
`{{invoke:import-key}}` skill (which is the entry point for re-imports
later — once config.json exists, that skill is the canonical way to swap
keys). For first-time setup we run the pipe inline because config.json
doesn't exist yet.

Ask the user to provide the **path to a file** containing their mnemonic.
They create the file themselves in a separate terminal:

```bash
umask 077
MNEMONIC_INPUT_PATH=$(mktemp)
cat > "$MNEMONIC_INPUT_PATH"
# paste mnemonic, press Enter, then Ctrl+D
printf '%s\n' "$MNEMONIC_INPUT_PATH"
```

**Do NOT use `echo`** (shell history). **Do NOT ask the user to paste the
mnemonic in the conversation. Do NOT `{{read_tool}}` the mnemonic file.** The
mnemonic must never enter {{host}}'s context.

Wait for the user to provide the path. Use properly shell-escaped literals
for the supplied path and registry symbol, including any apostrophes; never
insert unescaped text into shell source. Run, substituting `MNEMONIC_FILE`,
`CHOSEN_CHAIN` from Step 2 and `GAS_TOKEN` from Step 3:

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/import-key.cjs" --prefix manifest < 'MNEMONIC_FILE' | node "$MANIFEST_PLUGIN_ROOT/scripts/write-config.cjs" --chain 'CHOSEN_CHAIN' --gas-token 'GAS_TOKEN'
```

If the pipeline fails, stop and report the sanitized diagnostic and retained
keyfile path before retrying. Parse successful JSON output to get `address`
and `activeChain`. Suggest the user delete their mnemonic file after success
(e.g. `rm -- "$MNEMONIC_INPUT_PATH"` in the separate terminal where they
created it).

### After either successful wallet/config pipeline — Restore gas settings

{{restore_gas_multiplier}}

## Step 6 — Report results

Report `RUN_OUTCOME` and any recovery diagnostic. Tell the user:
1. Their agent address
2. The keyfile location
3. Which chain is active
4. The gas fee token and actual saved gas price and multiplier from
   `FINAL_SETTINGS` (null means the default `1.5`; unknown means status failed)
5. That MCP servers need to be restarted to use the new config — they can do
   this through their host's MCP controls or by restarting {{host}}
6. Generated wallets do not display a mnemonic. Back up the config, encrypted
   keyfile and referenced OS credential entry (or the explicit file fallback).
   Imported wallets can also be recovered using the original mnemonic.

## Step 7 — Offer testnet funding

Only after a successful result, if the user chose testnet, suggest requesting
faucet funds to the new address using the `{{tool:chain/request_faucet}}` tool
if it is available.

## Step 8 — Record this run in the journal

Append one record to the operation journal at
`$MANIFEST_PLUGIN_DATA/journal/<YYYY-MM-DD>.jsonl`. The writer auto-fills
`timestamp_iso`, `timestamp_unix`, `schema_version`, and `session_id` —
omit them. Do NOT include any key matching the writer's secret denylist
— `_journal.SECRET_KEY_DENYLIST` (mnemonic, password, private_key,
secret_key, api_key, auth_token, bearer_token — case-insensitive,
optional `_`/`-` separators; canonical regex in `scripts/_journal.cjs`);
the writer is fail-closed and will exit 1 rather than append such
records. This is the defense in depth for this skill — mnemonics flow
only through stdin pipes between scripts and never enter the journal.

Build the redacted record as an object with this shape. Placeholders describe
in-memory values; never substitute them into shell source or treat the sketch
as already serialized JSON.

```text
{
  "skill": "init-agent",
  "active_chain": "<FINAL_SETTINGS.activeChain>",
  "signer_address": "<address parsed from write-config output>",
  "intent": "<a brief paraphrase of the user's request — what they want to accomplish, not their verbatim message; max ~240 chars; do NOT echo any secrets the user may have typed (passwords, API keys, mnemonics) — the value field is not redacted>",
  "plan_summary": "init-agent (<generate|import>) on <chosen chain>, gas_token=<GAS_TOKEN>",
  "tool_calls": [],
  "outcome": "<RUN_OUTCOME>",
  "final_state": {
    "address": "<FINAL_SETTINGS.address>",
    "active_chain": "<FINAL_SETTINGS.activeChain>",
    "gas_price": "<FINAL_SETTINGS.gasPrice>",
    "gas_multiplier": "<FINAL_SETTINGS.gasMultiplier>"
  },
  "errors": [{ "class": "<ERROR.class>", "message": "<ERROR.message>" }],
  "recovery_actions": ["<recovery actions attempted or still needed>"]
}
```

Use `RUN_OUTCOME` (`success` or `partial`) from the checked restoration. Fill
`errors` with the structured errors recorded there and `recovery_actions` with
attempted or needed recovery; both arrays are empty when no failure occurred.
Write the multiplier as a number, null for the observed default, or `"unknown"`
if status failed. Never journal the previous value as though it were restored.

{{journal_write}}

If the user declined the existing-key warning in Step 4 or cancelled at
any choice prompt, set `outcome` to `"cancelled"` and use the last observed
settings (or unknown), since no replacement took place. Do NOT mention the
journal write in your reply to the user.

## Security notes

- The key password NEVER appears in this conversation. It flows directly from
  the key script to write-config via pipe.
- Never display the mnemonic or password in conversation output.
- The keyfile is encrypted; config stores only a credential reference. The password
  is stored in the OS keychain, or separate private files after explicit headless opt-in.
- Never log or display the mnemonic. Only the address and keyfile path are safe
  to show.
