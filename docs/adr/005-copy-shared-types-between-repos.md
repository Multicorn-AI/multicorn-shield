# ADR-005: Copy shared types between repos initially

## Status
Accepted

## Context

The SDK and backend need to agree on API contracts: request/response shapes, error formats, permission scope definitions, etc. Since the SDK is TypeScript and the backend is Kotlin, we can't directly share type definitions.

We considered several approaches:
- **Shared package**: Extract types into a separate npm package, import in both repos
- **Code generation**: Generate TypeScript from Kotlin (or vice versa) via OpenAPI/Swagger
- **Copy types**: Manually maintain copies of type definitions in both repos
- **API-first**: Define types in OpenAPI spec, generate both TypeScript and Kotlin

## Decision

Initially, copy shared types between repos. The SDK and backend maintain their own type definitions that represent the same API contract. When types change, we update both repos manually.

We will extract shared types into a package (or use code generation) once the API stabilizes (target: after v1.0 release).

## Consequences

**Positive:**
- **Speed**: No build-time dependencies or code generation setup required
- **Flexibility**: Each repo can evolve types independently during early development
- **Simplicity**: No additional tooling or build steps to maintain
- **Fast iteration**: Changes to API contracts can be made quickly without regenerating code

**Negative:**
- **Drift risk**: Types can get out of sync between repos, causing runtime errors
- **Maintenance burden**: Every API change requires updates in two places
- **No single source of truth**: Harder to see the complete API contract at a glance
- **Testing gap**: Type mismatches only surface at runtime or integration tests

**Mitigation:**
- Integration tests catch type mismatches early
- API versioning prevents breaking changes from propagating silently
- Code review checklist includes "update types in both repos"
- Automated checks (future): compare TypeScript and Kotlin types in CI

**Future considerations:**
- Once API stabilizes (post-v1.0), extract types into `@multicorn/types` package
- Alternatively, adopt OpenAPI-first development: define API in OpenAPI spec, generate both TypeScript and Kotlin types
- Consider tools like `openapi-typescript-codegen` or `kotlin-openapi-generator` for type generation
