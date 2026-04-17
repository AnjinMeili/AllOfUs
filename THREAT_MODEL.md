# Threat Model

dev-keys and the bundled agent are **local developer tools** for a single
macOS user account. This document records what that threat model does and
does not cover, so you can decide whether the tool fits your situation.

## Assumptions

- The local user account is trusted; the Keychain is unlocked for
  interactive developer sessions.
- macOS Keychain encryption at rest is trusted.
- Processes running as the same user have equivalent access — macOS
  isolates user accounts, not applications within an account (outside of
  TCC and Mac App Store sandboxing).
- Network is not trusted; the tool never makes outbound connections
  other than those the agent performs via the OpenRouter API.

## What is defended against

- **Plaintext key files on disk.** Keys are stored in macOS Keychain, not
  `.env` files. `.gitignore` excludes `.env`.
- **Remote exfiltration via the local web UI.** The `dev-keys ui` server
  binds to `127.0.0.1` only, validates the `Host` header (blocks DNS
  rebinding), requires a per-launch bearer token on every API and SSE
  request, and does not set permissive CORS headers.
- **Stored XSS via Keychain key names.** The VS Code webview and the
  browser UI render all Keychain-sourced data via `textContent` and
  `addEventListener`. The webview's CSP uses a per-render nonce and
  forbids inline scripts.
- **Unsafe expression evaluation.** The agent's built-in `calculate`
  tool uses a bounded recursive-descent parser — no `Function()`, no
  `eval()`, no identifiers or function calls.
- **Least-privilege via `vscode.authentication`.** The extension's
  `AuthenticationProvider` refuses to dump every stored key in response
  to a no-scope probe; callers must request exactly one key by name.

## What is NOT defended against

- **Malicious processes running as the same user.** Any process under
  your user account can run `security find-generic-password -s
  dev-api-keys -a <name> -w` and read every key. dev-keys adds no
  authorization layer beyond Keychain's own.
- **Environment-variable leakage.** `with-key` and `eval "$(dev-keys
  env)"` export keys into the process environment. Child processes
  inherit them, `ps` may expose them in some configurations, and shell
  history / terminal scrollback may capture them.
- **Keyloggers, terminal recorders, clipboard history.** Values typed
  into `dev-keys set` or pasted into the UI are visible to any such
  tool.
- **Supply-chain compromise.** A malicious dependency in the agent or a
  VS Code extension running in the same extension host reads keys
  through the normal API.
- **Multi-user machines and unattended services.** dev-keys is designed
  for a single developer's interactive laptop. It is not an appropriate
  secrets manager for servers, CI runners, or shared workstations — use
  HashiCorp Vault, 1Password Connect, or AWS Secrets Manager for those.
- **Key rotation, expiry, or access audit.** dev-keys does not rotate,
  expire, or log access. Keys live in Keychain until you delete them.
- **Cross-platform caveats.** Secret storage on Linux and Windows goes
  through `@napi-rs/keyring` (Secret Service / Credential Manager); on
  macOS it goes through the `security` CLI. A small name-index file
  (`~/.config/dev-keys/names.json` or `%APPDATA%/dev-keys/names.json`)
  records key *names* on Linux/Windows so `list()` can enumerate them
  — no secret values are stored in that file. Deleting it is
  non-destructive: secrets stay in the OS credential store, you just
  lose the list view until keys are re-added.
- **The agent's API calls.** The agent sends prompts and tool results
  to OpenRouter. Keys are never sent as content, but anything you type
  into a prompt reaches the model provider.

## Reporting a vulnerability

See [SECURITY.md](SECURITY.md).
