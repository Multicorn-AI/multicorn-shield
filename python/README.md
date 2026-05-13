# Multicorn Shield - Python Client

[![MIT Licence](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)
[![PyPI version](https://img.shields.io/pypi/v/multicorn-shield.svg)](https://pypi.org/project/multicorn-shield/)

Python client for Multicorn Shield, the open-source AI agent governance platform.

## Install

```bash
pip install multicorn-shield
```

## Quick start

```python
from multicorn_shield import ShieldClient

client = ShieldClient(api_key="mcs_your_key_here")

result = client.log_action(
    agent_id="your-agent-uuid",  # from the dashboard or list_agents()
    service="gmail",
    action_type="send_email",
    cost=2,  # 2 cents
    metadata={"recipient": "user@example.com"},
)

print(result.status)  # APPROVED, BLOCKED, PENDING, etc.
```

The client also works as a context manager:

```python
with ShieldClient(api_key="mcs_your_key_here") as client:
    agents = client.list_agents()
    for agent in agents:
        print(f"{agent.name} ({agent.status})")
```

## Async usage

```python
import asyncio
from multicorn_shield import AsyncShieldClient

async def main():
    async with AsyncShieldClient(api_key="mcs_your_key_here") as client:
        result = await client.log_action(
            agent_id="your-agent-uuid",  # from the dashboard or list_agents()
            service="gmail",
            action_type="send_email",
        )
        print(result.status)

asyncio.run(main())
```

## API methods

| Method                                            | Description                                           |
| ------------------------------------------------- | ----------------------------------------------------- |
| `log_action(agent_id, service, action_type, ...)` | Submit an action to the policy engine (cost in cents) |
| `get_agent(agent_id)`                             | Fetch a single agent by ID                            |
| `list_agents()`                                   | List all agents visible to your API key               |
| `list_scopes(agent_id)`                           | List all permission scopes for an agent               |
| `check_scopes(agent_id, service)`                 | Check resolved permissions for an agent on a service  |
| `get_spending(agent_id)`                          | Fetch spending limits for an agent (values in cents)  |

Both `ShieldClient` and `AsyncShieldClient` expose the same methods. The async variant returns coroutines.

## TypeScript SDK

The [TypeScript SDK](https://www.npmjs.com/package/multicorn-shield) has additional features not yet available in the Python client:

- Consent screens (Shadow DOM web component)
- MCP adapter (middleware for MCP tool call interception)
- MCP proxy (wrap any MCP server with zero code changes)
- Client-side spending enforcement with integer-cents arithmetic

## Documentation

Full docs at [multicorn.ai/shield](https://multicorn.ai/shield).

## Licence

[MIT](LICENSE) - Multicorn AI Pty Ltd
