#!/usr/bin/env node
// Issue #531 — asymmetric-drift invariant asserter.
//
// The canonical MCP server config lives in TWO source-tracked files:
//
//   1. `.mcp.json.example`                    (template; copied to .mcp.json
//                                              locally by contributors. .mcp.json
//                                              itself is .gitignored after the
//                                              #531 architectural untrack — see
//                                              .gitignore and tests/core/cli.test.ts
//                                              "package.json files[] MUST NOT ship
//                                              .mcp.json".)
//   2. `.claude-plugin/plugin.json`           (Claude Code's primary read path
//                                              for installed plugins.)
//
// Fork decision (e09fcfb): the two files serve DIFFERENT audiences and are
// intentionally asymmetric —
//
//   .mcp.json.example          → node ${CLAUDE_PLUGIN_ROOT}/start.mjs
//                                (contributors: launch the local checkout build)
//   .claude-plugin/plugin.json → npx --yes louisje/context-mode
//                                (marketplace installs: always latest from
//                                GitHub; no CLAUDE_PLUGIN_ROOT dependency)
//
// So the upstream "both files must agree" rule is relaxed to: each file must
// pin its OWN canonical launch form. Drift in either file still fails the
// build — the #253 regression class (a silently broken fresh install) stays
// caught; only the cross-file equality requirement is dropped.
//
// This script is the build-chain half of the slice-9 invariant pair.
// The vitest sibling (tests/scripts/asymmetric-drift-assert.test.ts) covers
// the source tree at test time; this script covers the build chain — wired
// into `npm run build` so any regression surfaces in CI before publish.
//
// Contract:
//   - Read `.mcp.json.example` and `.claude-plugin/plugin.json` from --root.
//   - Assert .mcp.json.example mcpServers["context-mode"] == CANONICAL_EXAMPLE.
//   - Assert .claude-plugin/plugin.json mcpServers["context-mode"] == CANONICAL_PLUGIN.
//   - If a `.mcp.json` exists (contributor's local copy), check it against
//     CANONICAL_EXAMPLE too — but absence is fine (it's .gitignored).
//   - Exit 0 on success, 1 with a violations report on failure.
//
// Usage:
//   node scripts/assert-asymmetric-drift.mjs              # checks repo root
//   node scripts/assert-asymmetric-drift.mjs --root <dir> # checks <dir>

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PLACEHOLDER = "${CLAUDE_PLUGIN_ROOT}/start.mjs";
const CANONICAL_EXAMPLE = { command: "node", args: [PLACEHOLDER] };
// Fork intent (e09fcfb): marketplace installs launch via npx from GitHub.
const CANONICAL_PLUGIN = { command: "npx", args: ["--yes", "louisje/context-mode"] };
const PLUGIN_KEY = "context-mode";
const SKILLS_PATH = "./skills/";
const REQUIRED_PLUGIN_RUNTIME_FILES = [
  "start.mjs",
  "server.bundle.mjs",
  "cli.bundle.mjs",
];

function parseArgs(argv) {
  const out = { root: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root" && i + 1 < argv.length) {
      out.root = argv[i + 1];
      i++;
    }
  }
  return out;
}

function readServer(filePath) {
  if (!existsSync(filePath)) return { ok: false, error: `missing: ${filePath}` };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (err) {
    return { ok: false, error: `parse-failed (${filePath}): ${err && err.message}` };
  }
  const servers = parsed && parsed.mcpServers;
  if (!servers || typeof servers !== "object") {
    return { ok: false, error: `no mcpServers in ${filePath}` };
  }
  const ours = servers[PLUGIN_KEY];
  if (!ours || typeof ours !== "object" || !Array.isArray(ours.args) || ours.args.length === 0) {
    return { ok: false, error: `no args[] for ${PLUGIN_KEY} in ${filePath}` };
  }
  return { ok: true, command: ours.command, args: ours.args };
}

function serverMatches(got, want) {
  return (
    got.command === want.command &&
    got.args.length === want.args.length &&
    want.args.every((a, i) => got.args[i] === a)
  );
}

function formatServer(s) {
  return JSON.stringify({ command: s.command, args: s.args });
}

function readJson(filePath) {
  if (!existsSync(filePath)) return { ok: false, error: `missing: ${filePath}` };
  try {
    return { ok: true, value: JSON.parse(readFileSync(filePath, "utf-8")) };
  } catch (err) {
    return { ok: false, error: `parse-failed (${filePath}): ${err && err.message}` };
  }
}

function main() {
  const { root: explicitRoot } = parseArgs(process.argv.slice(2));
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const root = explicitRoot
    ? resolve(explicitRoot)
    : resolve(__dirname, "..");

  const exampleJsonPath = resolve(root, ".mcp.json.example");
  const pluginJsonPath = resolve(root, ".claude-plugin", "plugin.json");
  const localMcpJsonPath = resolve(root, ".mcp.json");

  /** @type {string[]} */
  const violations = [];

  const example = readServer(exampleJsonPath);
  const plg = readServer(pluginJsonPath);
  const pluginJson = readJson(pluginJsonPath);

  if (!example.ok) violations.push(example.error);
  if (!plg.ok) violations.push(plg.error);

  if (example.ok && !serverMatches(example, CANONICAL_EXAMPLE)) {
    violations.push(
      `.mcp.json.example mcpServers["${PLUGIN_KEY}"] is ${formatServer(example)} but must be ${formatServer(CANONICAL_EXAMPLE)}. ` +
        `Contributors copy this template to .mcp.json for local dev, so the template MUST hold the canonical form. (Issue #531 / #253 class.)`,
    );
  }
  if (plg.ok && !serverMatches(plg, CANONICAL_PLUGIN)) {
    violations.push(
      `.claude-plugin/plugin.json mcpServers["${PLUGIN_KEY}"] is ${formatServer(plg)} but must be the fork npx form ${formatServer(CANONICAL_PLUGIN)} — drift. ` +
        `Marketplace installs launch via npx from GitHub (fork intent, e09fcfb); do not "fix" this back to start.mjs.`,
    );
  }

  if (pluginJson.ok) {
    const skills = pluginJson.value && pluginJson.value.skills;
    if (skills !== SKILLS_PATH) {
      violations.push(
        `.claude-plugin/plugin.json skills is "${skills}" but must equal "${SKILLS_PATH}". The npm package ships top-level skills/, not .claude/skills/.`,
      );
    }
    if (!existsSync(resolve(root, "skills"))) {
      violations.push(`missing skills directory at ${resolve(root, "skills")}`);
    }
  } else {
    violations.push(pluginJson.error);
  }

  for (const rel of REQUIRED_PLUGIN_RUNTIME_FILES) {
    if (!existsSync(resolve(root, rel))) {
      violations.push(
        `missing plugin runtime file at ${resolve(root, rel)}. ` +
          `.claude-plugin/plugin.json can load but the MCP server will expose zero tools if ${rel} is absent.`,
      );
    }
  }

  // Contributor's local .mcp.json (if present) — must match the template.
  // Absence is fine; the file is .gitignored after the #531 architectural untrack.
  if (existsSync(localMcpJsonPath)) {
    const local = readServer(localMcpJsonPath);
    if (local.ok && !serverMatches(local, CANONICAL_EXAMPLE)) {
      violations.push(
        `local .mcp.json mcpServers["${PLUGIN_KEY}"] is ${formatServer(local)} but must be ${formatServer(CANONICAL_EXAMPLE)}. ` +
          `If you intentionally use a different launch form locally, ignore — but this file would ship the regression if it ever lands in package.json files[]. Consider \`cp .mcp.json.example .mcp.json\` to reset.`,
      );
    }
  }

  if (violations.length > 0) {
    process.stderr.write("asymmetric-drift: FAIL\n");
    for (const v of violations) {
      process.stderr.write(`  - ${v}\n`);
    }
    process.exit(1);
  }

  process.stdout.write(
    `asymmetric-drift: OK (.mcp.json.example pins ${formatServer(CANONICAL_EXAMPLE)}; .claude-plugin/plugin.json pins the fork npx form ${formatServer(CANONICAL_PLUGIN)}; skills path is ${SKILLS_PATH}; runtime files present)\n`,
  );
}

main();
