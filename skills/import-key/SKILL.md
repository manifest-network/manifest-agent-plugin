---
name: import-key
description: >
  Import an existing mnemonic phrase into the Manifest agent config.
  The mnemonic flows through scripts via stdin and never enters the
  conversation. Use when the user requests this operation.
allowed-tools: Bash(*), Write
disable-model-invocation: true
---

<!-- Generated from workflows/import-key.md by ci/build-packages.cjs. -->

# Import Existing Key

You are importing an existing mnemonic phrase into the Manifest agent
configuration. The mnemonic must NEVER appear in this conversation.

**Do not narrate the skill's internal structure in your chat output.**
Step numbers are scaffolding for skill authors only. To the user, just
describe what you're doing in plain language — e.g. "Now I'll import the
key from the file you provided", not "Now in Step 3 the import pipe runs".

## Step 0 — Verify environment

Run:
```bash
echo "$MANIFEST_PLUGIN_ROOT"
```

If empty, `$MANIFEST_PLUGIN_ROOT` is not set; tell the user to restart Claude Code so the SessionStart hook runs, then stop.

Run:
```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --status
```

If config is absent, tell the user to run `/manifest-agent:init-agent` first and stop.
If an existing config cannot be read, show the sanitized diagnostic and stop
before importing: the user must repair its JSON privately to preserve any legacy
password, or move it aside as a private backup before initialization. Do not
delete it or ask the user to paste its contents. Otherwise parse the JSON;
`activeChain` AND `gasPrice` are required in Step 2 to preserve the existing chain
and gas price when re-writing the config. Also note `gasMultiplier`: the config
writer resets that optional setting to its default of 1.5. Before importing,
explain this if a custom multiplier is configured; offer `/manifest-agent:set-gas-price`
after the import if the user wants to restore it.

**Never** read `$MANIFEST_PLUGIN_DATA/config.json` directly — legacy copies may contain the key password. Always use `update-config.cjs --status` to read safe fields.

## Step 1 — Get mnemonic file path

Ask the user to provide the **path to a file** containing their mnemonic. They
should create this file themselves in a separate terminal, e.g.:

```bash
umask 077
cat > /tmp/mnemonic.txt
# paste mnemonic, press Enter, then Ctrl+D
chmod 600 /tmp/mnemonic.txt
```

**Do NOT use `echo` — it appears in shell history.**

Wait for the user to provide the file path before proceeding.

**CRITICAL**: Do NOT ask the user to paste the mnemonic in the conversation.
Do NOT read the mnemonic file. The file content must never enter Claude Code's context.

## Step 2 — Import key and update config

The password is saved in the OS credential store and config keeps only its
reference. Linux requires `secret-tool` and an unlocked Secret Service session.
For headless use without a keychain, explain the private-file fallback and set
`MANIFEST_CREDENTIAL_STORE=file` only when the user has selected it. A keychain
failure must stop the import, with the existing wallet configuration preserved;
do not work around it by writing a plaintext password into config.

Run (replacing `MNEMONIC_FILE` with the user's file path, `ACTIVE_CHAIN`
with the `activeChain` from Step 0, and `CURRENT_GAS_PRICE` with the
`gasPrice` from Step 0):
Use properly shell-escaped literals for the supplied path and saved values,
including any apostrophes; never insert unescaped text into shell source.

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/import-key.cjs" --prefix manifest < 'MNEMONIC_FILE' | node "$MANIFEST_PLUGIN_ROOT/scripts/write-config.cjs" --chain 'ACTIVE_CHAIN' --gas-price 'CURRENT_GAS_PRICE'
```

The mnemonic flows through the pipe (file → import-key → write-config).
Claude Code sees only the bash invocation (the file path, but not contents)
and `write-config.cjs`'s safe stdout JSON.

Parse the JSON output to get `address` and `activeChain`.

If the pipeline fails, stop and show the diagnostic, including the retained
keyfile path. Resolve the credential/config problem before retrying; repeated
imports can leave unused encrypted keyfiles. Never delete a supplied keyfile
automatically, because it may still be the active wallet.
After the user restores store access, the manual
`node "$MANIFEST_PLUGIN_ROOT/scripts/migrate-credentials.cjs"` command retries any
legacy migration immediately. Explicit config writes also bypass the brief pause
used by automatic startup attempts.

Suggest the user delete their mnemonic file after a successful import.

## Step 3 — Report

Tell the user:
1. Their imported agent address
2. The keyfile location
3. That MCP servers need to be restarted to pick up the new key
4. Any configured gas multiplier was reset to its default of 1.5; the selected
   chain and gas price were retained
5. Backups require the config, encrypted keyfile and referenced credential;
   the original mnemonic is the independent recovery option

## Step 4 — Record this run in the journal

Append one record to the operation journal at
`$MANIFEST_PLUGIN_DATA/journal/<YYYY-MM-DD>.jsonl`. The writer auto-fills
`timestamp_iso`, `timestamp_unix`, `schema_version`, and `session_id` —
omit them. Do NOT include any key matching the writer's secret denylist
— `_journal.SECRET_KEY_DENYLIST` (mnemonic, password, private_key,
secret_key, api_key, auth_token, bearer_token — case-insensitive,
optional `_`/`-` separators; canonical regex in `scripts/_journal.cjs`);
the writer is fail-closed and will exit 1 rather than append such
records. This is the defense in depth for this skill.

Build the redacted record as an object with this shape. Placeholders describe
in-memory values; never substitute them into shell source or treat the sketch
as already serialized JSON.

```text
{
  "skill": "import-key",
  "active_chain": "<activeChain from Step 0>",
  "signer_address": "<address parsed from write-config output>",
  "intent": "<a brief paraphrase of the user's request — what they want to accomplish, not their verbatim message; max ~240 chars; do NOT echo any secrets the user may have typed (passwords, API keys, mnemonics) — the value field is not redacted>",
  "plan_summary": "imported key on <activeChain>",
  "tool_calls": [],
  "outcome": "success",
  "final_state": {
    "address": "<address>",
    "active_chain": "<activeChain>"
  },
  "errors": [],
  "recovery_actions": []
}
```

Create a private temporary file with `mktemp` and capture its path as
`JOURNAL_PATH`. Use the **Write tool** to serialize the complete redacted
record to that file as JSON, correctly encoding quotes, backslashes and newlines.
Never put the record, its fields or tool responses into a Bash command,
heredoc or `echo`; redaction does not make user text safe shell code.
Set `JOURNAL_PATH` to its shell-quoted path in the same Bash call; shell
variables do not persist across calls. Pass the file through stdin:

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/journal-write.cjs" < "$JOURNAL_PATH"
```

Remove the temporary file after the call, preserving the writer's exit status.
If appending fails, report its diagnostic without repeating the import; a journal
failure does not undo the saved wallet configuration.

Do NOT mention the journal write in your reply to the user.

## Security notes

- The mnemonic NEVER appears in this conversation. The user creates a file
  containing it, and the skill pipes that file through scripts without Claude Code
  ever seeing the content.
- The key password also never appears — it flows via pipe from import-key to
  write-config.
- Do NOT read the mnemonic file or `$MANIFEST_PLUGIN_DATA/config.json`.
