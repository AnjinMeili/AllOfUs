# AllOfUs

A modular AI agent framework with secure, cross-app API key management across macOS, Linux, and Windows.

> Store API keys once in your OS credential store. Access them from any terminal, script, Node.js app, VS Code extension, or browser.

## Overview

AllOfUs has two components that share a single secure credential-store backend:

| Component | What it does |
| --- | --- |
| **dev-keys** | CLI + Web UI + VS Code extension for managing API keys in the OS credential store |
| **Agent** | Event-driven AI agent built on the [OpenRouter SDK](https://openrouter.ai/docs) |

---

## dev-keys

### Choose Your Interface

| Interface | Example |
| --- | --- |
| **CLI** | dev-keys set openrouter |
| **Web UI** | dev-keys ui |
| **VS Code** | Cmd+Shift+P → Dev Keys: Open Setup Panel |

All three read and write the same secure keystore entries. A key stored from the CLI is instantly available in VS Code and the web UI.

### CLI

![dev-keys CLI demo](docs/images/cli-demo.svg)

```text
dev-keys v0.1.0 — API keys in your secure OS credential store

COMMANDS
  set <name> [value]     Store a key (prompts securely if value omitted)
  get <name>             Print a key to stdout
  show <name>            Print key name + masked value
  test <name>            Validate a stored key with a sanity check
  delete <name>          Remove a key (with confirmation)
  list                   List all stored key names
  env [names...]         Print export statements for shell eval
  init                   Print shell startup script for .zshrc/.bashrc
  ui                     Open setup panel in your browser

OPTIONS
  --help, -h             Show this help
  --version, -v          Print version
```

**Terminal behavior:** Adapts to terminal capabilities automatically. Respects `NO_COLOR`, `CLICOLOR`, `CLICOLOR_FORCE`, and `TERM=dumb`. Falls back to ASCII glyphs when Unicode is unavailable. Adjusts column widths to terminal size. Disables color and prompts when piped.

### Web UI

![dev-keys web UI](docs/images/web-ui-preview.svg)

```bash
dev-keys ui
#  dev-keys UI running at http://localhost:9876
#  Opens in default browser
```

Features:

- Cards for 6 known AI services (OpenRouter, OpenAI, Anthropic, Google AI, GitHub, Hugging Face) with direct "Get key" links
- Instant format and network validation after storing a key
- Inline validation for already stored keys
- Progress bar showing configuration status
- Inline password inputs with show/hide toggle
- Add/update/remove keys with toast notifications
- Dark and light mode via `prefers-color-scheme`
- SSE-powered live sync across browser tabs
- Custom key support with optional verify endpoints

### VS Code Extension

Open the command palette (`Cmd+Shift+P`) and run:

| Command | Description |
| --- | --- |
| **Dev Keys: Open Setup Panel** | Full setup UI as a webview panel |
| **Dev Keys: Add API Key** | Quick add via input box |
| **Dev Keys: Remove API Key** | Quick remove via picker |
| **Dev Keys: List API Keys** | View stored keys |

Any VS Code extension can request keys programmatically:

```typescript
const session = await vscode.authentication.getSession(
  'dev-api-keys',        // provider ID
  ['openrouter'],        // scope = key name
  { createIfNone: true } // prompts to add if missing
);
const apiKey = session.accessToken;
```

---

## Installation

### Requirements

- **Node.js** >= 18
- [OpenRouter API key](https://openrouter.ai/settings/keys) (for the agent)

Platform support (all three work on macOS, Linux, and Windows):

| Component | Backend |
| --- | --- |
| CLI (`dev-keys`) | Keychain / Secret Service / Credential Manager via [`@napi-rs/keyring`](https://github.com/Brooooooklyn/keyring-node) |
| VS Code extension | same |
| Web UI (`dev-keys ui`) | same |
| Agent (`npm start`) | same (via `getKey(...)` in `src/get-key.ts`) |

The agent's `getKey` is async: `const key = await getKey('openrouter')`.

### Install Everything

```bash
git clone https://github.com/AnjinMeili/AllOfUs.git
cd AllOfUs

# Install dependencies for both packages
npm install
cd dev-keys && npm install && cd ..

# Build everything (agent + extension + VSIX)
npm run build:all

# Make the CLI available on your $PATH (from the dev-keys package)
cd dev-keys && npm link && cd ..

# Install VS Code extension
npm run install:ext
```

### Install dev-keys Only

If you just want key management without the agent:

```bash
cd dev-keys
npm install && npm run build

# CLI — npm link creates a platform-appropriate shim on $PATH
npm link

# VS Code extension
npm run install:vsix
```

### Verify Installation

```bash
dev-keys --version
# dev-keys 0.1.0

dev-keys set openrouter
# Enter value for openrouter: ********
# OK Stored openrouter

dev-keys list
# 1 key(s) in Keychain:
#   openrouter
```

---

## Usage

### Store and Retrieve Keys

```bash
# Store with value on the command line
dev-keys set openrouter sk-or-abc123

# Store with secure prompt (no value in shell history)
dev-keys set anthropic
# Enter value for anthropic: ********

# Retrieve (prints to stdout)
dev-keys get openrouter

# View masked
dev-keys show openrouter
# openrouter           sk-o****************************

# Remove (confirms interactively)
dev-keys delete openrouter
# Delete openrouter from Keychain? [y/N]
```

### Shell Integration

Add to `~/.zshrc` or `~/.bashrc` for automatic key loading:

```bash
eval "$(dev-keys init)"
```

This does two things:

1. Exports all stored keys as `<NAME>_API_KEY` environment variables
2. Provides a `with-key` helper function

```bash
# After eval "$(dev-keys init)":
echo $OPENROUTER_API_KEY
# sk-or-abc123

# Run a command with a specific key injected
with-key openrouter npm start
```

### Use in Scripts

```bash
# Inline (no shell config needed)
OPENROUTER_API_KEY=$(dev-keys get openrouter) npm start

# Export specific keys
eval $(dev-keys env openrouter anthropic)

# Use in curl
curl -H "Authorization: Bearer $(dev-keys get openrouter)" https://api.example.com
```

### Use Without dev-keys Installed

On macOS, every command is a thin wrapper around the built-in `security` tool. You can always access keys directly:

```bash
# Store
security add-generic-password -s dev-api-keys -a openrouter -w "sk-or-abc123" -U

# Retrieve
security find-generic-password -s dev-api-keys -a openrouter -w

# Use inline
OPENROUTER_API_KEY=$(security find-generic-password -s dev-api-keys -a openrouter -w) npm start
```

### Use in Node.js

```typescript
import { getKey } from './get-key.js';

// Checks OPENROUTER_API_KEY env var first, then the platform keystore
// (Keychain on macOS, Secret Service on Linux, Credential Manager on Windows).
const apiKey = await getKey('openrouter');
```

### Access Patterns Summary

| Consumer | Method |
| --- | --- |
| **CLI / shell scripts** | `dev-keys get <name>` or `eval $(dev-keys env)` |
| **Node.js** | `import { getKey } from './get-key.js'` |
| **VS Code extensions** | `vscode.authentication.getSession('dev-api-keys', ['openrouter'])` |
| **Web UI** | `dev-keys ui` on localhost |
| **Any macOS app** | `security find-generic-password -s dev-api-keys -a <name> -w` |
| **Python, Ruby, etc.** | Shell out to `dev-keys get <name>` or the platform-native credential tool |

---

## Agent

An event-driven AI agent built on the OpenRouter SDK with items-based streaming.

### Run the Agent

```bash
# Store your key (if not already done)
dev-keys set openrouter

# Headless (readline)
npm run start:headless

# Ink TUI
npm start
```

No environment variable needed — the agent reads from the secure store automatically via `getKey('openrouter')`.

### Architecture

```text
User Input --> Agent.send() --> OpenRouter SDK --> callModel()
                                                      |
                                               getItemsStream()
                                                      |
                                          Events: item:update, stream:delta,
                                                  tool:call, reasoning:update
                                                      |
                                                UI / Hooks / Logs
```

### Agent API

```typescript
import { createAgent } from './agent.js';
import { getKey } from './get-key.js';

const agent = createAgent({
  apiKey: await getKey('openrouter'),
  model: 'openrouter/auto',
  instructions: 'You are a helpful assistant.',
  tools: [...],
  maxSteps: 5,
});

// Streaming
const response = await agent.send('Hello');

// Non-streaming
const response = await agent.sendSync('Hello');

// Events
agent.on('stream:delta', (delta, accumulated) => { ... });
agent.on('tool:call', (name, args) => { ... });
agent.on('error', (err) => { ... });
```

### Events

| Event | Payload | Description |
| --- | --- | --- |
| `message:user` | `Message` | User message added |
| `message:assistant` | `Message` | Assistant response complete |
| `item:update` | `StreamableOutputItem` | Streaming item (replace by ID) |
| `stream:delta` | `(delta, accumulated)` | New text chunk |
| `tool:call` | `(name, args)` | Tool invoked |
| `tool:result` | `(callId, result)` | Tool returned |
| `thinking:start` / `end` | -- | Processing lifecycle |
| `error` | `Error` | Error occurred |

---

## Permissions Audit

Audit permission and prompt-risk configuration across VS Code, extensions, and project settings.

```bash
# Full audit
npm run audit:perms -- --scope all

# Project-only
npm run audit:perms -- --scope project

# JSON output
npm run audit:perms -- --scope project --format json

# Interactive web report
npm run audit:perms -- --scope all --format web --interactive --open-browser
```

Exit codes: `0` clean, `1` warnings, `2` failures.

---

## Project Structure

```text
AllOfUs/
├── src/
│   ├── agent.ts           # Agent core (EventEmitter + OpenRouter SDK)
│   ├── tools.ts           # Example tools (time, calculator)
│   ├── get-key.ts         # Key resolver: env var --> secure store fallback
│   ├── headless.ts        # Headless CLI entry point
│   ├── cli.tsx            # Ink TUI entry point
│   └── audit-permissions.ts
├── dev-keys/
│   ├── bin/dev-keys       # CLI shim
│   ├── src/
│   │   ├── keystore.ts    # Cross-platform keystore backend
│   │   ├── extension.ts   # VS Code AuthenticationProvider
│   │   ├── setup-panel.ts # VS Code webview panel UI
│   │   ├── validation.ts  # Key validation helpers
│   │   └── web-server.ts  # Standalone HTTP server + browser UI
│   ├── package.json       # npm + VS Code extension manifest
│   └── dev-keys-*.vsix    # Packaged VS Code extension
├── docs/images/           # Documentation assets
├── CLAUDE.md              # Claude Code project instructions
├── AGENTS.md              # Workspace instructions
├── .github/
│   └── copilot-instructions.md
├── CONTRIBUTING.md
├── SECURITY.md
├── LICENSE
└── package.json
```

## npm Scripts

| Script | Description |
| --- | --- |
| `npm start` | Run agent with Ink TUI |
| `npm run start:headless` | Run agent with readline |
| `npm run dev` | Run agent with file watching |
| `npm run check` | Type-check with `tsc --noEmit` |
| `npm run build` | Compile TypeScript |
| `npm run build:all` | Build agent + dev-keys + VSIX |
| `npm run install:ext` | Install VSIX into VS Code |
| `npm run audit:perms` | Run permissions audit |

---

## Security

- API keys are stored in the OS credential store, encrypted at rest by the OS
- On macOS, the native `security` CLI remains available for direct Keychain access
- `.gitignore` excludes `.env` files
- The `dev-keys ui` server binds to `127.0.0.1`, validates the `Host`
  header, and requires a per-launch session token on every request
- Keys reachable in environment variables (via `with-key` or `dev-keys env`)
  are visible to child processes and may be captured by `ps` or shell history
- See [THREAT_MODEL.md](THREAT_MODEL.md) for what is and isn't defended
  against, and [SECURITY.md](SECURITY.md) for vulnerability reporting

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

[MIT](LICENSE)
