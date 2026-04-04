# AllOfUs — Project Instructions

## Overview

This is a modular AI agent framework with two components:
- **Agent** (`src/`) — Event-driven agent built on `@openrouter/sdk` with items-based streaming
- **dev-keys** (`dev-keys/`) — CLI + VS Code extension for macOS Keychain-backed API key management

## Build & Check

```bash
npm run check          # Type-check agent (tsc --noEmit)
cd dev-keys && npm run build  # Build VS Code extension
```

## Architecture

- `src/agent.ts` — Core `Agent` class extending `EventEmitter3`. Uses `client.callModel()` with `getItemsStream()` for streaming. Items are replaced by ID, not accumulated.
- `src/tools.ts` — Tool definitions using `tool()` from `@openrouter/sdk/lib/tool.js`
- `src/get-key.ts` — Resolves API keys: checks env var first (`<NAME>_API_KEY`), falls back to macOS Keychain (`security find-generic-password`)
- `dev-keys/src/keychain.ts` — Node.js wrapper around macOS `security` CLI
- `dev-keys/src/extension.ts` — VS Code `AuthenticationProvider` that bridges Keychain to `vscode.authentication` API

## Key Conventions

- TypeScript strict mode throughout
- ESM (`"type": "module"`) with `.js` extensions in imports
- SDK imports use deep paths: `@openrouter/sdk/lib/tool.js`, `@openrouter/sdk/lib/stop-conditions.js`, `@openrouter/sdk/lib/stream-transformers.js`
- The top-level `@openrouter/sdk` only exports `OpenRouter` (class) and `ToolType` (enum)
- `dev-keys` is a separate package with its own `node_modules` and `tsconfig.json`
- All Keychain operations use service name `dev-api-keys`

## Security

- Never hardcode or log API keys
- Keys are stored in macOS Keychain, never in plaintext files
- The `.gitignore` excludes `.env` files
