# ADR-003: MCP-native as primary protocol

## Status
Accepted

## Context

Multicorn Shield needs to integrate with AI agents that use various protocols for tool calling and permission management. The industry is converging on the Model Context Protocol (MCP) as a standard, with major players (Anthropic, OpenAI) adopting it.

We evaluated protocol options:
- **Custom protocol**: Full control, but requires building ecosystem support
- **OpenAI Functions/Tools**: Widely used, but proprietary and may change
- **LangChain**: Popular but adds abstraction layer and dependency overhead
- **MCP**: Emerging standard, designed for agent-tool interactions, gaining industry momentum

## Decision

Design Multicorn Shield to be MCP-native. The SDK and backend prioritize MCP protocol support. Other protocols (OpenAI Functions, LangChain) are supported via adapters, but MCP is the first-class citizen.

The consent screen, permission scopes, and action logging all use MCP terminology and concepts (tools, resources, prompts).

## Consequences

**Positive:**
- Aligns with industry trajectory: MCP is becoming the de facto standard
- Future-proof: as MCP adoption grows, our integration becomes easier for developers
- Reduced integration friction: developers already using MCP can add Shield with minimal changes
- Clear mental model: MCP's tool/resource/prompt structure maps cleanly to permission scopes
- Community alignment: we can contribute to MCP spec improvements and benefit from ecosystem growth

**Negative:**
- MCP is still evolving: spec changes may require SDK updates
- Not all agents use MCP yet: we need adapters for OpenAI Functions, LangChain, etc.
- Early adoption risk: if MCP doesn't gain traction, we may need to pivot
- Documentation must explain MCP concepts to developers unfamiliar with the protocol

**Future considerations:**
- Monitor MCP spec evolution and participate in standardization discussions
- Build robust adapters for non-MCP protocols to capture early adopters
- If MCP fragments or fails to gain adoption, we can pivot while maintaining our permission model (the core value is in the consent and control, not the protocol)
