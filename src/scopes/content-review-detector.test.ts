import { describe, it, expect } from "vitest";
import { requiresContentReview, isPublicContentAction } from "./content-review-detector.js";

describe("requiresContentReview", () => {
  it("is true for publish:web", () => {
    expect(requiresContentReview({ service: "web", permissionLevel: "publish" })).toBe(true);
  });

  it("is true for create:public_content", () => {
    expect(requiresContentReview({ service: "public_content", permissionLevel: "create" })).toBe(
      true,
    );
  });

  it("is false for unrelated scopes", () => {
    expect(requiresContentReview({ service: "gmail", permissionLevel: "execute" })).toBe(false);
  });
});

describe("isPublicContentAction", () => {
  it("is true when service is web or public_content", () => {
    expect(isPublicContentAction("anything", "web")).toBe(true);
    expect(isPublicContentAction("x", "Public_Content")).toBe(true);
  });

  it("detects indicators in tool name when service is not special", () => {
    expect(isPublicContentAction("deploy_site", "infra")).toBe(true);
    expect(isPublicContentAction("postToTwitter", "social")).toBe(true);
  });

  it("is false when no indicator matches", () => {
    expect(isPublicContentAction("read_inbox", "gmail")).toBe(false);
  });
});
