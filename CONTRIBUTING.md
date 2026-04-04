# Contributing to AllOfUs

## Development Setup

```bash
git clone https://github.com/AnjinMeili/AllOfUs.git
cd AllOfUs
npm install
cd dev-keys && npm install && cd ..
```

## Building

```bash
# Type-check the agent
npm run check

# Build the VS Code extension
cd dev-keys && npm run build
```

## Project Layout

- `src/` — Agent core, tools, and entry points
- `dev-keys/` — CLI and VS Code extension for Keychain-backed key management

## Pull Requests

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Ensure `npm run check` passes with no errors
4. Open a pull request with a clear description

## Reporting Issues

Open an issue on GitHub. Include:
- What you expected to happen
- What actually happened
- Steps to reproduce
- macOS version and Node.js version

## Code Style

- TypeScript strict mode
- No unused imports or variables
- Prefer explicit types at module boundaries, inferred types internally
