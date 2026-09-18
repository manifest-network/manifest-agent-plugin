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
and gas price when re-writing the config.

**Never** read `$MANIFEST_PLUGIN_DATA/config.json` directly — legacy copies may contain the key password. Always use `update-config.cjs --status` to read safe fields.

## Step 1 — Get mnemonic file path

Ask the user to provide the **path to a file** containing their mnemonic. They
should create this file themselves in a separate terminal, e.g.:

```bash
umask 077
MNEMONIC_INPUT_PATH=$(mktemp)
cat > "$MNEMONIC_INPUT_PATH"
# paste mnemonic, press Enter, then Ctrl+D
printf '%s\n' "$MNEMONIC_INPUT_PATH"
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

Use properly shell-escaped literals for the supplied path and saved values,
including any apostrophes; never insert unescaped text into shell source.
Run, replacing `MNEMONIC_FILE` with the user's file path, `ACTIVE_CHAIN`
with `activeChain` from Step 0, and `CURRENT_GAS_PRICE` with `gasPrice`
from Step 0:

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/import-key.cjs" --prefix manifest < 'MNEMONIC_FILE' | node "$MANIFEST_PLUGIN_ROOT/scripts/write-config.cjs" --chain 'ACTIVE_CHAIN' --gas-price 'CURRENT_GAS_PRICE'
```

The mnemonic flows through the pipe (file → import-key → write-config).
Claude Code sees only the bash invocation (the file path, but not contents)
and `write-config.cjs`'s safe stdout JSON.

After the pipeline succeeds, save its safe JSON output as `WRITTEN_CONFIG`
(`address` and `activeChain`).

If the pipeline fails, stop and show the diagnostic, including the retained
keyfile path. Resolve the credential/config problem before retrying; repeated
imports can leave unused encrypted keyfiles. Never delete a supplied keyfile
automatically, because it may still be the active wallet.
After the user restores store access, the manual
`node "$MANIFEST_PLUGIN_ROOT/scripts/migrate-credentials.cjs"` command retries any
legacy migration immediately. Explicit config writes also bypass the brief pause
used by automatic startup attempts.

Once the wallet/config pipeline succeeds, suggest the user delete their mnemonic file
(e.g. `rm -- "$MNEMONIC_INPUT_PATH"` in the separate terminal where they
created it), even if final status verification is still pending.

### After a successful wallet/config pipeline — Verify saved settings

`write-config.cjs` has already preserved any configured gas multiplier in the
same atomic write as the wallet. No separate gas update is needed.

Read the saved settings before reporting completion:

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --status
```

On success, store the parsed safe output as `FINAL_SETTINGS` and set
`RUN_OUTCOME` to `"success"`. Report the returned gas price and multiplier;
a null multiplier means the effective default is `1.5`. Keep the returned
value's type, including a numeric string from a hand-edited config.

If status fails, set `RUN_OUTCOME` to `"partial"`. Set `FINAL_SETTINGS.address`
and `FINAL_SETTINGS.activeChain` from the successful `WRITTEN_CONFIG` output,
and set only `gasPrice` and `gasMultiplier` to `"unknown"`. Record one
`config_status_failed` error with the sanitized diagnostic in `message`.
Explain that the wallet was written but the final gas settings could not be
read; do not claim the multiplier reverted to the default or was lost.

Resolve the read failure and retry only `--status`. **Do not generate or import
another wallet** to verify settings. If verification cannot finish in this run,
report and journal the partial result and needed recovery action, then stop.
Use empty errors and recovery actions when no failure occurred; otherwise
retain the diagnostic and describe whether the status retry succeeded.

## Step 3 — Report

Report `RUN_OUTCOME` and any recovery diagnostic. Tell the user:
1. Their imported agent address
2. The keyfile location
3. That MCP servers need to be restarted to pick up the new key
4. The actual saved chain, gas price and multiplier from `FINAL_SETTINGS`;
   confirm retention only after verification. A null multiplier uses the
   default `1.5`; unknown means status failed, not that settings were retained
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
  "active_chain": "<FINAL_SETTINGS.activeChain>",
  "signer_address": "<FINAL_SETTINGS.address>",
  "intent": "<a brief paraphrase of the user's request — what they want to accomplish, not their verbatim message; max ~240 chars; do NOT echo any secrets the user may have typed (passwords, API keys, mnemonics) — the value field is not redacted>",
  "plan_summary": "imported key on <activeChain>",
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

Use `RUN_OUTCOME` (`success` or `partial`) from the final status check. Fill
`errors` with the structured errors recorded there and `recovery_actions` with
attempted or needed recovery; both arrays are empty when no failure occurred.
Use the multiplier returned by status, null for the observed default, or
`"unknown"` if status failed. Keep the confirmed wallet address and chain from
`WRITTEN_CONFIG` when status cannot be read.

Create a private temporary directory with `mktemp -d` and capture its returned
path as `JOURNAL_DIR`. Use the **Write tool** to create a **new** file
`journal.json` inside that directory containing the complete redacted record as
JSON, correctly encoding every string. Do not create the file beforehand and
do not use `mktemp -u`. The directory is mode `0700`; the host may create the
file at `0644`, but the private parent prevents other users from accessing it.

Never paste the record, its fields, or tool responses into a Bash
command, heredoc, or `echo`. Redaction does not make user or registry text safe
shell code. Bind `JOURNAL_DIR` to the returned directory as a properly
shell-escaped literal in the same Bash call below; shell variables do
not persist across calls. Pass the file through stdin and clean up only this
staging file and directory, preserving the writer's exit status:

```bash
JOURNAL_PATH="$JOURNAL_DIR/journal.json"
journal_status=0
node "$MANIFEST_PLUGIN_ROOT/scripts/journal-write.cjs" < "$JOURNAL_PATH" || journal_status=$?
rm -f -- "$JOURNAL_PATH" || true
rmdir -- "$JOURNAL_DIR" || true
exit "$journal_status"
```

Also remove the staging file (if created) and directory on cancellation or
Write failure. If appending fails, report the journal diagnostic
without repeating the underlying operation; a journal failure does not undo
completed work.

Do NOT mention the journal write in your reply to the user.

## Security notes

- The mnemonic NEVER appears in this conversation. The user creates a file
  containing it, and the skill pipes that file through scripts without Claude Code
  ever seeing the content.
- The key password also never appears — it flows via pipe from import-key to
  write-config.
- Do NOT read the mnemonic file or `$MANIFEST_PLUGIN_DATA/config.json`.
