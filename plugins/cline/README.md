# Multicorn Shield Cline plugin

This folder ships **Shield hooks for the [Cline](https://github.com/cline/cline) VS Code extension**. The PreToolUse script asks Shield whether a pending tool call is allowed; the PostToolUse script records completed actions in the Shield audit trail.

## Prerequisites

- **Node.js** 20 or newer (hooks run as standalone Node scripts).
- **Cline** v3.36 or newer with **Hooks** enabled in settings.

Keep these three scripts together whenever you install by hand:

- `hooks/scripts/pre-tool-use.cjs`
- `hooks/scripts/post-tool-use.cjs`
- `hooks/scripts/shared.cjs`

## Installing the hooks

**CLI (recommended):** run `npx multicorn-shield init` and follow prompts so the scripts are copied into Cline's hooks directory.

**Manual:** copy the `hooks/scripts/` `.cjs` files into:

`~/Documents/Cline/Hooks/`

(or the equivalent Hooks path on your machine). Cline runs each hook with stdin JSON from its Hooks API.

## Config file

Path: **`~/.multicorn/config.json`**

| Field     | Required | Description                                                                                                                                                                               |
| --------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiKey`  | yes      | Multicorn API key used in the Shield request (`X-Multicorn-Key`).                                                                                                                         |
| `baseUrl` | no       | API root. Defaults to `https://api.multicorn.ai` (no trailing slash). Non-local URLs must use `https://` or the hooks disable Shield (fail-open). `localhost` / `127.0.0.1` may use HTTP. |
| `agents`  | no       | Array of `{ "name": "...", "platform": "cline" }` objects so the hooks know which Shield agent name to use. Legacy `agentName` string is still read if present.                           |

Example:

```json
{
  "apiKey": "mcs_your_key_here",
  "baseUrl": "https://api.multicorn.ai",
  "agents": [{ "name": "my-repo-agent", "platform": "cline" }]
}
```

## How it works

1. **PreToolUse:** before Cline runs a tool, stdin carries the pending request. The script maps the tool name to a Shield **service** and **actionType**, POSTs `status: pending` to `/api/v1/actions`, and reads the response. It either allows the tool (`cancel: false`) or blocks with an error message and optional consent workflow.
2. **PostToolUse:** after the tool completes, stdin includes the outcome. The script POSTs `status: approved` with metadata (scrubbed parameters and result) so the audit log stays usable without stuffing large secrets into the payload.

Both hooks reply with JSON on stdout. The post-hook always finishes with `{ "cancel": false }`.

## Security model

Shield wiring is **fail-open by design**. If config is missing, invalid for remote HTTP, or the API errors or times out, **actions are allowed** so work is not silently blocked because Shield is down. Deployers treat Shield as governance and auditing, not as a cryptographic boundary against a hostile process on the same machine.

## Troubleshooting

1. **Confirm hooks run:** temporarily add stderr output (not recommended long term), or tail Cline's hook output/logs if exposed. Successful runs should not spam the developer console unless there is an API warning.
2. **Nothing reaches Shield:** check `config.json` path and `apiKey`, that `agents` includes `platform: "cline"` with the right `name`, and that `baseUrl` uses HTTPS on non-local installs.
3. **Windows consent / browser:** the pre-hook opens the consent URL via `cmd.exe start`; if that fails, open the URL from the blocking message manually.
