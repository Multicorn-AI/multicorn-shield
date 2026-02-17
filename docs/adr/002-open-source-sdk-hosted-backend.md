# ADR-002: Open-source SDK with hosted backend revenue model

## Status
Accepted

## Context

Multicorn Shield needs to balance three goals:
1. Build trust and adoption by being transparent and open-source
2. Generate revenue to sustain development and operations
3. Avoid fragmenting the ecosystem with competing implementations

We considered several business models:
- **Fully proprietary**: SDK and backend both closed-source, license fees
- **Open-core**: Basic features open, advanced features proprietary
- **Open SDK, hosted backend**: SDK is fully open-source, revenue from hosted platform
- **Open everything**: Both SDK and backend open-source, rely on support/services revenue

## Decision

The SDK (`multicorn-shield`) is fully open-source (MIT license). The backend service (`multicorn-service`) is proprietary and hosted. Revenue comes from:
- Hosted platform subscriptions (usage-based pricing)
- Enterprise features (SSO, advanced audit logs, custom integrations)
- Support and SLA guarantees

The SDK can be configured to point to any backend that implements the Multicorn API, but the default configuration points to our hosted service.

## Consequences

**Positive:**
- Builds trust: security-sensitive code is auditable by customers and researchers
- Drives adoption: developers can integrate without vendor lock-in concerns
- Follows proven precedent: Stripe (open SDK, hosted API), Sentry (open SDK, hosted backend), PostHog (open SDK, hosted analytics)
- Community contributions improve the SDK quality and feature set
- Transparent security model helps with enterprise sales cycles

**Negative:**
- Competitors could fork the SDK and build competing backends (though this validates the market)
- Must maintain high-quality open-source standards (documentation, tests, issue triage)
- Revenue depends entirely on hosted service adoption, not SDK usage
- Some enterprise customers may want on-premise deployments, which we'll need to handle separately

**Future considerations:**
- If on-premise demand is significant, we may offer a self-hosted backend option (separate license)
- We may open-source non-core backend components (e.g., database migrations, API client libraries) to reduce integration friction
- The SDK's API design must remain stable to avoid breaking community forks
