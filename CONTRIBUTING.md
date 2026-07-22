# Contributing to Agent Flow

Thanks for your interest in improving Agent Flow! This is a VS Code / Cursor extension written
in TypeScript, with React webviews bundled by esbuild and tested with Vitest.

## Getting started

```bash
git clone https://github.com/oznasi1/agent-flow.git
cd agent-flow
npm install
```

## Everyday commands

| Command | What it does |
|---------|--------------|
| `npm run build` | Bundle the extension host + both webviews into `dist/` (esbuild). |
| `npm run watch` | Same, in watch mode. |
| `npm test` | Run the Vitest unit/webview suite. |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run test:cov` | Run tests with V8 coverage (thresholds enforced). |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run package` | Build a `.vsix` with `vsce`. |

## Running the extension

Press **F5** in VS Code (the "Run Agent Flow" launch config) to open an Extension Development
Host with a `build` pre-launch task. Open the **Agent Flow** icon in the activity bar and
complete the first-run setup wizard.

## Conventions

- **No hardcoded organization values.** Anything organization-specific (Jira site, project
  key, repo layout, blocklist, provenance label) belongs in a `agentFlow.*` setting and is
  read through `getConfig()` in `src/config.ts` — never inlined. New behavior that varies per
  user should follow the same pattern and be collected in the first-run wizard (`src/setup.ts`)
  where appropriate.
- **Tests.** Add or update tests for any behavior change; coverage thresholds are enforced by
  `npm run test:cov`. The `vscode` module is mocked in `test/_mocks/vscode.ts`.
- **Type safety.** Keep `npm run typecheck` clean.

## Before opening a PR

Run `npm run typecheck` and `npm test`, and make sure `npm run build` succeeds. For any
user-facing change, add an entry under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md).

## Publishing (maintainers)

`package.json` carries the `publisher`, `repository`, `homepage`, and `bugs` metadata. Before
publishing to the Marketplace:

1. Confirm `publisher` matches your registered Marketplace publisher id.
2. Add a top-level `icon` pointing to a 128×128 PNG.
3. Move the `## [Unreleased]` notes in [CHANGELOG.md](CHANGELOG.md) under a new version
   heading, and bump `version` in `package.json`.
4. `npm run package` and `vsce publish`.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
