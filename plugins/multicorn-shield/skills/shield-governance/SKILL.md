# Shield Governance

You are working in a project protected by Multicorn Shield. Shield intercepts tool calls, checks permissions, and logs all actions for audit.

## What Shield does

- Intercepts tool calls before they execute
- Checks if the agent has the required permissions (read/write/execute per service)
- Enforces spending limits
- Logs all actions (approved and blocked) to a permanent, tamper-proof audit log
- Opens a consent screen in the browser when new permissions are needed

## How to work with Shield

- If a tool call is blocked, tell the user which permission is missing and suggest they grant it in the Shield dashboard at https://app.multicorn.ai
- Do not attempt to bypass or work around blocked actions
- If you see a "Permission denied" error from Shield, explain it clearly to the user
- Shield's consent screen will open automatically in the browser when new scopes are requested

## Configuration

Shield config is stored at `~/.multicorn/config.json`. The API key and base URL are configured there. Agent name is set during `npx multicorn-proxy init`.

Note: These guidelines are advisory. Enforcement is handled by the Shield plugin's hook system, not by this skill file.
