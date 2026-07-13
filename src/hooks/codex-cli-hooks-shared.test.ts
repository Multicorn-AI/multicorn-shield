import { describe, expect, it } from "vitest";
import {
  redactSecretsForAudit,
  redactGoogleUserDataInText,
  redactGoogleUserDataValue,
  serializeHookAuditFragment,
  truncateForAudit,
} from "./codex-cli-hooks-shared.js";

describe("codex-cli-hooks-shared", () => {
  it("truncateForAudit appends marker when over limit", () => {
    const long = "z".repeat(10_001);
    const out = truncateForAudit(long, 10_000);
    expect(out.endsWith("[truncated]")).toBe(true);
    expect(out.length).toBe(10_000 + "[truncated]".length);
  });

  it("serializeHookAuditFragment redacts then truncates", () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789abcd";
    const payload = { cmd: `run ${secret}` };
    const out = serializeHookAuditFragment(payload);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain(secret.slice(0, 10));
  });

  it("redactSecretsForAudit masks token= query pairs", () => {
    expect(redactSecretsForAudit("foo token=abc123secret bar")).toContain("token=[REDACTED]");
  });

  it("redactGoogleUserDataValue redacts gmail send fields", () => {
    const out = redactGoogleUserDataValue({
      to: "user@example.com",
      subject: "Quarterly report",
      body: "Please review the attached figures.",
      query: "from:boss",
    }) as Record<string, unknown>;

    expect(out["to"]).toBe("[REDACTED]");
    expect(out["subject"]).toBe("[REDACTED]");
    expect(out["body"]).toBe("[REDACTED]");
    expect(out["query"]).toBe("[REDACTED]");
  });

  it("serializeHookAuditFragment redacts gmail send arguments", () => {
    const out = serializeHookAuditFragment({
      to: "user@example.com",
      subject: "Quarterly report",
      body: "Please review the attached figures.",
    });

    expect(out).not.toContain("user@example.com");
    expect(out).not.toContain("Quarterly report");
    expect(out).not.toContain("attached figures");
    expect(out).toContain("[REDACTED]");
  });

  it("redactGoogleUserDataInText redacts email addresses in tool output", () => {
    const out = redactGoogleUserDataInText("Email sent to user@example.com with subject 'Hello'");
    expect(out).not.toContain("user@example.com");
    expect(out).toContain("[REDACTED]");
  });
});
