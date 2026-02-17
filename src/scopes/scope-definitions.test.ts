import { describe, it, expect } from "vitest";
import {
  BUILT_IN_SERVICES,
  SERVICE_NAME_PATTERN,
  createScopeRegistry,
} from "./scope-definitions.js";
import { PERMISSION_LEVELS } from "../types/index.js";

// ---------------------------------------------------------------------------
// BUILT_IN_SERVICES
// ---------------------------------------------------------------------------

describe("BUILT_IN_SERVICES", () => {
  const serviceEntries = Object.entries(BUILT_IN_SERVICES);

  it("contains the expected built-in services", () => {
    const names = Object.keys(BUILT_IN_SERVICES);
    expect(names).toEqual(
      expect.arrayContaining([
        "gmail",
        "calendar",
        "slack",
        "drive",
        "payments",
        "github",
        "jira",
      ]),
    );
    expect(names).toHaveLength(7);
  });

  it.each(serviceEntries)(
    '"%s" has a name matching its key',
    (key, definition) => {
      expect(definition.name).toBe(key);
    },
  );

  it.each(serviceEntries)(
    '"%s" has a non-empty description',
    (_key, definition) => {
      expect(definition.description.length).toBeGreaterThan(0);
    },
  );

  it.each(serviceEntries)(
    '"%s" has at least one capability',
    (_key, definition) => {
      expect(definition.capabilities.length).toBeGreaterThan(0);
    },
  );

  it.each(serviceEntries)(
    '"%s" capabilities are valid permission levels',
    (_key, definition) => {
      const validLevels = new Set(Object.values(PERMISSION_LEVELS));
      for (const cap of definition.capabilities) {
        expect(validLevels.has(cap)).toBe(true);
      }
    },
  );

  it("drive does NOT support execute", () => {
    const caps = BUILT_IN_SERVICES.drive.capabilities as readonly string[];
    expect(caps).not.toContain("execute");
  });

  it("payments does NOT support write", () => {
    const caps = BUILT_IN_SERVICES.payments.capabilities as readonly string[];
    expect(caps).not.toContain("write");
  });

  it("gmail supports read, write, and execute", () => {
    const caps = BUILT_IN_SERVICES.gmail.capabilities;
    expect(caps).toEqual(["read", "write", "execute"]);
  });
});

// ---------------------------------------------------------------------------
// SERVICE_NAME_PATTERN
// ---------------------------------------------------------------------------

describe("SERVICE_NAME_PATTERN", () => {
  it.each(["gmail", "my-service", "my_service", "analytics2", "a"])(
    'accepts valid name "%s"',
    (name) => {
      expect(SERVICE_NAME_PATTERN.test(name)).toBe(true);
    },
  );

  it.each(["", "123bad", "Bad", "UPPER", "has space", "-start", "_start"])(
    'rejects invalid name "%s"',
    (name) => {
      expect(SERVICE_NAME_PATTERN.test(name)).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// createScopeRegistry
// ---------------------------------------------------------------------------

describe("createScopeRegistry", () => {
  describe("built-in services", () => {
    it("has all built-in services pre-registered", () => {
      const registry = createScopeRegistry();
      for (const name of Object.keys(BUILT_IN_SERVICES)) {
        expect(registry.has(name)).toBe(true);
      }
    });

    it("returns the correct definition for a built-in service", () => {
      const registry = createScopeRegistry();
      const gmail = registry.get("gmail");
      expect(gmail).toBeDefined();
      expect(gmail?.name).toBe("gmail");
      expect(gmail?.description).toContain("Gmail");
    });

    it("returns undefined for an unknown service", () => {
      const registry = createScopeRegistry();
      expect(registry.get("nonexistent")).toBeUndefined();
    });

    it("has() returns false for unknown services", () => {
      const registry = createScopeRegistry();
      expect(registry.has("nonexistent")).toBe(false);
    });

    it("getAllServices() returns all built-in services", () => {
      const registry = createScopeRegistry();
      const all = registry.getAllServices();
      expect(all.length).toBe(Object.keys(BUILT_IN_SERVICES).length);
    });
  });

  describe("custom service registration", () => {
    it("registers a valid custom service", () => {
      const registry = createScopeRegistry();
      registry.register({
        name: "analytics",
        description: "Internal analytics",
        capabilities: ["read"],
      });
      expect(registry.has("analytics")).toBe(true);
      expect(registry.get("analytics")?.description).toBe(
        "Internal analytics",
      );
    });

    it("includes custom services in getAllServices()", () => {
      const registry = createScopeRegistry();
      const before = registry.getAllServices().length;
      registry.register({
        name: "my-custom",
        description: "Custom service",
        capabilities: ["read", "write"],
      });
      expect(registry.getAllServices().length).toBe(before + 1);
    });

    it("throws when registering a duplicate service name", () => {
      const registry = createScopeRegistry();
      expect(() =>
        registry.register({
          name: "gmail",
          description: "Duplicate",
          capabilities: ["read"],
        }),
      ).toThrow(/already registered/);
    });

    it("throws when registering a duplicate custom service", () => {
      const registry = createScopeRegistry();
      registry.register({
        name: "my-svc",
        description: "First",
        capabilities: ["read"],
      });
      expect(() =>
        registry.register({
          name: "my-svc",
          description: "Duplicate",
          capabilities: ["read"],
        }),
      ).toThrow(/already registered/);
    });

    it("throws on empty service name", () => {
      const registry = createScopeRegistry();
      expect(() =>
        registry.register({
          name: "",
          description: "Bad",
          capabilities: ["read"],
        }),
      ).toThrow(/must not be empty/);
    });

    it("throws on invalid service name format", () => {
      const registry = createScopeRegistry();
      expect(() =>
        registry.register({
          name: "Bad-Name",
          description: "Bad",
          capabilities: ["read"],
        }),
      ).toThrow(/Invalid service name/);
    });

    it("throws on empty capabilities", () => {
      const registry = createScopeRegistry();
      expect(() =>
        registry.register({
          name: "empty-caps",
          description: "No caps",
          capabilities: [],
        }),
      ).toThrow(/at least one capability/);
    });

    it("throws on invalid capability", () => {
      const registry = createScopeRegistry();
      expect(() =>
        registry.register({
          name: "bad-cap",
          description: "Bad cap",
          capabilities: ["read", "delete" as never],
        }),
      ).toThrow(/Invalid capability/);
    });

    it("throws on duplicate capabilities", () => {
      const registry = createScopeRegistry();
      expect(() =>
        registry.register({
          name: "dup-cap",
          description: "Dup cap",
          capabilities: ["read", "read"],
        }),
      ).toThrow(/Duplicate capability/);
    });
  });

  describe("isValidScope", () => {
    it("returns true for a valid built-in scope", () => {
      const registry = createScopeRegistry();
      expect(
        registry.isValidScope({ service: "gmail", permissionLevel: "read" }),
      ).toBe(true);
    });

    it("returns true for an execute scope on a service that supports it", () => {
      const registry = createScopeRegistry();
      expect(
        registry.isValidScope({
          service: "payments",
          permissionLevel: "execute",
        }),
      ).toBe(true);
    });

    it("returns false for execute on drive (not supported)", () => {
      const registry = createScopeRegistry();
      expect(
        registry.isValidScope({
          service: "drive",
          permissionLevel: "execute",
        }),
      ).toBe(false);
    });

    it("returns false for an unknown service", () => {
      const registry = createScopeRegistry();
      expect(
        registry.isValidScope({
          service: "unknown",
          permissionLevel: "read",
        }),
      ).toBe(false);
    });

    it("returns true for a valid custom scope", () => {
      const registry = createScopeRegistry();
      registry.register({
        name: "crm",
        description: "CRM",
        capabilities: ["read", "write"],
      });
      expect(
        registry.isValidScope({ service: "crm", permissionLevel: "write" }),
      ).toBe(true);
    });

    it("returns false for a capability not in custom service", () => {
      const registry = createScopeRegistry();
      registry.register({
        name: "crm",
        description: "CRM",
        capabilities: ["read"],
      });
      expect(
        registry.isValidScope({
          service: "crm",
          permissionLevel: "execute",
        }),
      ).toBe(false);
    });
  });

  describe("isolation between registries", () => {
    it("custom services in one registry do not appear in another", () => {
      const a = createScopeRegistry();
      const b = createScopeRegistry();

      a.register({
        name: "only-in-a",
        description: "A-only",
        capabilities: ["read"],
      });

      expect(a.has("only-in-a")).toBe(true);
      expect(b.has("only-in-a")).toBe(false);
    });
  });
});
