/**
 * Detects if a scope requires content review before execution.
 *
 * Public content scopes that require review:
 * - `publish:web` - publishing content to the web
 * - `create:public_content` - creating public-facing content
 *
 * @module scopes/content-review-detector
 */

import type { Scope } from "../types/index.js";

/**
 * Check if a scope requires content review.
 *
 * @param scope - The scope to check
 * @returns `true` if the scope requires content review
 *
 * @example
 * ```ts
 * requiresContentReview({ service: "web", permissionLevel: "publish" }); // true
 * requiresContentReview({ service: "public_content", permissionLevel: "create" }); // true
 * requiresContentReview({ service: "gmail", permissionLevel: "execute" }); // false
 * ```
 */
export function requiresContentReview(scope: Scope): boolean {
  // Check for publish:web scope
  if (scope.service === "web" && scope.permissionLevel === "publish") {
    return true;
  }

  // Check for create:public_content scope
  if (scope.service === "public_content" && scope.permissionLevel === "create") {
    return true;
  }

  return false;
}

/**
 * Check if a tool name/action indicates public content creation.
 *
 * This is a helper for cases where the service might not be explicitly
 * "web" or "public_content" but the action name indicates public content.
 *
 * @param toolName - The tool name to check
 * @param service - The service name
 * @returns `true` if the tool/action indicates public content
 */
export function isPublicContentAction(toolName: string, service: string): boolean {
  const lowerToolName = toolName.toLowerCase();
  const lowerService = service.toLowerCase();

  // Explicit publish:web or create:public_content services
  if (lowerService === "web" || lowerService === "public_content") {
    return true;
  }

  // Check for public content indicators in tool name
  const publicContentIndicators = [
    "publish",
    "public",
    "web",
    "blog",
    "post",
    "article",
    "social",
    "twitter",
    "facebook",
    "linkedin",
    "github_pages",
    "deploy",
  ];

  return publicContentIndicators.some((indicator) => lowerToolName.includes(indicator));
}
