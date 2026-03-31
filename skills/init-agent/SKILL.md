---
name: init-agent
description: >
  Set up a Manifest blockchain agent — install dependencies, choose a chain,
  generate or import a keypair, and configure the MCP servers. Run this first
  after installing the plugin.
allowed-tools: Bash(*), Read, Write, Glob, Grep
---

# Initialize Manifest Agent

You are interactively setting up a Manifest blockchain agent. Follow these steps
exactly, asking the user questions where indicated.

## Step 0 — Verify environment

Run:
```bash
echo "$MANIFEST_PLUGIN_ROOT"
```

If the output is empty, tell the user:
> `MANIFEST_PLUGIN_ROOT` is not set. Please restart Claude Code so the
> SessionStart hook can run, then try again.

Stop here if empty.

## Step 1 — Install dependencies

```bash
mkdir -p ~/.manifest-agent && cp "$MANIFEST_PLUGIN_ROOT/package.json" ~/.manifest-agent/package.json && cd ~/.manifest-agent && npm install --production
```

**If npm install fails, STOP and report the error to the user. Do not proceed
to subsequent steps.**

## Step 2 — Fetch chain registry data

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/fetch-chain-registry.cjs"
```

Parse the JSON output. This fetches both mainnet and testnet data from the
Cosmos chain registry.

## Step 3 — Choose chain

Ask the user which chain they want to use:

- **testnet** (`manifest-ledger-testnet`) — recommended for development and testing
- **mainnet** (`manifest-ledger-mainnet`) — real assets, use with care

Wait for the user's answer before proceeding.

## Step 4 — Check for existing agent

Read `~/.manifest-agent/config.json`. If it exists and has an `agent` section,
warn the user:

> An agent key already exists at `<keyFile>` with address `<address>`.
> Proceeding will generate a new key. The old key's password will be lost
> (the old keyfile stays on disk but becomes unrecoverable without the password).

Ask for confirmation before continuing.

## Step 5 — Generate or import key

Ask the user: **Generate a new key** or **import an existing mnemonic**?

### If generating a new key:

```bash
NODE_PATH=$HOME/.manifest-agent/node_modules node "$MANIFEST_PLUGIN_ROOT/scripts/gen-agent-key.cjs" --prefix manifest
```

Parse the JSON output to get `address`, `keyfile`, `password`, and `agentId`.

### If importing an existing mnemonic:

Ask the user to provide their mnemonic phrase (12 or 24 words).

**Security warning**: Tell the user the mnemonic will appear in the conversation
context.

Then run (replacing the mnemonic words):

```bash
NODE_PATH=$HOME/.manifest-agent/node_modules node "$MANIFEST_PLUGIN_ROOT/scripts/import-key.cjs" --prefix manifest <<'EOF'
word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12 word13 word14 word15 word16 word17 word18 word19 word20 word21 word22 word23 word24
EOF
```

**CRITICAL**: Use `<<'EOF'` (single-quoted delimiter) to prevent shell expansion.

Parse the JSON output to get `address`, `keyfile`, `password`, and `agentId`.

**After receiving the mnemonic, NEVER echo it back in any output.**

## Step 6 — Write config

Read the chain data from `~/.manifest-agent/chains/<chosen-chain>.json` (where
`<chosen-chain>` is `mainnet` or `testnet`).

Also read the other chain's file if it exists (so both are stored in config).

Write `~/.manifest-agent/config.json` with:

```json
{
  "activeChain": "<testnet|mainnet>",
  "chains": {
    "mainnet": { "<contents of mainnet.json>" },
    "testnet": { "<contents of testnet.json>" }
  },
  "agent": {
    "keyFile": "<keyfile path from step 5>",
    "keyPassword": "<password from step 5>",
    "address": "<address from step 5>"
  }
}
```

Then set permissions:

```bash
chmod 600 ~/.manifest-agent/config.json
```

## Step 7 — Report results

Tell the user:
1. Their agent address
2. The keyfile location
3. Which chain is active
4. That MCP servers need to be restarted to use the new config — they can do
   this by running `/mcp` and reconnecting, or by restarting Claude Code

## Step 8 — Offer testnet funding

If the user chose testnet, suggest requesting faucet funds to the new address
using the `mcp__manifest-chain__request_faucet` tool if it is available.

## Security notes

- Never display the mnemonic or password in conversation output
- The keyfile is encrypted; the password is stored only in config.json (0600)
- Never log or display the mnemonic. Only the address and keyfile path are safe
  to show.
