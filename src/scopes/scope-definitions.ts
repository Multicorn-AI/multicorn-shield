/**
 * Scope definitions for built-in and custom service integrations.
 *
 * Provides a type-safe registry of service definitions that describe which
 * permission levels (read / write / execute) each service supports. Built-in
 * services are pre-defined; developers can register custom services at runtime.
 *
 * @module scopes/scope-definitions
 */

import {
  type PermissionLevel,
  type Scope,
  PERMISSION_LEVELS,
} from "../types/index.js";

// ---------------------------------------------------------------------------
// Service definition types
// ---------------------------------------------------------------------------

/**
 * Describes a service integration and its supported permission capabilities.
 *
 * @example
 * ```ts
 * const myService: ServiceDefinition = {
 *   name: "analytics",
 *   description: "Internal analytics platform — dashboards and reports",
 *   capabilities: ["read", "write"],
 * };
 * ```
 */
export interface ServiceDefinition {
  /** Unique, lowercase identifier for the service (e.g. `"gmail"`). */
  readonly name: string;
  /** Human-readable description shown on consent screens and documentation. */
  readonly description: string;
  /** Permission levels the service supports. Must be a non-empty subset of {@link PermissionLevel}. */
  readonly capabilities: readonly PermissionLevel[];
}

// ---------------------------------------------------------------------------
// Built-in service definitions
// ---------------------------------------------------------------------------

/**
 * Pre-defined service integrations shipped with the Multicorn Shield SDK.
 *
 * Each service declares the permission levels it supports. For example,
 * `payments` supports `read` and `execute` but **not** `write` because
 * payment data is immutable — you can view transactions or initiate new
 * ones, but not edit past records.
 *
 * @example
 * ```ts
 * import { BUILT_IN_SERVICES } from "multicorn-shield";
 *
 * // Narrow literal type preserved:
 * const gmailCaps = BUILT_IN_SERVICES.gmail.capabilities;
 * //    ^? readonly ["read", "write", "execute"]
 * ```
 */
export const BUILT_IN_SERVICES = {
  gmail: {
    name: "gmail",
    description: "Google Gmail — email reading, composing, and sending",
    capabilities: [
      PERMISSION_LEVELS.Read,
      PERMISSION_LEVELS.Write,
      PERMISSION_LEVELS.Execute,
    ],
  },
  calendar: {
    name: "calendar",
    description:
      "Google Calendar — event viewing, creation, and management",
    capabilities: [
      PERMISSION_LEVELS.Read,
      PERMISSION_LEVELS.Write,
      PERMISSION_LEVELS.Execute,
    ],
  },
  slack: {
    name: "slack",
    description:
      "Slack — message reading, posting, and workflow triggers",
    capabilities: [
      PERMISSION_LEVELS.Read,
      PERMISSION_LEVELS.Write,
      PERMISSION_LEVELS.Execute,
    ],
  },
  drive: {
    name: "drive",
    description:
      "Google Drive — file browsing, uploading, and sharing",
    capabilities: [PERMISSION_LEVELS.Read, PERMISSION_LEVELS.Write],
  },
  payments: {
    name: "payments",
    description:
      "Payment processing — balance enquiries and transaction execution",
    capabilities: [PERMISSION_LEVELS.Read, PERMISSION_LEVELS.Execute],
  },
  github: {
    name: "github",
    description:
      "GitHub — repository access, issues, and pull requests",
    capabilities: [
      PERMISSION_LEVELS.Read,
      PERMISSION_LEVELS.Write,
      PERMISSION_LEVELS.Execute,
    ],
  },
  jira: {
    name: "jira",
    description:
      "Jira — issue tracking, sprint management, and reporting",
    capabilities: [PERMISSION_LEVELS.Read, PERMISSION_LEVELS.Write],
  },
} as const satisfies Record<string, ServiceDefinition>;

/**
 * Union of all built-in service name literals.
 *
 * @example
 * ```ts
 * const svc: BuiltInServiceName = "gmail"; // ✓
 * const bad: BuiltInServiceName = "foo";   // ✗ compile error
 * ```
 */
export type BuiltInServiceName = keyof typeof BUILT_IN_SERVICES;

// ---------------------------------------------------------------------------
// Scope registry
// ---------------------------------------------------------------------------

/**
 * Pattern that valid service names must match.
 *
 * Rules:
 * - Starts with a lowercase ASCII letter
 * - Followed by zero or more lowercase letters, digits, hyphens, or underscores
 *
 * @example
 * ```ts
 * SERVICE_NAME_PATTERN.test("gmail");       // true
 * SERVICE_NAME_PATTERN.test("my-service");  // true
 * SERVICE_NAME_PATTERN.test("123bad");      // false
 * ```
 */
export const SERVICE_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

/**
 * A registry of service definitions that maps service names to their
 * capabilities. Pre-populated with built-in services and extensible
 * with custom ones.
 *
 * Created via {@link createScopeRegistry}.
 *
 * @example
 * ```ts
 * const registry = createScopeRegistry();
 *
 * registry.register({
 *   name: "analytics",
 *   description: "Internal analytics",
 *   capabilities: ["read"],
 * });
 *
 * registry.has("analytics"); // true
 * registry.isValidScope({ service: "analytics", permissionLevel: "read" }); // true
 * ```
 */
export interface ScopeRegistry {
  /**
   * Register a new custom service definition.
   *
   * @param definition - The service to register.
   * @throws {Error} If a service with the same name is already registered.
   * @throws {Error} If the definition fails validation (bad name, empty capabilities, etc.).
   *
   * @example
   * ```ts
   * registry.register({
   *   name: "crm",
   *   description: "Customer relationship management",
   *   capabilities: ["read", "write"],
   * });
   * ```
   */
  register(definition: ServiceDefinition): void;

  /**
   * Look up a service definition by name.
   *
   * @param serviceName - The service identifier to look up.
   * @returns The definition, or `undefined` if not registered.
   *
   * @example
   * ```ts
   * const gmail = registry.get("gmail");
   * // gmail?.capabilities → ["read", "write", "execute"]
   * ```
   */
  get(serviceName: string): ServiceDefinition | undefined;

  /**
   * Check whether a service is registered.
   *
   * @param serviceName - The service identifier.
   *
   * @example
   * ```ts
   * registry.has("gmail");    // true
   * registry.has("unknown");  // false
   * ```
   */
  has(serviceName: string): boolean;

  /**
   * Return all registered service definitions (built-in and custom).
   *
   * @example
   * ```ts
   * for (const svc of registry.getAllServices()) {
   *   console.log(svc.name, svc.capabilities);
   * }
   * ```
   */
  getAllServices(): readonly ServiceDefinition[];

  /**
   * Validate that a {@link Scope} references a registered service and
   * a capability that the service supports.
   *
   * @param scope - The scope to validate.
   * @returns `true` if the scope is valid within this registry.
   *
   * @example
   * ```ts
   * registry.isValidScope({ service: "gmail", permissionLevel: "read" });    // true
   * registry.isValidScope({ service: "gmail", permissionLevel: "execute" }); // true
   * registry.isValidScope({ service: "drive", permissionLevel: "execute" }); // false
   * ```
   */
  isValidScope(scope: Scope): boolean;
}

/**
 * Create a new {@link ScopeRegistry} pre-populated with all
 * {@link BUILT_IN_SERVICES | built-in services}.
 *
 * @returns A mutable registry that can be extended with custom services.
 *
 * @example
 * ```ts
 * import { createScopeRegistry } from "multicorn-shield";
 *
 * const registry = createScopeRegistry();
 * console.log(registry.has("gmail")); // true
 *
 * registry.register({
 *   name: "custom-crm",
 *   description: "Our internal CRM",
 *   capabilities: ["read", "write"],
 * });
 * ```
 */
export function createScopeRegistry(): ScopeRegistry {
  const services = new Map<string, ServiceDefinition>();

  const validPermissionLevels = new Set<string>(
    Object.values(PERMISSION_LEVELS),
  );

  // Pre-populate with built-in services
  for (const service of Object.values(BUILT_IN_SERVICES)) {
    services.set(service.name, service);
  }

  function validateDefinition(definition: ServiceDefinition): void {
    // Name validation
    if (definition.name.length === 0) {
      throw new Error(
        "Service name must not be empty. Provide a lowercase identifier such as \"my-service\".",
      );
    }

    if (!SERVICE_NAME_PATTERN.test(definition.name)) {
      throw new Error(
        `Invalid service name "${definition.name}". Service names must start with a lowercase letter ` +
          "and contain only lowercase letters, digits, hyphens, or underscores " +
          "(e.g. \"my-service\", \"analytics2\").",
      );
    }

    // Capabilities validation
    if (definition.capabilities.length === 0) {
      throw new Error(
        `Service "${definition.name}" must declare at least one capability ` +
          `(${[...validPermissionLevels].join(", ")}).`,
      );
    }

    const seen = new Set<PermissionLevel>();
    for (const cap of definition.capabilities) {
      if (!validPermissionLevels.has(cap)) {
        throw new Error(
          `Invalid capability "${cap}" for service "${definition.name}". ` +
            `Valid capabilities are: ${[...validPermissionLevels].join(", ")}.`,
        );
      }
      if (seen.has(cap)) {
        throw new Error(
          `Duplicate capability "${cap}" in service "${definition.name}". ` +
            "Each capability should be listed only once.",
        );
      }
      seen.add(cap);
    }
  }

  return {
    register(definition: ServiceDefinition): void {
      validateDefinition(definition);

      if (services.has(definition.name)) {
        throw new Error(
          `Service "${definition.name}" is already registered. ` +
            "Choose a unique name for your custom service.",
        );
      }

      services.set(definition.name, {
        name: definition.name,
        description: definition.description,
        capabilities: [...definition.capabilities],
      });
    },

    get(serviceName: string): ServiceDefinition | undefined {
      return services.get(serviceName);
    },

    has(serviceName: string): boolean {
      return services.has(serviceName);
    },

    getAllServices(): readonly ServiceDefinition[] {
      return [...services.values()];
    },

    isValidScope(scope: Scope): boolean {
      const service = services.get(scope.service);
      if (!service) {
        return false;
      }
      return (service.capabilities as readonly string[]).includes(
        scope.permissionLevel,
      );
    },
  };
}
