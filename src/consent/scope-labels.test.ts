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
      expect(getServiceDisplayName("web")).toBe("Web");
      expect(getServiceDisplayName("public_content")).toBe("Public Content");
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
      expect(getServiceIcon("web")).toBe("🌐");
      expect(getServiceIcon("public_content")).toBe("📢");
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
      expect(getPermissionLabel(PERMISSION_LEVELS.Publish)).toBe("Publish");
      expect(getPermissionLabel(PERMISSION_LEVELS.Create)).toBe("Create");
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

    it("returns special description for publish:web scope", () => {
      expect(getScopeLabel({ service: "web", permissionLevel: PERMISSION_LEVELS.Publish })).toBe(
        "Publish content to the open internet",
      );
    });

    it("returns generic publish description for non-web services", () => {
      expect(getScopeLabel({ service: "blog", permissionLevel: PERMISSION_LEVELS.Publish })).toBe(
        "Publish blog content",
      );
    });

    it("returns special description for create:public_content scope", () => {
      expect(
        getScopeLabel({ service: "public_content", permissionLevel: PERMISSION_LEVELS.Create }),
      ).toBe("Create content that is immediately public");
    });

    it("returns generic create description for non-public_content services", () => {
      expect(getScopeLabel({ service: "blog", permissionLevel: PERMISSION_LEVELS.Create })).toBe(
        "Create blog",
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

    it("returns short label for publish permission", () => {
      expect(
        getScopeShortLabel({ service: "web", permissionLevel: PERMISSION_LEVELS.Publish }),
      ).toBe("Web: Publish");
    });

    it("returns short label for create permission", () => {
      expect(
        getScopeShortLabel({
          service: "public_content",
          permissionLevel: PERMISSION_LEVELS.Create,
        }),
      ).toBe("Public Content: Create");
    });

    it("returns short label for unknown service", () => {
      expect(
        getScopeShortLabel({ service: "unknown", permissionLevel: PERMISSION_LEVELS.Read }),
      ).toBe("Unknown: Read");
    });
  });
});
