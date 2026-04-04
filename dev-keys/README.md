# dev-keys

Store API keys in macOS Keychain. Access them from any terminal, script, Node.js app, or VS Code extension.

```bash
npm install -g @allofus/dev-keys
```

## Why

- **One place** — keys live in macOS Keychain, encrypted at rest by the OS
- **Every consumer** — CLI, env vars, Node.js, VS Code extensions, raw `security` command
- **No dotfiles** — no `.env` files to leak, rotate, or `.gitignore`

## CLI

```bash
dev-keys set openrouter sk-or-abc123    # store
dev-keys set anthropic                  # prompts securely
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

Every command is a thin wrapper around macOS `security`:

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

## Requirements

- **macOS** (uses Keychain via `security` CLI)
- **Node.js** >= 18 (for npm install)

## License

MIT
