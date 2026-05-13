from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class Agent:
    """An AI agent registered with Multicorn Shield."""

    id: str
    name: str
    platform: str
    status: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Agent:
        return cls(
            id=data["id"],
            name=data["name"],
            platform=data["platform"],
            status=data["status"],
        )


@dataclass(frozen=True)
class Action:
    """A recorded action taken or attempted by an agent."""

    id: str
    agent_id: str
    service: str
    action_type: str
    status: str
    cost: int
    timestamp: str
    metadata: dict[str, Any] | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Action:
        return cls(
            id=data["id"],
            agent_id=data["agent_id"],
            service=data["service"],
            action_type=data["action_type"],
            status=data["status"],
            cost=data["cost"],
            timestamp=data["timestamp"],
            metadata=data.get("metadata"),
        )


@dataclass(frozen=True)
class ActionResult:
    """The result of submitting an action to Shield's policy engine.

    status is one of: APPROVED, BLOCKED, PENDING, RATE_LIMITED, OUTSIDE_WINDOW.
    """

    status: str
    reason: str | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ActionResult:
        return cls(
            status=data["status"],
            reason=data.get("reason"),
        )


@dataclass(frozen=True)
class Scope:
    """Permission scope binding a service to access levels."""

    service: str
    read: bool
    write: bool
    execute: bool
    publish: bool = False
    create: bool = False

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Scope:
        return cls(
            service=data["service"],
            read=data.get("read", False),
            write=data.get("write", False),
            execute=data.get("execute", False),
            publish=data.get("publish", False),
            create=data.get("create", False),
        )


@dataclass(frozen=True)
class SpendingLimits:
    """Spending thresholds for an agent. All values are in cents."""

    budget_limit: int | None = None
    approval_threshold: int | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> SpendingLimits:
        return cls(
            budget_limit=data.get("budgetLimit"),
            approval_threshold=data.get("approvalThreshold"),
        )
