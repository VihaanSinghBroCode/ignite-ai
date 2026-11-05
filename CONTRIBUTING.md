# Contributing to Ignite

Thanks for helping. Ignite is small on purpose, so most changes touch one or two files.

## Setup

You need Node 22.12 or newer.

```bash
git clone https://github.com/VihaanSinghBroCode/ignite-ai.git
cd ignite-ai
npm install
npm link                  # puts `ignite` on your PATH, pointing at this folder
```

## Tests

```bash
npm test                  # unit tests: fast and offline
npm run test:e2e          # the real CLI with real npm, Vite and Express, against a mock LLM
```

Neither suite needs an API key. The end-to-end tests start a local server that speaks the Anthropic and OpenAI streaming formats, so the real SDKs parse real event streams. They take about a minute and need network access to the npm registry.

To try a change against a real model:

```bash
ANTHROPIC_API_KEY=sk-ant-... node index.js "A habit tracker with streaks"
```

Generated apps vary from run to run. When you change the prompt or the defaults, try more than one prompt and open the results in a browser, including at phone width. Build and boot checks don't catch layout problems.

## How the code is organized

| File | Job |
| --- | --- |
| `index.js` | CLI, terminal UI and the overall flow |
| `src/prompts.js` | The system prompt and the generate, repair and fix messages |
| `src/chain.js` | Runs the prompt chain |
| `src/providers.js` | Anthropic and OpenAI streaming, error handling and retries |
| `src/parse.js` | JSON parsing and live file-name tracking |
| `src/policy.js` | Safety and stack rules applied to the model's output |
| `src/writer.js` | Writes files to disk |
| `src/executor.js` | Runs npm: `exec` for install and checks, `spawn` for the dev server |

## Guidelines

- **Treat model output as untrusted.** Anything that decides what is written to disk or executed belongs in `src/policy.js` or `src/writer.js`, with tests showing that it rejects hostile input.
- **Keep the dependency list short.** Ignite has five runtime dependencies, and every new one is another thing `npx` downloads.
- **Test the behavior you change.** Fix a bug with a test that fails without the fix.
- **Report failures plainly.** When something goes wrong, the user should see what happened and what to do next.

## Pull requests

1. Branch from `main`.
2. Run `npm test` and `npm run test:e2e`.
3. Add a line under "Unreleased" in [CHANGELOG.md](CHANGELOG.md) if users will notice the change.
4. Open the pull request and describe what changed and why.

## Releasing

Maintainers only:

1. Move the "Unreleased" entries in `CHANGELOG.md` under a new version heading.
2. Bump `version` in `package.json` and commit.
3. Run `npm publish`. npm asks for your two-factor code, and `prepublishOnly` runs the unit tests first.
4. Tag the release: `git tag v<version> && git push --tags`.
