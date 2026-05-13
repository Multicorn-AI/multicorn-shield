from __future__ import annotations

from typing import Any

import httpx

from multicorn_shield._version import __version__
from multicorn_shield.exceptions import ShieldAPIError, ShieldAuthError, ShieldNotFoundError
from multicorn_shield.models import ActionResult, Agent, Scope, SpendingLimits

_USER_AGENT = f"multicorn-shield-python/{__version__}"


def _handle_response(response: httpx.Response) -> None:
    """Raise typed exceptions for non-2xx responses."""
    if response.is_success:
        return
    if response.status_code in (401, 403):
        raise ShieldAuthError(response.text)
    if response.status_code == 404:
        raise ShieldNotFoundError(response.text)
    raise ShieldAPIError(response.status_code, response.text)


class ShieldClient:
    """Synchronous client for the Multicorn Shield API."""

    def __init__(
        self,
        api_key: str,
        base_url: str = "https://api.multicorn.ai",
        *,
        _transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._client = httpx.Client(
            headers={
                "X-Multicorn-Key": api_key,
                "Content-Type": "application/json",
                "User-Agent": _USER_AGENT,
            },
            transport=_transport,
        )

    def log_action(
        self,
        agent_id: str,
        service: str,
        action_type: str,
        cost: int = 0,
        metadata: dict[str, Any] | None = None,
    ) -> ActionResult:
        """Submit an action to the Shield policy engine.

        Returns an ActionResult with the policy decision.
        Cost is in cents (integer).
        """
        payload: dict[str, Any] = {
            "agent_id": agent_id,
            "service": service,
            "action_type": action_type,
            "cost": cost,
        }
        if metadata is not None:
            payload["metadata"] = metadata
        response = self._client.post(
            f"{self._base_url}/api/v1/actions",
            json=payload,
        )
        _handle_response(response)
        return ActionResult.from_dict(response.json())

    def get_agent(self, agent_id: str) -> Agent:
        """Fetch a single agent by ID."""
        response = self._client.get(f"{self._base_url}/api/v1/agents/{agent_id}")
        _handle_response(response)
        return Agent.from_dict(response.json())

    def list_agents(self) -> list[Agent]:
        """List all agents visible to the current API key."""
        response = self._client.get(f"{self._base_url}/api/v1/agents")
        _handle_response(response)
        return [Agent.from_dict(a) for a in response.json()]

    def list_scopes(self, agent_id: str) -> list[Scope]:
        """Return all permission scopes for an agent."""
        response = self._client.get(
            f"{self._base_url}/api/v1/agents/{agent_id}/permissions",
        )
        _handle_response(response)
        return [Scope.from_dict(s) for s in response.json()]

    def check_scopes(self, agent_id: str, service: str) -> Scope:
        """Check the resolved permission scope for an agent on a service.

        Raises ShieldNotFoundError if no scope exists for the given service.
        """
        scopes = self.list_scopes(agent_id)
        for scope in scopes:
            if scope.service == service:
                return scope
        raise ShieldNotFoundError(
            f"No permission scope found for service '{service}'"
        )

    def get_spending(self, agent_id: str) -> SpendingLimits:
        """Fetch spending limits for an agent. Values are in cents."""
        response = self._client.get(f"{self._base_url}/api/v1/agents/{agent_id}")
        _handle_response(response)
        return SpendingLimits.from_dict(response.json())

    def close(self) -> None:
        """Close the underlying HTTP client."""
        self._client.close()

    def __enter__(self) -> ShieldClient:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()


class AsyncShieldClient:
    """Asynchronous client for the Multicorn Shield API."""

    def __init__(
        self,
        api_key: str,
        base_url: str = "https://api.multicorn.ai",
        *,
        _transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(
            headers={
                "X-Multicorn-Key": api_key,
                "Content-Type": "application/json",
                "User-Agent": _USER_AGENT,
            },
            transport=_transport,
        )

    async def log_action(
        self,
        agent_id: str,
        service: str,
        action_type: str,
        cost: int = 0,
        metadata: dict[str, Any] | None = None,
    ) -> ActionResult:
        """Submit an action to the Shield policy engine.

        Returns an ActionResult with the policy decision.
        Cost is in cents (integer).
        """
        payload: dict[str, Any] = {
            "agent_id": agent_id,
            "service": service,
            "action_type": action_type,
            "cost": cost,
        }
        if metadata is not None:
            payload["metadata"] = metadata
        response = await self._client.post(
            f"{self._base_url}/api/v1/actions",
            json=payload,
        )
        _handle_response(response)
        return ActionResult.from_dict(response.json())

    async def get_agent(self, agent_id: str) -> Agent:
        """Fetch a single agent by ID."""
        response = await self._client.get(
            f"{self._base_url}/api/v1/agents/{agent_id}",
        )
        _handle_response(response)
        return Agent.from_dict(response.json())

    async def list_agents(self) -> list[Agent]:
        """List all agents visible to the current API key."""
        response = await self._client.get(f"{self._base_url}/api/v1/agents")
        _handle_response(response)
        return [Agent.from_dict(a) for a in response.json()]

    async def list_scopes(self, agent_id: str) -> list[Scope]:
        """Return all permission scopes for an agent."""
        response = await self._client.get(
            f"{self._base_url}/api/v1/agents/{agent_id}/permissions",
        )
        _handle_response(response)
        return [Scope.from_dict(s) for s in response.json()]

    async def check_scopes(self, agent_id: str, service: str) -> Scope:
        """Check the resolved permission scope for an agent on a service.

        Raises ShieldNotFoundError if no scope exists for the given service.
        """
        scopes = await self.list_scopes(agent_id)
        for scope in scopes:
            if scope.service == service:
                return scope
        raise ShieldNotFoundError(
            f"No permission scope found for service '{service}'"
        )

    async def get_spending(self, agent_id: str) -> SpendingLimits:
        """Fetch spending limits for an agent. Values are in cents."""
        response = await self._client.get(
            f"{self._base_url}/api/v1/agents/{agent_id}",
        )
        _handle_response(response)
        return SpendingLimits.from_dict(response.json())

    async def close(self) -> None:
        """Close the underlying HTTP client."""
        await self._client.aclose()

    async def __aenter__(self) -> AsyncShieldClient:
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.close()
