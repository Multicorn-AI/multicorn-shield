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

  it("maps whitespace-only tool names to unknown:execute", () => {
    expect(mapMcpToolToScope("   ")).toEqual({
      service: "unknown",
      permissionLevel: "execute",
      actionType: "",
    });
  });

  it("maps browser execute tools", () => {
    expect(mapMcpToolToScope("web_fetch")).toEqual({
      service: "browser",
      permissionLevel: "execute",
      actionType: "web_fetch",
    });
    expect(mapMcpToolToScope("browser_navigate")).toEqual({
      service: "browser",
      permissionLevel: "execute",
      actionType: "browser_navigate",
    });
  });

  it("maps single-token read write edit exec", () => {
    expect(mapMcpToolToScope("read")).toEqual({
      service: "filesystem",
      permissionLevel: "read",
      actionType: "read",
    });
    expect(mapMcpToolToScope("write")).toEqual({
      service: "filesystem",
      permissionLevel: "write",
      actionType: "write",
    });
    expect(mapMcpToolToScope("edit")).toEqual({
      service: "filesystem",
      permissionLevel: "write",
      actionType: "edit",
    });
    expect(mapMcpToolToScope("exec")).toEqual({
      service: "terminal",
      permissionLevel: "execute",
      actionType: "exec",
    });
  });

  it("maps git_ tools with inferred levels", () => {
    expect(mapMcpToolToScope("git_read_tree")).toEqual({
      service: "git",
      permissionLevel: "read",
      actionType: "git_read_tree",
    });
    expect(mapMcpToolToScope("git_push_origin")).toEqual({
      service: "git",
      permissionLevel: "write",
      actionType: "git_push_origin",
    });
    expect(mapMcpToolToScope("git_unknown")).toEqual({
      service: "git",
      permissionLevel: "execute",
      actionType: "git_unknown",
    });
  });

  it("maps integration prefixes including stripe and notion", () => {
    expect(mapMcpToolToScope("stripe_create_payment")).toEqual({
      service: "payments",
      permissionLevel: "write",
      actionType: "stripe_create_payment",
    });
    expect(mapMcpToolToScope("notion")).toEqual({
      service: "notion",
      permissionLevel: "execute",
      actionType: "notion",
    });
    expect(mapMcpToolToScope("linear_list_issues")).toEqual({
      service: "linear",
      permissionLevel: "read",
      actionType: "linear_list_issues",
    });
    expect(mapMcpToolToScope("jira_update_ticket")).toEqual({
      service: "jira",
      permissionLevel: "write",
      actionType: "jira_update_ticket",
    });
  });

  it("maps underscore-split custom service tails", () => {
    expect(mapMcpToolToScope("customsvc_list_items")).toEqual({
      service: "customsvc",
      permissionLevel: "read",
      actionType: "customsvc_list_items",
    });
    expect(mapMcpToolToScope("customsvc_send_msg")).toEqual({
      service: "customsvc",
      permissionLevel: "write",
      actionType: "customsvc_send_msg",
    });
    expect(mapMcpToolToScope("customsvc_run")).toEqual({
      service: "customsvc",
      permissionLevel: "execute",
      actionType: "customsvc_run",
    });
  });

  it("maps single-segment tool to service execute", () => {
    expect(mapMcpToolToScope("ping")).toEqual({
      service: "ping",
      permissionLevel: "execute",
      actionType: "ping",
    });
  });
});
