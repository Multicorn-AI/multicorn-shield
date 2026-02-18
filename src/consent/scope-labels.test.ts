/**
 * Unit tests for scope label utilities.
 *
 * @module consent/scope-labels.test
 */

import { describe, it, expect } from "vitest";
import { PERMISSION_LEVELS } from "../types/index.js";
import {
  getServiceDisplayName,
  getServiceIcon,
  getPermissionLabel,
  getScopeLabel,
  getScopeShortLabel,
} from "./scope-labels.js";

describe("scope-labels", () => {
  describe("getServiceDisplayName", () => {
    it("returns display name for known services", () => {
      expect(getServiceDisplayName("gmail")).toBe("Gmail");
      expect(getServiceDisplayName("calendar")).toBe("Google Calendar");
      expect(getServiceDisplayName("slack")).toBe("Slack");
      expect(getServiceDisplayName("drive")).toBe("Google Drive");
      expect(getServiceDisplayName("payments")).toBe("Payments");
      expect(getServiceDisplayName("github")).toBe("GitHub");
      expect(getServiceDisplayName("jira")).toBe("Jira");
    });

    it("capitalizes unknown service names", () => {
      expect(getServiceDisplayName("custom-service")).toBe("Custom-service");
      expect(getServiceDisplayName("myapi")).toBe("Myapi");
    });

    it("returns empty string for empty service name", () => {
      expect(getServiceDisplayName("")).toBe("");
    });
  });

  describe("getServiceIcon", () => {
    it("returns icon for known services", () => {
      expect(getServiceIcon("gmail")).toBe("📧");
      expect(getServiceIcon("calendar")).toBe("📅");
      expect(getServiceIcon("slack")).toBe("💬");
      expect(getServiceIcon("drive")).toBe("📁");
      expect(getServiceIcon("payments")).toBe("💳");
      expect(getServiceIcon("github")).toBe("🐙");
      expect(getServiceIcon("jira")).toBe("🎯");
    });

    it("returns default icon for unknown services", () => {
      expect(getServiceIcon("unknown")).toBe("🔌");
      expect(getServiceIcon("")).toBe("🔌");
    });
  });

  describe("getPermissionLabel", () => {
    it("returns label for each permission level", () => {
      expect(getPermissionLabel(PERMISSION_LEVELS.Read)).toBe("Read");
      expect(getPermissionLabel(PERMISSION_LEVELS.Write)).toBe("Create and modify");
      expect(getPermissionLabel(PERMISSION_LEVELS.Execute)).toBe("Execute actions");
    });
  });

  describe("getScopeLabel", () => {
    it("returns full description for read scopes", () => {
      expect(getScopeLabel({ service: "gmail", permissionLevel: PERMISSION_LEVELS.Read })).toBe(
        "Read your Gmail",
      );
    });

    it("returns full description for write scopes", () => {
      expect(getScopeLabel({ service: "drive", permissionLevel: PERMISSION_LEVELS.Write })).toBe(
        "Create and modify Google Drive content",
      );
    });

    it("returns special description for payments execute", () => {
      expect(
        getScopeLabel({ service: "payments", permissionLevel: PERMISSION_LEVELS.Execute }),
      ).toBe("Make purchases on your behalf");
    });

    it("returns generic execute description for non-payment services", () => {
      expect(getScopeLabel({ service: "github", permissionLevel: PERMISSION_LEVELS.Execute })).toBe(
        "Execute actions in GitHub",
      );
    });

    it("handles unknown services with fallback capitalization", () => {
      expect(
        getScopeLabel({ service: "custom-api", permissionLevel: PERMISSION_LEVELS.Read }),
      ).toBe("Read your Custom-api");
    });
  });

  describe("getScopeShortLabel", () => {
    it("returns short label combining service and permission", () => {
      expect(
        getScopeShortLabel({ service: "gmail", permissionLevel: PERMISSION_LEVELS.Read }),
      ).toBe("Gmail: Read");
    });

    it("returns short label for write permission", () => {
      expect(
        getScopeShortLabel({ service: "slack", permissionLevel: PERMISSION_LEVELS.Write }),
      ).toBe("Slack: Create and modify");
    });

    it("returns short label for execute permission", () => {
      expect(
        getScopeShortLabel({ service: "github", permissionLevel: PERMISSION_LEVELS.Execute }),
      ).toBe("GitHub: Execute actions");
    });

    it("returns short label for unknown service", () => {
      expect(
        getScopeShortLabel({ service: "unknown", permissionLevel: PERMISSION_LEVELS.Read }),
      ).toBe("Unknown: Read");
    });
  });
});
