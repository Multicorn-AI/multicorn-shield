from __future__ import annotations

import httpx
import pytest

from multicorn_shield.client import AsyncShieldClient
from multicorn_shield.exceptions import ShieldAuthError
from multicorn_shield.models import ActionResult


def _async_client_with_transport(transport: httpx.MockTransport) -> AsyncShieldClient:
    """Create an AsyncShieldClient whose internal httpx.AsyncClient uses a mock transport."""
    return AsyncShieldClient(
        api_key="test-key",
        base_url="https://test.local",
        _transport=transport,
    )


@pytest.mark.anyio
async def test_async_log_action_approved():
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"status": "APPROVED", "reason": None})

    transport = httpx.MockTransport(handler)
    client = _async_client_with_transport(transport)
    try:
        result = await client.log_action("agent-1", "gmail", "send_email")
        assert isinstance(result, ActionResult)
        assert result.status == "APPROVED"
        assert result.reason is None
    finally:
        await client.close()


@pytest.mark.anyio
async def test_async_log_action_blocked():
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"status": "BLOCKED", "reason": "Spending limit exceeded"},
        )

    transport = httpx.MockTransport(handler)
    client = _async_client_with_transport(transport)
    try:
        result = await client.log_action("agent-1", "gmail", "send_email", cost=100)
        assert result.status == "BLOCKED"
        assert result.reason == "Spending limit exceeded"
    finally:
        await client.close()


@pytest.mark.anyio
async def test_async_401_raises_auth_error():
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="Unauthorized")

    transport = httpx.MockTransport(handler)
    client = _async_client_with_transport(transport)
    try:
        with pytest.raises(ShieldAuthError):
            await client.log_action("agent-1", "gmail", "send_email")
    finally:
        await client.close()


@pytest.mark.anyio
async def test_async_context_manager():
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"status": "APPROVED"})

    transport = httpx.MockTransport(handler)
    async with _async_client_with_transport(transport) as client:
        result = await client.log_action("agent-1", "gmail", "send_email")
        assert result.status == "APPROVED"
