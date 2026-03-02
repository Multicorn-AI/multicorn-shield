import { describe, it, expect, vi, afterEach } from "vitest";
import { deriveDashboardUrl, buildConsentUrl } from "../consent.js";

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
});
