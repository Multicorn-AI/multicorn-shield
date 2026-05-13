from __future__ import annotations

import httpx
import pytest

from multicorn_shield.client import ShieldClient
from multicorn_shield.exceptions import ShieldAPIError, ShieldAuthError, ShieldNotFoundError
from multicorn_shield.models import ActionResult, Agent, Scope


def _make_transport(handler):
    """Build an httpx.MockTransport from a request handler function."""
    return httpx.MockTransport(handler)


def _client_with_transport(transport: httpx.MockTransport) -> ShieldClient:
    """Create a ShieldClient whose internal httpx.Client uses a mock transport."""
    return ShieldClient(
        api_key="test-key",
        base_url="https://test.local",
        _transport=transport,
    )


class TestLogAction:
    def test_approved(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"status": "APPROVED", "reason": None})

        client = _client_with_transport(_make_transport(handler))
        result = client.log_action("agent-1", "gmail", "send_email")
        assert isinstance(result, ActionResult)
        assert result.status == "APPROVED"
        assert result.reason is None

    def test_blocked_with_reason(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={"status": "BLOCKED", "reason": "Daily limit exceeded"},
            )

        client = _client_with_transport(_make_transport(handler))
        result = client.log_action("agent-1", "gmail", "send_email", cost=100)
        assert result.status == "BLOCKED"
        assert result.reason == "Daily limit exceeded"


class TestErrorHandling:
    def test_401_raises_auth_error(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(401, text="Unauthorized")

        client = _client_with_transport(_make_transport(handler))
        with pytest.raises(ShieldAuthError):
            client.log_action("agent-1", "gmail", "send_email")

    def test_403_raises_auth_error(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(403, text="Forbidden")

        client = _client_with_transport(_make_transport(handler))
        with pytest.raises(ShieldAuthError):
            client.get_agent("agent-1")

    def test_404_raises_not_found(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(404, text="Not Found")

        client = _client_with_transport(_make_transport(handler))
        with pytest.raises(ShieldNotFoundError):
            client.get_agent("nonexistent")

    def test_500_raises_api_error(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500, text="Internal Server Error")

        client = _client_with_transport(_make_transport(handler))
        with pytest.raises(ShieldAPIError) as exc_info:
            client.log_action("agent-1", "gmail", "send_email")
        assert exc_info.value.status_code == 500


class TestHeaders:
    def test_api_key_header(self):
        captured_headers: dict[str, str] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured_headers.update(dict(request.headers))
            return httpx.Response(200, json={"status": "APPROVED"})

        client = _client_with_transport(_make_transport(handler))
        client.log_action("agent-1", "gmail", "send_email")
        assert captured_headers["x-multicorn-key"] == "test-key"

    def test_user_agent_header(self):
        captured_headers: dict[str, str] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured_headers.update(dict(request.headers))
            return httpx.Response(200, json={"status": "APPROVED"})

        client = _client_with_transport(_make_transport(handler))
        client.log_action("agent-1", "gmail", "send_email")
        assert "multicorn-shield-python" in captured_headers["user-agent"]


class TestBaseURL:
    def test_configurable_base_url(self):
        captured_urls: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            captured_urls.append(str(request.url))
            return httpx.Response(
                200,
                json={"id": "a1", "name": "Bot", "platform": "cursor", "status": "active"},
            )

        client = _client_with_transport(_make_transport(handler))
        client.get_agent("a1")
        assert captured_urls[0] == "https://test.local/api/v1/agents/a1"


class TestContextManager:
    def test_close_called(self):
        closed = False
        original_close = httpx.Client.close

        def tracking_close(self_inner):
            nonlocal closed
            closed = True
            original_close(self_inner)

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=[])

        transport = _make_transport(handler)
        httpx.Client.close = tracking_close
        try:
            with _client_with_transport(transport) as client:
                client.list_agents()
            assert closed
        finally:
            httpx.Client.close = original_close


class TestListAgents:
    def test_returns_agent_list(self):
        agents_json = [
            {"id": "a1", "name": "Bot A", "platform": "cursor", "status": "active"},
            {"id": "a2", "name": "Bot B", "platform": "openclaw", "status": "paused"},
        ]

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=agents_json)

        client = _client_with_transport(_make_transport(handler))
        agents = client.list_agents()
        assert len(agents) == 2
        assert all(isinstance(a, Agent) for a in agents)
        assert agents[0].id == "a1"
        assert agents[0].name == "Bot A"
        assert agents[1].status == "paused"


class TestCheckScopes:
    def test_returns_matching_scope(self):
        permissions_json = [
            {"service": "gmail", "read": True, "write": True, "execute": False},
            {"service": "calendar", "read": True, "write": False, "execute": False},
        ]

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=permissions_json)

        client = _client_with_transport(_make_transport(handler))
        scope = client.check_scopes("agent-1", "gmail")
        assert isinstance(scope, Scope)
        assert scope.service == "gmail"
        assert scope.read is True
        assert scope.write is True

    def test_raises_not_found_for_missing_service(self):
        permissions_json = [
            {"service": "gmail", "read": True, "write": False, "execute": False},
        ]

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=permissions_json)

        client = _client_with_transport(_make_transport(handler))
        with pytest.raises(ShieldNotFoundError):
            client.check_scopes("agent-1", "slack")


class TestListScopes:
    def test_returns_all_scopes(self):
        permissions_json = [
            {"service": "gmail", "read": True, "write": True, "execute": False},
            {"service": "calendar", "read": True, "write": False, "execute": False},
        ]

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=permissions_json)

        client = _client_with_transport(_make_transport(handler))
        scopes = client.list_scopes("agent-1")
        assert len(scopes) == 2
        assert all(isinstance(s, Scope) for s in scopes)
        assert scopes[0].service == "gmail"
        assert scopes[1].service == "calendar"


class TestGetSpending:
    def test_maps_backend_fields(self):
        agent_json = {
            "id": "a1",
            "name": "Bot",
            "status": "active",
            "budgetLimit": 50000,
            "approvalThreshold": 5000,
        }

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=agent_json)

        client = _client_with_transport(_make_transport(handler))
        limits = client.get_spending("a1")
        assert limits.budget_limit == 50000
        assert limits.approval_threshold == 5000
