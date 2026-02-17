import { describe, it, expect } from "vitest";
import type { Scope } from "../types/index.js";
import {
  validateScopeAccess,
  validateAllScopesAccess,
  hasScope,
} from "./scope-validator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scope(
  permissionLevel: "read" | "write" | "execute",
  service: string,
): Scope {
  return { service, permissionLevel };
}

// ---------------------------------------------------------------------------
// validateScopeAccess
// ---------------------------------------------------------------------------

describe("validateScopeAccess", () => {
  describe("exact match", () => {
    it("allows when the exact scope is granted", () => {
      const granted = [scope("read", "gmail")];
      const result = validateScopeAccess(granted, scope("read", "gmail"));
      expect(result.allowed).toBe(true);
      expect(result).not.toHaveProperty("reason");
    });

    it("allows when the scope is one of several granted", () => {
      const granted = [
        scope("read", "gmail"),
        scope("write", "gmail"),
        scope("read", "calendar"),
      ];
      const result = validateScopeAccess(granted, scope("write", "gmail"));
      expect(result.allowed).toBe(true);
    });
  });

  describe("partial match (service exists, wrong permission)", () => {
    it("denies when the service is granted but not the requested level", () => {
      const granted = [scope("read", "gmail")];
      const result = validateScopeAccess(granted, scope("write", "gmail"));
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain(
        'Permission "write" is not granted for service "gmail"',
      );
    });

    it("includes the granted levels in the reason", () => {
      const granted = [scope("read", "gmail"), scope("write", "gmail")];
      const result = validateScopeAccess(
        granted,
        scope("execute", "gmail"),
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('"read"');
      expect(result.reason).toContain('"write"');
    });

    it("mentions explicit consent is required", () => {
      const granted = [scope("read", "gmail")];
      const result = validateScopeAccess(
        granted,
        scope("execute", "gmail"),
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("requires explicit consent");
    });
  });

  describe("no match (service not granted at all)", () => {
    it("denies when the service has no grants", () => {
      const granted = [scope("read", "gmail")];
      const result = validateScopeAccess(granted, scope("read", "slack"));
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain(
        'No permissions granted for service "slack"',
      );
    });

    it("suggests requesting via the consent screen", () => {
      const granted: Scope[] = [];
      const result = validateScopeAccess(granted, scope("read", "gmail"));
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("consent screen");
    });

    it("denies with empty granted scopes", () => {
      const result = validateScopeAccess([], scope("read", "gmail"));
      expect(result.allowed).toBe(false);
      expect(result.reason).toBeDefined();
    });
  });

  describe("no implicit escalation (Jordan persona)", () => {
    it("read does NOT imply write", () => {
      const granted = [scope("read", "gmail")];
      expect(
        validateScopeAccess(granted, scope("write", "gmail")).allowed,
      ).toBe(false);
    });

    it("write does NOT imply read", () => {
      const granted = [scope("write", "gmail")];
      expect(
        validateScopeAccess(granted, scope("read", "gmail")).allowed,
      ).toBe(false);
    });

    it("write does NOT imply execute", () => {
      const granted = [scope("write", "payments")];
      expect(
        validateScopeAccess(granted, scope("execute", "payments")).allowed,
      ).toBe(false);
    });

    it("execute does NOT imply read or write", () => {
      const granted = [scope("execute", "payments")];
      expect(
        validateScopeAccess(granted, scope("read", "payments")).allowed,
      ).toBe(false);
      expect(
        validateScopeAccess(granted, scope("write", "payments")).allowed,
      ).toBe(false);
    });

    it("grants on one service do NOT carry over to another", () => {
      const granted = [
        scope("read", "gmail"),
        scope("write", "gmail"),
        scope("execute", "gmail"),
      ];
      expect(
        validateScopeAccess(granted, scope("read", "calendar")).allowed,
      ).toBe(false);
    });
  });

  describe("custom service scopes", () => {
    it("allows a custom service scope when granted", () => {
      const granted = [scope("read", "my-custom-crm")];
      const result = validateScopeAccess(
        granted,
        scope("read", "my-custom-crm"),
      );
      expect(result.allowed).toBe(true);
    });

    it("denies a custom service scope when not granted", () => {
      const granted = [scope("read", "my-custom-crm")];
      const result = validateScopeAccess(
        granted,
        scope("write", "my-custom-crm"),
      );
      expect(result.allowed).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// validateAllScopesAccess
// ---------------------------------------------------------------------------

describe("validateAllScopesAccess", () => {
  it("allows when all requested scopes are granted", () => {
    const granted = [
      scope("read", "gmail"),
      scope("write", "calendar"),
      scope("execute", "payments"),
    ];
    const requested = [
      scope("read", "gmail"),
      scope("write", "calendar"),
    ];
    const result = validateAllScopesAccess(granted, requested);
    expect(result.allowed).toBe(true);
  });

  it("denies when one requested scope is missing", () => {
    const granted = [scope("read", "gmail")];
    const requested = [scope("read", "gmail"), scope("write", "gmail")];
    const result = validateAllScopesAccess(granted, requested);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("write");
  });

  it("denies when no scopes are granted but some are requested", () => {
    const result = validateAllScopesAccess([], [scope("read", "gmail")]);
    expect(result.allowed).toBe(false);
  });

  it("allows when no scopes are requested (vacuous truth)", () => {
    const result = validateAllScopesAccess(
      [scope("read", "gmail")],
      [],
    );
    expect(result.allowed).toBe(true);
  });

  it("allows when both granted and requested are empty", () => {
    const result = validateAllScopesAccess([], []);
    expect(result.allowed).toBe(true);
  });

  it("returns the reason for the first denied scope", () => {
    const granted = [scope("read", "gmail")];
    const requested = [
      scope("read", "gmail"),
      scope("read", "slack"),
      scope("read", "drive"),
    ];
    const result = validateAllScopesAccess(granted, requested);
    expect(result.allowed).toBe(false);
    // Should mention slack (the first failure), not drive
    expect(result.reason).toContain("slack");
  });
});

// ---------------------------------------------------------------------------
// hasScope
// ---------------------------------------------------------------------------

describe("hasScope", () => {
  it("returns true when scope is granted", () => {
    const granted = [
      scope("read", "gmail"),
      scope("write", "calendar"),
    ];
    expect(hasScope(granted, scope("read", "gmail"))).toBe(true);
  });

  it("returns false when scope is not granted", () => {
    const granted = [scope("read", "gmail")];
    expect(hasScope(granted, scope("write", "gmail"))).toBe(false);
  });

  it("returns false with empty granted scopes", () => {
    expect(hasScope([], scope("read", "gmail"))).toBe(false);
  });

  it("returns false for wrong service", () => {
    const granted = [scope("read", "gmail")];
    expect(hasScope(granted, scope("read", "slack"))).toBe(false);
  });

  it("handles custom service names", () => {
    const granted = [scope("execute", "my-service")];
    expect(hasScope(granted, scope("execute", "my-service"))).toBe(true);
    expect(hasScope(granted, scope("read", "my-service"))).toBe(false);
  });
});
