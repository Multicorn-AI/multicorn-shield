/**
 * Resolves which Shield agent name to use for Claude Code hooks when multiple
 * `claude-code` agents exist in ~/.multicorn/config.json.
 *
 * @module hooks/claude-code-resolve-agent
 */

import { resolve, sep } from "node:path";

function cwdUnderWorkspacePath(cwdResolved: string, workspacePath: string): boolean {
  const w = resolve(workspacePath);
  if (cwdResolved === w) return true;
  const prefix = w.endsWith(sep) ? w : w + sep;
  return cwdResolved.startsWith(prefix);
}

/**
 * Picks the agent for Claude Code hooks: longest matching workspacePath under cwd, then defaultAgent, then first claude-code agent.
 *
 * @param obj - Parsed ~/.multicorn/config.json
 * @param cwd - Prefer `process.env.PWD` when set (shell cwd); else caller passes `process.cwd()`.
 */
export function resolveClaudeCodeAgentNameFromConfig(
  obj: Record<string, unknown>,
  cwd: string,
): string {
  const agentsRaw = obj["agents"];
  const defaultAgentRaw = obj["defaultAgent"];
  const defaultAgentName =
    typeof defaultAgentRaw === "string" && defaultAgentRaw.length > 0 ? defaultAgentRaw : "";

  if (!Array.isArray(agentsRaw)) {
    return typeof obj["agentName"] === "string" ? obj["agentName"] : "";
  }

  const matches: { name: string; workspacePath?: string }[] = [];
  for (const entry of agentsRaw) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (e["platform"] !== "claude-code") continue;
    const n = e["name"];
    if (typeof n !== "string") continue;
    const wp = e["workspacePath"];
    matches.push({
      name: n,
      ...(typeof wp === "string" && wp.length > 0 ? { workspacePath: wp } : {}),
    });
  }

  if (matches.length === 0) {
    return typeof obj["agentName"] === "string" ? obj["agentName"] : "";
  }

  const resolvedCwd = resolve(cwd);
  const withWs = matches.filter(
    (m): m is { name: string; workspacePath: string } =>
      typeof m.workspacePath === "string" && m.workspacePath.length > 0,
  );

  let best: { name: string; workspacePath: string } | null = null;
  let bestLen = -1;
  for (const m of withWs) {
    const wp = m.workspacePath;
    if (!cwdUnderWorkspacePath(resolvedCwd, wp)) continue;
    const len = resolve(wp).length;
    if (len > bestLen) {
      bestLen = len;
      best = { name: m.name, workspacePath: wp };
    }
  }
  if (best !== null) {
    return best.name;
  }

  if (defaultAgentName.length > 0) {
    const d = matches.find((m) => m.name === defaultAgentName);
    if (d !== undefined) return d.name;
  }

  const first = matches[0];
  return first !== undefined ? first.name : "";
}
