# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.1] - 2026-11-05

### Added

- Repository links in `package.json`, so the npm page links to GitHub.
- A README with a demo, a gallery of generated apps and measured speed and cost, rendered on npm as well as GitHub.

### Changed

- OpenAI support is labeled experimental in the CLI and docs. It has been tested only against a simulated API so far.

### Fixed

- On Linux, stopping Ignite with SIGTERM now also stops the dev server. Before, Vite could keep running in the background.

## [0.1.0] - 2026-11-05

### Added

- One-command generation of a full-stack React 19, Vite and Express 5 app from a sentence, with Anthropic or OpenAI.
- Live terminal progress showing each file as the model writes it.
- Checks that install, build and boot every app, with up to two automatic fix rounds.
- Repair rounds for invalid or truncated model output.
- Retries for rate limits and dropped streams that honor `Retry-After`, with clear errors for bad keys, unknown models and empty balances.
- Safeguards for model output: path validation, dotfile and lockfile filtering, an allowlisted `package.json`, `--ignore-scripts` installs, checks that extra packages exist, and credential-free environments for generated code.

[Unreleased]: https://github.com/VihaanSinghBroCode/ignite-ai/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/VihaanSinghBroCode/ignite-ai/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/VihaanSinghBroCode/ignite-ai/releases/tag/v0.1.0
