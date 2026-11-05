# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub's private reporting](https://github.com/VihaanSinghBroCode/ignite-ai/security/advisories/new), not in a public issue. Include steps to reproduce and the Ignite version (`npx ignite-ai --version`).

You should get a reply within a few days. Once a fix is released, the advisory is published with credit to you, unless you prefer otherwise.

## Scope

Ignite writes files and runs commands based on output from an AI model, so the most important bugs are ways for that output to get past its safeguards. For example:

- writing a file outside the project folder
- running a script from the generated `package.json` during install
- exposing your API key or other credentials to the generated app
- installing a package from somewhere other than the npm registry

Bugs inside a generated app are not security issues in Ignite. Ignite runs generated code with your user permissions and does not sandbox it, as the README explains.

## Supported versions

Only the latest release on npm receives security fixes.
