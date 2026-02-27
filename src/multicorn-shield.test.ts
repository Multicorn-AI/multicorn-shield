import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  MulticornShield,
  type MulticornShieldConfig,
  type ConsentOptions,
} from "./multicorn-shield.js";
import type {
  ConsentGrantedEventDetail,
  ConsentPartialEventDetail,
  ConsentDeniedEventDetail,
} from "./consent/consent-events.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const VALID_KEY = "mcs_testkey123456";

const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  status: 200,
  statusText: "OK",
});

vi.stubGlobal("fetch", mockFetch);

function grantConsent(
  grantedScopes: { service: string; permissionLevel: "read" | "write" | "execute" }[],
  spendLimit = 0,
): void {
  const element = document.querySelector("multicorn-consent");
  if (!element) throw new Error("Consent element not found in DOM");

  const detail: ConsentGrantedEventDetail = {
    grantedScopes,
    spendLimit,
    timestamp: new Date().toISOString(),
  };
  element.dispatchEvent(
    new CustomEvent("consent-granted", { detail, bubbles: true, composed: true }),
  );
}

function partialConsent(
  grantedScopes: { service: string; permissionLevel: "read" | "write" | "execute" }[],
  deniedScopes: { service: string; permissionLevel: "read" | "write" | "execute" }[],
  spendLimit = 0,
): void {
  const element = document.querySelector("multicorn-consent");
  if (!element) throw new Error("Consent element not found in DOM");

  const detail: ConsentPartialEventDetail = {
    grantedScopes,
    deniedScopes,
    spendLimit,
    timestamp: new Date().toISOString(),
  };
  element.dispatchEvent(
    new CustomEvent("consent-partial", { detail, bubbles: true, composed: true }),
  );
}

function denyConsent(
  deniedScopes: { service: string; permissionLevel: "read" | "write" | "execute" }[] = [],
): void {
  const element = document.querySelector("multicorn-consent");
  if (!element) throw new Error("Consent element not found in DOM");

  const detail: ConsentDeniedEventDetail = {
    deniedScopes,
    timestamp: new Date().toISOString(),
  };
  element.dispatchEvent(
    new CustomEvent("consent-denied", { detail, bubbles: true, composed: true }),
  );
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe("MulticornShield constructor", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    mockFetch.mockClear();
  });

  it("creates an instance with a valid API key", () => {
    expect(() => new MulticornShield({ apiKey: VALID_KEY })).not.toThrow();
  });

  it("throws when the API key does not start with mcs_", () => {
    expect(() => new MulticornShield({ apiKey: "sk_livekey123456" })).toThrow(
      'must start with "mcs_"',
    );
  });

  it("throws when the API key is exactly the prefix with no key material", () => {
    expect(() => new MulticornShield({ apiKey: "mcs_" })).toThrow("too short");
  });

  it("throws when the API key is shorter than the minimum length", () => {
    expect(() => new MulticornShield({ apiKey: "mcs_abc" })).toThrow("too short");
  });

  it("throws when the API key is empty", () => {
    expect(() => new MulticornShield({ apiKey: "" })).toThrow();
  });

  it("accepts an optional baseUrl pointing to localhost", () => {
    expect(
      () => new MulticornShield({ apiKey: VALID_KEY, baseUrl: "http://localhost:8080" }),
    ).not.toThrow();
  });

  it("accepts optional timeout and batchMode configuration", () => {
    const config: MulticornShieldConfig = {
      apiKey: VALID_KEY,
      timeout: 3000,
      batchMode: { enabled: true, maxSize: 5, flushIntervalMs: 2000 },
    };
    expect(() => new MulticornShield(config)).not.toThrow();
  });

  it("does not write the API key to localStorage", () => {
    const setSpy = vi.spyOn(Storage.prototype, "setItem");
    new MulticornShield({ apiKey: VALID_KEY });
    expect(setSpy).not.toHaveBeenCalled();
    setSpy.mockRestore();
  });

  it("does not write the API key to sessionStorage", () => {
    const setSpy = vi.spyOn(Storage.prototype, "setItem");
    new MulticornShield({ apiKey: VALID_KEY });
    expect(setSpy).not.toHaveBeenCalled();
    setSpy.mockRestore();
  });

  it("does not write the API key to any DOM attribute", () => {
    new MulticornShield({ apiKey: VALID_KEY });
    for (const el of document.querySelectorAll("*")) {
      for (const attr of el.attributes) {
        expect(attr.value).not.toContain(VALID_KEY);
      }
    }
  });

  // Invalid API key format edge cases
  it("accepts API key with correct prefix and whitespace padding to meet length", () => {
    // "mcs_" (4) + 12 spaces = 16 chars, meets minimum length
    expect(() => new MulticornShield({ apiKey: "mcs_            " })).not.toThrow();
  });

  it("rejects API key that is just the prefix repeated", () => {
    expect(() => new MulticornShield({ apiKey: "mcs_mcs_mcs_mcs_" })).not.toThrow();
  });

  it("rejects API key with wrong prefix casing", () => {
    expect(() => new MulticornShield({ apiKey: "MCS_testkey123456" })).toThrow(
      'must start with "mcs_"',
    );
  });

  it("rejects API key with extra prefix characters", () => {
    expect(() => new MulticornShield({ apiKey: "xmcs_testkey123456" })).toThrow(
      'must start with "mcs_"',
    );
  });

  it("rejects API key with spaces before the prefix", () => {
    expect(() => new MulticornShield({ apiKey: " mcs_testkey123456" })).toThrow(
      'must start with "mcs_"',
    );
  });

  it("rejects API key that is exactly 15 characters long", () => {
    expect(() => new MulticornShield({ apiKey: "mcs_12345678901" })).toThrow("too short");
  });

  it("accepts API key that is exactly 16 characters long", () => {
    expect(() => new MulticornShield({ apiKey: "mcs_123456789012" })).not.toThrow();
  });

  it("rejects API key with no prefix at all", () => {
    expect(() => new MulticornShield({ apiKey: "thisisavalidlengthkey" })).toThrow(
      'must start with "mcs_"',
    );
  });

  it("rejects API key that contains only the prefix mcs_ with no material", () => {
    expect(() => new MulticornShield({ apiKey: "mcs_" })).toThrow("too short");
  });
});

// ---------------------------------------------------------------------------
// requestConsent
// ---------------------------------------------------------------------------

describe("MulticornShield.requestConsent", () => {
  let shield: MulticornShield;

  beforeEach(() => {
    shield = new MulticornShield({ apiKey: VALID_KEY });
    mockFetch.mockClear();
  });

  afterEach(() => {
    shield.destroy();
    document.body.innerHTML = "";
  });

  it("mounts the consent element in the DOM", () => {
    void shield.requestConsent({ agent: "OpenClaw", scopes: ["read:gmail"] });
    expect(document.querySelector("multicorn-consent")).not.toBeNull();
  });

  it("resolves with all scopes when the user approves", async () => {
    const promise = shield.requestConsent({
      agent: "OpenClaw",
      scopes: ["read:gmail", "write:calendar"],
      spendLimit: 200,
    });

    grantConsent(
      [
        { service: "gmail", permissionLevel: "read" },
        { service: "calendar", permissionLevel: "write" },
      ],
      200,
    );

    const decision = await promise;
    expect(decision.grantedScopes).toHaveLength(2);
    expect(decision.scopeRequest.agentName).toBe("OpenClaw");
    expect(decision.scopeRequest.spendLimit).toBe(200);
  });

  it("resolves with partial scopes when the user partially approves", async () => {
    const promise = shield.requestConsent({
      agent: "OpenClaw",
      scopes: ["read:gmail", "write:calendar"],
    });

    partialConsent(
      [{ service: "gmail", permissionLevel: "read" }],
      [{ service: "calendar", permissionLevel: "write" }],
    );

    const decision = await promise;
    expect(decision.grantedScopes).toHaveLength(1);
    expect(decision.grantedScopes[0]).toEqual({ service: "gmail", permissionLevel: "read" });
  });

  it("resolves with an empty grantedScopes array when the user denies", async () => {
    const promise = shield.requestConsent({
      agent: "OpenClaw",
      scopes: ["read:gmail"],
    });

    denyConsent([{ service: "gmail", permissionLevel: "read" }]);

    const decision = await promise;
    expect(decision.grantedScopes).toHaveLength(0);
  });

  it("removes the consent element from the DOM after the user decides", async () => {
    const promise = shield.requestConsent({ agent: "OpenClaw", scopes: ["read:gmail"] });
    denyConsent();
    await promise;
    expect(document.querySelector("multicorn-consent")).toBeNull();
  });

  it("stores granted scopes for use by logAction", async () => {
    const promise = shield.requestConsent({ agent: "OpenClaw", scopes: ["read:gmail"] });
    grantConsent([{ service: "gmail", permissionLevel: "read" }]);
    await promise;

    expect(shield.getGrantedScopes("OpenClaw")).toHaveLength(1);
  });

  it("stores empty scopes when consent is denied", async () => {
    const promise = shield.requestConsent({ agent: "OpenClaw", scopes: ["read:gmail"] });
    denyConsent();
    await promise;

    expect(shield.getGrantedScopes("OpenClaw")).toHaveLength(0);
  });

  it("sets up a spending checker when the user approves a spend limit", async () => {
    const promise = shield.requestConsent({
      agent: "OpenClaw",
      scopes: ["read:gmail"],
      spendLimit: 100,
    });

    grantConsent([{ service: "gmail", permissionLevel: "read" }], 100);
    await promise;

    expect(shield.checkSpending("OpenClaw", 50).allowed).toBe(true);
    expect(shield.checkSpending("OpenClaw", 200).allowed).toBe(false);
  });

  it("does not configure a spending checker when spendLimit is zero", async () => {
    const promise = shield.requestConsent({ agent: "OpenClaw", scopes: ["read:gmail"] });
    grantConsent([{ service: "gmail", permissionLevel: "read" }], 0);
    await promise;

    expect(shield.checkSpending("OpenClaw", 999_999).allowed).toBe(true);
  });

  it("sets up a spending checker when the user partially approves with a spend limit", async () => {
    const promise = shield.requestConsent({
      agent: "OpenClaw",
      scopes: ["read:gmail", "write:calendar"],
      spendLimit: 50,
    });

    partialConsent(
      [{ service: "gmail", permissionLevel: "read" }],
      [{ service: "calendar", permissionLevel: "write" }],
      50,
    );

    await promise;

    expect(shield.checkSpending("OpenClaw", 30).allowed).toBe(true);
    expect(shield.checkSpending("OpenClaw", 100).allowed).toBe(false);
  });

  it("uses the agentColor option when provided", () => {
    void shield.requestConsent({
      agent: "OpenClaw",
      scopes: ["read:gmail"],
      agentColor: "#ff0000",
    });

    const element = document.querySelector("multicorn-consent") as Element & {
      agentColor?: string;
    };
    expect(element).not.toBeNull();
    denyConsent();
  });

  it("rejects with ScopeParseError when a scope string is malformed", async () => {
    await expect(
      shield.requestConsent({ agent: "OpenClaw", scopes: ["not-a-valid-scope"] }),
    ).rejects.toThrow();
  });

  it("rejects with ScopeParseError when a scope has an unknown permission level", async () => {
    await expect(
      shield.requestConsent({ agent: "OpenClaw", scopes: ["delete:gmail"] }),
    ).rejects.toThrow();
  });

  it("throws when called after destroy", async () => {
    shield.destroy();
    await expect(
      shield.requestConsent({ agent: "OpenClaw", scopes: ["read:gmail"] }),
    ).rejects.toThrow("destroyed");
  });

  // Concurrent consent requests
  it("handles concurrent consent requests for different agents independently", async () => {
    const promise1 = shield.requestConsent({
      agent: "AgentAlpha",
      scopes: ["read:gmail"],
    });

    // Grab the first consent element
    const element1 = document.querySelector("multicorn-consent");
    if (element1 == null) throw new Error("Consent element not found in DOM");

    // Grant consent for AgentAlpha
    const detail1: ConsentGrantedEventDetail = {
      grantedScopes: [{ service: "gmail", permissionLevel: "read" }],
      spendLimit: 0,
      timestamp: new Date().toISOString(),
    };
    element1.dispatchEvent(
      new CustomEvent("consent-granted", { detail: detail1, bubbles: true, composed: true }),
    );

    const decision1 = await promise1;
    expect(decision1.grantedScopes).toHaveLength(1);
    expect(shield.getGrantedScopes("AgentAlpha")).toHaveLength(1);
  });

  it("resolves consent with a single scope when only one is requested", async () => {
    const promise = shield.requestConsent({
      agent: "SingleScopeAgent",
      scopes: ["execute:payments"],
    });

    grantConsent([{ service: "payments", permissionLevel: "execute" }]);

    const decision = await promise;
    expect(decision.grantedScopes).toHaveLength(1);
    expect(decision.grantedScopes[0]).toEqual({
      service: "payments",
      permissionLevel: "execute",
    });
  });

  it("handles consent request with many scopes without errors", async () => {
    const manyScopes = [
      "read:gmail",
      "write:gmail",
      "execute:gmail",
      "read:calendar",
      "write:calendar",
      "execute:calendar",
      "read:slack",
      "write:slack",
      "execute:slack",
      "read:payments",
      "write:payments",
      "execute:payments",
      "read:github",
      "write:github",
      "execute:github",
      "read:jira",
      "write:jira",
      "execute:jira",
      "read:stripe",
      "write:stripe",
      "execute:stripe",
    ];

    const promise = shield.requestConsent({
      agent: "GreedyAgent",
      scopes: manyScopes,
    });

    const grantedScopes = manyScopes.map((s) => {
      const [permissionLevel, service] = s.split(":") as [string, string];
      return { service, permissionLevel: permissionLevel as "read" | "write" | "execute" };
    });

    grantConsent(grantedScopes);

    const decision = await promise;
    expect(decision.grantedScopes).toHaveLength(21);
  });
});

// ---------------------------------------------------------------------------
// logAction
// ---------------------------------------------------------------------------

describe("MulticornShield.logAction", () => {
  let shield: MulticornShield;

  beforeEach(() => {
    shield = new MulticornShield({ apiKey: VALID_KEY });
    mockFetch.mockClear();
  });

  afterEach(() => {
    shield.destroy();
    document.body.innerHTML = "";
  });

  async function grantGmailAccess(s: MulticornShield): Promise<void> {
    const promise = s.requestConsent({ agent: "OpenClaw", scopes: ["read:gmail"] });
    grantConsent([{ service: "gmail", permissionLevel: "read" }]);
    await promise;
  }

  it("submits the log entry when the agent has permission for the service", async () => {
    await grantGmailAccess(shield);

    await shield.logAction({
      agent: "OpenClaw",
      service: "gmail",
      action: "read_message",
      status: "approved",
    });

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });

    // Find the /actions call (grantGmailAccess POSTs to /consent first)
    const actionsCall = mockFetch.mock.calls.find((call) =>
      (call[0] as string).includes("/actions"),
    );
    expect(actionsCall).toBeDefined();
    const [url, init] = actionsCall as [string, RequestInit];
    expect(url).toContain("/actions");
    const body = JSON.parse(init.body as string) as { actionType: string };
    expect(body.actionType).toBe("read_message");
  });

  it("includes optional cost and metadata in the payload", async () => {
    await grantGmailAccess(shield);

    await shield.logAction({
      agent: "OpenClaw",
      service: "gmail",
      action: "send_email",
      status: "approved",
      cost: 0.002,
      metadata: { recipient: "user@example.com" },
    });

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });

    // Find the /actions call (grantGmailAccess POSTs to /consent first)
    const actionsCall = mockFetch.mock.calls.find((call) =>
      (call[0] as string).includes("/actions"),
    );
    expect(actionsCall).toBeDefined();
    const [, init] = actionsCall as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { cost: number; metadata: unknown };
    expect(body.cost).toBe(0.002);
    expect(body.metadata).toEqual({ recipient: "user@example.com" });
  });

  it("throws when the agent has no permission for the requested service", async () => {
    await expect(
      shield.logAction({
        agent: "OpenClaw",
        service: "gmail",
        action: "send_email",
        status: "approved",
      }),
    ).rejects.toThrow("does not have permission");
  });

  it("includes the list of services with access in the error message", async () => {
    await expect(
      shield.logAction({ agent: "OpenClaw", service: "slack", action: "post", status: "blocked" }),
    ).rejects.toThrow("none");
  });

  it("throws when called after destroy", async () => {
    shield.destroy();
    await expect(
      shield.logAction({ agent: "OpenClaw", service: "gmail", action: "read", status: "approved" }),
    ).rejects.toThrow("destroyed");
  });
});

// ---------------------------------------------------------------------------
// revokeScope
// ---------------------------------------------------------------------------

describe("MulticornShield.revokeScope", () => {
  let shield: MulticornShield;

  beforeEach(() => {
    shield = new MulticornShield({ apiKey: VALID_KEY });
    mockFetch.mockClear();
  });

  afterEach(() => {
    shield.destroy();
    document.body.innerHTML = "";
  });

  it("removes a specific granted scope", async () => {
    const options: ConsentOptions = {
      agent: "OpenClaw",
      scopes: ["read:gmail", "write:calendar"],
    };
    const promise = shield.requestConsent(options);
    grantConsent([
      { service: "gmail", permissionLevel: "read" },
      { service: "calendar", permissionLevel: "write" },
    ]);
    await promise;

    expect(shield.getGrantedScopes("OpenClaw")).toHaveLength(2);

    shield.revokeScope("OpenClaw", "write:calendar");

    const remaining = shield.getGrantedScopes("OpenClaw");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toEqual({ service: "gmail", permissionLevel: "read" });
  });

  it("is a no-op for an agent with no grants", () => {
    expect(() => {
      shield.revokeScope("unknown-agent", "read:gmail");
    }).not.toThrow();
  });

  it("is a no-op when the specific scope was not granted", async () => {
    const promise = shield.requestConsent({ agent: "OpenClaw", scopes: ["read:gmail"] });
    grantConsent([{ service: "gmail", permissionLevel: "read" }]);
    await promise;

    shield.revokeScope("OpenClaw", "write:gmail");
    expect(shield.getGrantedScopes("OpenClaw")).toHaveLength(1);
  });

  it("throws ScopeParseError when the scope string has multiple colons", () => {
    expect(() => {
      shield.revokeScope("OpenClaw", "read:gm:ail");
    }).toThrow();
  });

  it("throws ScopeParseError when the scope string has an unknown permission level", () => {
    expect(() => {
      shield.revokeScope("OpenClaw", "delete:gmail");
    }).toThrow();
  });

  it("blocks subsequent logAction calls after the scope is revoked", async () => {
    const promise = shield.requestConsent({ agent: "OpenClaw", scopes: ["write:calendar"] });
    grantConsent([{ service: "calendar", permissionLevel: "write" }]);
    await promise;

    shield.revokeScope("OpenClaw", "write:calendar");

    await expect(
      shield.logAction({
        agent: "OpenClaw",
        service: "calendar",
        action: "create_event",
        status: "blocked",
      }),
    ).rejects.toThrow("does not have permission");
  });

  it("throws when called after destroy", () => {
    shield.destroy();
    expect(() => {
      shield.revokeScope("OpenClaw", "read:gmail");
    }).toThrow("destroyed");
  });

  // Scope revocation race conditions
  it("blocks action immediately after revoking a scope mid-session", async () => {
    const promise = shield.requestConsent({
      agent: "OpenClaw",
      scopes: ["read:gmail", "write:gmail", "write:calendar"],
    });
    grantConsent([
      { service: "gmail", permissionLevel: "read" },
      { service: "gmail", permissionLevel: "write" },
      { service: "calendar", permissionLevel: "write" },
    ]);
    await promise;

    // Revoke write:gmail while other scopes remain
    shield.revokeScope("OpenClaw", "write:gmail");

    // read:gmail should still work
    await expect(
      shield.logAction({
        agent: "OpenClaw",
        service: "gmail",
        action: "read_message",
        status: "approved",
      }),
    ).resolves.toBeUndefined();

    // calendar should still work
    await expect(
      shield.logAction({
        agent: "OpenClaw",
        service: "calendar",
        action: "create_event",
        status: "approved",
      }),
    ).resolves.toBeUndefined();
  });

  it("revokes all scopes for a service when each is revoked individually", async () => {
    const promise = shield.requestConsent({
      agent: "OpenClaw",
      scopes: ["read:gmail", "write:gmail"],
    });
    grantConsent([
      { service: "gmail", permissionLevel: "read" },
      { service: "gmail", permissionLevel: "write" },
    ]);
    await promise;

    shield.revokeScope("OpenClaw", "read:gmail");
    shield.revokeScope("OpenClaw", "write:gmail");

    await expect(
      shield.logAction({
        agent: "OpenClaw",
        service: "gmail",
        action: "read_message",
        status: "approved",
      }),
    ).rejects.toThrow("does not have permission");
  });

  it("handles revoking the same scope twice without error", async () => {
    const promise = shield.requestConsent({
      agent: "OpenClaw",
      scopes: ["read:gmail"],
    });
    grantConsent([{ service: "gmail", permissionLevel: "read" }]);
    await promise;

    shield.revokeScope("OpenClaw", "read:gmail");
    // Second revoke should be a no-op, not throw
    expect(() => {
      shield.revokeScope("OpenClaw", "read:gmail");
    }).not.toThrow();

    expect(shield.getGrantedScopes("OpenClaw")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getGrantedScopes
// ---------------------------------------------------------------------------

describe("MulticornShield.getGrantedScopes", () => {
  let shield: MulticornShield;

  beforeEach(() => {
    shield = new MulticornShield({ apiKey: VALID_KEY });
  });

  afterEach(() => {
    shield.destroy();
    document.body.innerHTML = "";
  });

  it("returns an empty array for an agent with no grants", () => {
    expect(shield.getGrantedScopes("unknown-agent")).toEqual([]);
  });

  it("returns the granted scopes after consent is approved", async () => {
    const promise = shield.requestConsent({ agent: "OpenClaw", scopes: ["read:gmail"] });
    grantConsent([{ service: "gmail", permissionLevel: "read" }]);
    await promise;

    const scopes = shield.getGrantedScopes("OpenClaw");
    expect(scopes).toHaveLength(1);
    expect(scopes[0]).toEqual({ service: "gmail", permissionLevel: "read" });
  });

  it("returns an empty array after consent is denied", async () => {
    const promise = shield.requestConsent({ agent: "OpenClaw", scopes: ["read:gmail"] });
    denyConsent();
    await promise;

    expect(shield.getGrantedScopes("OpenClaw")).toEqual([]);
  });

  it("reflects scope changes after revokeScope", async () => {
    const promise = shield.requestConsent({
      agent: "OpenClaw",
      scopes: ["read:gmail", "write:calendar"],
    });
    grantConsent([
      { service: "gmail", permissionLevel: "read" },
      { service: "calendar", permissionLevel: "write" },
    ]);
    await promise;

    shield.revokeScope("OpenClaw", "write:calendar");
    expect(shield.getGrantedScopes("OpenClaw")).toHaveLength(1);
  });

  it("throws when called after destroy", () => {
    shield.destroy();
    expect(() => shield.getGrantedScopes("OpenClaw")).toThrow("destroyed");
  });
});

// ---------------------------------------------------------------------------
// checkSpending
// ---------------------------------------------------------------------------

describe("MulticornShield.checkSpending", () => {
  let shield: MulticornShield;

  beforeEach(() => {
    shield = new MulticornShield({ apiKey: VALID_KEY });
  });

  afterEach(() => {
    shield.destroy();
    document.body.innerHTML = "";
  });

  it("allows all amounts when no spending limit is configured for the agent", () => {
    expect(shield.checkSpending("OpenClaw", 999_999).allowed).toBe(true);
  });

  it("returns MAX_SAFE_INTEGER as remaining budget when no limit is configured", () => {
    const result = shield.checkSpending("OpenClaw", 0);
    expect(result.remainingBudget.transaction).toBe(Number.MAX_SAFE_INTEGER);
    expect(result.remainingBudget.daily).toBe(Number.MAX_SAFE_INTEGER);
    expect(result.remainingBudget.monthly).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("allows amounts within the per-transaction spending limit", async () => {
    const promise = shield.requestConsent({
      agent: "OpenClaw",
      scopes: ["read:gmail"],
      spendLimit: 100,
    });
    grantConsent([{ service: "gmail", permissionLevel: "read" }], 100);
    await promise;

    expect(shield.checkSpending("OpenClaw", 50).allowed).toBe(true);
    expect(shield.checkSpending("OpenClaw", 100).allowed).toBe(true);
  });

  it("blocks amounts that exceed the per-transaction spending limit", async () => {
    const promise = shield.requestConsent({
      agent: "OpenClaw",
      scopes: ["read:gmail"],
      spendLimit: 100,
    });
    grantConsent([{ service: "gmail", permissionLevel: "read" }], 100);
    await promise;

    const result = shield.checkSpending("OpenClaw", 101);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain("exceeds");
  });

  it("throws when called after destroy", () => {
    shield.destroy();
    expect(() => shield.checkSpending("OpenClaw", 50)).toThrow("destroyed");
  });

  // Spending limit boundary values
  it("allows spend at exactly the per-transaction limit", async () => {
    const promise = shield.requestConsent({
      agent: "OpenClaw",
      scopes: ["read:gmail"],
      spendLimit: 50,
    });
    grantConsent([{ service: "gmail", permissionLevel: "read" }], 50);
    await promise;

    const result = shield.checkSpending("OpenClaw", 50);
    expect(result.allowed).toBe(true);
  });

  it("blocks spend one cent over the per-transaction limit", async () => {
    const promise = shield.requestConsent({
      agent: "OpenClaw",
      scopes: ["read:gmail"],
      spendLimit: 50,
    });
    grantConsent([{ service: "gmail", permissionLevel: "read" }], 50);
    await promise;

    const result = shield.checkSpending("OpenClaw", 50.01);
    expect(result.allowed).toBe(false);
  });

  it("allows zero amount spend", async () => {
    const promise = shield.requestConsent({
      agent: "OpenClaw",
      scopes: ["read:gmail"],
      spendLimit: 50,
    });
    grantConsent([{ service: "gmail", permissionLevel: "read" }], 50);
    await promise;

    const result = shield.checkSpending("OpenClaw", 0);
    expect(result.allowed).toBe(true);
  });

  it("blocks negative amount spend", async () => {
    const promise = shield.requestConsent({
      agent: "OpenClaw",
      scopes: ["read:gmail"],
      spendLimit: 50,
    });
    grantConsent([{ service: "gmail", permissionLevel: "read" }], 50);
    await promise;

    expect(() => shield.checkSpending("OpenClaw", -1)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// destroy
// ---------------------------------------------------------------------------

describe("MulticornShield.destroy", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    mockFetch.mockClear();
  });

  it("removes an open consent screen from the DOM", () => {
    const shield = new MulticornShield({ apiKey: VALID_KEY });
    void shield.requestConsent({ agent: "OpenClaw", scopes: ["read:gmail"] });
    expect(document.querySelector("multicorn-consent")).not.toBeNull();

    shield.destroy();
    expect(document.querySelector("multicorn-consent")).toBeNull();
  });

  it("is safe to call multiple times", () => {
    const shield = new MulticornShield({ apiKey: VALID_KEY });
    expect(() => {
      shield.destroy();
      shield.destroy();
      shield.destroy();
    }).not.toThrow();
  });

  it("causes requestConsent to throw after being called", async () => {
    const shield = new MulticornShield({ apiKey: VALID_KEY });
    shield.destroy();
    await expect(
      shield.requestConsent({ agent: "OpenClaw", scopes: ["read:gmail"] }),
    ).rejects.toThrow("destroyed");
  });

  it("causes logAction to throw after being called", async () => {
    const shield = new MulticornShield({ apiKey: VALID_KEY });
    shield.destroy();
    await expect(
      shield.logAction({ agent: "OpenClaw", service: "gmail", action: "read", status: "approved" }),
    ).rejects.toThrow("destroyed");
  });

  it("causes revokeScope to throw after being called", () => {
    const shield = new MulticornShield({ apiKey: VALID_KEY });
    shield.destroy();
    expect(() => {
      shield.revokeScope("OpenClaw", "read:gmail");
    }).toThrow("destroyed");
  });

  it("causes getGrantedScopes to throw after being called", () => {
    const shield = new MulticornShield({ apiKey: VALID_KEY });
    shield.destroy();
    expect(() => shield.getGrantedScopes("OpenClaw")).toThrow("destroyed");
  });

  it("causes checkSpending to throw after being called", () => {
    const shield = new MulticornShield({ apiKey: VALID_KEY });
    shield.destroy();
    expect(() => shield.checkSpending("OpenClaw", 50)).toThrow("destroyed");
  });

  it("flushes pending batched actions on destroy", async () => {
    const shield = new MulticornShield({
      apiKey: VALID_KEY,
      batchMode: { enabled: true, maxSize: 100, flushIntervalMs: 60000 },
    });

    const consentPromise = shield.requestConsent({
      agent: "BatchAgent",
      scopes: ["read:gmail"],
    });
    grantConsent([{ service: "gmail", permissionLevel: "read" }]);
    await consentPromise;

    // Queue several actions (they won't flush immediately due to large maxSize)
    await shield.logAction({
      agent: "BatchAgent",
      service: "gmail",
      action: "read_inbox",
      status: "approved",
    });
    await shield.logAction({
      agent: "BatchAgent",
      service: "gmail",
      action: "read_drafts",
      status: "approved",
    });

    // Destroy should trigger a flush of pending batched actions
    shield.destroy();

    // Give time for the async shutdown flush
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify fetch was called (logger shutdown triggers flush)
    expect(mockFetch).toHaveBeenCalled();
  });

  it("cleans up consent container and marks instance destroyed simultaneously", () => {
    const shield = new MulticornShield({ apiKey: VALID_KEY });
    void shield.requestConsent({ agent: "OpenClaw", scopes: ["read:gmail"] });

    expect(document.querySelector("multicorn-consent")).not.toBeNull();

    shield.destroy();

    expect(document.querySelector("multicorn-consent")).toBeNull();
    expect(() => shield.getGrantedScopes("OpenClaw")).toThrow("destroyed");
  });
});

// ---------------------------------------------------------------------------
// Full lifecycle: construct → consent → log → revoke → blocked → destroy
// ---------------------------------------------------------------------------

describe("MulticornShield full lifecycle", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    mockFetch.mockClear();
  });

  it("construct → consent → log → revoke → blocked action → destroy", async () => {
    const shield = new MulticornShield({ apiKey: VALID_KEY });

    const consentPromise = shield.requestConsent({
      agent: "OpenClaw",
      scopes: ["read:gmail", "write:calendar"],
      spendLimit: 200,
    });

    grantConsent(
      [
        { service: "gmail", permissionLevel: "read" },
        { service: "calendar", permissionLevel: "write" },
      ],
      200,
    );

    const decision = await consentPromise;
    expect(decision.grantedScopes).toHaveLength(2);
    expect(document.querySelector("multicorn-consent")).toBeNull();

    await shield.logAction({
      agent: "OpenClaw",
      service: "gmail",
      action: "read_inbox",
      status: "approved",
    });
    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });

    shield.revokeScope("OpenClaw", "write:calendar");
    expect(shield.getGrantedScopes("OpenClaw")).toHaveLength(1);

    await expect(
      shield.logAction({
        agent: "OpenClaw",
        service: "calendar",
        action: "create_event",
        status: "blocked",
      }),
    ).rejects.toThrow("does not have permission");

    const spendCheck = shield.checkSpending("OpenClaw", 150);
    expect(spendCheck.allowed).toBe(true);

    const blockedSpend = shield.checkSpending("OpenClaw", 250);
    expect(blockedSpend.allowed).toBe(false);

    shield.destroy();

    expect(() => shield.getGrantedScopes("OpenClaw")).toThrow("destroyed");
  });
});
