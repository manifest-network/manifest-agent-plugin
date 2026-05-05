---
name: init-agent
description: >
  Set up the Manifest agent's chain configuration and keypair. Run this once
  after installing the plugin (or to re-key); it picks a chain, generates or
  imports a wallet, and writes config.json. User-invoked only — not for
  Claude to auto-discover.
allowed-tools: Bash(*)
disable-model-invocation: true
---

# Initialize Manifest Agent

You are interactively setting up a Manifest blockchain agent. Follow these steps
exactly, asking the user questions where indicated.

**For all user choices, use the `AskUserQuestion` tool.**

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

If empty, `$MANIFEST_PLUGIN_ROOT` is not set; tell the user to restart Claude Code so the SessionStart hook runs, then stop.

## Step 1 — Fetch chain registry data

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/fetch-chain-registry.cjs"
```

Parse the JSON output. This fetches both mainnet and testnet data from the
Cosmos chain registry.

## Step 2 — Choose chain

Use AskUserQuestion to ask which chain to use, with these options:

- **testnet** — manifest-ledger-testnet (recommended for development)
- **mainnet** — manifest-ledger-mainnet (real assets, use with care)

Store the answer as `CHOSEN_CHAIN` (`testnet` or `mainnet`).

## Step 3 — Choose gas fee token

Look at the `feeTokens` array for the chosen chain from the Step 1 output.
Each fee token has a `symbol` (human-readable name like "MFX" or "PWR") and
a `fixedMinGasPrice`.

Use AskUserQuestion to ask which token to use for gas fees, showing the
**symbol** and **min gas price** for each. For example:

- **MFX** (min gas price: 1)
- **PWR** (min gas price: 0.37)

Store the user's choice as `GAS_TOKEN` (the symbol). The script handles the
denom resolution and gas-price string composition; do NOT compose it inline.

## Step 4 — Check for existing agent

Run:
```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --status 2>/dev/null
```

If the command succeeds and the JSON output has a non-null `address` field,
warn the user:

> An agent key already exists with address `<address>`.
> Proceeding will generate a new key. The old key's password will be lost
> (the old keyfile stays on disk but becomes unrecoverable without the password).

Confirm via `AskUserQuestion` (Yes / No) before continuing. Stop on No.

If the command fails (no config.json yet), that's fine — skip the warning and
proceed.

**IMPORTANT**: Do NOT read `$MANIFEST_PLUGIN_DATA/config.json` directly — it contains
the key password. Always use `update-config.cjs --status` to read safe fields.

## Step 5 — Generate or import key and write config

Use AskUserQuestion to ask the user:

- **Generate a new key** — create a fresh keypair
- **Import an existing mnemonic** — use a key you already have

### If generating a new key:

The key script pipes directly into write-config so the password never enters the
conversation:

```bash
NODE_PATH=$MANIFEST_PLUGIN_DATA/node_modules node "$MANIFEST_PLUGIN_ROOT/scripts/gen-agent-key.cjs" --prefix manifest | node "$MANIFEST_PLUGIN_ROOT/scripts/write-config.cjs" --chain CHOSEN_CHAIN --gas-token GAS_TOKEN
```

Replace `CHOSEN_CHAIN` with the user's choice from Step 2 and `GAS_TOKEN`
with the symbol they chose in Step 3 (e.g., `MFX`).

Parse the JSON output from stdout to get `address` and `activeChain`.

### If importing an existing mnemonic:

This branch uses the same file-pipe pattern as the standalone
`/manifest-agent:import-key` skill (which is the entry point for re-imports
later — once config.json exists, that skill is the canonical way to swap
keys). For first-time setup we run the pipe inline because config.json
doesn't exist yet.

Ask the user to provide the **path to a file** containing their mnemonic.
They create the file themselves in a separate terminal:

```bash
cat > /tmp/mnemonic.txt    # paste mnemonic, Enter, Ctrl+D
chmod 600 /tmp/mnemonic.txt
```

**Do NOT use `echo`** (shell history). **Do NOT ask the user to paste the
mnemonic in the conversation. Do NOT `Read` the mnemonic file.** The
mnemonic must never enter Claude's context.

Wait for the user to provide the path. Then run (substitute `MNEMONIC_FILE`,
`CHOSEN_CHAIN` from Step 2, `GAS_TOKEN` from Step 3):

```bash
cat MNEMONIC_FILE | NODE_PATH=$MANIFEST_PLUGIN_DATA/node_modules node "$MANIFEST_PLUGIN_ROOT/scripts/import-key.cjs" --prefix manifest | node "$MANIFEST_PLUGIN_ROOT/scripts/write-config.cjs" --chain CHOSEN_CHAIN --gas-token GAS_TOKEN
```

Parse the JSON output to get `address` and `activeChain`. Suggest the
user `rm` their mnemonic file after.

## Step 6 — Report results

Tell the user:
1. Their agent address
2. The keyfile location
3. Which chain is active
4. The gas fee token in use
5. That MCP servers need to be restarted to use the new config — they can do
   this by running `/mcp` and reconnecting, or by restarting Claude Code

## Step 7 — Offer testnet funding

If the user chose testnet, suggest requesting faucet funds to the new address
using the `mcp__manifest-chain__request_faucet` tool if it is available.

## Security notes

- The key password NEVER appears in this conversation. It flows directly from
  the key script to write-config via pipe.
- Never display the mnemonic or password in conversation output.
- The keyfile is encrypted; the password is stored only in config.json (0600).
- Never log or display the mnemonic. Only the address and keyfile path are safe
  to show.
