/**
 * @vitest-environment node
 */

import { describe, it, expect } from "vitest";
import { mapMcpToolToScope } from "./mcp-tool-mapper.js";

describe("mapMcpToolToScope", () => {
  it("maps MCP filesystem read tools to filesystem:read", () => {
    expect(mapMcpToolToScope("read_file")).toEqual({
      service: "filesystem",
      permissionLevel: "read",
      actionType: "read_file",
    });
    expect(mapMcpToolToScope("list_directory")).toEqual({
      service: "filesystem",
      permissionLevel: "read",
      actionType: "list_directory",
    });
  });

  it("maps MCP filesystem write tools to filesystem:write", () => {
    expect(mapMcpToolToScope("write_file")).toEqual({
      service: "filesystem",
      permissionLevel: "write",
      actionType: "write_file",
    });
    expect(mapMcpToolToScope("edit_file")).toEqual({
      service: "filesystem",
      permissionLevel: "write",
      actionType: "edit_file",
    });
  });

  it("maps gmail_send_email to gmail:write", () => {
    expect(mapMcpToolToScope("gmail_send_email")).toEqual({
      service: "gmail",
      permissionLevel: "write",
      actionType: "gmail_send_email",
    });
  });

  it("maps calendar_create_event to google_calendar with inferred write", () => {
    expect(mapMcpToolToScope("calendar_create_event")).toEqual({
      service: "google_calendar",
      permissionLevel: "write",
      actionType: "calendar_create_event",
    });
  });

  it("maps run_terminal_cmd to terminal:execute", () => {
    expect(mapMcpToolToScope("run_terminal_cmd")).toEqual({
      service: "terminal",
      permissionLevel: "execute",
      actionType: "run_terminal_cmd",
    });
  });

  it("does not treat read_file as service read with action file", () => {
    const result = mapMcpToolToScope("read_file");
    expect(result.service).toBe("filesystem");
    expect(result.permissionLevel).toBe("read");
  });
});
