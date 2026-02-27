/**
 * Unit tests for scope metadata utilities.
 *
 * @module scopes/scope-metadata.test
 */

import { describe, it, expect } from "vitest";
import {
  getScopeMetadata,
  isHighRiskScope,
  requiresExplicitOptIn,
  getScopeWarning,
} from "./scope-metadata.js";

describe("scope-metadata", () => {
  describe("getScopeMetadata", () => {
    it("returns metadata for publish:web scope", () => {
      const metadata = getScopeMetadata("publish:web");
      expect(metadata).toBeDefined();
      expect(metadata?.riskLevel).toBe("high");
      expect(metadata?.requiresExplicitOptIn).toBe(true);
      expect(metadata?.warningMessage).toBe(
        "This agent is requesting permission to publish content publicly on the internet",
      );
    });

    it("returns metadata for create:public_content scope", () => {
      const metadata = getScopeMetadata("create:public_content");
      expect(metadata).toBeDefined();
      expect(metadata?.riskLevel).toBe("high");
      expect(metadata?.requiresExplicitOptIn).toBe(true);
      expect(metadata?.warningMessage).toBe(
        "This agent is requesting permission to publish content publicly on the internet",
      );
    });

    it("returns undefined for unknown scopes", () => {
      expect(getScopeMetadata("read:gmail")).toBeUndefined();
      expect(getScopeMetadata("write:calendar")).toBeUndefined();
      expect(getScopeMetadata("execute:payments")).toBeUndefined();
      expect(getScopeMetadata("unknown:scope")).toBeUndefined();
    });
  });

  describe("isHighRiskScope", () => {
    it("returns true for high-risk scopes", () => {
      expect(isHighRiskScope("publish:web")).toBe(true);
      expect(isHighRiskScope("create:public_content")).toBe(true);
    });

    it("returns false for standard scopes", () => {
      expect(isHighRiskScope("read:gmail")).toBe(false);
      expect(isHighRiskScope("write:calendar")).toBe(false);
      expect(isHighRiskScope("execute:payments")).toBe(false);
      expect(isHighRiskScope("unknown:scope")).toBe(false);
    });
  });

  describe("requiresExplicitOptIn", () => {
    it("returns true for scopes that require explicit opt-in", () => {
      expect(requiresExplicitOptIn("publish:web")).toBe(true);
      expect(requiresExplicitOptIn("create:public_content")).toBe(true);
    });

    it("returns false for scopes that do not require explicit opt-in", () => {
      expect(requiresExplicitOptIn("read:gmail")).toBe(false);
      expect(requiresExplicitOptIn("write:calendar")).toBe(false);
      expect(requiresExplicitOptIn("execute:payments")).toBe(false);
      expect(requiresExplicitOptIn("unknown:scope")).toBe(false);
    });
  });

  describe("getScopeWarning", () => {
    it("returns warning message for high-risk scopes", () => {
      expect(getScopeWarning("publish:web")).toBe(
        "This agent is requesting permission to publish content publicly on the internet",
      );
      expect(getScopeWarning("create:public_content")).toBe(
        "This agent is requesting permission to publish content publicly on the internet",
      );
    });

    it("returns undefined for scopes without warnings", () => {
      expect(getScopeWarning("read:gmail")).toBeUndefined();
      expect(getScopeWarning("write:calendar")).toBeUndefined();
      expect(getScopeWarning("execute:payments")).toBeUndefined();
      expect(getScopeWarning("unknown:scope")).toBeUndefined();
    });
  });
});
