# ADR-004: TypeScript SDK + Kotlin backend

## Status

Accepted

## Context

We need to choose languages for the SDK (public, npm package) and backend (private, API service). The choices impact:

- Developer adoption and ecosystem fit
- Team productivity and hiring
- Type safety and maintainability
- Performance and operational costs

For the SDK, we considered:

- **TypeScript**: Dominant in npm ecosystem, excellent tooling, type safety, easy for contributors
- **JavaScript**: Smaller learning curve, but no type safety, harder to maintain
- **Rust/WASM**: Maximum performance, but complex build, limited npm ecosystem fit

For the backend, we considered:

- **Kotlin**: Type safety, Spring Boot maturity, JVM performance, good for enterprise
- **TypeScript/Node.js**: Single language, but runtime performance and memory usage concerns at scale
- **Go**: Excellent performance, but smaller ecosystem, less type safety than Kotlin
- **Java**: Mature, but more verbose than Kotlin, less modern tooling

## Decision

Use **TypeScript** for the SDK (`multicorn-shield`) and **Kotlin** for the backend (`multicorn-service`).

The SDK is written in TypeScript, compiled to ES modules and CommonJS, and published to npm. The backend is Kotlin with Spring Boot, running on the JVM.

## Consequences

**Positive:**

- **SDK adoption**: TypeScript is the default for npm packages, making it easy for developers to integrate
- **Type safety**: Both languages provide strong typing, catching errors at compile time
- **Ecosystem fit**: TypeScript fits npm perfectly; Kotlin fits enterprise Java ecosystems
- **Hiring**: Large pools of TypeScript and Kotlin developers
- **Tooling**: Excellent IDE support, testing frameworks, and build tools for both
- **Performance**: JVM backend handles high concurrency and memory management well

**Negative:**

- **Language split**: Team must maintain expertise in two languages and ecosystems
- **Type sharing**: Can't directly share types between repos (addressed in ADR-005)
- **Context switching**: Developers working across repos need to switch mental models
- **Build complexity**: Two different build systems (tsup/TypeScript vs Gradle/Kotlin)

**Future considerations:**

- If the team grows, we may have specialists in each language (frontend vs backend)
- We can extract shared types into a separate package (see ADR-005) to reduce duplication
- If we need to optimize for a single-language team, we could migrate the backend to TypeScript/Node.js, but we'd lose JVM performance and Spring Boot's enterprise features
