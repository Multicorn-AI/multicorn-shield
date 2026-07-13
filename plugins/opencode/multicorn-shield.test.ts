import { describe, expect, it } from "vitest";

import {
  buildOpenCodeParametersMetadata,
  buildOpenCodeResultMetadata,
} from "./multicorn-shield.js";

describe("OpenCode audit metadata", () => {
  it("does not persist gmail_send_email recipient, subject or body in parameters", () => {
    const metadata = buildOpenCodeParametersMetadata({
      to: "alice@example.com",
      subject: "Project update",
      body: "Here are the confidential numbers for Q3.",
    });

    expect(metadata).not.toContain("alice@example.com");
    expect(metadata).not.toContain("Project update");
    expect(metadata).not.toContain("confidential numbers");
    expect(metadata).toContain("[REDACTED]");
  });

  it("does not persist gmail result text with addresses or subjects", () => {
    const metadata = buildOpenCodeResultMetadata(
      "Email sent to alice@example.com with subject 'Project update'.",
    );

    expect(metadata).not.toContain("alice@example.com");
    expect(metadata).not.toContain("Project update");
    expect(metadata).toContain("[REDACTED]");
  });
});
