# AllOfUs — Project Instructions

## Overview

Modular AI agent framework with three-interface API key management (CLI, Web UI, VS Code extension), all backed by macOS Keychain.

- **Agent** (`src/`) — Event-driven agent on `@openrouter/sdk` with items-based streaming
- **dev-keys** (`dev-keys/`) — CLI + web server + VS Code AuthenticationProvider for Keychain-backed key management

## Build & Check

```bash
npm run check              # Type-check agent (tsc --noEmit)
npm run build:all          # Build agent + dev-keys + VSIX
npm run install:ext        # Install VS Code extension
```

## Architecture

- `src/agent.ts` — Core `Agent` class extending `EventEmitter3`. Uses `client.callModel()` with `getItemsStream()` for streaming. Items are replaced by ID, not accumulated.
- `src/tools.ts` — Tool definitions using `tool()` from `@openrouter/sdk/lib/tool.js`
- `src/get-key.ts` — Resolves API keys: checks env var first (`<NAME>_API_KEY`), falls back to macOS Keychain (`security find-generic-password`)
- `dev-keys/bin/dev-keys` — Bash CLI with terminal capability detection (NO_COLOR, CLICOLOR, TERM=dumb, Unicode, width)
- `dev-keys/src/keychain.ts` — Async Node.js wrapper around macOS `security` CLI
- `dev-keys/src/extension.ts` — VS Code `AuthenticationProvider` bridging Keychain to `vscode.authentication`
- `dev-keys/src/setup-panel.ts` — VS Code webview panel UI for key management
- `dev-keys/src/web-server.ts` — Standalone HTTP + SSE server serving browser UI on localhost

## Key Conventions

- TypeScript strict mode throughout
- ESM (`"type": "module"`) with `.js` extensions in imports
- SDK imports use deep paths: `@openrouter/sdk/lib/tool.js`, `@openrouter/sdk/lib/stop-conditions.js`, `@openrouter/sdk/lib/stream-transformers.js`
- The top-level `@openrouter/sdk` only exports `OpenRouter` (class) and `ToolType` (enum)
- `dev-keys` is a separate package with its own `node_modules` and `tsconfig.json`
- All Keychain operations use service name `dev-api-keys`
- The CLI respects NO_COLOR, CLICOLOR, CLICOLOR_FORCE, TERM=dumb conventions

## Security

- Never hardcode or log API keys
- Keys are stored in macOS Keychain, never in plaintext files
- The `.gitignore` excludes `.env` files
