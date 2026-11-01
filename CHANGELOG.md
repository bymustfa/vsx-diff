# Changelog

## Unreleased

- Turkish README, community files, and CI on Node.js 20 and 22.
- npm publish metadata, release-please, Dependabot, CodeQL, Scorecard, and a demo GIF.

## 0.1.0 — 2026-11-01

First public release of `vsx-diff`.

- Compare two versions of a VS Code, Cursor, or VSCodium extension from Open VSX, the VS Code Marketplace, installed extension directories, or local `.vsix` files.
- Report manifest, lifecycle script, dependency, and file changes, plus explainable suspicious-file findings and a low/medium/high risk score.
- Print a colored terminal report, JSON (`--json`), or Markdown (`--markdown`). `--fail-on` sets a CI exit code.
- `pin`, `unpin`, `rollback`, `cooldown`, `policy`, and `check` store policy in `~/.config/vsx-diff/config.json` and fall back to a dry-run when `code`, `cursor`, or `codium` is not on `PATH`.
- Cache downloaded VSIX files under `~/.cache/vsx-diff`.
