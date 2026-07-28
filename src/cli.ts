#!/usr/bin/env node
/**
 * context-mode CLI
 *
 * Usage:
 *   context-mode                              → Start MCP server (stdio)
 *   context-mode doctor                       → Diagnose runtime issues, hooks, FTS5, version
 *   context-mode hook <platform> <event>      → Dispatch a hook script (used by platform hook configs)
 *   CONTEXT_MODE_DIR=/abs/path context-mode   → Override sessions/content storage root
 *     Empty/whitespace is ignored; non-empty values must be absolute.
 *
 * Platform auto-detection: CLI detects which platform is running
 * (Claude Code, Gemini CLI, OpenCode, etc.) and uses the appropriate adapter.
 */

import * as p from "@clack/prompts";
import color from "picocolors";
import { execFileSync, execSync, type ExecSyncOptions } from "node:child_process";
import { readFileSync, writeFileSync, accessSync, existsSync, readdirSync, closeSync, openSync, realpathSync, statSync, constants } from "node:fs";
import { resolve, dirname, join, sep, basename, isAbsolute } from "node:path";
import { tmpdir, devNull, homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  detectRuntimes,
  getRuntimeSummary,
  hasBunRuntime,
  getAvailableLanguages,
} from "./runtime.js";
import { getHookScriptPaths } from "./util/hook-config.js";
import { resolveClaudeConfigDir } from "./util/claude-config.js";
import {
  ensureWritableStorageDir,
  formatStorageDirectoryError,
  resolveContentStorageDir,
  resolveSessionStorageDir,
  resolveStatsStorageDir,
  StorageDirectoryError,
  type ResolvedStorageDir,
} from "./session/db.js";
import { ContentStore } from "./store.js";
import { readToolDenyPatterns, evaluateFilePath } from "./security.js";
// ── Adapter imports ──────────────────────────────────────
import { detectPlatform, getAdapter } from "./adapters/detect.js";
import { isInProcessPluginPlatform } from "./adapters/types.js";

/* -------------------------------------------------------
 * Hook dispatcher — `context-mode hook <platform> <event>`
 * ------------------------------------------------------- */

const HOOK_MAP: Record<string, Record<string, string>> = {
  "claude-code": {
    pretooluse: "hooks/pretooluse.mjs",
    posttooluse: "hooks/posttooluse.mjs",
    precompact: "hooks/precompact.mjs",
    sessionstart: "hooks/sessionstart.mjs",
    userpromptsubmit: "hooks/userpromptsubmit.mjs",
    stop: "hooks/stop.mjs",
  },
  "gemini-cli": {
    beforeagent: "hooks/gemini-cli/beforeagent.mjs",
    beforetool: "hooks/gemini-cli/beforetool.mjs",
    aftertool: "hooks/gemini-cli/aftertool.mjs",
    precompress: "hooks/gemini-cli/precompress.mjs",
    sessionstart: "hooks/gemini-cli/sessionstart.mjs",
  },
  "vscode-copilot": {
    pretooluse: "hooks/vscode-copilot/pretooluse.mjs",
    posttooluse: "hooks/vscode-copilot/posttooluse.mjs",
    precompact: "hooks/vscode-copilot/precompact.mjs",
    sessionstart: "hooks/vscode-copilot/sessionstart.mjs",
  },
  "cursor": {
    pretooluse: "hooks/cursor/pretooluse.mjs",
    posttooluse: "hooks/cursor/posttooluse.mjs",
    sessionstart: "hooks/cursor/sessionstart.mjs",
    stop: "hooks/cursor/stop.mjs",
    afteragentresponse: "hooks/cursor/afteragentresponse.mjs",
  },
  "codex": {
    pretooluse: "hooks/codex/pretooluse.mjs",
    posttooluse: "hooks/codex/posttooluse.mjs",
    precompact: "hooks/codex/precompact.mjs",
    sessionstart: "hooks/codex/sessionstart.mjs",
    userpromptsubmit: "hooks/codex/userpromptsubmit.mjs",
    stop: "hooks/codex/stop.mjs",
  },
  "kiro": {
    pretooluse: "hooks/kiro/pretooluse.mjs",
    posttooluse: "hooks/kiro/posttooluse.mjs",
  },
  "jetbrains-copilot": {
    pretooluse: "hooks/jetbrains-copilot/pretooluse.mjs",
    posttooluse: "hooks/jetbrains-copilot/posttooluse.mjs",
    precompact: "hooks/jetbrains-copilot/precompact.mjs",
    sessionstart: "hooks/jetbrains-copilot/sessionstart.mjs",
  },
  "copilot-cli": {
    pretooluse: "hooks/copilot-cli/pretooluse.mjs",
    posttooluse: "hooks/copilot-cli/posttooluse.mjs",
    precompact: "hooks/copilot-cli/precompact.mjs",
    sessionstart: "hooks/copilot-cli/sessionstart.mjs",
    userpromptsubmit: "hooks/copilot-cli/userpromptsubmit.mjs",
    stop: "hooks/copilot-cli/stop.mjs",
  },
  // Antigravity CLI (`agy`) — bounded PreToolUse enforcement plus capture-only
  // PostToolUse/Stop hooks. Configured via an installed agy plugin's
  // hooks/hooks.json or ~/.gemini/config/hooks.json.
  "antigravity-cli": {
    pretooluse: "hooks/antigravity-cli/pretooluse.mjs",
    posttooluse: "hooks/antigravity-cli/posttooluse.mjs",
    stop: "hooks/antigravity-cli/stop.mjs",
  },
  "kimi": {
    pretooluse: "hooks/kimi/pretooluse.mjs",
    posttooluse: "hooks/kimi/posttooluse.mjs",
    precompact: "hooks/kimi/precompact.mjs",
    sessionstart: "hooks/kimi/sessionstart.mjs",
    sessionend: "hooks/kimi/sessionend.mjs",
    userpromptsubmit: "hooks/kimi/userpromptsubmit.mjs",
    stop: "hooks/kimi/stop.mjs",
  },
  "qwen-code": {
    pretooluse: "hooks/pretooluse.mjs",
    posttooluse: "hooks/posttooluse.mjs",
    precompact: "hooks/precompact.mjs",
    sessionstart: "hooks/sessionstart.mjs",
    userpromptsubmit: "hooks/userpromptsubmit.mjs",
  },
};

async function hookDispatch(platform: string, event: string): Promise<void> {
  // Suppress stderr at OS fd level — native C++ modules (better-sqlite3) write
  // directly to fd 2 during initialization, bypassing Node.js process.stderr.
  // Platforms like Claude Code interpret ANY stderr output as hook failure.
  // Cross-platform: os.devNull → /dev/null (Unix) or \\.\NUL (Windows). See: #68
  try {
    closeSync(2);
    openSync(devNull, "w"); // Acquires fd 2 (lowest available)
  } catch {
    process.stderr.write = (() => true) as typeof process.stderr.write;
  }

  const scriptPath = HOOK_MAP[platform]?.[event];
  if (!scriptPath) {
    // Fail OPEN. context-mode has no hook for this platform/event — most often
    // because a newer adapter's hook command (`context-mode hook copilot-cli …`)
    // is running against an OLDER global binary that predates that adapter
    // (version skew). Exit 0 (no decision) so the host ALLOWS the tool. Exiting
    // non-zero here makes some hosts treat it as a hook ERROR and DENY the tool:
    // verified against GitHub Copilot CLI 1.0.59, where an exit-1 + empty-stdout
    // PreToolUse hook blocks EVERY tool ("Denied by preToolUse hook (hook
    // errored)") — bricking the agent during a skew instead of just disabling
    // context-mode's instrumentation.
    process.exit(0);
  }
  const pluginRoot = getPluginRoot();
  await import(pathToFileURL(join(pluginRoot, scriptPath)).href);
}

/* -------------------------------------------------------
 * Entry point
 * ------------------------------------------------------- */

const args = process.argv.slice(2);

function printHelp(): void {
  console.log([
    "Usage:",
    "  context-mode                         Start MCP server (stdio)",
    "  context-mode index <path>            Index a file or directory into the FTS5 knowledge base",
    "  context-mode search <query...>       Search the current project's FTS5 knowledge base",
    "  context-mode doctor                  Diagnose runtime issues, hooks, FTS5, version",
    "  context-mode hook <platform> <event> Dispatch a configured hook script",
    "  context-mode statusline              Print Claude Code status line",
    "",
    "Index options:",
    "  --source <label>                     Source label (default: project:<directory-name> or path)",
    "  --project <path>                     Project identity for the content DB (default: indexed dir or cwd)",
    "  --max-depth <n>                      Directory recursion depth (default: 5)",
    "  --max-files <n>                      Directory file cap (default: 200)",
    "  --ext <.ts,.md>                      Comma-separated extension allowlist",
    "  --include <glob>                     Directory include pattern (repeatable)",
    "  --exclude <glob>                     Directory exclude pattern (repeatable)",
    "  --no-gitignore                       Do not apply .gitignore during directory walks",
    "  --follow-symlinks                    Follow directory symlinks inside the root",
    "",
    "Search options:",
    "  --project <path>                     Project identity for the content DB (default: cwd)",
    "  --source <label>                     Filter to a source label (partial match)",
    "  --limit <n>                          Results to show (default: 3)",
    "  --type <code|prose>                  Filter by content type",
    "",
    "Environment:",
    "  CONTEXT_MODE_DIR=/absolute/path      Override sessions/content storage root; empty is ignored, non-empty must be absolute",
  ].join("\n"));
}

if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
  printHelp();
} else if (args[0] === "index") {
  indexCommand(args.slice(1)).then((code) => process.exit(code));
} else if (args[0] === "search") {
  searchCommand(args.slice(1)).then((code) => process.exit(code));
} else if (args[0] === "doctor") {
  doctor().then((code) => process.exit(code));
} else if (args[0] === "hook") {
  hookDispatch(args[1], args[2]);
} else if (args[0] === "statusline") {
  // Status line implementation lives in bin/statusline.mjs to keep it
  // dependency-free and fast. Forward stdin and exit with its result.
  statuslineForward();
} else {
  // Default: start MCP server
  import("./server.js");
}

/* -------------------------------------------------------
 * Shared helpers
 * ------------------------------------------------------- */

/** Normalize Windows backslash paths to forward slashes for Bash (MSYS2) compatibility. */
export function toUnixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Windows-safe npm execution. On Windows:
 * - "npm" → "npm.cmd" (Node won't resolve via PATHEXT in execFile)
 * - shell: true required (Node v20+ CVE-2024-27980 mitigation)
 * See: https://github.com/mksglu/context-mode/issues/344
 */
const isWin = process.platform === "win32";

export function npmExecFile(args: string[], opts: Record<string, unknown> = {}): void {
  execFileSync(isWin ? "npm.cmd" : "npm", args, {
    ...opts,
    ...(isWin ? { shell: true } : {}),
  });
}

export function npmExec(command: string, opts: Record<string, unknown> = {}): void {
  // Issue #511: use top-level static import (line 17) — never inline `require("node:...")`
  // in ESM-bundled sources. esbuild rewrites them to a `__require` shim that throws
  // `Dynamic require of "node:child_process" is not supported` under Node ESM/Bun.
  // Cast preserves the prior `require()`-as-`any` shape; `shell: true` is the documented
  // Node behavior even though @types/node typed `shell` as `string | undefined`.
  const execOpts = {
    ...opts,
    ...(isWin ? { shell: true } : {}),
  } as unknown as ExecSyncOptions;
  execSync(isWin ? command.replace(/^npm /, "npm.cmd ") : command, execOpts);
}

/**
 * Open a URL in the user's default browser without invoking a shell.
 *
 * Uses `execFile` with an arg array so the URL cannot be interpreted as
 * shell metacharacters.  Original code used `execSync(`open "${url}"`)`
 * which would shell-interpolate the URL — fragile if the URL ever
 * becomes attacker-controlled (remote, weak port-validation, etc).
 *
 * Best-effort: if the OS opener is missing the function logs a copyable
 * URL hint and returns; it never throws.  `runner` is injectable for
 * tests; default is `child_process.execFile` (callback form, fire-and-
 * forget).
 */
function defaultPluginRoot(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // build/cli.js or src/cli.ts → go up one level; cli.bundle.mjs at project root → stay here
  if (__dirname.endsWith("/build") || __dirname.endsWith("\\build") ||
      __dirname.endsWith("/src") || __dirname.endsWith("\\src")) {
    return resolve(__dirname, "..");
  }
  return __dirname;
}

// Opencode/Kilocode install plugins from npm into a per-package cache folder.
// Layout (changed silently in late 2024 — see PR #376 / KiloCode#9503):
//   POSIX  : ~/.cache/<platform>/packages/context-mode@latest/node_modules/context-mode
//   Windows: %LOCALAPPDATA%\<platform>\packages\context-mode@latest\node_modules\context-mode
function cachePluginRoot(platform: string): string {
  const subPath = ["packages", "context-mode@latest", "node_modules", "context-mode"];
  if (process.platform === "win32") {
    const localApp = process.env.LOCALAPPDATA;
    if (localApp) return resolve(localApp, platform, ...subPath);
    return resolve(homedir(), "AppData", "Local", platform, ...subPath);
  }
  return resolve(homedir(), ".cache", platform, ...subPath);
}

function getPluginRoot(): string {
  const platform = detectPlatform().platform;
  if (isInProcessPluginPlatform(platform)) {
    return cachePluginRoot(platform);
  }
  return defaultPluginRoot();
}

function getLocalVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(getPluginRoot(), "package.json"), "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function fetchLatestVersion(): Promise<string> {
  // Disabled for local/offline install: no outbound network calls to npm registry.
  return Promise.resolve("unknown");
}

/* -------------------------------------------------------
 * Doctor — adapter-aware diagnostics
 * ------------------------------------------------------- */

function describeStorageSource(dir: ResolvedStorageDir): string {
  return dir.envVar ? dir.envVar : "adapter default";
}

interface ParsedFlags {
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
}

function parseFlags(argv: string[]): ParsedFlags {
  const positional: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--") || arg === "--") {
      positional.push(arg);
      continue;
    }

    const raw = arg.slice(2);
    const eq = raw.indexOf("=");
    const key = eq >= 0 ? raw.slice(0, eq) : raw;
    const inlineValue = eq >= 0 ? raw.slice(eq + 1) : undefined;
    const next = argv[i + 1];
    const value =
      inlineValue !== undefined
        ? inlineValue
        : next && !next.startsWith("--")
          ? (i++, next)
          : true;

    if (key === "include" || key === "exclude") {
      const prev = flags[key];
      flags[key] = Array.isArray(prev) ? [...prev, String(value)] : [String(value)];
    } else {
      flags[key] = value;
    }
  }

  return { positional, flags };
}

function stringFlag(flags: ParsedFlags["flags"], key: string): string | undefined {
  const v = flags[key];
  if (typeof v === "string" && v.length > 0) return v;
  return undefined;
}

function boolFlag(flags: ParsedFlags["flags"], key: string): boolean {
  return flags[key] === true || flags[key] === "true";
}

function stringListFlag(flags: ParsedFlags["flags"], key: string): string[] | undefined {
  const v = flags[key];
  if (Array.isArray(v)) return v.filter(Boolean);
  if (typeof v === "string" && v.length > 0) return [v];
  return undefined;
}

function numberFlag(flags: ParsedFlags["flags"], key: string, opts: { min?: number } = {}): number | undefined {
  const raw = stringFlag(flags, key);
  if (!raw) return undefined;
  const n = Number(raw);
  const min = opts.min ?? 1;
  if (!Number.isInteger(n) || n < min) throw new Error(`--${key} must be an integer >= ${min}`);
  return n;
}

function extFlag(flags: ParsedFlags["flags"]): string[] | undefined {
  const raw = stringFlag(flags, "ext") ?? stringFlag(flags, "extensions");
  if (!raw) return undefined;
  const exts = raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => (x.startsWith(".") ? x : `.${x}`));
  return exts.length > 0 ? exts : undefined;
}

function resolveCliProjectDir(projectFlag: string | undefined, fallback: string): string {
  if (projectFlag) return resolve(projectFlag);
  return resolve(fallback);
}

async function openCliContentStore(projectDir: string): Promise<{ store: ContentStore; dbPath: string; contentDir: string }> {
  const adapter = await getAdapter(detectPlatform().platform);
  const contentStorage = resolveContentStorageDir(() => adapter.getSessionDir());
  const contentDir = ensureWritableStorageDir(contentStorage);
  const { resolveContentStorePath } = await import("./session/db.js");
  const dbPath = resolveContentStorePath({ projectDir, contentDir });
  return { store: new ContentStore(dbPath), dbPath, contentDir };
}

function defaultSourceForPath(absPath: string): string {
  try {
    if (statSync(absPath).isDirectory()) return `project:${basename(absPath) || absPath}`;
  } catch { /* path errors are reported by the index command */ }
  return absPath;
}

function assertReadAllowed(path: string, projectDir: string): void {
  const denyGlobs = readToolDenyPatterns("Read", projectDir);
  const denied = evaluateFilePath(path, denyGlobs, process.platform === "win32", projectDir);
  if (denied.denied) {
    throw new Error(`Read denied by policy: ${path}`);
  }
}

async function indexCommand(argv: string[]): Promise<number> {
  try {
    const parsed = parseFlags(argv);
    const target = parsed.positional[0];
    if (!target || target === "-h" || target === "--help") {
      console.log("Usage: context-mode index <path> [--source label] [--project path] [--max-files n] [--max-depth n] [--ext .ts,.md]");
      return target ? 0 : 1;
    }

    const absPath = isAbsolute(target) ? resolve(target) : resolve(process.cwd(), target);
    if (!existsSync(absPath)) throw new Error(`Path does not exist: ${absPath}`);

    const st = statSync(absPath);
    const projectDir = resolveCliProjectDir(
      stringFlag(parsed.flags, "project"),
      st.isDirectory() ? absPath : dirname(absPath),
    );
    const source = stringFlag(parsed.flags, "source") ?? defaultSourceForPath(absPath);
    const { store, dbPath } = await openCliContentStore(projectDir);

    try {
      assertReadAllowed(absPath, projectDir);
      if (st.isDirectory()) {
        const denyGlobs = readToolDenyPatterns("Read", projectDir);
        const result = store.indexDirectory({
          path: absPath,
          source,
          include: stringListFlag(parsed.flags, "include"),
          exclude: stringListFlag(parsed.flags, "exclude"),
          maxDepth: numberFlag(parsed.flags, "max-depth", { min: 0 }),
          maxFiles: numberFlag(parsed.flags, "max-files"),
          extensions: extFlag(parsed.flags),
          respectGitignore: !boolFlag(parsed.flags, "no-gitignore"),
          followSymlinks: boolFlag(parsed.flags, "follow-symlinks"),
          perFileDeny: (filePath) => {
            try {
              return evaluateFilePath(filePath, denyGlobs, process.platform === "win32", projectDir).denied;
            } catch {
              return false;
            }
          },
        });
        const cap = result.capped ? ` (cap reached at ${result.filesIndexed} files)` : "";
        const denied = result.denied > 0 ? `; ${result.denied} denied` : "";
        const failed = result.failed > 0 ? `; ${result.failed} failed` : "";
        console.log(`Indexed ${result.filesIndexed} files (${result.totalChunks} sections) from ${absPath}${cap}${denied}${failed}`);
      } else {
        const result = store.index({ path: absPath, source });
        console.log(`Indexed ${result.totalChunks} sections (${result.codeChunks} with code) from ${absPath}`);
      }
      console.log(`Source: ${source}`);
      console.log(`Project: ${projectDir}`);
      console.log(`DB: ${dbPath}`);
      return 0;
    } finally {
      store.close();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`context-mode index: ${message}`);
    return 1;
  }
}

async function searchCommand(argv: string[]): Promise<number> {
  try {
    const parsed = parseFlags(argv);
    const query = parsed.positional.join(" ").trim();
    if (!query || query === "-h" || query === "--help") {
      console.log("Usage: context-mode search <query...> [--source label] [--project path] [--limit n] [--type code|prose]");
      return query ? 0 : 1;
    }

    const projectDir = resolveCliProjectDir(stringFlag(parsed.flags, "project"), process.cwd());
    const { store, dbPath } = await openCliContentStore(projectDir);
    try {
      const limit = numberFlag(parsed.flags, "limit") ?? 3;
      const type = stringFlag(parsed.flags, "type");
      if (type && type !== "code" && type !== "prose") throw new Error("--type must be code or prose");

      const results = store.searchWithFallback(
        query,
        limit,
        stringFlag(parsed.flags, "source"),
        type as "code" | "prose" | undefined,
      );
      if (results.length === 0) {
        console.log(`No matches for: ${query}`);
        console.log(`Project: ${projectDir}`);
        console.log(`DB: ${dbPath}`);
        return 0;
      }
      for (const [i, r] of results.entries()) {
        const content = r.content.replace(/\s+/g, " ").trim();
        const snippet = content.length > 500 ? `${content.slice(0, 500)}...` : content;
        console.log(`## ${i + 1}. ${r.title}`);
        console.log(`Source: ${r.source}`);
        console.log(`Type: ${r.contentType}`);
        console.log(snippet);
        console.log("");
      }
      return 0;
    } finally {
      store.close();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`context-mode search: ${message}`);
    return 1;
  }
}

function logStorageDir(dir: ResolvedStorageDir): number {
  try {
    ensureWritableStorageDir(dir);
    p.log.success(
      color.green(`Storage ${dir.kind}: PASS`) +
        color.dim(` — ${dir.path} (${describeStorageSource(dir)})`),
    );
    return 0;
  } catch (err) {
    if (err instanceof StorageDirectoryError) {
      p.log.error(
        color.red(`Storage ${dir.kind}: FAIL`) +
          color.dim(` — ${formatStorageDirectoryError(err)}`),
      );
      return 1;
    }
    throw err;
  }
}

async function doctor(): Promise<number> {
  if (process.stdout.isTTY) console.clear();

  // Detect platform
  const detection = detectPlatform();
  const adapter = await getAdapter(detection.platform);

  p.intro(color.bgMagenta(color.white(" context-mode doctor ")));
  p.log.info(
    `Platform: ${color.cyan(adapter.name)}` +
      color.dim(` (${detection.confidence} confidence — ${detection.reason})`),
  );

  let criticalFails = 0;

  try {
    const sessionDir = resolveSessionStorageDir(() => adapter.getSessionDir());
    const contentDir = resolveContentStorageDir(() => sessionDir.path);
    const statsDir = resolveStatsStorageDir(() => sessionDir.path);

    p.note(
      [
        `sessions: ${sessionDir.path} (${describeStorageSource(sessionDir)})`,
        `content:  ${contentDir.path} (${describeStorageSource(contentDir)})`,
        `stats:    ${statsDir.path} (${describeStorageSource(statsDir)})`,
      ].join("\n"),
      "Storage paths",
    );
    criticalFails += logStorageDir(sessionDir);
    criticalFails += logStorageDir(contentDir);
    criticalFails += logStorageDir(statsDir);
  } catch (err) {
    if (err instanceof StorageDirectoryError) {
      criticalFails++;
      p.log.error(
        color.red(`Storage ${err.kind}: FAIL`) +
          color.dim(` — ${formatStorageDirectoryError(err)}`),
      );
    } else {
      throw err;
    }
  }

  const s = p.spinner();
  s.start("Running diagnostics");

  let runtimes: ReturnType<typeof detectRuntimes>;
  let available: string[];
  try {
    runtimes = detectRuntimes();
    available = getAvailableLanguages(runtimes);
  } catch {
    s.stop("Diagnostics partial");
    p.log.warn(color.yellow("Could not detect runtimes") + color.dim(" — module may be missing, restart session after upgrade"));
    p.outro(color.yellow("Doctor could not fully run — try again after restarting"));
    return 1;
  }

  s.stop("Diagnostics complete");

  // Runtime check
  p.note(getRuntimeSummary(runtimes), "Runtimes");

  // ── Issue #564 — Linux + Node < 22.5 + no Bun is unsafe ────────────
  // V8's madvise(MADV_DONTNEED) can corrupt better-sqlite3's native addon
  // `.got.plt` on Linux, causing sporadic SIGSEGV (1-4/hour). The 22.5
  // gate (`hasModernSqlite()` in src/db-base.ts:226-244) is the contract:
  // at or above it we use node:sqlite (built-in, no native addon, no
  // .got.plt to corrupt); below it we fall through to better-sqlite3
  // which WILL crash. engines.node + a hard-fail postinstall guard this
  // at install time, but doctor() surfaces it for already-installed users
  // (and for adapters whose MCP host swallows stderr during install).
  // Refs:
  //   - https://github.com/nodejs/node/issues/62515
  //   - https://github.com/mksglu/context-mode/issues/564
  {
    const { hasModernSqlite } = await import("./db-base.js");
    if (
      process.platform === "linux" &&
      !hasModernSqlite() &&
      !hasBunRuntime()
    ) {
      criticalFails++;
      p.log.error(
        color.red("Node version: FAIL") +
          ` — Linux + Node ${process.versions.node} is unsafe (SIGSEGV)` +
          color.dim(
            "\n  context-mode requires Node.js >= 22.5 (or Bun) on Linux to avoid the" +
            "\n  V8 madvise(MADV_DONTNEED) SIGSEGV in better-sqlite3 (1-4/hour)." +
            "\n  Refs: https://github.com/nodejs/node/issues/62515" +
            "\n        https://github.com/mksglu/context-mode/issues/564" +
            "\n  Fix:  nvm install 22.5 && nvm use 22.5 && npm install -g context-mode" +
            "\n  Or:   curl -fsSL https://bun.sh/install | bash && bun add -g context-mode",
          ),
      );
    }
  }

  // Speed tier
  if (hasBunRuntime()) {
    p.log.success(
      color.green("Performance: FAST") +
        " — Bun detected for JS/TS execution",
    );
  } else {
    p.log.warn(
      color.yellow("Performance: NORMAL") +
        " — Using Node.js (install Bun for 3-5x speed boost)",
    );
  }

  // Language coverage
  const total = 11;
  const pct = ((available.length / total) * 100).toFixed(0);
  if (available.length < 2) {
    criticalFails++;
    p.log.error(
      color.red(`Language coverage: ${available.length}/${total} (${pct}%)`) +
        " — too few runtimes detected" +
        color.dim(` — ${available.join(", ") || "none"}`),
    );
  } else {
    p.log.info(
      `Language coverage: ${available.length}/${total} (${pct}%)` +
        color.dim(` — ${available.join(", ")}`),
    );
  }

  // Server test
  p.log.step("Testing server initialization...");
  try {
    const { PolyglotExecutor } = await import("./executor.js");
    const executor = new PolyglotExecutor({ runtimes });
    const result = await executor.execute({
      language: "javascript",
      code: 'console.log("ok");',
      timeout: 5000,
    });
    if (result.exitCode === 0 && result.stdout.trim() === "ok") {
      p.log.success(color.green("Server test: PASS"));
    } else {
      criticalFails++;
      const detail = result.stderr?.trim() ? ` (${result.stderr.trim().slice(0, 200)})` : "";
      p.log.error(
        color.red("Server test: FAIL") + ` — exit ${result.exitCode}${detail}`,
      );
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Cannot find module") || message.includes("MODULE_NOT_FOUND")) {
      p.log.warn(color.yellow("Server test: SKIP") + color.dim(" — module not available (restart session after upgrade)"));
    } else {
      criticalFails++;
      p.log.error(color.red("Server test: FAIL") + ` — ${message}`);
    }
  }

  // Hooks — adapter-aware validation
  p.log.step(`Checking ${adapter.name} hooks configuration...`);
  const pluginRoot = getPluginRoot();
  const hookResults = adapter.validateHooks(pluginRoot);

  for (const result of hookResults) {
    if (result.status === "pass") {
      p.log.success(color.green(`${result.check}: PASS`) + ` — ${result.message}`);
    } else if (result.status === "warn") {
      p.log.warn(
        color.yellow(`${result.check}: WARN`) +
          ` — ${result.message}` +
          (result.fix ? color.dim(`\n  Run: ${result.fix}`) : ""),
      );
    } else {
      p.log.error(
        color.red(`${result.check}: FAIL`) +
          ` — ${result.message}` +
          (result.fix ? color.dim(`\n  Run: ${result.fix}`) : ""),
      );
    }
  }

  // Hook scripts exist — Algo-D1 protocol path takes precedence.
  // Adapters that override `getHealthChecks` (claude-code today) get a
  // direct `existsSync(join(pluginRoot, "hooks", scriptName))` per
  // HOOK_SCRIPTS entry — no regex round-trip on a hook command, so the
  // #548 doubled-path FAIL class can't surface. Adapters that don't
  // override fall through to the legacy `getHookScriptPaths` flow which
  // generates the hook config and parses each command via
  // `extractHookScriptPath`. Post-D3 every adapter emits buildNodeCommand-
  // shape, so the legacy flow is also safe — but the direct existsSync
  // path is strictly preferable when the adapter offers it.
  p.log.step("Checking hook scripts...");
  const adapterHealthChecks = adapter.getHealthChecks?.(pluginRoot) ?? [];
  if (adapterHealthChecks.length > 0) {
    for (const hc of adapterHealthChecks) {
      const result = hc.check();
      if (result.status === "OK") {
        p.log.success(
          color.green(`${hc.name}: PASS`) +
            (result.detail ? color.dim(` — ${result.detail}`) : ""),
        );
      } else {
        p.log.error(
          color.red(`${hc.name}: FAIL`) +
            (result.detail ? color.dim(` — ${result.detail}`) : ""),
        );
      }
    }
  } else {
    const hookScriptPaths = getHookScriptPaths(adapter, pluginRoot);
    if (hookScriptPaths.length === 0) {
      p.log.success(color.green("Hook scripts: PASS") + color.dim(" — no direct .mjs script paths to verify"));
    } else {
      for (const scriptPath of hookScriptPaths) {
        const absolutePath = resolve(pluginRoot, scriptPath);
        try {
          accessSync(absolutePath, constants.R_OK);
          p.log.success(color.green("Hook script exists: PASS") + color.dim(` — ${absolutePath}`));
        } catch {
          p.log.error(
            color.red("Hook script exists: FAIL") +
              color.dim(` — not found at ${absolutePath}`),
          );
        }
      }
    }
  }

  // Plugin registration — adapter-aware
  p.log.step(`Checking ${adapter.name} plugin registration...`);
  const pluginCheck = adapter.checkPluginRegistration();
  if (pluginCheck.status === "pass") {
    p.log.success(color.green("Plugin enabled: PASS") + color.dim(` — ${pluginCheck.message}`));
  } else {
    p.log.warn(
      color.yellow("Plugin enabled: WARN") +
        ` — ${pluginCheck.message}`,
    );
  }

  // ── Issue #613 — proactive Tier C absolute-path detection ───────────
  // PR #620 fixed `buildHookCommand` for vscode-copilot + jetbrains-copilot
  // so future writes are CLI-dispatcher-shape. But users who ran
  // /ctx-upgrade on v1.0.136 or earlier are still carrying poisoned
  // committable files in their workspace:
  //   - `.github/hooks/context-mode.json`      (vscode-copilot, team-shared)
  //   - `.jetbrains/copilot/hooks.json`        (jetbrains-copilot, team-shared)
  //   - `.cursor/hooks.json`                   (cursor, team-shared)
  // Per ISSUE-613-VERDICT §6.1 these are Tier C — workspace-committed
  // cross-machine config. Doctor scans them for absolute paths and
  // fnm_multishells shims; if found, FAIL with `ctx_upgrade` remediation.
  // Per ISSUE-604-VERDICT §11 ("silent-green doctor while hooks are dead
  // is itself a P0 trust bug") — surface poison BEFORE the user hits a
  // runtime failure.
  p.log.step("Checking team-shared hook configs in your workspace...");
  {
    const projectDir = process.cwd();
    const tierCFiles = [
      ".github/hooks/context-mode.json",
      ".cursor/hooks.json",
      ".jetbrains/copilot/hooks.json",
    ];
    let tierCFails = 0;
    let tierCChecked = 0;

    // Detect absolute-path patterns that should never appear in a
    // workspace-committed config. Per Mert's standing Windows-safety rule:
    // handle both `/` and `\\` separators.
    function isAbsoluteOrShimPath(s: string): boolean {
      // unix absolute
      if (s.startsWith("/")) return true;
      // Windows drive-letter absolute (e.g. C:/, C:\)
      if (/^[A-Za-z]:[/\\]/.test(s)) return true;
      // Windows UNC or escaped-backslash absolute fragments
      if (s.includes("\\\\")) return true;
      // fnm shim hint — issue #613 reporter's exact stderr shape
      if (s.includes("fnm_multishells")) return true;
      // process.execPath literal baked into JSON
      if (s.includes("process.execPath")) return true;
      return false;
    }

    function recurseStrings(node: unknown, hit: (s: string) => void): void {
      if (typeof node === "string") {
        hit(node);
      } else if (Array.isArray(node)) {
        for (const item of node) recurseStrings(item, hit);
      } else if (node && typeof node === "object") {
        for (const v of Object.values(node)) recurseStrings(v, hit);
      }
    }

    for (const rel of tierCFiles) {
      const abs = resolve(projectDir, rel);
      if (!existsSync(abs)) continue; // missing config → SKIP, no false fail
      tierCChecked++;
      try {
        const parsed = JSON.parse(readFileSync(abs, "utf-8"));
        const offenders: string[] = [];
        recurseStrings(parsed, (s) => {
          if (isAbsoluteOrShimPath(s)) offenders.push(s);
        });
        if (offenders.length > 0) {
          criticalFails++;
          tierCFails++;
          // Truncate to one example to keep output readable; show count.
          const example = offenders[0].length > 100
            ? offenders[0].slice(0, 97) + "..."
            : offenders[0];
          p.log.error(
            color.red(`Hook config: FAIL`) +
              ` — ${rel} has your machine's local paths baked in` +
              color.dim(
                "\n  This file is committed to git, so teammates and CI will get your path and the hooks will break for them." +
                `\n  Found ${offenders.length} hard-coded path(s), e.g.: ${example}` +
                "\n  Fix: run /context-mode:ctx-upgrade — it rewrites the file to a portable form that works on every machine." +
                "\n  Details: https://github.com/mksglu/context-mode/issues/613",
              ),
          );
        } else {
          p.log.success(
            color.green("Hook config: PASS") +
              color.dim(` — ${rel} is portable (no hard-coded paths)`),
          );
        }
      } catch (err: unknown) {
        // Malformed JSON should not crash doctor; warn and move on.
        const msg = err instanceof Error ? err.message : String(err);
        p.log.warn(
          color.yellow(`Hook config: WARN`) +
            ` — ${rel} is not valid JSON` +
            color.dim(
              "\n  Doctor cannot scan it for portability issues until the file parses." +
              "\n  Fix: open the file and check it in a JSON validator, or delete it and run /context-mode:ctx-upgrade to regenerate." +
              `\n  Parser said: ${msg.slice(0, 160)}`,
            ),
        );
      }
    }
    if (tierCChecked === 0) {
      p.log.info(
        color.dim("Hook config: SKIP — no team-shared hook configs found in this workspace"),
      );
    } else if (tierCFails === 0) {
      // already individual PASS messages above; no need for a summary
    }
  }

  // ── Issue #609 — proactive stale `.mcp.json` detection ──────────────
  // PR #620 deleted the per-version cache `.mcp.json` write from cli.ts
  // and shipped `sweepStaleMcpJson` to clean up any pre-existing copies.
  // But users on the field may still have stale `.mcp.json` files left
  // by /ctx-upgrade flows that ran before PR #620 (or by Claude Code's
  // native auto-update copying a poisoned file forward). Surface those
  // as WARN (recoverable — next ctx_upgrade sweeps them) so the user
  // knows what to do instead of being told everything is green while
  // the file lingers on disk.
  // Per ISSUE-604-VERDICT §11 same trust contract as Tier C check above.
  p.log.step("Checking for leftover .mcp.json files from older versions...");
  {
    const cacheRoot = join(
      homedir(),
      ".claude",
      "plugins",
      "cache",
      "context-mode",
      "context-mode",
    );
    if (!existsSync(cacheRoot)) {
      p.log.info(
        color.dim("Leftover .mcp.json check: SKIP — no plugin cache exists yet (Claude Code has not installed context-mode here)"),
      );
    } else {
      let staleCount = 0;
      const staleVersions: string[] = [];
      try {
        const versionDirs = readdirSync(cacheRoot);
        for (const v of versionDirs) {
          const candidate = join(cacheRoot, v, ".mcp.json");
          if (existsSync(candidate)) {
            staleCount++;
            if (staleVersions.length < 5) staleVersions.push(v);
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        p.log.warn(
          color.yellow("Leftover .mcp.json check: WARN") +
            ` — could not read the plugin cache directory` +
            color.dim(
              `\n  Path: ${cacheRoot}` +
              `\n  Reason: ${msg.slice(0, 160)}` +
              "\n  Fix: check that the directory is readable, then re-run doctor. If the issue persists, run /context-mode:ctx-upgrade.",
            ),
        );
        staleCount = 0;
      }
      if (staleCount === 0) {
        p.log.success(
          color.green("Leftover .mcp.json check: PASS") +
            color.dim(" — no old .mcp.json files in the plugin cache"),
        );
      } else {
        // WARN, not FAIL — per architect spec this is recoverable.
        p.log.warn(
          color.yellow("Leftover .mcp.json check: WARN") +
            ` — found ${staleCount} old .mcp.json file(s) left over from previous context-mode versions` +
            color.dim(
              "\n  These are harmless but should be cleaned up so they cannot confuse Claude Code after an auto-update." +
              `\n  Versions affected: ${staleVersions.join(", ")}${staleCount > staleVersions.length ? ", ..." : ""}` +
              "\n  Fix: run /context-mode:ctx-upgrade — it sweeps these files automatically on the next run." +
              "\n  Details: https://github.com/mksglu/context-mode/issues/609",
            ),
        );
      }
    }
  }

  // FTS5 / SQLite
  p.log.step("Checking FTS5 / SQLite...");
  try {
    const Database = (await import("./db-base.js")).loadDatabase();
    const db = new Database(":memory:");
    db.exec("CREATE VIRTUAL TABLE fts_test USING fts5(content)");
    db.exec("INSERT INTO fts_test(content) VALUES ('hello world')");
    const row = db.prepare("SELECT * FROM fts_test WHERE fts_test MATCH 'hello'").get() as { content: string } | undefined;
    db.close();
    if (row && row.content === "hello world") {
      p.log.success(color.green("FTS5 / SQLite: PASS") + " — native module works");
    } else {
      criticalFails++;
      p.log.error(color.red("FTS5 / SQLite: FAIL") + " — query returned unexpected result");
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Distinguish package-missing from binding-missing (#514). Both
    // throw with similar shapes from `import("better-sqlite3")` but the
    // recovery commands differ:
    //   - package-missing → `npm install better-sqlite3 --no-optional`
    //     (npm@7+ silently drops optionalDependencies on engine
    //     mismatch, e.g. Node 26 vs better-sqlite3@12.x — we name the
    //     package explicitly + flip the optional filter to recover)
    //   - binding-missing → `npm rebuild better-sqlite3` (#408 flow,
    //     Windows + missing prebuild-install shim)
    const pluginRootForDoctor = getPluginRoot();
    const bsqPackageDir = resolve(pluginRootForDoctor, "node_modules", "better-sqlite3");
    const packageMissing = !existsSync(bsqPackageDir);

    if (packageMissing) {
      criticalFails++;
      p.log.error(
        color.red("FTS5 / better-sqlite3: FAIL") +
          color.dim(" — package-missing") +
          color.dim(
            `\n  Path: ${bsqPackageDir}` +
            "\n  Root cause: npm silently skipped better-sqlite3 because the package's `engines` field excluded the running Node (issue #514, e.g. Node 26 vs better-sqlite3@12.x)." +
            `\n  Try (primary): cd "${pluginRootForDoctor}" && npm install better-sqlite3 --no-optional` +
            "\n  Try (fallback): /context-mode:ctx-upgrade",
          ),
      );
    } else if (message.includes("Cannot find module") || message.includes("MODULE_NOT_FOUND")) {
      p.log.warn(color.yellow("FTS5 / better-sqlite3: SKIP") + color.dim(" — module not available (restart session after upgrade)"));
    } else {
      criticalFails++;
      // Detect better-sqlite3 native bindings-missing pattern (issue #408).
      // The `bindings` package throws "Could not locate the bindings file"
      // when better_sqlite3.node failed to install — typical on Windows
      // when prebuild-install was not on PATH so install fell through to
      // node-gyp without an MSVC toolchain.
      const isBindingsMissing =
        /Could not locate the bindings file/i.test(message) ||
        /bindings\.node/i.test(message) ||
        /\bbindings\b/i.test(message);
      if (isBindingsMissing && process.platform === "win32") {
        p.log.error(
          color.red("FTS5 / better-sqlite3: FAIL") +
            ` — ${message}` +
            color.dim(
              "\n  Root cause: prebuild-install was likely not on PATH, so install fell through to node-gyp without an MSVC toolchain (Windows)." +
              "\n  Try (primary): npm install better-sqlite3   # re-resolves the dep tree and re-links the prebuild-install bin shim to fetch a prebuilt binary" +
              "\n  Try (fallback): npm rebuild better-sqlite3",
            ),
        );
      } else {
        p.log.error(
          color.red("FTS5 / better-sqlite3: FAIL") +
            ` — ${message}` +
            color.dim("\n  Try: npm rebuild better-sqlite3"),
        );
      }
    }
  }

  // Version check — adapter-aware
  p.log.step("Checking versions...");
  const localVersion = getLocalVersion();
  const latestVersion = await fetchLatestVersion();
  const installedVersion = adapter.getInstalledVersion();

  if (latestVersion === "unknown") {
    p.log.warn(
      color.yellow("npm (MCP): WARN") +
        ` — local v${localVersion}, could not reach npm registry`,
    );
  } else if (localVersion === latestVersion) {
    p.log.success(
      color.green("npm (MCP): PASS") +
        ` — v${localVersion}`,
    );
  } else {
    p.log.warn(
      color.yellow("npm (MCP): WARN") +
        ` — local v${localVersion}, latest v${latestVersion}` +
        color.dim("\n  Run: /context-mode:ctx-upgrade"),
    );
  }

  if (installedVersion === "standalone") {
    p.log.info(
      color.dim(`${adapter.name}: standalone MCP mode`) +
        " — no platform plugin version to compare",
    );
  } else if (installedVersion === "not installed") {
    p.log.info(
      color.dim(`${adapter.name}: not installed`) +
        " — using standalone MCP mode",
    );
  } else if (latestVersion !== "unknown" && installedVersion === latestVersion) {
    p.log.success(
      color.green(`${adapter.name}: PASS`) +
        ` — v${installedVersion}`,
    );
  } else if (latestVersion !== "unknown") {
    p.log.warn(
      color.yellow(`${adapter.name}: WARN`) +
        ` — v${installedVersion}, latest v${latestVersion}` +
        color.dim("\n  Run: /context-mode:ctx-upgrade"),
    );
  } else {
    p.log.info(
      `${adapter.name}: v${installedVersion}` +
        color.dim(" — could not verify against npm registry"),
    );
  }

  // Summary
  if (criticalFails > 0) {
    p.outro(
      color.red(`Diagnostics failed — ${criticalFails} critical issue(s) found`),
    );
    return 1;
  }

  p.outro(
    available.length >= 4
      ? color.green("Diagnostics complete!")
      : color.yellow("Some checks need attention — see above for details"),
  );
  return 0;
}

// `insight` command disabled for local/offline install: upstream opened a
// hosted third-party dashboard (context-mode.com/insight) in the browser.

/* -------------------------------------------------------
 * statusline — forward to bin/statusline.mjs
 * ------------------------------------------------------- */

function statuslineForward(): void {
  // Try multiple plugin-root candidates in priority order. getPluginRoot()
  // can resolve to a cache dir that sessionstart.mjs (#181) already cleaned,
  // leaving bin/statusline.mjs missing. Falling back to the marketplace
  // clone (#418-synced) and to the path
  // Claude Code itself loads from (installed_plugins.json) keeps the bar
  // alive instead of silently going blank.
  // Issue #460 round-3: marketplace + registry paths must follow
  // $CLAUDE_CONFIG_DIR so relocated CC trees still find the statusline binary.
  const claudeRoot = resolveClaudeConfigDir();
  const candidates: string[] = [
    resolve(getPluginRoot(), "bin", "statusline.mjs"),
    resolve(claudeRoot, "plugins", "marketplaces", "context-mode", "bin", "statusline.mjs"),
  ];

  // installed_plugins.json may list one or more install paths CC actually
  // loads from. Prefer those if they exist.
  try {
    const registryPath = resolve(claudeRoot, "plugins", "installed_plugins.json");
    if (existsSync(registryPath)) {
      // Only honor installPath values that resolve under
      // <claudeRoot>/plugins/cache. A stray /etc or
      // ~/.ssh entry written by another local actor must not become the
      // script the statusline forwarder imports, since statusline re-fires
      // several times per second and would hand the attacker durable RCE
      // on the user's behalf.
      //
      // path.resolve is purely lexical, so a same-uid actor who can plant
      // a symlink at <cacheRoot>/<owner>/<plugin>/<version> targeting an
      // attacker dir would pass the lexical gate. Re-check via
      // realpathSync so the dynamic-import target's actual on-disk
      // location also stays under cacheRoot.
      const cacheRoot = resolve(claudeRoot, "plugins", "cache");
      let cacheRootCanon: string;
      try { cacheRootCanon = realpathSync(cacheRoot); }
      catch { cacheRootCanon = cacheRoot; }
      const cacheRootWithSep = cacheRootCanon + sep;
      const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
      const entries = registry?.plugins?.["context-mode@context-mode"];
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          const installPath = entry?.installPath;
          if (typeof installPath !== "string" || !installPath) continue;
          const resolvedInstallPath = resolve(installPath);
          if (!(resolvedInstallPath + sep).startsWith(cacheRootWithSep)) continue;
          let realInstallPath: string;
          try { realInstallPath = realpathSync(resolvedInstallPath); }
          catch { continue; }
          if (!(realInstallPath + sep).startsWith(cacheRootWithSep)) continue;
          candidates.push(resolve(realInstallPath, "bin", "statusline.mjs"));
        }
      }
    }
  } catch { /* registry malformed — fall through to other candidates */ }

  const scriptPath = candidates.find((c) => existsSync(c));
  if (!scriptPath) {
    // Statusline output is the user-facing status bar; stderr surfaces visibly
    // in some terminals. Exit silently — the bar simply stays empty until the
    // next /ctx-upgrade or restart resolves the path.
    process.exit(0);
  }
  // Re-exec via dynamic import so stdin/stdout are inherited cleanly.
  import(pathToFileURL(scriptPath).href).catch(() => {
    process.exit(0);
  });
}
