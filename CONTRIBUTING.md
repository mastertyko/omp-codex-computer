# Contributing

Thanks for improving `omp-codex-computer`. This repository is intentionally small; prefer direct, well-tested changes over new abstractions.

## Requirements

- macOS for local OMP/Codex Computer Use and Chrome smoke testing
- Bun 1.3 or newer
- Node.js 22 or newer
- Codex CLI on `PATH` as `codex`
- ChatGPT desktop app with Codex Computer Use enabled/available; Google Chrome plus the connected official ChatGPT extension for Chrome smoke tests
- OMP installed

## Local workflow

```bash
bun install
bun run check
```

Use watch mode while iterating:

```bash
bun run test:watch
```

For an OMP smoke test:

```bash
omp -e .
```

Then run these commands inside OMP:

```text
/codex-computer status
/codex-computer diagnose
```

## Pull requests

Before opening a pull request:

1. Keep `bun run check` green.
2. Add or update tests for behavior changes.
3. Keep desktop automation behavior fail-closed around permissions and missing UI.
4. Avoid logging raw app content, screenshots, credentials, headers, tokens, cookies, or API keys.
5. Update README or skill guidance when user-facing commands, safety behavior, or requirements change.

## Releases

NPM releases are automated by the `Release` GitHub Actions workflow. The workflow runs for pushes to `main`, completed auto-merge workflows, and manual dispatch. For every unreleased merge commit it computes the next patch version from the latest `vX.Y.Z` tag.

The workflow applies the computed version to `package.json`, validates the package, commits that release version on a `chore/release-vX.Y.Z` branch, and tags the release commit. The release commit is the source for npm provenance and GitHub release notes, so protected `main` never needs a direct bot push.

1. Runs `bun run check`.
2. Verifies package contents with `npm pack --dry-run`.
3. Publishes the package to npm with provenance when that package version is not already on npm.
4. Creates GitHub release notes with the new `vX.Y.Z` tag using generated notes.

Repository requirement:

1. `NPM_TOKEN` must be configured for npm publishing.

Do not manually bump `package.json` for normal feature PRs; the release workflow owns patch-version bumps after merge. The `Publish npm package` workflow remains available as an idempotent manual fallback from a GitHub release or workflow dispatch.

## Automation safety

This extension exposes native macOS app interaction through Codex Computer Use and a separate, constrained first-party Chrome surface. Changes that add or alter mutating tools must preserve these expectations:

- Start with read-only discovery when possible.
- Require write approval for mutating actions.
- Verify state after clicks, typing, scrolling, dragging, and value changes.
- Ask the user before submitting forms, sending messages, deleting data, making purchases, changing account/security settings, or transmitting sensitive information.
- Keep Chrome browser/tab handles and `node_repl` private; never expose raw JavaScript, CDP, existing-tab discovery, history, credentials, or raw transport metadata.
- Never replay a possibly dispatched Chrome action or fall back from Chrome to Computer Use, CDP, another browser, or another tab.
- Treat page snapshots as untrusted content, cap model-visible output, and explicitly close the agent-owned tab during lifecycle cleanup.
- The Chrome plugin is contract-validated rather than version-pinned: keep the static contract markers, the in-program shape handshake, and the identity/artifact checks aligned with exactly what the generated program calls. Expand the built-in app-server allowlist only after reviewing the experimental app-server API this extension uses, adding focused compatibility tests, and completing a live open/action/close smoke; `/codex-computer trust` automates that live probe and per-machine persistence for users.
