---
description: >
  Import an existing mnemonic phrase into the Manifest agent config.
  The mnemonic flows through scripts via stdin and never enters the
  conversation. User-invoked only — not for Claude to auto-discover.
allowed-tools: Bash(*)
disable-model-invocation: true
---

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

If it fails, tell the user to run `/manifest-agent:init-agent` first and stop. Otherwise parse the JSON; you need `activeChain` AND `gasPrice` — both are required in Step 2 to preserve the existing chain + gas-price settings when re-writing the config.

**Never** read `$MANIFEST_PLUGIN_DATA/config.json` directly — it contains the key password. Always use `update-config.cjs --status` to read safe fields.

## Step 1 — Get mnemonic file path

Ask the user to provide the **path to a file** containing their mnemonic. They
should create this file themselves in a separate terminal, e.g.:

```bash
cat > /tmp/mnemonic.txt
# paste mnemonic, press Enter, then Ctrl+D
chmod 600 /tmp/mnemonic.txt
```

**Do NOT use `echo` — it appears in shell history.**

Wait for the user to provide the file path before proceeding.

**CRITICAL**: Do NOT ask the user to paste the mnemonic in the conversation.
Do NOT read the mnemonic file. The file content must never enter Claude's context.

## Step 2 — Import key and update config

Run (replacing `MNEMONIC_FILE` with the user's file path, `ACTIVE_CHAIN`
with the `activeChain` from Step 0, and `CURRENT_GAS_PRICE` with the
`gasPrice` from Step 0):

```bash
cat MNEMONIC_FILE | node "$MANIFEST_PLUGIN_ROOT/scripts/import-key.cjs" --prefix manifest | node "$MANIFEST_PLUGIN_ROOT/scripts/write-config.cjs" --chain ACTIVE_CHAIN --gas-price CURRENT_GAS_PRICE
```

The mnemonic flows through the pipe (file → import-key → write-config).
Claude sees only the bash invocation (the file path, but not contents)
and `write-config.cjs`'s safe stdout JSON.

Parse the JSON output to get `address` and `activeChain`.

Suggest the user delete their mnemonic file after a successful import.

## Step 3 — Report

Tell the user:
1. Their imported agent address
2. The keyfile location
3. That MCP servers need to be restarted to pick up the new key

## Step 4 — Record this run in the journal

Append one record to the operation journal at
`$MANIFEST_PLUGIN_DATA/journal/<YYYY-MM-DD>.jsonl`. The writer auto-fills
`timestamp_iso`, `timestamp_unix`, `schema_version`, and `session_id` —
omit them. Do NOT include any key whose name contains `password` or
`mnemonic`; the writer refuses to append such records (this is the
defense in depth for this skill).

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/journal-write.cjs" <<'JOURNAL_EOF'
{
  "skill": "import-key",
  "active_chain": "<activeChain from Step 0>",
  "signer_address": "<address parsed from write-config output>",
  "intent": "<the user's request, in their words, max ~240 chars>",
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
JOURNAL_EOF
```

Do NOT mention the journal write in your reply to the user.

## Security notes

- The mnemonic NEVER appears in this conversation. The user creates a file
  containing it, and the skill pipes that file through scripts without Claude
  ever seeing the content.
- The key password also never appears — it flows via pipe from import-key to
  write-config.
- Do NOT read the mnemonic file or `$MANIFEST_PLUGIN_DATA/config.json`.
