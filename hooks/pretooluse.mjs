#!/usr/bin/env node
/**
 * Unified PreToolUse hook for context-mode (Claude Code)
 * Redirects data-fetching tools to context-mode MCP tools
 *
 * Cross-platform (Windows/macOS/Linux) — no bash/jq dependency.
 *
 * Routing is delegated to core/routing.mjs (shared across platforms).
 * This file retains the Claude Code-specific self-heal block and
 * uses core/formatters.mjs for Claude Code output format.
 *
 * Crash-resilience: wrapped via runHook (#414) — module loads happen
 * dynamically inside the wrapper.
 *
 * #415: the destructive settings.json mutation block (which removed
 * context-mode hook entries when hooks.json was present) was deleted.
 * It deleted user-written hook configs without consent and was the
 * documented cause of the regression.
 */

import { runHook } from "./run-hook.mjs";

await runHook(async () => {
  const { writeFileSync } = await import("node:fs");
  const { resolve, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { tmpdir } = await import("node:os");
  const { readStdin } = await import("./core/stdin.mjs");
  const { routePreToolUse, initSecurity } = await import("./core/routing.mjs");
  const { formatDecision } = await import("./core/formatters.mjs");
  const { parseStdin, getInputProjectDir, getSessionId } = await import("./session-helpers.mjs");

  // ─── Init security from compiled build ───
  const __hookDir = dirname(fileURLToPath(import.meta.url));
  await initSecurity(resolve(__hookDir, "..", "build"));

  // ─── Read stdin ───
  const raw = await readStdin();
  const input = parseStdin(raw);
  const tool = input.tool_name ?? "";
  const toolInput = input.tool_input ?? {};
  const projectDir = getInputProjectDir(input);
  const isSubagentContext = input.agent_id != null || input.agent_type != null;

  // ─── Route and format response ───
  const decision = routePreToolUse(tool, toolInput, projectDir, "claude-code", getSessionId(input), {
    mcpToolsAvailable: !isSubagentContext,
  });
  const response = formatDecision("claude-code", decision);

  // ─── Write latency marker for cross-hook timing (Category 27) ───
  // Marker writes MUST happen before stdout write — stdout is the last action
  // so the process can exit immediately after, avoiding CI test timeouts.
  try {
    const sessionId = getSessionId(input);
    if (tool) {
      const markerPath = resolve(tmpdir(), `context-mode-latency-${sessionId}-${tool}.txt`);
      writeFileSync(markerPath, String(Date.now()), "utf-8");
    }
  } catch { /* latency tracking is best-effort — never block hook */ }

  // ─── Write rejected-approach marker for PostToolUse to pick up ───
  // PreToolUse cannot safely load SessionDB (native module loading breaks hook stdout).
  // Write a marker file instead; PostToolUse reads it and writes the event.
  // "ask" is included so analytics still capture high-risk paths even when the
  // user is given the final decision.
  if (decision && (decision.action === "deny" || decision.action === "modify" || decision.action === "ask")) {
    try {
      const sessionId = getSessionId(input);
      const reason = decision.action === "modify"
        ? "Redirected to context-mode sandbox"
        : (decision.reason || "denied");
      const markerPath = resolve(tmpdir(), `context-mode-rejected-${sessionId}.txt`);
      writeFileSync(markerPath, `${tool}:${reason}`, "utf-8");
    } catch { /* best-effort — never block hook */ }
  }

  // ─── D2 PRD Phase 3/4: redirect marker for byte-accounting events ───
  // routing.mjs attaches `redirectMeta` to decisions for tools whose output we
  // kept out of the model's context window (curl/wget, WebFetch, large Read).
  // PostToolUse reads this marker to emit a `category=redirect` event with the
  // estimated `bytes_avoided`. PreToolUse cannot load SessionDB safely (native
  // module load breaks hook stdout), hence the marker indirection.
  if (decision && decision.redirectMeta) {
    try {
      const sessionId = getSessionId(input);
      const meta = decision.redirectMeta;
      const summary = String(meta.commandSummary ?? "").slice(0, 200);
      const markerPath = resolve(tmpdir(), `context-mode-redirect-${sessionId}.txt`);
      // Format: tool:type:bytesAvoided:commandSummary (matches Override C).
      // commandSummary may legitimately contain `:` (URLs) — don't quote it,
      // PostToolUse parses only the first 3 colons and treats the rest as data.
      writeFileSync(
        markerPath,
        `${meta.tool}:${meta.type}:${meta.bytesAvoided}:${summary}`,
        "utf-8",
      );
    } catch { /* best-effort — never block hook */ }
  }

  // ─── stdout write is the LAST action — process exits immediately after ───
  if (response !== null) {
    process.stdout.write(JSON.stringify(response) + "\n");
  }
});
