---
name: import-key
description: >
  Import an existing mnemonic phrase into the Manifest agent config.
  Use when the user wants to re-use an existing blockchain identity.
  The mnemonic never enters the conversation.
allowed-tools: Bash(*)
---

# Import Existing Key

You are importing an existing mnemonic phrase into the Manifest agent
configuration. The mnemonic must NEVER appear in this conversation.

## Step 0 — Verify environment

Run:
```bash
echo "$MANIFEST_PLUGIN_ROOT"
```

If the output is empty, tell the user to restart Claude Code and stop.

## Step 1 — Check config exists

Run:
```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --status
```

If the command fails, tell the user:
> No agent configuration found. Run `/manifest-agent:init-agent` first to set up
> the chain configuration and install dependencies.

Stop here.

Parse the JSON output to get `activeChain` — you will need it in Step 3.

**IMPORTANT**: Do NOT read `~/.manifest-agent/config.json` directly — it contains
the key password. Always use `update-config.cjs --status` to read safe fields.

## Step 2 — Get mnemonic file path

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

## Step 3 — Import key and update config

Run (replacing `MNEMONIC_FILE` with the user's file path and `ACTIVE_CHAIN`
with the `activeChain` from Step 1):

```bash
cat MNEMONIC_FILE | NODE_PATH=$HOME/.manifest-agent/node_modules node "$MANIFEST_PLUGIN_ROOT/scripts/import-key.cjs" --prefix manifest | node "$MANIFEST_PLUGIN_ROOT/scripts/write-config.cjs" --chain ACTIVE_CHAIN
```

The mnemonic flows through the pipe (file → import-key → write-config).
Claude only sees `write-config.cjs`'s safe stdout JSON.

Parse the JSON output to get `address`, `activeChain`, and `keyfile`.

Suggest the user delete their mnemonic file after a successful import.

## Step 4 — Report

Tell the user:
1. Their imported agent address
2. The keyfile location
3. That MCP servers need to be restarted to pick up the new key

## Security notes

- The mnemonic NEVER appears in this conversation. The user creates a file
  containing it, and the skill pipes that file through scripts without Claude
  ever seeing the content.
- The key password also never appears — it flows via pipe from import-key to
  write-config.
- Do NOT read the mnemonic file or `~/.manifest-agent/config.json`.
