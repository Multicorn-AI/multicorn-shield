# ADR-001: Use Lit for consent screen web component

## Status
Accepted

## Context

The consent screen is a critical security component that must be embedded into any web page where an agent requests permission. It needs to:

1. Render reliably across different frameworks (React, Vue, Svelte, vanilla JS)
2. Prevent CSS and JavaScript from the host page from affecting its appearance or behavior (security requirement)
3. Have a minimal bundle size to avoid impacting page load times
4. Work without requiring the host application to install additional dependencies

We evaluated several options:
- **React**: Requires React as a peer dependency, adds ~40KB to bundle, framework lock-in
- **Svelte**: Smaller bundle (~10KB), but still requires a build step and framework knowledge
- **Vanilla Web Components**: No dependencies, but requires significant boilerplate and manual Shadow DOM management
- **Lit**: Minimal runtime (~5KB), built-in Shadow DOM support, framework-agnostic, active maintenance

## Decision

Use Lit to build the consent screen as a web component. The component will be compiled and distributed as a standalone JavaScript file that can be loaded via a script tag or imported as an ES module.

The component uses Shadow DOM to isolate styles and prevent host page interference. All styling is self-contained within the component.

## Consequences

**Positive:**
- Framework-agnostic: works in React, Vue, Angular, Svelte, or vanilla JS
- Small bundle size (~5KB gzipped) minimizes impact on host applications
- Shadow DOM provides strong isolation against CSS and JavaScript injection
- Lit's active development and TypeScript support make maintenance straightforward
- Can be loaded via CDN or bundled, giving flexibility to SDK users

**Negative:**
- Adds a dependency (Lit) to the SDK, though it's small and well-maintained
- Shadow DOM can make debugging slightly more complex (requires browser DevTools Shadow DOM inspection)
- Some CSS features (like `:host-context()`) have limited browser support, though we don't need them
- Styling must be done programmatically or via `<style>` tags within the component (no external stylesheets)

**Future considerations:**
- If bundle size becomes a concern, we could explore a vanilla Web Components implementation, but the maintenance cost would be higher
- If we need framework-specific optimizations (e.g., React hooks integration), we can build wrapper components without changing the core Lit component
