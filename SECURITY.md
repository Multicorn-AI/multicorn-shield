# Security policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.9.x   | Yes       |
| < 0.9   | No        |

## Reporting a vulnerability

Please report security vulnerabilities through GitHub's private vulnerability reporting: https://github.com/Multicorn-AI/multicorn-shield/security/advisories/new

If you cannot use GitHub, email security@multicorn.ai.

We aim to acknowledge reports within 2 business days and provide a resolution timeline within 7 business days.

## Publishing posture

Releases publish from a single GitHub Actions workflow (`.github/workflows/publish.yml`). It is manually dispatched (`workflow_dispatch`). Each run installs dependencies, runs lint, typecheck, tests, and build, bumps the package version, publishes to npm with `pnpm publish --access public --provenance`, then pushes the version commit and tag. After a successful publish, the same workflow may POST to a Vercel deploy hook (repository secret) to refresh the learn site; that step does not interact with the npm registry. This workflow is the only supported publishing path for the npm package.

The npm publish step uses a scoped automation token stored as one repository secret (`NPM_TOKEN`), used only by this workflow.
