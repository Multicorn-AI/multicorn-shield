# multicorn-shield

The control layer for AI agents — permissions, consent, spending limits, and audit logging.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## What is Multicorn Shield?

Multicorn Shield is a TypeScript SDK that gives you fine-grained control over what AI agents can do. It provides:

- **Consent screen** — A web component that lets users review and approve agent permissions before granting access
- **Scope validation** — Type-safe permission scopes with runtime validation
- **Action logging** — Structured audit trail of every action an agent takes
- **Spending controls** — Client-side enforcement of per-transaction and cumulative spend limits

## Quick Start

```bash
# Install
pnpm add multicorn-shield

# Or with npm/yarn
npm install multicorn-shield
yarn add multicorn-shield
```

```typescript
import { /* modules will be exported here */ } from "multicorn-shield";
```

## Development

### Prerequisites

- Node.js 20+ (see `.nvmrc`)
- pnpm 9+

### Setup

```bash
git clone https://github.com/Multicorn-AI/multicorn-shield.git
cd multicorn-shield
pnpm install
```

### Commands

| Command | Description |
|---------|-------------|
| `pnpm build` | Build ESM and CJS bundles with tsup |
| `pnpm dev` | Build in watch mode |
| `pnpm lint` | Run ESLint and Prettier checks |
| `pnpm lint:fix` | Auto-fix lint and formatting issues |
| `pnpm test` | Run tests with Vitest |
| `pnpm test:watch` | Run tests in watch mode |
| `pnpm test:coverage` | Run tests with Istanbul coverage reporting |
| `pnpm typecheck` | Type-check without emitting |

### Project Structure

```
src/
├── index.ts          # Package entry point (barrel exports)
├── consent/          # Consent screen web component
├── scopes/           # Scope types and validation
├── logger/           # Action logging client
├── spending/         # Client-side spend checks
└── types/            # Shared TypeScript types
```

## Architecture

Multicorn Shield is the client-side SDK in the Multicorn ecosystem. It communicates with the [Multicorn Service](https://github.com/Multicorn-AI/multicorn-service) backend API and is complemented by the [Multicorn Dashboard](https://github.com/Multicorn-AI/multicorn-dashboard) for administration.

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE) © Multicorn AI
