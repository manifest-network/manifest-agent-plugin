---
name: import-key
description: >
  Import an existing mnemonic phrase into the Manifest agent config.
  Use when the user wants to re-use an existing blockchain identity.
allowed-tools: Bash(*), Read, Write
---

# Import Existing Key

You are importing an existing mnemonic phrase into the Manifest agent
configuration. Follow these steps exactly.

## Step 0 — Verify environment

Run:
```bash
echo "$MANIFEST_PLUGIN_ROOT"
```

If the output is empty, tell the user to restart Claude Code and stop.

## Step 1 — Check config exists

Check if `~/.manifest-agent/config.json` exists by reading it.

If it does not exist, tell the user:
> No agent configuration found. Run `/manifest-agent:init-agent` first to set up
> the chain configuration and install dependencies.

Stop here.

## Step 2 — Get mnemonic

Ask the user to paste their mnemonic phrase (12 or 24 words).

**Warn them**: The mnemonic will appear in the conversation context.

## Step 3 — Import key

Run (replacing the words with the user's mnemonic):

```bash
NODE_PATH=$HOME/.manifest-agent/node_modules node "$MANIFEST_PLUGIN_ROOT/scripts/import-key.cjs" --prefix manifest <<'EOF'
word1 word2 word3 ... word24
EOF
```

**CRITICAL**: Use `<<'EOF'` (single-quoted delimiter) to prevent shell expansion.

Parse the JSON output to get `address`, `keyfile`, `password`, and `agentId`.

**After receiving the mnemonic, NEVER echo it back in any output.**

## Step 4 — Update config

Read `~/.manifest-agent/config.json`, update the `agent` section:

```json
{
  "agent": {
    "keyFile": "<keyfile path from step 3>",
    "keyPassword": "<password from step 3>",
    "address": "<address from step 3>"
  }
}
```

Write the updated config back, then:

```bash
chmod 600 ~/.manifest-agent/config.json
```

## Step 5 — Report

Tell the user:
1. Their imported agent address
2. The keyfile location
3. That MCP servers need to be restarted to pick up the new key

## Security notes

- NEVER display the mnemonic after receiving it
- The mnemonic is piped via stdin to avoid appearing in process listings
- Warn the user that the mnemonic should be stored securely offline
