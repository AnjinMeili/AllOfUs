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

- **API keys** are stored in macOS Keychain, encrypted at rest by the OS
- The `dev-keys` CLI uses the `security` command-line tool — keys are never written to disk in plaintext
- The VS Code extension accesses Keychain via child process (`security find-generic-password`), not via Node.js native addons
- Never commit `.env` files or API keys to version control
