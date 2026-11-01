# Contributing

`vsx-diff` is a small TypeScript CLI. Issues and patches that keep the heuristics explainable are welcome.

## Setup

```bash
npm install
npm run build
npm test
```

Node.js 20 or newer is required. CI runs the same checks on Node.js 20 and 22.

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Report security issues privately, as described in [SECURITY.md](SECURITY.md).

## Layout

| Path | Role |
| --- | --- |
| `src/cli.ts` | Command-line parsing and exit codes |
| `src/registry.ts` | Open VSX and VS Code Marketplace clients, VSIX cache |
| `src/unpack.ts` | Pack and unpack `.vsix` zip archives |
| `src/analyze.ts` | Manifest, script, dependency, file, and risk diff |
| `src/installed.ts` | Discover extensions under the editor directories |
| `src/policy.ts` | Pin and cooldown decisions |
| `src/report.ts` | Terminal, JSON, and Markdown renderers |
| `src/fixture.ts` | Offline malicious-update fixture used by tests and `demo/` |
| `test/` | Vitest tests |

## Checks

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run demo
```

`npm run demo` is offline. It compares `demo/fixtures/goodpub.hello-1.0.0.vsix` with `demo/fixtures/evilpub.hello-1.1.0.vsix` and expects a high risk score. Regenerate those archives with `npm run generate:fixtures` after changing `src/fixture.ts`.

## Heuristics

Prefer a rule you can explain in one sentence in the report. A new signal should name the file, the threshold, and why it matters. Do not raise the score for matches inside `node_modules`; those show up in the dependency and file sections instead.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/) so release-please can version the package: `feat:`, `fix:`, and `chore:`. A `feat!` or `BREAKING CHANGE:` footer is a breaking change.

Describe the change. Follow `AGENTS.md`: no AI-tool signature, no `Co-Authored-By` trailer, and no "generated with ..." note in commit messages or pull request descriptions.

## Maintainers

Releases are cut by [release-please](https://github.com/googleapis/release-please). On every push to `main`, `.github/workflows/release-please.yml` opens or updates a release pull request and, when that PR is merged, tags the commit and publishes a GitHub Release. The same workflow then publishes the package.

npm publish needs a repository secret named `NPM_TOKEN`:

1. On npm, create a granular access token that can publish `vsx-diff` (automation token is fine).
2. In the GitHub repo, add it as an Actions secret named `NPM_TOKEN` (Settings → Secrets and variables → Actions).
3. Leave the workflow's `id-token: write` permission in place. The publish job runs `npm publish --provenance --access public` and maps `NPM_TOKEN` to `NODE_AUTH_TOKEN`. Provenance only succeeds for a public repository.

Do not commit the token. `npm publish` also runs `prepublishOnly`, which builds and tests before the tarball is packed. The last released version tracked by release-please is in `.release-please-manifest.json` (currently `0.1.0`).

Dependabot opens weekly update PRs for npm and GitHub Actions. CodeQL and OpenSSF Scorecard run from `.github/workflows/`.
