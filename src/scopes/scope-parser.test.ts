import { describe, it, expect } from "vitest";
import {
  parseScope,
  parseScopes,
  tryParseScope,
  formatScope,
  isValidScopeString,
  ScopeParseError,
} from "./scope-parser.js";

// parseScope: valid inputs

describe("parseScope", () => {
  describe("valid scope strings", () => {
    it('parses "read:gmail"', () => {
      const scope = parseScope("read:gmail");
      expect(scope).toEqual({
        service: "gmail",
        permissionLevel: "read",
      });
    });

    it('parses "write:calendar"', () => {
      const scope = parseScope("write:calendar");
      expect(scope).toEqual({
        service: "calendar",
        permissionLevel: "write",
      });
    });

    it('parses "execute:payments"', () => {
      const scope = parseScope("execute:payments");
      expect(scope).toEqual({
        service: "payments",
        permissionLevel: "execute",
      });
    });

    it('parses "publish:web"', () => {
      const scope = parseScope("publish:web");
      expect(scope).toEqual({
        service: "web",
        permissionLevel: "publish",
      });
    });

    it('parses "create:public_content"', () => {
      const scope = parseScope("create:public_content");
      expect(scope).toEqual({
        service: "public_content",
        permissionLevel: "create",
      });
    });

    it("parses a custom service name with hyphens", () => {
      const scope = parseScope("read:my-custom-service");
      expect(scope).toEqual({
        service: "my-custom-service",
        permissionLevel: "read",
      });
    });

    it("parses a custom service name with underscores", () => {
      const scope = parseScope("write:my_service");
      expect(scope).toEqual({
        service: "my_service",
        permissionLevel: "write",
      });
    });

    it("parses a custom service name with digits", () => {
      const scope = parseScope("execute:service2");
      expect(scope).toEqual({
        service: "service2",
        permissionLevel: "execute",
      });
    });

    it("parses a single-letter service name", () => {
      const scope = parseScope("read:x");
      expect(scope).toEqual({ service: "x", permissionLevel: "read" });
    });
  });

  // parseScope: invalid inputs

  describe("invalid scope strings", () => {
    it("throws on empty string", () => {
      expect(() => parseScope("")).toThrow(ScopeParseError);
      expect(() => parseScope("")).toThrow(/must not be empty/);
    });

    it("throws on whitespace-only string", () => {
      expect(() => parseScope("   ")).toThrow(ScopeParseError);
      expect(() => parseScope("   ")).toThrow(/contains whitespace/);
    });

    it("throws on string with leading whitespace", () => {
      expect(() => parseScope(" read:gmail")).toThrow(ScopeParseError);
      expect(() => parseScope(" read:gmail")).toThrow(/contains whitespace/);
    });

    it("throws on string with trailing whitespace", () => {
      expect(() => parseScope("read:gmail ")).toThrow(ScopeParseError);
      expect(() => parseScope("read:gmail ")).toThrow(/contains whitespace/);
    });

    it("throws on missing colon separator", () => {
      expect(() => parseScope("readgmail")).toThrow(ScopeParseError);
      expect(() => parseScope("readgmail")).toThrow(/missing ":" separator/);
    });

    it("throws on multiple colons", () => {
      expect(() => parseScope("read:gmail:extra")).toThrow(ScopeParseError);
      expect(() => parseScope("read:gmail:extra")).toThrow(/multiple ":" separators/);
    });

    it("throws on empty permission level", () => {
      expect(() => parseScope(":gmail")).toThrow(ScopeParseError);
      expect(() => parseScope(":gmail")).toThrow(/permission level is empty/);
    });

    it("throws on empty service name", () => {
      expect(() => parseScope("read:")).toThrow(ScopeParseError);
      expect(() => parseScope("read:")).toThrow(/service name is empty/);
    });

    it("throws on unknown permission level", () => {
      expect(() => parseScope("delete:gmail")).toThrow(ScopeParseError);
      expect(() => parseScope("delete:gmail")).toThrow(/Unknown permission level "delete"/);
    });

    it("throws on misspelled permission level", () => {
      expect(() => parseScope("raed:gmail")).toThrow(ScopeParseError);
      expect(() => parseScope("raed:gmail")).toThrow(/Unknown permission level "raed"/);
    });

    it("throws on uppercase permission level", () => {
      expect(() => parseScope("Read:gmail")).toThrow(ScopeParseError);
      expect(() => parseScope("Read:gmail")).toThrow(/Unknown permission level "Read"/);
    });

    it("throws on uppercase service name", () => {
      expect(() => parseScope("read:Gmail")).toThrow(ScopeParseError);
      expect(() => parseScope("read:Gmail")).toThrow(/Invalid service name "Gmail"/);
    });

    it("throws on service name starting with a digit", () => {
      expect(() => parseScope("read:123service")).toThrow(ScopeParseError);
      expect(() => parseScope("read:123service")).toThrow(/Invalid service name/);
    });

    it("throws on service name starting with a hyphen", () => {
      expect(() => parseScope("read:-service")).toThrow(ScopeParseError);
      expect(() => parseScope("read:-service")).toThrow(/Invalid service name/);
    });

    it("includes the original input in the error", () => {
      try {
        parseScope("bad-input");
        expect.fail("Expected ScopeParseError");
      } catch (error) {
        expect(error).toBeInstanceOf(ScopeParseError);
        expect((error as ScopeParseError).input).toBe("bad-input");
      }
    });

    it("error name is ScopeParseError", () => {
      try {
        parseScope("");
        expect.fail("Expected ScopeParseError");
      } catch (error) {
        expect((error as ScopeParseError).name).toBe("ScopeParseError");
      }
    });
  });
});

// parseScopes

describe("parseScopes", () => {
  it("parses multiple valid scope strings", () => {
    const scopes = parseScopes(["read:gmail", "write:calendar", "execute:payments"]);
    expect(scopes).toEqual([
      { service: "gmail", permissionLevel: "read" },
      { service: "calendar", permissionLevel: "write" },
      { service: "payments", permissionLevel: "execute" },
    ]);
  });

  it("parses scopes including publish and create", () => {
    const scopes = parseScopes([
      "read:gmail",
      "publish:web",
      "create:public_content",
      "execute:payments",
    ]);
    expect(scopes).toEqual([
      { service: "gmail", permissionLevel: "read" },
      { service: "web", permissionLevel: "publish" },
      { service: "public_content", permissionLevel: "create" },
      { service: "payments", permissionLevel: "execute" },
    ]);
  });

  it("returns an empty array for empty input", () => {
    const scopes = parseScopes([]);
    expect(scopes).toEqual([]);
  });

  it("throws on the first invalid string", () => {
    expect(() => parseScopes(["read:gmail", "bad", "write:calendar"])).toThrow(ScopeParseError);
  });
});

// tryParseScope

describe("tryParseScope", () => {
  it("returns success for a valid scope string", () => {
    const result = tryParseScope("read:gmail");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.scope).toEqual({
        service: "gmail",
        permissionLevel: "read",
      });
    }
  });

  it("returns failure with error message for an invalid string", () => {
    const result = tryParseScope("invalid");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('missing ":" separator');
    }
  });

  it("returns failure for empty string", () => {
    const result = tryParseScope("");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("must not be empty");
    }
  });

  it("does not throw on invalid input", () => {
    expect(() => tryParseScope("totally:::broken")).not.toThrow();
  });
});

// formatScope

describe("formatScope", () => {
  it("formats a scope to permission:service", () => {
    expect(formatScope({ service: "gmail", permissionLevel: "read" })).toBe("read:gmail");
  });

  it("round-trips with parseScope", () => {
    const original = "execute:payments";
    const scope = parseScope(original);
    expect(formatScope(scope)).toBe(original);
  });

  it("formats publish and create scopes", () => {
    expect(formatScope({ service: "web", permissionLevel: "publish" })).toBe("publish:web");
    expect(formatScope({ service: "public_content", permissionLevel: "create" })).toBe(
      "create:public_content",
    );
  });

  it("formats a custom service scope", () => {
    expect(formatScope({ service: "my-custom", permissionLevel: "write" })).toBe("write:my-custom");
  });
});

// isValidScopeString

describe("isValidScopeString", () => {
  it("returns true for valid scope strings", () => {
    expect(isValidScopeString("read:gmail")).toBe(true);
    expect(isValidScopeString("write:calendar")).toBe(true);
    expect(isValidScopeString("execute:payments")).toBe(true);
    expect(isValidScopeString("publish:web")).toBe(true);
    expect(isValidScopeString("create:public_content")).toBe(true);
  });

  it("returns false for invalid scope strings", () => {
    expect(isValidScopeString("")).toBe(false);
    expect(isValidScopeString("bad")).toBe(false);
    expect(isValidScopeString("delete:gmail")).toBe(false);
    expect(isValidScopeString("read:")).toBe(false);
    expect(isValidScopeString(":gmail")).toBe(false);
  });
});
