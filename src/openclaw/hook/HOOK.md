---
name: multicorn-shield
description: "Multicorn Shield governance for OpenClaw. Checks permissions, logs actions, and enforces controls via the Shield API."
metadata:
  {
    "openclaw":
      {
        "emoji": "shield",
        "events": ["agent:tool_call"],
        "requires": { "env": ["MULTICORN_API_KEY"] },
        "primaryEnv": "MULTICORN_API_KEY",
      },
  }
---

# Multicorn Shield (Gateway Hook - Deprecated)

> **This gateway hook is deprecated.** Gateway hooks cannot intercept tool calls.
> Use the **Plugin API** version instead:
>
> ```bash
> cd multicorn-shield && npm run build
> openclaw plugins install --link ./dist/openclaw-plugin/index.js
> openclaw plugins enable multicorn-shield
> openclaw gateway restart
> ```
>
> See the plugin README for full instructions.

Governance layer for OpenClaw agents. Every tool call is checked against your Shield permissions before it runs. Blocked actions never reach the tool. All activity - approved and blocked - shows up in your Shield dashboard.

## What it does

- Checks every tool call (read, write, exec, browser, message) against your Shield permissions
- Blocks tools you haven't granted access to, with a clear message to the agent
- Opens the Shield consent page in your browser on first use
- Logs all activity to the Shield dashboard (fire-and-forget, doesn't slow down the agent)

## Setup (Deprecated - use the plugin instead)

```bash
# 1. Copy the hook
cp -r multicorn-shield ~/.openclaw/hooks/

# 2. Set your API key
export MULTICORN_API_KEY=mcs_your_key_here

# 3. Enable it
openclaw hooks enable multicorn-shield

# 4. Restart the gateway
openclaw gateway restart
```

## Environment variables

| Variable             | Required | Default                  | Description                                                                   |
| -------------------- | -------- | ------------------------ | ----------------------------------------------------------------------------- |
| MULTICORN_API_KEY    | Yes      | -                        | Your Multicorn API key (starts with `mcs_`)                                   |
| MULTICORN_BASE_URL   | No       | https://api.multicorn.ai | Shield API base URL                                                           |
| MULTICORN_AGENT_NAME | No       | Derived from session     | Override the agent name shown in the dashboard                                |
| MULTICORN_FAIL_MODE  | No       | open                     | `open` = allow tool calls when the API is unreachable. `closed` = block them. |

## How permissions map

| OpenClaw tool  | Shield permission |
| -------------- | ----------------- |
| read           | filesystem:read   |
| write, edit    | filesystem:write  |
| exec, process  | terminal:execute  |
| browser        | browser:execute   |
| message        | messaging:write   |
| sessions_spawn | agents:execute    |

Tools not in this list are tracked under their own name with `execute` permission.
