import { describe, it, expect, vi } from "vitest";
import {
  createMcpAdapter,
  isBlockedResult,
  type McpToolCall,
  type McpToolHandler,
  type McpToolResult,
} from "./mcp-adapter.js";
import type { ActionLogger } from "../logger/action-logger.js";
import type { Scope } from "../types/index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface MockLogger {
  readonly logger: ActionLogger;
  readonly logActionSpy: ReturnType<typeof vi.fn>;
}

function makeLogger(): MockLogger {
  const logActionSpy = vi.fn().mockResolvedValue(undefined);
  return {
    logger: {
      logAction: logActionSpy,
      flush: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    },
    logActionSpy,
  };
}

function makeHandler(result: McpToolResult = { content: "success" }): McpToolHandler {
  return vi.fn().mockResolvedValue(result);
}

const GMAIL_EXECUTE: Scope = { service: "gmail", permissionLevel: "execute" };
const GMAIL_READ: Scope = { service: "gmail", permissionLevel: "read" };
const CALENDAR_READ: Scope = { service: "calendar", permissionLevel: "read" };

const GMAIL_SEND_CALL: McpToolCall = {
  toolName: "gmail_send_email",
  arguments: { to: "user@example.com", subject: "Hello" },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createMcpAdapter", () => {
  // -------------------------------------------------------------------------
  // Allowed tool calls
  // -------------------------------------------------------------------------

  describe("allowed tool calls", () => {
    it("forwards the tool call to the handler when the scope is granted", async () => {
      const handler = makeHandler();
      const adapter = createMcpAdapter({
        agentId: "inbox-assistant",
        grantedScopes: [GMAIL_EXECUTE],
      });

      await adapter.intercept(GMAIL_SEND_CALL, handler);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(GMAIL_SEND_CALL);
    });

    it("returns the handler result unchanged when the action is permitted", async () => {
      const handlerResult: McpToolResult = { content: { messageId: "abc123" } };
      const adapter = createMcpAdapter({
        agentId: "inbox-assistant",
        grantedScopes: [GMAIL_EXECUTE],
      });

      const result = await adapter.intercept(GMAIL_SEND_CALL, makeHandler(handlerResult));

      expect(result).toBe(handlerResult);
    });

    it("logs the action as approved when permitted", async () => {
      const { logger, logActionSpy } = makeLogger();
      const adapter = createMcpAdapter({
        agentId: "inbox-assistant",
        grantedScopes: [GMAIL_EXECUTE],
        logger,
      });

      await adapter.intercept(GMAIL_SEND_CALL, makeHandler());

      expect(logActionSpy).toHaveBeenCalledWith({
        agent: "inbox-assistant",
        service: "gmail",
        actionType: "send_email",
        status: "approved",
      });
    });
  });

  // -------------------------------------------------------------------------
  // Blocked tool calls
  // -------------------------------------------------------------------------

  describe("blocked tool calls", () => {
    it("returns a blocked result when no scope is granted for the service", async () => {
      const adapter = createMcpAdapter({
        agentId: "inbox-assistant",
        grantedScopes: [],
      });

      const result = await adapter.intercept(GMAIL_SEND_CALL, makeHandler());

      expect(isBlockedResult(result)).toBe(true);
    });

    it("returns a blocked result when the granted permission level is insufficient", async () => {
      const adapter = createMcpAdapter({
        agentId: "inbox-assistant",
        grantedScopes: [GMAIL_READ],
        requiredPermissionLevel: "execute",
      });

      const result = await adapter.intercept(GMAIL_SEND_CALL, makeHandler());

      expect(isBlockedResult(result)).toBe(true);
    });

    it("does not call the handler when the action is blocked", async () => {
      const handler = makeHandler();
      const adapter = createMcpAdapter({
        agentId: "inbox-assistant",
        grantedScopes: [],
      });

      await adapter.intercept(GMAIL_SEND_CALL, handler);

      expect(handler).not.toHaveBeenCalled();
    });

    it("includes the service, action, and tool name in the blocked result", async () => {
      const adapter = createMcpAdapter({
        agentId: "inbox-assistant",
        grantedScopes: [],
      });

      const result = await adapter.intercept(GMAIL_SEND_CALL, makeHandler());

      if (!isBlockedResult(result)) throw new Error("Expected a blocked result");

      expect(result.service).toBe("gmail");
      expect(result.action).toBe("send_email");
      expect(result.toolName).toBe("gmail_send_email");
    });

    it("includes a descriptive reason in the blocked result", async () => {
      const adapter = createMcpAdapter({
        agentId: "inbox-assistant",
        grantedScopes: [],
      });

      const result = await adapter.intercept(GMAIL_SEND_CALL, makeHandler());

      if (!isBlockedResult(result)) throw new Error("Expected a blocked result");

      expect(result.reason.length).toBeGreaterThan(10);
    });

    it("logs the action as blocked", async () => {
      const { logger, logActionSpy } = makeLogger();
      const adapter = createMcpAdapter({
        agentId: "inbox-assistant",
        grantedScopes: [],
        logger,
      });

      await adapter.intercept(GMAIL_SEND_CALL, makeHandler());

      expect(logActionSpy).toHaveBeenCalledWith({
        agent: "inbox-assistant",
        service: "gmail",
        actionType: "send_email",
        status: "blocked",
      });
    });
  });

  // -------------------------------------------------------------------------
  // Service and action extraction
  // -------------------------------------------------------------------------

  describe("service and action extraction", () => {
    it("extracts the service as the segment before the first underscore", async () => {
      const adapter = createMcpAdapter({
        agentId: "agent",
        grantedScopes: [{ service: "calendar", permissionLevel: "execute" }],
      });

      const result = await adapter.intercept(
        { toolName: "calendar_create_event", arguments: {} },
        makeHandler(),
      );

      expect(isBlockedResult(result)).toBe(false);
    });

    it("extracts the action as the segment after the first underscore", async () => {
      const { logger, logActionSpy } = makeLogger();
      const adapter = createMcpAdapter({
        agentId: "agent",
        grantedScopes: [{ service: "calendar", permissionLevel: "execute" }],
        logger,
      });

      await adapter.intercept({ toolName: "calendar_create_event", arguments: {} }, makeHandler());

      expect(logActionSpy).toHaveBeenCalledWith(
        expect.objectContaining({ actionType: "create_event" }),
      );
    });

    it("treats the full tool name as service and 'call' as action when there is no underscore", async () => {
      const { logger, logActionSpy } = makeLogger();
      const adapter = createMcpAdapter({
        agentId: "agent",
        grantedScopes: [{ service: "search", permissionLevel: "execute" }],
        logger,
      });

      await adapter.intercept({ toolName: "search", arguments: {} }, makeHandler());

      expect(logActionSpy).toHaveBeenCalledWith(
        expect.objectContaining({ service: "search", actionType: "call" }),
      );
    });

    it("uses the custom service extractor when provided", async () => {
      const { logger, logActionSpy } = makeLogger();
      const adapter = createMcpAdapter({
        agentId: "agent",
        grantedScopes: [{ service: "gmail", permissionLevel: "execute" }],
        logger,
        extractService: (toolName) => toolName.split(":")[0] ?? toolName,
        extractAction: (toolName) => toolName.split(":")[1] ?? "call",
      });

      await adapter.intercept({ toolName: "gmail:send_email", arguments: {} }, makeHandler());

      expect(logActionSpy).toHaveBeenCalledWith(
        expect.objectContaining({ service: "gmail", actionType: "send_email" }),
      );
    });

    it("uses the custom action extractor when provided", async () => {
      const { logger, logActionSpy } = makeLogger();
      const adapter = createMcpAdapter({
        agentId: "agent",
        grantedScopes: [GMAIL_EXECUTE],
        logger,
        extractAction: () => "custom_action",
      });

      await adapter.intercept(GMAIL_SEND_CALL, makeHandler());

      expect(logActionSpy).toHaveBeenCalledWith(
        expect.objectContaining({ actionType: "custom_action" }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Scope validation
  // -------------------------------------------------------------------------

  describe("scope validation", () => {
    it("allows access when the exact scope is in the granted set", async () => {
      const adapter = createMcpAdapter({
        agentId: "agent",
        grantedScopes: [GMAIL_EXECUTE],
        requiredPermissionLevel: "execute",
      });

      const result = await adapter.intercept(GMAIL_SEND_CALL, makeHandler());

      expect(isBlockedResult(result)).toBe(false);
    });

    it("blocks access when the granted scopes are for a different service", async () => {
      const adapter = createMcpAdapter({
        agentId: "agent",
        grantedScopes: [CALENDAR_READ],
      });

      const result = await adapter.intercept(GMAIL_SEND_CALL, makeHandler());

      expect(isBlockedResult(result)).toBe(true);
    });

    it("blocks access when the granted permission level is lower than required", async () => {
      const adapter = createMcpAdapter({
        agentId: "agent",
        grantedScopes: [GMAIL_READ],
        requiredPermissionLevel: "execute",
      });

      const result = await adapter.intercept(GMAIL_SEND_CALL, makeHandler());

      expect(isBlockedResult(result)).toBe(true);
    });

    it("allows access when the matching scope is among multiple granted scopes", async () => {
      const adapter = createMcpAdapter({
        agentId: "agent",
        grantedScopes: [CALENDAR_READ, GMAIL_READ, GMAIL_EXECUTE],
      });

      const result = await adapter.intercept(GMAIL_SEND_CALL, makeHandler());

      expect(isBlockedResult(result)).toBe(false);
    });

    it("defaults to requiring execute permission", async () => {
      const allowedAdapter = createMcpAdapter({
        agentId: "agent",
        grantedScopes: [GMAIL_EXECUTE],
      });
      const blockedAdapter = createMcpAdapter({
        agentId: "agent",
        grantedScopes: [GMAIL_READ],
      });

      const allowedResult = await allowedAdapter.intercept(GMAIL_SEND_CALL, makeHandler());
      const blockedResult = await blockedAdapter.intercept(GMAIL_SEND_CALL, makeHandler());

      expect(isBlockedResult(allowedResult)).toBe(false);
      expect(isBlockedResult(blockedResult)).toBe(true);
    });

    it("respects a non-default required permission level", async () => {
      const adapter = createMcpAdapter({
        agentId: "agent",
        grantedScopes: [GMAIL_READ],
        requiredPermissionLevel: "read",
      });

      const result = await adapter.intercept(GMAIL_SEND_CALL, makeHandler());

      expect(isBlockedResult(result)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Logging
  // -------------------------------------------------------------------------

  describe("logging", () => {
    it("works without a logger when the action is permitted", async () => {
      const adapter = createMcpAdapter({
        agentId: "agent",
        grantedScopes: [GMAIL_EXECUTE],
      });

      await expect(adapter.intercept(GMAIL_SEND_CALL, makeHandler())).resolves.toBeDefined();
    });

    it("works without a logger when the action is blocked", async () => {
      const adapter = createMcpAdapter({
        agentId: "agent",
        grantedScopes: [],
      });

      await expect(adapter.intercept(GMAIL_SEND_CALL, makeHandler())).resolves.toBeDefined();
    });

    it("logs with the configured agent ID", async () => {
      const { logger, logActionSpy } = makeLogger();
      const adapter = createMcpAdapter({
        agentId: "specific-agent-42",
        grantedScopes: [GMAIL_EXECUTE],
        logger,
      });

      await adapter.intercept(GMAIL_SEND_CALL, makeHandler());

      expect(logActionSpy).toHaveBeenCalledWith(
        expect.objectContaining({ agent: "specific-agent-42" }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // isBlockedResult type guard
  // -------------------------------------------------------------------------

  describe("isBlockedResult", () => {
    it("returns true for a blocked result", async () => {
      const adapter = createMcpAdapter({
        agentId: "agent",
        grantedScopes: [],
      });

      const result = await adapter.intercept(GMAIL_SEND_CALL, makeHandler());

      expect(isBlockedResult(result)).toBe(true);
    });

    it("returns false for a successful tool result", async () => {
      const adapter = createMcpAdapter({
        agentId: "agent",
        grantedScopes: [GMAIL_EXECUTE],
      });

      const result = await adapter.intercept(GMAIL_SEND_CALL, makeHandler());

      expect(isBlockedResult(result)).toBe(false);
    });
  });
});
