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
import { PERMISSION_LEVELS } from "../types/index.js";

// Test helpers

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

const GMAIL_EXECUTE: Scope = { service: "gmail", permissionLevel: PERMISSION_LEVELS.Execute };
const GMAIL_READ: Scope = { service: "gmail", permissionLevel: PERMISSION_LEVELS.Read };
const CALENDAR_READ: Scope = { service: "calendar", permissionLevel: PERMISSION_LEVELS.Read };
const WEB_PUBLISH: Scope = { service: "web", permissionLevel: PERMISSION_LEVELS.Publish };
const PUBLIC_CONTENT_CREATE: Scope = {
  service: "public_content",
  permissionLevel: PERMISSION_LEVELS.Create,
};

const GMAIL_SEND_CALL: McpToolCall = {
  toolName: "gmail_send_email",
  arguments: { to: "user@example.com", subject: "Hello" },
};

// Tests

describe("createMcpAdapter", () => {
  // Allowed tool calls

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

  // Blocked tool calls

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

  // Service and action extraction

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

  // Scope validation

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

  // Logging

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

  // Malformed tool calls

  describe("malformed tool calls", () => {
    it("treats an empty tool name as both the service and falls back to 'call' action", async () => {
      const { logger, logActionSpy } = makeLogger();
      const adapter = createMcpAdapter({
        agentId: "agent",
        grantedScopes: [{ service: "", permissionLevel: "execute" }],
        logger,
      });

      const result = await adapter.intercept({ toolName: "", arguments: {} }, makeHandler());

      expect(isBlockedResult(result)).toBe(false);
      expect(logActionSpy).toHaveBeenCalledWith(
        expect.objectContaining({ service: "", actionType: "call" }),
      );
    });

    it("blocks tool call with empty tool name when no empty-service scope is granted", async () => {
      const adapter = createMcpAdapter({
        agentId: "agent",
        grantedScopes: [GMAIL_EXECUTE],
      });

      const result = await adapter.intercept({ toolName: "", arguments: {} }, makeHandler());

      expect(isBlockedResult(result)).toBe(true);
    });

    it("handles tool name with only underscores as empty service and empty action", async () => {
      const { logger, logActionSpy } = makeLogger();
      const adapter = createMcpAdapter({
        agentId: "agent",
        grantedScopes: [{ service: "", permissionLevel: "execute" }],
        logger,
      });

      await adapter.intercept({ toolName: "_", arguments: {} }, makeHandler());

      expect(logActionSpy).toHaveBeenCalledWith(
        expect.objectContaining({ service: "", actionType: "" }),
      );
    });

    it("handles tool name with multiple underscores preserving action after first", async () => {
      const { logger, logActionSpy } = makeLogger();
      const adapter = createMcpAdapter({
        agentId: "agent",
        grantedScopes: [{ service: "gmail", permissionLevel: "execute" }],
        logger,
      });

      await adapter.intercept(
        { toolName: "gmail_send_batch_emails", arguments: {} },
        makeHandler(),
      );

      expect(logActionSpy).toHaveBeenCalledWith(
        expect.objectContaining({ service: "gmail", actionType: "send_batch_emails" }),
      );
    });

    it("handles tool name with leading underscore as empty service", async () => {
      const { logger, logActionSpy } = makeLogger();
      const adapter = createMcpAdapter({
        agentId: "agent",
        grantedScopes: [{ service: "", permissionLevel: "execute" }],
        logger,
      });

      await adapter.intercept({ toolName: "_send_email", arguments: {} }, makeHandler());

      expect(logActionSpy).toHaveBeenCalledWith(
        expect.objectContaining({ service: "", actionType: "send_email" }),
      );
    });

    it("handles tool name with trailing underscore as service with empty action", async () => {
      const { logger, logActionSpy } = makeLogger();
      const adapter = createMcpAdapter({
        agentId: "agent",
        grantedScopes: [{ service: "gmail", permissionLevel: "execute" }],
        logger,
      });

      await adapter.intercept({ toolName: "gmail_", arguments: {} }, makeHandler());

      expect(logActionSpy).toHaveBeenCalledWith(
        expect.objectContaining({ service: "gmail", actionType: "" }),
      );
    });

    it("handles tool name with special characters as a single service", async () => {
      const { logger, logActionSpy } = makeLogger();
      const adapter = createMcpAdapter({
        agentId: "agent",
        grantedScopes: [{ service: "my-service.v2", permissionLevel: "execute" }],
        logger,
      });

      await adapter.intercept({ toolName: "my-service.v2", arguments: {} }, makeHandler());

      expect(logActionSpy).toHaveBeenCalledWith(
        expect.objectContaining({ service: "my-service.v2", actionType: "call" }),
      );
    });

    it("passes through empty arguments object for malformed tool calls", async () => {
      const handler = makeHandler();
      const adapter = createMcpAdapter({
        agentId: "agent",
        grantedScopes: [{ service: "test", permissionLevel: "execute" }],
      });

      await adapter.intercept({ toolName: "test_action", arguments: {} }, handler);

      expect(handler).toHaveBeenCalledWith({ toolName: "test_action", arguments: {} });
    });
  });

  // Publishing platform mapping

  describe("publishing platform mapping", () => {
    describe("publish:web mapping", () => {
      it("maps deploy actions to publish:web scope", async () => {
        const adapter = createMcpAdapter({
          agentId: "agent",
          grantedScopes: [WEB_PUBLISH],
          checkAutoApprove: () => true, // Auto-approve to bypass content review
        });

        const result = await adapter.intercept(
          { toolName: "github_deploy", arguments: {} },
          makeHandler(),
        );

        expect(isBlockedResult(result)).toBe(false);
      });

      it("maps publish actions to publish:web scope", async () => {
        const adapter = createMcpAdapter({
          agentId: "agent",
          grantedScopes: [WEB_PUBLISH],
          checkAutoApprove: () => true, // Auto-approve to bypass content review
        });

        const result = await adapter.intercept(
          { toolName: "blog_publish", arguments: {} },
          makeHandler(),
        );

        expect(isBlockedResult(result)).toBe(false);
      });

      it("maps release actions to publish:web scope", async () => {
        const adapter = createMcpAdapter({
          agentId: "agent",
          grantedScopes: [WEB_PUBLISH],
          checkAutoApprove: () => true, // Auto-approve to bypass content review
        });

        const result = await adapter.intercept(
          { toolName: "app_release", arguments: {} },
          makeHandler(),
        );

        expect(isBlockedResult(result)).toBe(false);
      });

      it("maps GitHub Pages deployments to publish:web scope", async () => {
        const adapter = createMcpAdapter({
          agentId: "agent",
          grantedScopes: [WEB_PUBLISH],
          checkAutoApprove: () => true, // Auto-approve to bypass content review
        });

        const result = await adapter.intercept(
          { toolName: "github_pages_deploy", arguments: {} },
          makeHandler(),
        );

        expect(isBlockedResult(result)).toBe(false);
      });

      it("blocks deploy actions when publish:web is not granted", async () => {
        const adapter = createMcpAdapter({
          agentId: "agent",
          grantedScopes: [],
        });

        const result = await adapter.intercept(
          { toolName: "github_deploy", arguments: {} },
          makeHandler(),
        );

        expect(isBlockedResult(result)).toBe(true);
      });

      it("logs deploy actions with mapped web service", async () => {
        const { logger, logActionSpy } = makeLogger();
        const adapter = createMcpAdapter({
          agentId: "agent",
          grantedScopes: [WEB_PUBLISH],
          logger,
        });

        await adapter.intercept({ toolName: "github_deploy", arguments: {} }, makeHandler());

        expect(logActionSpy).toHaveBeenCalledWith(
          expect.objectContaining({ service: "web", actionType: "deploy" }),
        );
      });
    });

    describe("create:public_content mapping", () => {
      it("maps post actions to create:public_content scope", async () => {
        const adapter = createMcpAdapter({
          agentId: "agent",
          grantedScopes: [PUBLIC_CONTENT_CREATE],
          checkAutoApprove: () => true, // Auto-approve to bypass content review
        });

        const result = await adapter.intercept(
          { toolName: "twitter_post", arguments: {} },
          makeHandler(),
        );

        expect(isBlockedResult(result)).toBe(false);
      });

      it("maps tweet actions to create:public_content scope", async () => {
        const adapter = createMcpAdapter({
          agentId: "agent",
          grantedScopes: [PUBLIC_CONTENT_CREATE],
          checkAutoApprove: () => true, // Auto-approve to bypass content review
        });

        const result = await adapter.intercept(
          { toolName: "twitter_tweet", arguments: {} },
          makeHandler(),
        );

        expect(isBlockedResult(result)).toBe(false);
      });

      it("maps commit actions to create:public_content scope", async () => {
        const adapter = createMcpAdapter({
          agentId: "agent",
          grantedScopes: [PUBLIC_CONTENT_CREATE],
          checkAutoApprove: () => true, // Auto-approve to bypass content review
        });

        const result = await adapter.intercept(
          { toolName: "github_commit", arguments: {} },
          makeHandler(),
        );

        expect(isBlockedResult(result)).toBe(false);
      });

      it("blocks post actions when create:public_content is not granted", async () => {
        const adapter = createMcpAdapter({
          agentId: "agent",
          grantedScopes: [],
        });

        const result = await adapter.intercept(
          { toolName: "twitter_post", arguments: {} },
          makeHandler(),
        );

        expect(isBlockedResult(result)).toBe(true);
      });

      it("maps social media services to create:public_content scope", async () => {
        const adapter = createMcpAdapter({
          agentId: "agent",
          grantedScopes: [PUBLIC_CONTENT_CREATE],
          checkAutoApprove: () => true, // Auto-approve to bypass content review
        });

        const result = await adapter.intercept(
          { toolName: "twitter_update_status", arguments: {} },
          makeHandler(),
        );

        expect(isBlockedResult(result)).toBe(false);
      });

      it("maps Facebook actions to create:public_content scope", async () => {
        const adapter = createMcpAdapter({
          agentId: "agent",
          grantedScopes: [PUBLIC_CONTENT_CREATE],
          checkAutoApprove: () => true, // Auto-approve to bypass content review
        });

        const result = await adapter.intercept(
          { toolName: "facebook_post", arguments: {} },
          makeHandler(),
        );

        expect(isBlockedResult(result)).toBe(false);
      });

      it("logs post actions with mapped public_content service", async () => {
        const { logger, logActionSpy } = makeLogger();
        const adapter = createMcpAdapter({
          agentId: "agent",
          grantedScopes: [PUBLIC_CONTENT_CREATE],
          logger,
        });

        await adapter.intercept({ toolName: "twitter_post", arguments: {} }, makeHandler());

        expect(logActionSpy).toHaveBeenCalledWith(
          expect.objectContaining({ service: "public_content", actionType: "post" }),
        );
      });
    });

    describe("blog/CMS service mapping", () => {
      it("maps WordPress publish actions to publish:web scope", async () => {
        const adapter = createMcpAdapter({
          agentId: "agent",
          grantedScopes: [WEB_PUBLISH],
          checkAutoApprove: () => true, // Auto-approve to bypass content review
        });

        const result = await adapter.intercept(
          { toolName: "wordpress_publish", arguments: {} },
          makeHandler(),
        );

        expect(isBlockedResult(result)).toBe(false);
      });

      it("maps WordPress post actions to create:public_content scope", async () => {
        const adapter = createMcpAdapter({
          agentId: "agent",
          grantedScopes: [PUBLIC_CONTENT_CREATE],
          checkAutoApprove: () => true, // Auto-approve to bypass content review
        });

        const result = await adapter.intercept(
          { toolName: "wordpress_post", arguments: {} },
          makeHandler(),
        );

        expect(isBlockedResult(result)).toBe(false);
      });

      it("defaults blog post actions to create:public_content when not a publish action", async () => {
        const adapter = createMcpAdapter({
          agentId: "agent",
          grantedScopes: [PUBLIC_CONTENT_CREATE],
          checkAutoApprove: () => true, // Auto-approve to bypass content review
        });

        const result = await adapter.intercept(
          { toolName: "medium_create_article", arguments: {} },
          makeHandler(),
        );

        expect(isBlockedResult(result)).toBe(false);
      });
    });

    describe("backward compatibility", () => {
      it("does not map non-publishing actions to publish:web", async () => {
        const adapter = createMcpAdapter({
          agentId: "agent",
          grantedScopes: [{ service: "github", permissionLevel: "write" }],
        });

        // Regular GitHub write action should not be mapped
        const result = await adapter.intercept(
          { toolName: "github_create_issue", arguments: {} },
          makeHandler(),
        );

        // Should be blocked because we only have write:github, not execute
        expect(isBlockedResult(result)).toBe(true);
      });

      it("requires explicit publish:web for GitHub Pages deployments", async () => {
        const adapter = createMcpAdapter({
          agentId: "agent",
          grantedScopes: [{ service: "github", permissionLevel: "write" }],
        });

        // GitHub Pages deploy should require publish:web, not just write:github
        const result = await adapter.intercept(
          { toolName: "github_pages_deploy", arguments: {} },
          makeHandler(),
        );

        expect(isBlockedResult(result)).toBe(true);
      });
    });
  });

  // isBlockedResult type guard

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
