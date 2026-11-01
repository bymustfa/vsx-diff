# Contributing

`vsx-diff` is a small TypeScript CLI. Issues and patches that keep the heuristics explainable are welcome.

## Setup

```bash
npm install
npm run build
npm test
```

Node.js 20 or newer is required.

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

Describe the change. Follow `AGENTS.md`: no AI-tool signature, no `Co-Authored-By` trailer, and no "generated with ..." note in commit messages or pull request descriptions.
