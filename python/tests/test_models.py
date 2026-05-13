from __future__ import annotations

from multicorn_shield.models import Action, ActionResult, Agent, Scope, SpendingLimits


class TestAgentFromDict:
    def test_basic(self):
        agent = Agent.from_dict(
            {"id": "a1", "name": "Bot", "platform": "cursor", "status": "active"}
        )
        assert agent.id == "a1"
        assert agent.name == "Bot"
        assert agent.platform == "cursor"
        assert agent.status == "active"


class TestActionFromDict:
    def test_with_metadata(self):
        action = Action.from_dict(
            {
                "id": "act-1",
                "agent_id": "a1",
                "service": "gmail",
                "action_type": "send_email",
                "status": "approved",
                "cost": 5,
                "timestamp": "2026-01-01T00:00:00Z",
                "metadata": {"recipient": "user@example.com"},
            }
        )
        assert action.id == "act-1"
        assert action.agent_id == "a1"
        assert action.cost == 5
        assert action.metadata == {"recipient": "user@example.com"}

    def test_missing_optional_metadata(self):
        action = Action.from_dict(
            {
                "id": "act-2",
                "agent_id": "a1",
                "service": "slack",
                "action_type": "post_message",
                "status": "blocked",
                "cost": 0,
                "timestamp": "2026-01-01T00:00:00Z",
            }
        )
        assert action.metadata is None


class TestActionResultFromDict:
    def test_approved(self):
        result = ActionResult.from_dict({"status": "APPROVED"})
        assert result.status == "APPROVED"
        assert result.reason is None

    def test_blocked_with_reason(self):
        result = ActionResult.from_dict(
            {"status": "BLOCKED", "reason": "Spending limit exceeded"}
        )
        assert result.status == "BLOCKED"
        assert result.reason == "Spending limit exceeded"

    def test_pending(self):
        result = ActionResult.from_dict({"status": "PENDING"})
        assert result.status == "PENDING"

    def test_rate_limited(self):
        result = ActionResult.from_dict(
            {"status": "RATE_LIMITED", "reason": "Too many requests"}
        )
        assert result.status == "RATE_LIMITED"
        assert result.reason == "Too many requests"

    def test_outside_window(self):
        result = ActionResult.from_dict(
            {"status": "OUTSIDE_WINDOW", "reason": "Outside permitted hours"}
        )
        assert result.status == "OUTSIDE_WINDOW"


class TestScopeFromDict:
    def test_full_permissions(self):
        scope = Scope.from_dict(
            {
                "service": "gmail",
                "read": True,
                "write": True,
                "execute": True,
                "publish": True,
                "create": True,
            }
        )
        assert scope.service == "gmail"
        assert scope.read is True
        assert scope.write is True
        assert scope.execute is True
        assert scope.publish is True
        assert scope.create is True

    def test_missing_flags_default_false(self):
        scope = Scope.from_dict({"service": "calendar"})
        assert scope.read is False
        assert scope.write is False
        assert scope.execute is False
        assert scope.publish is False
        assert scope.create is False


class TestSpendingLimitsFromDict:
    def test_all_fields(self):
        limits = SpendingLimits.from_dict(
            {"budgetLimit": 50000, "approvalThreshold": 5000}
        )
        assert limits.budget_limit == 50000
        assert limits.approval_threshold == 5000

    def test_missing_fields_default_none(self):
        limits = SpendingLimits.from_dict({})
        assert limits.budget_limit is None
        assert limits.approval_threshold is None

    def test_partial_fields(self):
        limits = SpendingLimits.from_dict({"budgetLimit": 10000})
        assert limits.budget_limit == 10000
        assert limits.approval_threshold is None
