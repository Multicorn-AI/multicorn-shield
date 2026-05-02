# Multicorn Shield for Windsurf (Cascade Hooks)

Native Shield integration for [Windsurf](https://windsurf.com) using [Cascade Hooks](https://docs.windsurf.com/windsurf/cascade/hooks). Every governed pre-hook asks the Shield API whether the action may run; post-hooks log completed actions to your audit trail.

## Install

1. Install the CLI package (or use `npx`).

```bash
  npm install -g multicorn-shield
```

2. Run the wizard and pick **Windsurf**, then **Native plugin (recommended)**.

   ```bash
   npx multicorn-shield init
   ```

3. Restart Windsurf (quit fully, then reopen) so hooks load.

The wizard copies `pre-action.cjs` and `post-action.cjs` to `~/.multicorn/windsurf-hooks/` and merges entries into `~/.codeium/windsurf/hooks.json`.

## How it works

- **Config** is read from `~/.multicorn/config.json` (same file as other Shield integrations). The agent row must use `platform: "windsurf"`.
- **Permission check**: `POST /api/v1/actions` with `status: "pending"` and `X-Multicorn-Key`. Exit code `0` allows the action; `2` blocks and prints guidance on stderr (see Windsurf hook docs). (Exit code `2` tells Windsurf to cancel the action and show the message to the user.)
- **Audit log**: post-hooks send `POST /api/v1/actions` with `status: "approved"` after the action completes.

### Event to Shield mapping

| Windsurf `agent_action_name`  | Shield `service`      | Shield `actionType` |
| ----------------------------- | --------------------- | ------------------- |
| `pre_read_code` / `post_*`    | `filesystem`          | `read`              |
| `pre_write_code` / `post_*`   | `filesystem`          | `write`             |
| `pre_run_command` / `post_*`  | `terminal`            | `execute`           |
| `pre_mcp_tool_use` / `post_*` | `mcp:<server>.<tool>` | `execute`           |

Stdin includes `trajectory_id`, `execution_id`, and `tool_info`; those are forwarded in `metadata` for auditing.

## Trust model

Hooks run shell commands with **your user permissions**. They can read the JSON on stdin and call the network. Review the scripts under `~/.multicorn/windsurf-hooks/` before you rely on them in sensitive environments.

## Hosted proxy alternative

If you only need MCP traffic governed, use **Hosted proxy** in `npx multicorn-shield init` and paste the proxy URL into `~/.codeium/windsurf/mcp_config.json` instead.

## Windows

Hooks include a `powershell` field for Windsurf on Windows. Full Windows support may be incomplete compared to macOS and Linux; if something breaks, open an issue with your Windsurf and Node versions.

## References

- [Cascade Hooks](https://docs.windsurf.com/windsurf/cascade/hooks)
