import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

const fetchGrantedScopesMock = vi.hoisted(() => vi.fn());

vi.mock("../shield-client.js", () => ({
  fetchGrantedScopes: fetchGrantedScopesMock,
}));

import { deriveDashboardUrl, buildConsentUrl, waitForConsent } from "../consent.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deriveDashboardUrl", () => {
  it("converts localhost:8080 to localhost:5173", () => {
    expect(deriveDashboardUrl("http://localhost:8080")).toBe("http://localhost:5173/");
  });

  it("converts 127.0.0.1 to port 5173", () => {
    expect(deriveDashboardUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:5173/");
  });

  it("converts api.multicorn.ai to app.multicorn.ai", () => {
    expect(deriveDashboardUrl("https://api.multicorn.ai")).toBe("https://app.multicorn.ai/");
  });

  it("replaces 'api' with 'app' in other hostnames", () => {
    expect(deriveDashboardUrl("https://api.staging.multicorn.ai")).toBe(
      "https://app.staging.multicorn.ai/",
    );
  });

  it("falls back to production dashboard for unrecognised URLs", () => {
    expect(deriveDashboardUrl("https://custom.example.com")).toBe("https://app.multicorn.ai");
  });

  it("falls back to production dashboard for invalid URLs", () => {
    expect(deriveDashboardUrl("not-a-url")).toBe("https://app.multicorn.ai");
  });

  it("handles 127.0.0.1 with different ports", () => {
    expect(deriveDashboardUrl("http://127.0.0.1:3000")).toBe("http://127.0.0.1:5173/");
  });

  it("adds http when localhost has no protocol", () => {
    expect(deriveDashboardUrl("localhost:8080")).toBe("http://localhost:5173/");
  });

  it("adds http when 127.0.0.1 has no protocol", () => {
    expect(deriveDashboardUrl("127.0.0.1:9000")).toBe("http://127.0.0.1:5173/");
  });
});

describe("buildConsentUrl", () => {
  it("builds the consent URL with the agent name", () => {
    const url = buildConsentUrl("openclaw", "https://app.multicorn.ai");
    expect(url).toBe("https://app.multicorn.ai/consent?agent=openclaw");
  });

  it("URL-encodes special characters in the agent name", () => {
    const url = buildConsentUrl("my agent & co", "https://app.multicorn.ai");
    expect(url).toContain("agent=my+agent+%26+co");
  });

  it("includes scope parameter when provided", () => {
    const url = buildConsentUrl("openclaw", "https://app.multicorn.ai", {
      service: "terminal",
      permissionLevel: "execute",
    });
    expect(url).toBe("https://app.multicorn.ai/consent?agent=openclaw&scopes=terminal%3Aexecute");
  });

  it("includes scope parameter for filesystem service", () => {
    const url = buildConsentUrl("main", "https://app.multicorn.ai", {
      service: "filesystem",
      permissionLevel: "read",
    });
    expect(url).toBe("https://app.multicorn.ai/consent?agent=main&scopes=filesystem%3Aread");
  });

  it("builds URL without scope when scope is undefined", () => {
    const url = buildConsentUrl("openclaw", "https://app.multicorn.ai", undefined);
    expect(url).toBe("https://app.multicorn.ai/consent?agent=openclaw");
  });
});

describe("waitForConsent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchGrantedScopesMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns scopes when the API reports permissions after polling", async () => {
    fetchGrantedScopesMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ service: "gmail", permissionLevel: "read" }]);

    const pending = waitForConsent("agent-id", "OpenClaw", "api-key", "https://api.multicorn.ai", {
      service: "terminal",
      permissionLevel: "execute",
    });

    await vi.advanceTimersByTimeAsync(10_000);
    const scopes = await pending;
    expect(scopes).toHaveLength(1);
    expect(scopes[0]?.service).toBe("gmail");
  });

  it("throws when consent times out", async () => {
    fetchGrantedScopesMock.mockResolvedValue([]);

    const pending = waitForConsent("agent-id", "OpenClaw", "api-key", "https://api.multicorn.ai");
    const assertion = expect(pending).rejects.toThrow(/Consent not granted/);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 5_000);
    await assertion;
  });
});
