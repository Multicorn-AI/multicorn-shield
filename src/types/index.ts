/**
 * Shared TypeScript types for the Multicorn Shield SDK.
 *
 * All public interfaces, constants, and type aliases used
 * across the SDK modules and the dashboard.
 *
 * @module types
 */

// ---------------------------------------------------------------------------
// Constants (prefer `as const` objects over enums for better tree-shaking)
// ---------------------------------------------------------------------------

/**
 * Possible operational states for an agent.
 *
 * - `active` — agent is running and permitted to take actions
 * - `paused` — agent is temporarily suspended by the user
 * - `revoked` — agent's permissions have been permanently revoked
 */
export const AGENT_STATUSES = {
  Active: 'active',
  Paused: 'paused',
  Revoked: 'revoked',
} as const;

export type AgentStatus = (typeof AGENT_STATUSES)[keyof typeof AGENT_STATUSES];

/**
 * Permission levels that can be granted on a service scope.
 *
 * - `read` — observe data without modification
 * - `write` — create or modify data
 * - `execute` — trigger side-effects (e.g. send an email, make a payment)
 */
export const PERMISSION_LEVELS = {
  Read: 'read',
  Write: 'write',
  Execute: 'execute',
} as const;

export type PermissionLevel =
  (typeof PERMISSION_LEVELS)[keyof typeof PERMISSION_LEVELS];

/**
 * Lifecycle states for an action processed by the policy engine.
 *
 * - `approved` — action passed policy checks and was executed
 * - `blocked` — action was denied by policy
 * - `pending` — action is awaiting human approval
 * - `flagged` — action was executed but flagged for review
 */
export const ACTION_STATUSES = {
  Approved: 'approved',
  Blocked: 'blocked',
  Pending: 'pending',
  Flagged: 'flagged',
} as const;

export type ActionStatus =
  (typeof ACTION_STATUSES)[keyof typeof ACTION_STATUSES];

// ---------------------------------------------------------------------------
// Domain interfaces
// ---------------------------------------------------------------------------

/**
 * An AI agent registered with Multicorn Shield.
 *
 * Each agent has a unique identifier, a human-readable name, and configurable
 * spending limits. The `colour` field is used for visual identification in
 * the dashboard and consent screen.
 */
export interface Agent {
  readonly id: string;
  readonly name: string;
  readonly status: AgentStatus;
  readonly colour: string;
  readonly budgetLimit: number;
}

/**
 * A single permission scope binding a service to an access level.
 *
 * For example, `{ service: "gmail", permissionLevel: "write" }` grants
 * write access to the Gmail integration.
 */
export interface Scope {
  readonly service: string;
  readonly permissionLevel: PermissionLevel;
}

/**
 * A request from an agent to be granted one or more permission scopes.
 *
 * Presented to the user via the consent screen for approval.
 */
export interface ScopeRequest {
  readonly agentName: string;
  readonly scopes: readonly Scope[];
  readonly spendLimit: number;
}

/**
 * A recorded action taken (or attempted) by an agent.
 *
 * Actions flow through the policy engine and end up in one of the
 * {@link ActionStatus} states. Cost is present only for actions
 * that incur a financial charge (e.g. API calls with usage-based pricing).
 */
export interface Action {
  readonly id: string;
  readonly agentId: string;
  readonly service: string;
  readonly actionType: string;
  readonly status: ActionStatus;
  /** Present only when the action incurs a financial cost. */
  readonly cost: number | undefined;
  readonly timestamp: string;
  readonly metadata: Readonly<Record<string, string>>;
}

/**
 * The resolved permission set for an agent on a specific service.
 *
 * Each boolean flag indicates whether the corresponding access level
 * has been granted.
 */
export interface Permission {
  readonly agentId: string;
  readonly service: string;
  readonly read: boolean;
  readonly write: boolean;
  readonly execute: boolean;
}

/**
 * The user's decision on a {@link ScopeRequest}.
 *
 * Captures which of the requested scopes were actually granted,
 * enabling partial consent (e.g. granting read but not write).
 */
export interface ConsentDecision {
  readonly scopeRequest: ScopeRequest;
  readonly grantedScopes: readonly Scope[];
  readonly timestamp: string;
}

/**
 * Spending thresholds for a single agent.
 *
 * The policy engine checks these limits before approving any action
 * that carries a cost. All values are in the organisation's base currency.
 */
export interface SpendingLimit {
  readonly agentId: string;
  readonly perTransaction: number;
  readonly perDay: number;
  readonly perMonth: number;
}

/**
 * Structured error returned by the Shield API.
 *
 * Follows RFC 7807 (Problem Details for HTTP APIs) conventions so
 * clients can programmatically distinguish error categories.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc7807
 */
export interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}
