# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.x     | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do not** open a public issue
2. Use [GitHub's private vulnerability reporting](https://github.com/AnjinMeili/AllOfUs/security/advisories/new)
3. Or email the maintainer directly

You can expect an initial response within 72 hours.

## Security Considerations

- API keys are stored in macOS Keychain, encrypted at rest by the OS
- All Keychain access goes through the `security` CLI — no native Node addons
- The `dev-keys ui` web server binds to `127.0.0.1`, validates the `Host`
  header (blocks DNS rebinding), and requires a per-launch session token
- Never commit `.env` files or API keys to version control
- Keys exported via `with-key` or `dev-keys env` live in the process
  environment and may be observable to other processes running as the same
  user — see [THREAT_MODEL.md](THREAT_MODEL.md) for the full scope
