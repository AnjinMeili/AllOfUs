# AllOfUs

A modular AI agent framework with secure API key management for macOS.

**Two components, one Keychain:**
- **Agent** — Event-driven AI agent built on the [OpenRouter SDK](https://openrouter.ai/docs), with streaming, tool use, and optional Ink TUI
- **dev-keys** — CLI + VS Code extension that stores API keys in macOS Keychain and shares them with any app, extension, or script

## Quick Start

### 1. Install dependencies

```bash
npm install
cd dev-keys && npm install && npm run build && cd ..
```

### 2. Store your API key in Keychain

```bash
# Install the CLI
ln -sf "$(pwd)/dev-keys/bin/dev-keys" /usr/local/bin/dev-keys

# Store a key (once — it persists in Keychain)
dev-keys set openrouter sk-or-your-key-here
```

### 3. Run the agent

```bash
# Headless (readline)
npm run start:headless

# Ink TUI
npm start
```

No `export OPENROUTER_API_KEY=...` needed — the agent reads from Keychain automatically.

## Project Structure

```
AllOfUs/
├── src/
│   ├── agent.ts        # Agent core — event emitter with streaming
│   ├── tools.ts        # Example tools (time, calculator)
│   ├── get-key.ts      # Key resolver: env var → Keychain fallback
│   ├── headless.ts     # Headless CLI entry point
│   └── cli.tsx         # Ink TUI entry point
├── dev-keys/
│   ├── bin/dev-keys    # Shell CLI for Keychain key management
│   ├── src/
│   │   ├── keychain.ts # Node.js Keychain bindings (macOS `security`)
│   │   └── extension.ts# VS Code AuthenticationProvider
│   └── package.json    # VS Code extension manifest
├── package.json
└── tsconfig.json
```

## dev-keys: API Key Management

Keys are stored in macOS Keychain under service `dev-api-keys`. Any app on your Mac can read them.

### CLI Usage

```bash
dev-keys set <name> [value]     # Store (prompts if value omitted)
dev-keys get <name>             # Retrieve
dev-keys delete <name>          # Remove
dev-keys list                   # List all key names
dev-keys env [names...]         # Print export statements
dev-keys init                   # Print shell init script
```

### Shell Integration

Add to `~/.zshrc` or `~/.bashrc`:

```bash
eval "$(dev-keys init)"
```

This loads all stored keys as `<NAME>_API_KEY` environment variables and provides a `with-key` helper:

```bash
with-key openrouter npm start
```

### VS Code Extension

The extension registers an `AuthenticationProvider` so any VS Code extension can request keys:

```typescript
const session = await vscode.authentication.getSession(
  'dev-api-keys',
  ['openrouter'],
  { createIfNone: true },
);
const apiKey = session.accessToken;
```

Commands available in the palette:
- **Dev Keys: Add API Key**
- **Dev Keys: Remove API Key**
- **Dev Keys: List API Keys**

### Access Patterns

| Consumer | How |
|---|---|
| **Shell / scripts** | `dev-keys get openrouter` or `eval $(dev-keys env)` |
| **Node.js** | `import { getKey } from './get-key.js'` |
| **VS Code extensions** | `vscode.authentication.getSession('dev-api-keys', ['openrouter'])` |
| **Any macOS app** | `security find-generic-password -s dev-api-keys -a openrouter -w` |

## Agent Architecture

The agent uses an event-driven, items-based streaming model:

```
User Input → Agent.send() → OpenRouter SDK → callModel()
                                                 ↓
                                          getItemsStream()
                                                 ↓
                                     Events: item:update, stream:delta,
                                             tool:call, reasoning:update
                                                 ↓
                                          UI / Hooks / Logs
```

### Agent API

```typescript
import { createAgent } from './agent.js';

const agent = createAgent({
  apiKey: 'sk-or-...',
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
|---|---|---|
| `message:user` | `Message` | User message added |
| `message:assistant` | `Message` | Assistant response complete |
| `item:update` | `StreamableOutputItem` | Streaming item (replace by ID) |
| `stream:delta` | `(delta, accumulated)` | Text chunk |
| `tool:call` | `(name, args)` | Tool invoked |
| `tool:result` | `(callId, result)` | Tool returned |
| `thinking:start` / `thinking:end` | — | Processing lifecycle |
| `error` | `Error` | Error occurred |

## Requirements

- **Node.js** >= 18
- **macOS** (dev-keys uses macOS Keychain via `security` CLI)
- [OpenRouter API key](https://openrouter.ai/settings/keys)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

[MIT](LICENSE)
