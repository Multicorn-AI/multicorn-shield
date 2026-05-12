# Codex CLI hook scripts for Multicorn Shield

These files support **Codex CLI** native hooks (`PreToolUse` / `PostToolUse`): permission checks before tools run and logging afterward.

## Generated outputs

The runnable scripts under `hooks/scripts/` are **built from TypeScript** in `src/hooks/`:

| Output (`hooks/scripts/`)    | Source                                 |
| ---------------------------- | -------------------------------------- |
| `pre-tool-use.cjs`           | `src/hooks/codex-cli-pre-tool-use.ts`  |
| `post-tool-use.cjs`          | `src/hooks/codex-cli-post-tool-use.ts` |
| `codex-cli-hooks-shared.cjs` | `src/hooks/codex-cli-hooks-shared.ts`  |
| `codex-cli-tool-map.cjs`     | `src/hooks/codex-cli-tool-map.ts`      |

Do **not** edit the `.cjs` files by hand. Change the `.ts` sources and rebuild.

## Build

From the **multicorn-shield** package root:

```bash
pnpm build
```

That runs `tsup`, which emits the Codex CLI hook bundle into `plugins/codex-cli/hooks/scripts/`.

## Manual testing

Hooks read **one JSON object from stdin** (Codex passes the hook payload). Examples:

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | node plugins/codex-cli/hooks/scripts/pre-tool-use.cjs
echo '{"tool_name":"Bash","tool_input":{"command":"ls"},"tool_result":"ok"}' | node plugins/codex-cli/hooks/scripts/post-tool-use.cjs
```

Use a valid `~/.multicorn/config.json` with `apiKey`, `baseUrl`, and agent entries when exercising the Shield API paths.

## Main documentation

See the [multicorn-shield README](../../README.md) for installation, configuration, and Shield concepts.
