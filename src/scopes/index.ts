/**
 * Scope types and validation for agent permissions.
 *
 * Defines the permission scopes that agents can request and
 * provides validation utilities for scope strings.
 *
 * @module scopes
 */

export {
  BUILT_IN_SERVICES,
  SERVICE_NAME_PATTERN,
  createScopeRegistry,
  type BuiltInServiceName,
  type ScopeRegistry,
  type ServiceDefinition,
} from "./scope-definitions.js";

export {
  ScopeParseError,
  parseScope,
  parseScopes,
  tryParseScope,
  formatScope,
  isValidScopeString,
  type ScopeParseResult,
} from "./scope-parser.js";

export {
  validateScopeAccess,
  validateAllScopesAccess,
  hasScope,
  type ValidationResult,
} from "./scope-validator.js";

export { requiresContentReview, isPublicContentAction } from "./content-review-detector.js";
