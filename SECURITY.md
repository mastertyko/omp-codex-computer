# Security Policy

## Supported versions

Security fixes target the current `main` branch until the project starts publishing versioned releases.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability.

Use GitHub private vulnerability reporting for `mastertyko/omp-codex-computer` when it is available. If private vulnerability reporting is not enabled yet, contact the maintainer privately through the same channel that gave you access to the repository.

Include:

- affected commit or version
- reproduction steps
- expected impact
- whether the issue can expose desktop content, screenshots, credentials, tokens, cookies, headers, or local files

## Security expectations

This project must not commit credentials, tokens, private keys, screenshots, `.env` files, or local app-server logs. Runtime logs must redact sensitive fields before output. Desktop automation changes must fail closed when required permissions, UI, or Codex Computer Use dependencies are unavailable.
