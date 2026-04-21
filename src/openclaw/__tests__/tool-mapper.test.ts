import { describe, it, expect } from "vitest";
import { mapToolToScope, isKnownTool, isDestructiveExecCommand } from "../tool-mapper.js";

describe("mapToolToScope", () => {
  it("maps 'read' to filesystem:read", () => {
    const result = mapToolToScope("read");
    expect(result).toEqual({ service: "filesystem", permissionLevel: "read" });
  });

  it("maps 'write' to filesystem:write", () => {
    const result = mapToolToScope("write");
    expect(result).toEqual({ service: "filesystem", permissionLevel: "write" });
  });

  it("maps 'edit' to filesystem:write", () => {
    const result = mapToolToScope("edit");
    expect(result).toEqual({ service: "filesystem", permissionLevel: "write" });
  });

  it("maps 'exec' to terminal:execute", () => {
    const result = mapToolToScope("exec");
    expect(result).toEqual({ service: "terminal", permissionLevel: "execute" });
  });

  it("maps 'exec' with a destructive command to terminal:write", () => {
    expect(mapToolToScope("exec", "rm -rf ./dist")).toEqual({
      service: "terminal",
      permissionLevel: "write",
    });
    expect(mapToolToScope("exec", "sudo apt update")).toEqual({
      service: "terminal",
      permissionLevel: "write",
    });
  });

  it("maps 'exec' with a non-destructive command to terminal:execute", () => {
    expect(mapToolToScope("exec", "ls -la")).toEqual({
      service: "terminal",
      permissionLevel: "execute",
    });
  });

  it("maps 'browser' to browser:execute", () => {
    const result = mapToolToScope("browser");
    expect(result).toEqual({ service: "browser", permissionLevel: "execute" });
  });

  it("maps 'message' to messaging:write", () => {
    const result = mapToolToScope("message");
    expect(result).toEqual({ service: "messaging", permissionLevel: "write" });
  });

  it("maps 'process' to terminal:execute", () => {
    const result = mapToolToScope("process");
    expect(result).toEqual({ service: "terminal", permissionLevel: "execute" });
  });

  it("maps 'sessions_spawn' to agents:execute", () => {
    const result = mapToolToScope("sessions_spawn");
    expect(result).toEqual({ service: "agents", permissionLevel: "execute" });
  });

  it("falls back to tool name as service for unknown tools", () => {
    const result = mapToolToScope("custom_tool");
    expect(result).toEqual({ service: "custom_tool", permissionLevel: "execute" });
  });

  it("normalizes tool names to lowercase", () => {
    const result = mapToolToScope("EXEC");
    expect(result).toEqual({ service: "terminal", permissionLevel: "execute" });
  });

  it("trims whitespace from tool names", () => {
    const result = mapToolToScope("  read  ");
    expect(result).toEqual({ service: "filesystem", permissionLevel: "read" });
  });

  it("returns unknown:execute for an empty string", () => {
    const result = mapToolToScope("");
    expect(result).toEqual({ service: "unknown", permissionLevel: "execute" });
  });

  it("returns unknown:execute for whitespace-only input", () => {
    const result = mapToolToScope("   ");
    expect(result).toEqual({ service: "unknown", permissionLevel: "execute" });
  });

  // Integration tools - exact matches
  it("maps 'gmail' to gmail:execute", () => {
    const result = mapToolToScope("gmail");
    expect(result).toEqual({ service: "gmail", permissionLevel: "execute" });
  });

  it("maps 'slack' to slack:execute", () => {
    const result = mapToolToScope("slack");
    expect(result).toEqual({ service: "slack", permissionLevel: "execute" });
  });

  it("maps 'google_calendar' to google_calendar:execute", () => {
    const result = mapToolToScope("google_calendar");
    expect(result).toEqual({ service: "google_calendar", permissionLevel: "execute" });
  });

  // Integration tools - prefix matching
  it("maps 'slack_send_message' to slack:write", () => {
    const result = mapToolToScope("slack_send_message");
    expect(result).toEqual({ service: "slack", permissionLevel: "write" });
  });

  it("maps 'slack_read_channels' to slack:read", () => {
    const result = mapToolToScope("slack_read_channels");
    expect(result).toEqual({ service: "slack", permissionLevel: "read" });
  });

  it("maps 'gmail_send' to gmail:write", () => {
    const result = mapToolToScope("gmail_send");
    expect(result).toEqual({ service: "gmail", permissionLevel: "write" });
  });

  it("maps 'gmail_read' to gmail:read", () => {
    const result = mapToolToScope("gmail_read");
    expect(result).toEqual({ service: "gmail", permissionLevel: "read" });
  });

  it("maps 'calendar_create_event' to google_calendar:write", () => {
    const result = mapToolToScope("calendar_create_event");
    expect(result).toEqual({ service: "google_calendar", permissionLevel: "write" });
  });

  it("maps 'drive_read_file' to google_drive:read", () => {
    const result = mapToolToScope("drive_read_file");
    expect(result).toEqual({ service: "google_drive", permissionLevel: "read" });
  });

  it("maps 'stripe_charge' to payments:execute", () => {
    const result = mapToolToScope("stripe_charge");
    expect(result).toEqual({ service: "payments", permissionLevel: "execute" });
  });
});

describe("isDestructiveExecCommand", () => {
  it("detects destructive tokens case-insensitively", () => {
    expect(isDestructiveExecCommand("RM -rf /tmp")).toBe(true);
    expect(isDestructiveExecCommand("mv a b")).toBe(true);
    expect(isDestructiveExecCommand("chmod +x script")).toBe(true);
    expect(isDestructiveExecCommand("echo hello")).toBe(false);
  });
});

describe("isKnownTool", () => {
  it("returns true for all 8 built-in tools", () => {
    const knownTools = [
      "read",
      "write",
      "edit",
      "exec",
      "browser",
      "message",
      "process",
      "sessions_spawn",
    ];
    for (const tool of knownTools) {
      expect(isKnownTool(tool)).toBe(true);
    }
  });

  it("returns false for unknown tools", () => {
    expect(isKnownTool("custom_tool")).toBe(false);
    expect(isKnownTool("deploy")).toBe(false);
  });

  it("handles case-insensitive matching", () => {
    expect(isKnownTool("EXEC")).toBe(true);
    expect(isKnownTool("Read")).toBe(true);
  });

  it("returns false for empty string", () => {
    expect(isKnownTool("")).toBe(false);
  });
});
