/**
 * Human-readable labels and icons for permission scopes.
 *
 * Translates technical scope identifiers (e.g., `read:gmail`) into
 * user-friendly descriptions (e.g., "Read your Gmail messages").
 *
 * @module consent/scope-labels
 */

import type { PermissionLevel, Scope } from "../types/index.js";
import { PERMISSION_LEVELS } from "../types/index.js";

/**
 * Display name mapping for built-in services.
 *
 * Maps service identifiers to their human-readable names.
 */
const SERVICE_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  gmail: "Gmail",
  calendar: "Google Calendar",
  slack: "Slack",
  drive: "Google Drive",
  payments: "Payments",
  github: "GitHub",
  jira: "Jira",
  web: "Web",
  public_content: "Public Content",
} as const;

/**
 * Icon mapping for services (using Unicode emojis for simplicity).
 *
 * These icons are displayed next to service names in the consent screen.
 */
const SERVICE_ICONS: Readonly<Record<string, string>> = {
  gmail: "📧",
  calendar: "📅",
  slack: "💬",
  drive: "📁",
  payments: "💳",
  github: "🐙",
  jira: "🎯",
  web: "🌐",
  public_content: "📢",
} as const;

/**
 * Human-readable descriptions for permission levels.
 *
 * These are combined with service names to create full scope descriptions.
 */
const PERMISSION_DESCRIPTIONS: Readonly<Record<PermissionLevel, string>> = {
  [PERMISSION_LEVELS.Read]: "Read",
  [PERMISSION_LEVELS.Write]: "Create and modify",
  [PERMISSION_LEVELS.Execute]: "Execute actions",
  [PERMISSION_LEVELS.Publish]: "Publish",
  [PERMISSION_LEVELS.Create]: "Create",
} as const;

/**
 * Full descriptions for permission levels when combined with a service.
 *
 * These provide context-specific descriptions that make sense with service names.
 */
const PERMISSION_FULL_DESCRIPTIONS: Readonly<
  Record<PermissionLevel, (serviceName: string, rawServiceName: string) => string>
> = {
  [PERMISSION_LEVELS.Read]: (serviceName: string) => `Read your ${serviceName}`,
  [PERMISSION_LEVELS.Write]: (serviceName: string) => `Create and modify ${serviceName} content`,
  [PERMISSION_LEVELS.Execute]: (serviceName: string) => {
    // Special handling for payments (most critical execute permission)
    if (serviceName.toLowerCase().includes("payment")) {
      return "Make purchases on your behalf";
    }
    return `Execute actions in ${serviceName}`;
  },
  [PERMISSION_LEVELS.Publish]: (serviceName: string, rawServiceName: string) => {
    if (rawServiceName.toLowerCase() === "web") {
      return "Publish content to the open internet";
    }
    return `Publish ${serviceName} content`;
  },
  [PERMISSION_LEVELS.Create]: (serviceName: string, rawServiceName: string) => {
    if (rawServiceName.toLowerCase() === "public_content") {
      return "Create content that is immediately public";
    }
    return `Create ${serviceName}`;
  },
} as const;

/**
 * Get the human-readable display name for a service.
 *
 * @param serviceName - The service identifier (e.g., `"gmail"`).
 * @returns The display name (e.g., `"Gmail"`), or a capitalized version if unknown.
 *
 * @example
 * ```ts
 * getServiceDisplayName("gmail"); // "Gmail"
 * getServiceDisplayName("custom-service"); // "Custom-service"
 * ```
 */
export function getServiceDisplayName(serviceName: string): string {
  return SERVICE_DISPLAY_NAMES[serviceName] ?? capitalizeServiceName(serviceName);
}

/**
 * Get the icon for a service.
 *
 * @param serviceName - The service identifier.
 * @returns The icon (emoji), or a default icon if unknown.
 *
 * @example
 * ```ts
 * getServiceIcon("gmail"); // "📧"
 * getServiceIcon("unknown"); // "🔌"
 * ```
 */
export function getServiceIcon(serviceName: string): string {
  return SERVICE_ICONS[serviceName] ?? "🔌";
}

/**
 * Get a human-readable label for a permission level.
 *
 * @param permissionLevel - The permission level (read, write, execute, publish, or create).
 * @returns A short label (e.g., `"Read"`, `"Create and modify"`).
 *
 * @example
 * ```ts
 * getPermissionLabel("read"); // "Read"
 * getPermissionLabel("execute"); // "Execute actions"
 * ```
 */
export function getPermissionLabel(permissionLevel: PermissionLevel): string {
  return PERMISSION_DESCRIPTIONS[permissionLevel];
}

/**
 * Get a full human-readable description for a scope.
 *
 * Combines the service name and permission level into a user-friendly
 * description like "Read your Gmail messages" or "Make purchases on your behalf".
 *
 * @param scope - The scope to describe.
 * @returns A human-readable description.
 *
 * @example
 * ```ts
 * getScopeLabel({ service: "gmail", permissionLevel: "read" });
 * // "Read your Gmail"
 *
 * getScopeLabel({ service: "payments", permissionLevel: "execute" });
 * // "Make purchases on your behalf"
 * ```
 */
export function getScopeLabel(scope: Scope): string {
  const serviceDisplayName = getServiceDisplayName(scope.service);
  const descriptionFn = PERMISSION_FULL_DESCRIPTIONS[scope.permissionLevel];
  return descriptionFn(serviceDisplayName, scope.service);
}

/**
 * Get a short label for a scope (service name + permission level).
 *
 * Useful for compact displays or ARIA labels.
 *
 * @param scope - The scope to label.
 * @returns A short label (e.g., `"Gmail: Read"`).
 *
 * @example
 * ```ts
 * getScopeShortLabel({ service: "gmail", permissionLevel: "read" });
 * // "Gmail: Read"
 * ```
 */
export function getScopeShortLabel(scope: Scope): string {
  const serviceDisplayName = getServiceDisplayName(scope.service);
  const permissionLabel = getPermissionLabel(scope.permissionLevel);
  return `${serviceDisplayName}: ${permissionLabel}`;
}

/**
 * Capitalize a service name for fallback display.
 *
 * Converts `"my-service"` to `"My-service"` and `"my_service"` to `"My_service"`.
 *
 * @param serviceName - The service identifier.
 * @returns A capitalized version.
 */
function capitalizeServiceName(serviceName: string): string {
  if (serviceName.length === 0) {
    return serviceName;
  }
  return serviceName.charAt(0).toUpperCase() + serviceName.slice(1);
}
