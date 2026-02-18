# Contributing to Multicorn Shield

Thank you for your interest in contributing to Multicorn Shield. This document explains how to get involved.

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold these standards. Please report unacceptable behaviour to conduct@multicorn.ai.

## How to Contribute

### Reporting Issues

- Search [existing issues](https://github.com/Multicorn-AI/multicorn-shield/issues) before opening a new one.
- Use the appropriate issue template (bug report, feature request).
- Include reproduction steps for bugs. Minimal, complete examples speed up resolution.

### Pull Request Workflow

1. **Fork** the repository and clone your fork locally.
2. **Branch** from `main` using the naming convention:
   ```
   feature/short-description
   fix/short-description
   docs/short-description
   chore/short-description
   ```
3. **Make your changes.** Keep PRs focused — one logical change per PR.
4. **Write tests.** New code needs tests. The SDK targets 85% minimum coverage.
5. **Commit** using [Conventional Commits](https://www.conventionalcommits.org/):
   ```
   feat(consent): add keyboard shortcut for approve action
   fix(spending): correct daily reset at midnight boundary
   docs(readme): add Vue framework example
   test(mcp): add coverage for custom extractService function
   ```
6. **Push** and open a pull request against `main`.

## Development Setup

### Prerequisites

- Node.js 20+ (check `.nvmrc`)
- pnpm 9+

### Getting Started

```bash
git clone https://github.com/<your-fork>/multicorn-shield.git
cd multicorn-shield
pnpm install
pnpm test
pnpm build
```

### Useful Commands

| Command              | What it does                        |
| -------------------- | ----------------------------------- |
| `pnpm build`         | Build ESM + CJS bundles             |
| `pnpm dev`           | Build in watch mode                 |
| `pnpm test`          | Run the full test suite             |
| `pnpm test:watch`    | Run tests in watch mode             |
| `pnpm test:coverage` | Run tests with coverage reporting   |
| `pnpm lint`          | Check lint and formatting           |
| `pnpm lint:fix`      | Auto-fix lint and formatting issues |
| `pnpm typecheck`     | Type-check without emitting output  |
| `pnpm docs`          | Generate API documentation          |

## Coding Standards

### TypeScript

- Strict mode is always on. No `any` types — use `unknown` with type guards.
- No `!` non-null assertions. Handle nulls explicitly.
- No `enum` — use `as const` objects with type inference.
- Prefer `interface` over `type` for object shapes.
- Named exports only (no default exports).
- All async functions must have error handling.
- Use `readonly` on arrays and objects that should not be mutated.

### File Structure

- No file should exceed approximately 300 lines. Split if it does.
- One responsibility per file.
- Utility functions go in files named after what they do (`formatCurrency.ts`), not in catch-all `utils.ts` files.

### Testing

- Test names read like specifications: `"blocks action when agent exceeds spending limit"`.
- Test happy paths, edge cases, and error paths.
- Do not test framework internals or write tests that only assert mocks were called.

### Documentation

- All public functions and types have JSDoc with `@example` blocks.
- Comments explain why, not what. The code should be self-explanatory.

## Pull Request Process

### Before Submitting

- [ ] All tests pass (`pnpm test`)
- [ ] Lint passes (`pnpm lint`)
- [ ] Types check (`pnpm typecheck`)
- [ ] Build succeeds (`pnpm build`)
- [ ] Coverage meets or exceeds 85%

### PR Description

Include these sections in every PR description:

1. **What** — one-sentence summary of the change
2. **Why** — what problem this solves or what value it adds
3. **How** — brief technical approach
4. **Testing** — what was tested and how to verify

### What Reviewers Look For

- Does the change follow the coding standards above?
- Are there tests for new behaviour?
- Are error messages clear and actionable?
- Is the public API surface intentional (not accidentally exposing internals)?
- Does the change introduce any security concerns?

### Issue Labels

| Label              | Meaning                                   |
| ------------------ | ----------------------------------------- |
| `good first issue` | Suitable for new contributors             |
| `bug`              | Confirmed defect                          |
| `enhancement`      | Feature request or improvement            |
| `documentation`    | Documentation changes only                |
| `security`         | Security-related issue (handle with care) |
| `breaking`         | Change that affects the public API        |

### Release Process

This project follows [Semantic Versioning](https://semver.org/):

- **Patch** (0.0.x) — bug fixes, no API changes
- **Minor** (0.x.0) — new features, backwards compatible
- **Major** (x.0.0) — breaking changes to the public API

Releases are triggered by maintainers. The [CHANGELOG](CHANGELOG.md) is updated with every release using [Keep a Changelog](https://keepachangelog.com/) format.

## Questions?

Open a [discussion](https://github.com/Multicorn-AI/multicorn-shield/discussions) or reach out at hello@multicorn.ai.
