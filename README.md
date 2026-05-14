# Multicorn Shield

Most AI coding agents inherit direct access to MCP tools, terminals, mail, and spend with no enforced guardrails, and Shield inserts consent workflows, budgets, policy checks, and tamper-evident logging before governed calls execute.

- **Permission enforcement** - Policy checks on scoped access so agents can't wander past what you granted.
- **Consent flows** - Human-in-the-loop approval when the model asks for new or risky actions.
- **Audit trails** - Structured activity logs with append-only hashing so history is harder to forge.
- **Spending controls** - Per-session and rolling limits aligned with budgets you set on the dashboard.
- **Anomaly detection** - Surfaces spikes and outliers in agent behaviour before they become incidents.

[![npm version](https://img.shields.io/npm/v/multicorn-shield.svg)](https://www.npmjs.com/package/multicorn-shield)
[![MIT Licence](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/Multicorn-AI/multicorn-shield/actions/workflows/ci.yml/badge.svg)](https://github.com/Multicorn-AI/multicorn-shield/actions/workflows/ci.yml)

<p align="center">
  <img src="https://multicorn.ai/images/demo.gif" alt="Multicorn Shield demo: agent blocked, user approves in dashboard, agent proceeds" width="800" />
</p>

[Consent screen (full-size image)](https://multicorn.ai/images/screenshots/consent-screen.png)

## Supported agents

`npx multicorn-shield init` recognises every platform listed here (same registry as [`INIT_WIZARD_PLATFORM_REGISTRY`](https://github.com/Multicorn-AI/multicorn-shield/blob/main/src/proxy/config.ts) in source). Integration mode follows the [**Shield threat model**](https://multicorn.ai/shield/threat-model): **native plugins** inspect the whole tool surface exposed by the host; **hosted MCP proxy** governs MCP-shaped traffic routed through Shield.

| Agent                           | Mode                                             | Setup on multicorn.ai                                                 |
| ------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------- |
| [OpenClaw](https://openclaw.ai) | Native plugin                                    | [Setup guide](https://multicorn.ai/docs/mcp-proxy#openclaw)           |
| Claude Code                     | Native plugin                                    | [Setup guide](https://multicorn.ai/docs/mcp-proxy#claude-code)        |
| Windsurf                        | Native Cascade hooks (hosted MCP proxy optional) | [Setup guide](https://multicorn.ai/docs/mcp-proxy#quick-start)        |
| Cline                           | Native hooks                                     | [Setup guide](https://multicorn.ai/docs/mcp-proxy#quick-start)        |
| Gemini CLI                      | Native hooks                                     | [Setup guide](https://multicorn.ai/docs/mcp-proxy#quick-start)        |
| OpenCode                        | Native plugin                                    | [Setup guide](https://multicorn.ai/docs/mcp-proxy#quick-start)        |
| Codex CLI                       | Native hooks                                     | [Setup guide](https://multicorn.ai/docs/mcp-proxy#quick-start)        |
| Cursor                          | Hosted MCP proxy                                 | [Setup guide](https://multicorn.ai/docs/mcp-proxy#generic-mcp-client) |
| Claude Desktop                  | Hosted MCP proxy or `.mcpb` extension            | [Setup guide](https://multicorn.ai/shield)                            |
| GitHub Copilot                  | Hosted MCP proxy                                 | [Setup guide](https://multicorn.ai/docs/mcp-proxy#generic-mcp-client) |
| Kilo Code                       | Hosted MCP proxy                                 | [Setup guide](https://multicorn.ai/docs/mcp-proxy#generic-mcp-client) |
| Continue                        | Hosted MCP proxy                                 | [Setup guide](https://multicorn.ai/docs/mcp-proxy#generic-mcp-client) |
| Goose                           | Hosted MCP proxy                                 | [Setup guide](https://multicorn.ai/docs/mcp-proxy#generic-mcp-client) |

For any other MCP client on stdio, pick **Local MCP / Other** in the wizard or open the [Setup guide](https://multicorn.ai/docs/mcp-proxy#generic-mcp-client).

## Quick start

Fastest path to a governed proxy ([full walkthrough](https://multicorn.ai/docs/mcp-proxy)):

```bash
npm install -g multicorn-shield
npx multicorn-shield init
```

The wizard prompts for your API key (`mcs_…` from [app.multicorn.ai](https://app.multicorn.ai)) and merges platform-specific snippets into the right config paths. Run it again any time you add another host agent. Inspect saved agents with:

```bash
npx multicorn-shield agents
```

After init, wrap your MCP server when you launch it:

```bash
npx multicorn-shield --wrap <your-existing-mcp-command>
```

Shield bundles an OpenClaw plugin under `dist/openclaw-plugin/` if you prefer native interception over wrapping the MCP process. Claude Desktop users can sidestep manual JSON editing with the downloadable `.mcpb` bundle from [multicorn.ai/shield](https://multicorn.ai/shield). Need the SDK directly? Jump to **[SDK snippet](#sdk-snippet)** and the [getting started tutorial](https://multicorn.ai/docs/getting-started).

## Links

| Resource       | URL                                              |
| -------------- | ------------------------------------------------ |
| Docs hub       | https://multicorn.ai/shield                      |
| Product docs   | https://multicorn.ai/docs/getting-started        |
| Live dashboard | https://app.multicorn.ai                         |
| Source         | https://github.com/Multicorn-AI/multicorn-shield |

Changelog: [CHANGELOG.md](CHANGELOG.md) · Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) · Security: [SECURITY.md](SECURITY.md)

## SDK snippet

Install as a dependency when you embed consent screens or bespoke logging paths:

```bash
npm install multicorn-shield
```

```typescript
import { MulticornShield } from "multicorn-shield";

const shield = new MulticornShield({ apiKey: "mcs_your_key_here" });

const decision = await shield.requestConsent({
  agent: "OpenClaw",
  scopes: ["read:gmail", "write:calendar"],
  spendLimit: 200,
});

await shield.logAction({
  agent: "OpenClaw",
  service: "gmail",
  action: "send_email",
  status: "approved",
});
```

## Configuration

The hosted **[getting started guide](https://multicorn.ai/docs/getting-started)** spells out CLI quick starts and SDK bootstrap defaults. MCP adapter knobs, consent payloads, CLI flags for the proxy wrapper, spending helpers, and every public export are covered by TypeDoc emitted with `pnpm docs` into **`docs/api/`**.

## Architecture

```
Your agent / Browser
           │
           ▼
multicorn-shield SDK · CLI · local proxy shim
           │
        HTTPS (see Network behaviour below)
           ▼
   Multicorn hosted API -> Dashboard UI
```

For module-level internals (consent renderer, MCP adapter, spending checker, proxies), regenerate TypeDoc locally (`pnpm docs`) and skim `docs/adr/`.

The SDK validates scopes client-side before calling hosted persistence. MCP proxy setups add localhost-only IPC (`127.0.0.1`) between wrapper and MCP child.

See **[Network behaviour](#network-behaviour)** for reachable hosts.

## Network behaviour

- **`api.multicorn.ai`:** Consent workflows, approvals, auditing, spends. Calls happen only while your code or CLI path runs Shield. There is no import-time network activity.
- **`localhost`:** Proxy-local IPC during stdio MCP wrapping. Traffic never leaves the machine.
- **CLI config:** The wizard writes your API key into `~/.multicorn/config.json` on disk. The in-app SDK keeps keys in memory unless you persist them yourself.

No third-party telemetry.

## Dashboard

Approve, reject, revoke, tune budgets, and watch live traffic at [app.multicorn.ai](https://app.multicorn.ai). Works for both MCP proxy setups and bespoke SDK integrations.

## Development

Requires Node.js 20+ and pnpm 9+.

```bash
git clone https://github.com/Multicorn-AI/multicorn-shield.git
cd multicorn-shield
pnpm install
pnpm test
pnpm build
```

| Script               | Meaning                              |
| -------------------- | ------------------------------------ |
| `pnpm build`         | Produce ESM+CJS bundles with tsup    |
| `pnpm dev`           | tsup watch mode                      |
| `pnpm lint`          | ESLint + Prettier                    |
| `pnpm lint:fix`      | ESLint autofix plus Prettier write   |
| `pnpm test`          | Vitest unit suite                    |
| `pnpm test:coverage` | Vitest plus Istanbul instrumentation |
| `pnpm typecheck`     | `tsc --noEmit`                       |
| `pnpm docs`          | Typedoc emission into `docs/api/`    |

Detailed notes live in **`src/`** headers and **`docs/adr/`**.

```
multicorn-shield/
├── src/                 # SDK, CLI, MCP adapter, consent web component
├── plugins/             # Host-specific hooks (Cline, Codex CLI, Windsurf, OpenCode…)
├── bin/                 # Executable entry stubs
├── docs/adr/            # Architecture decision records
└── examples/            # Runnable HTML snippets
```

## Publishing & ownership

Published by `multicorn-ai` on npm. CI runs lint, types, tests, and build before every release. See [SECURITY.md](SECURITY.md) for supply-chain concerns. Operational detail lives in [CONTRIBUTING.md](CONTRIBUTING.md).

## Contributing

Patches welcome: read [CONTRIBUTING.md](CONTRIBUTING.md), open issues for platform gaps, attach repro logs whenever hooks mis-fire.

## Licence

[MIT](LICENSE) © Multicorn AI Pty Ltd
