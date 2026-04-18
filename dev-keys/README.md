# dev-keys

Store API keys in your OS credential store. Access them from any terminal, script, Node.js app, web UI, or VS Code extension.

```bash
npm install -g @allofus/dev-keys
```

## Why

- **One place** — keys live in Keychain / Secret Service / Credential Manager, encrypted at rest by the OS
- **Every consumer** — CLI, env vars, Node.js, VS Code extensions, and the browser UI
- **No dotfiles** — no `.env` files to leak, rotate, or `.gitignore`

## CLI

```bash
dev-keys set openrouter sk-or-abc123    # store and sanity-check
dev-keys set anthropic                  # prompts securely
dev-keys test openrouter                # validate a stored key
dev-keys get openrouter                 # print to stdout
dev-keys show openrouter                # print masked (openrout****************)
dev-keys list                           # list all key names
dev-keys delete openrouter              # remove (with confirmation)
dev-keys env                            # print export statements
dev-keys init                           # print shell startup script
```

## Shell Integration

Add to `~/.zshrc` or `~/.bashrc`:

```bash
eval "$(dev-keys init)"
```

This auto-exports all keys as `<NAME>_API_KEY` and provides `with-key`:

```bash
with-key openrouter npm start
```

## Use Without Installing

On macOS, every command is a thin wrapper around the built-in `security` tool:

```bash
# Store
security add-generic-password -s dev-api-keys -a openrouter -w "sk-or-abc123" -U

# Retrieve
security find-generic-password -s dev-api-keys -a openrouter -w

# Use inline
OPENROUTER_API_KEY=$(security find-generic-password -s dev-api-keys -a openrouter -w) npm start
```

## Node.js

```typescript
import { execFileSync } from 'node:child_process';

function getKey(name: string): string {
  return execFileSync(
    'security',
    ['find-generic-password', '-s', 'dev-api-keys', '-a', name, '-w'],
    { encoding: 'utf-8' },
  ).trim();
}

const apiKey = getKey('openrouter');
```

## VS Code Extension

When installed as a VS Code extension, registers an `AuthenticationProvider` so any extension can request keys:

```typescript
const session = await vscode.authentication.getSession(
  'dev-api-keys',
  ['openrouter'],
  { createIfNone: true },
);
const apiKey = session.accessToken;
```

## Features

- Built-in validation for well-known services such as OpenRouter, OpenAI, Anthropic, Google AI, GitHub, and Hugging Face
- Custom service support with optional verify endpoints
- Shared storage across the CLI, web UI, and VS Code extension

## Requirements

- **Node.js** >= 18 (for npm install)
- **macOS, Linux, or Windows**

## License

MIT
