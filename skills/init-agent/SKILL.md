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

**For all user choices in this skill, use the AskUserQuestion tool to present
the options so the user can select from a list instead of typing.**

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
mkdir -p ~/.manifest-agent && cp "$MANIFEST_PLUGIN_ROOT/package.json" ~/.manifest-agent/package.json && cd ~/.manifest-agent && npm install --omit=dev
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

Use AskUserQuestion to ask which chain to use, with these options:

- **testnet** — manifest-ledger-testnet (recommended for development)
- **mainnet** — manifest-ledger-mainnet (real assets, use with care)

Store the answer as `CHOSEN_CHAIN` (`testnet` or `mainnet`).

## Step 3b — Choose gas fee token

Look at the `feeTokens` array for the chosen chain from the Step 2 output.
Each fee token has a `symbol` (human-readable name like "MFX" or "PWR") and
a `fixedMinGasPrice`.

Use AskUserQuestion to ask which token to use for gas fees, showing the
**symbol** and **min gas price** for each. For example:

- **MFX** (min gas price: 1)
- **PWR** (min gas price: 0.37)

After the user selects, compose the gas price string from the selected token's
`fixedMinGasPrice` and `denom` (the raw on-chain denom, NOT the symbol) as
`<fixedMinGasPrice><denom>` (e.g., `1umfx`). Store this as `GAS_PRICE`.

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

Ask for confirmation before continuing.

If the command fails (no config.json yet), that's fine — skip the warning and
proceed.

**IMPORTANT**: Do NOT read `~/.manifest-agent/config.json` directly — it contains
the key password. Always use `update-config.cjs --status` to read safe fields.

## Step 5 — Generate or import key and write config

Use AskUserQuestion to ask the user:

- **Generate a new key** — create a fresh keypair
- **Import an existing mnemonic** — use a key you already have

### If generating a new key:

The key script pipes directly into write-config so the password never enters the
conversation:

```bash
NODE_PATH=$HOME/.manifest-agent/node_modules node "$MANIFEST_PLUGIN_ROOT/scripts/gen-agent-key.cjs" --prefix manifest | node "$MANIFEST_PLUGIN_ROOT/scripts/write-config.cjs" --chain CHOSEN_CHAIN --gas-price GAS_PRICE
```

Replace `CHOSEN_CHAIN` with the user's choice from Step 3 and `GAS_PRICE` with
the composed gas price string from Step 3b (e.g., `1umfx`).

Parse the JSON output from stdout to get `address` and `activeChain`.

### If importing an existing mnemonic:

The mnemonic must NEVER appear in this conversation. Ask the user to provide
the **path to a file** containing their mnemonic. They should create this file
themselves in a separate terminal, e.g.:

```bash
cat > /tmp/mnemonic.txt
# paste mnemonic, press Enter, then Ctrl+D
chmod 600 /tmp/mnemonic.txt
```

**Do NOT use `echo` — it appears in shell history.**

Wait for the user to provide the file path before proceeding.

**CRITICAL**: Do NOT ask the user to paste the mnemonic in the conversation.
Do NOT read the mnemonic file.

Then run (replacing `MNEMONIC_FILE` with the user's file path, `CHOSEN_CHAIN`
with the user's choice from Step 3, and `GAS_PRICE` with the gas price from
Step 3b):

```bash
cat MNEMONIC_FILE | NODE_PATH=$HOME/.manifest-agent/node_modules node "$MANIFEST_PLUGIN_ROOT/scripts/import-key.cjs" --prefix manifest | node "$MANIFEST_PLUGIN_ROOT/scripts/write-config.cjs" --chain CHOSEN_CHAIN --gas-price GAS_PRICE
```

Parse the JSON output from stdout to get `address` and `activeChain`.

Suggest the user delete their mnemonic file after a successful import.

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
