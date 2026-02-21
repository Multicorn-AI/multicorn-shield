import { describe, it, expect } from "vitest";
import {
  parseJsonRpcLine,
  extractToolCallParams,
  buildBlockedResponse,
  extractServiceFromToolName,
  extractActionFromToolName,
} from "./interceptor.js";

describe("parseJsonRpcLine", () => {
  it("parses a valid JSON-RPC tools/call request", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "gmail_send_email", arguments: {} },
    });

    const result = parseJsonRpcLine(line);

    expect(result).not.toBeNull();
    expect(result?.method).toBe("tools/call");
    expect(result?.id).toBe(1);
  });

  it("parses a tools/list request", () => {
    const line = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" });

    const result = parseJsonRpcLine(line);

    expect(result?.method).toBe("tools/list");
  });

  it("returns null for an empty line", () => {
    expect(parseJsonRpcLine("")).toBeNull();
    expect(parseJsonRpcLine("   ")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseJsonRpcLine("{broken json")).toBeNull();
  });

  it("returns null when jsonrpc field is not '2.0'", () => {
    const line = JSON.stringify({ jsonrpc: "1.0", id: 1, method: "tools/call" });
    expect(parseJsonRpcLine(line)).toBeNull();
  });

  it("returns null when method field is missing", () => {
    const line = JSON.stringify({ jsonrpc: "2.0", id: 1 });
    expect(parseJsonRpcLine(line)).toBeNull();
  });

  it("accepts string IDs", () => {
    const line = JSON.stringify({ jsonrpc: "2.0", id: "req-abc", method: "ping" });
    const result = parseJsonRpcLine(line);
    expect(result?.id).toBe("req-abc");
  });

  it("accepts null IDs (notifications)", () => {
    const line = JSON.stringify({ jsonrpc: "2.0", id: null, method: "ping" });
    const result = parseJsonRpcLine(line);
    expect(result?.id).toBeNull();
  });
});

describe("extractToolCallParams", () => {
  it("returns tool name and arguments from a valid tools/call request", () => {
    const request = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "tools/call",
      params: { name: "gmail_send_email", arguments: { to: "user@example.com" } },
    };

    const result = extractToolCallParams(request);

    expect(result?.name).toBe("gmail_send_email");
    expect(result?.arguments).toEqual({ to: "user@example.com" });
  });

  it("returns null for a non-tools/call method", () => {
    const request = { jsonrpc: "2.0" as const, id: 1, method: "tools/list" };
    expect(extractToolCallParams(request)).toBeNull();
  });

  it("returns null when params is missing", () => {
    const request = { jsonrpc: "2.0" as const, id: 1, method: "tools/call" };
    expect(extractToolCallParams(request)).toBeNull();
  });

  it("returns null when params.name is not a string", () => {
    const request = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "tools/call",
      params: { name: 42, arguments: {} },
    };
    expect(extractToolCallParams(request)).toBeNull();
  });

  it("returns null when params.arguments is missing", () => {
    const request = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "tools/call",
      params: { name: "gmail_read" },
    };
    expect(extractToolCallParams(request)).toBeNull();
  });
});

describe("buildBlockedResponse", () => {
  it("returns a JSON-RPC error response with the blocked message", () => {
    const response = buildBlockedResponse(1, "gmail", "execute");

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(1);
    expect(response.error).toBeDefined();
    expect(response.error?.message).toContain("Action blocked by Multicorn Shield");
    expect(response.error?.message).toContain("Gmail");
    expect(response.error?.message).toContain("https://app.multicorn.ai");
  });

  it("preserves the request ID in the error response", () => {
    const response = buildBlockedResponse("req-42", "slack", "execute");
    expect(response.id).toBe("req-42");
  });

  it("includes the permission level in the message", () => {
    const response = buildBlockedResponse(1, "gmail", "write");
    expect(response.error?.message).toContain("write access");
  });

  it("capitalises the service name in the message", () => {
    const response = buildBlockedResponse(1, "calendar", "execute");
    expect(response.error?.message).toContain("Calendar");
  });

  it("uses error code -32000", () => {
    const response = buildBlockedResponse(1, "gmail", "execute");
    expect(response.error?.code).toBe(-32000);
  });
});

describe("extractServiceFromToolName", () => {
  it("returns the segment before the first underscore", () => {
    expect(extractServiceFromToolName("gmail_send_email")).toBe("gmail");
  });

  it("returns the full name when there is no underscore", () => {
    expect(extractServiceFromToolName("search")).toBe("search");
  });

  it("handles leading underscore as empty service", () => {
    expect(extractServiceFromToolName("_send_email")).toBe("");
  });

  it("handles multi-part names correctly", () => {
    expect(extractServiceFromToolName("google_drive_list_files")).toBe("google");
  });
});

describe("extractActionFromToolName", () => {
  it("returns the segment after the first underscore", () => {
    expect(extractActionFromToolName("gmail_send_email")).toBe("send_email");
  });

  it("returns 'call' when there is no underscore", () => {
    expect(extractActionFromToolName("search")).toBe("call");
  });

  it("returns all segments after the first underscore for multi-part names", () => {
    expect(extractActionFromToolName("google_drive_list_files")).toBe("drive_list_files");
  });

  it("handles trailing underscore as empty action", () => {
    expect(extractActionFromToolName("gmail_")).toBe("");
  });
});
