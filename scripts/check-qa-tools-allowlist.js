#!/usr/bin/env node
"use strict";

/**
 * Blind QA tools-allowlist check (ALI-105 AC2).
 *
 * `.claude/agents/qa.md`'s `tools:` frontmatter key is the structural half
 * of the blind test-author's blindness — the seat's ability to author tests
 * from the issue's criteria alone, and never from the diff, the
 * implementation, or the PR, is enforced by it holding no tool that could
 * read any of those, not by an instruction it could misread or skip. This
 * script is the CI half: it fails if the key is missing, or if the
 * allowlist contains any read-capable tool (explicit list) or any `mcp__*`
 * tool (every MCP tool is a potential read path; `mcp__Linear__get_diff` is
 * the concrete one this rule exists to catch).
 *
 * AC2 requires this check be *demonstrated failing*, not just passing — see
 * the PR body for the recorded output of a run with `Read` temporarily
 * added to `qa.md`'s allowlist.
 *
 * No dependencies; run directly with `node`.
 */

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const QA_MD = path.join(REPO_ROOT, ".claude", "agents", "qa.md");

// The read-capable / non-Write tool names AC2 enumerates by name. `mcp__*`
// is matched by prefix below, separately -- every MCP tool is excluded on
// the same rule regardless of what name a future MCP server registers.
const FORBIDDEN_EXACT = [
  "Read",
  "Edit",
  "MultiEdit",
  "Grep",
  "Glob",
  "Bash",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Task",
];

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(QA_MD)) {
  fail(`.claude/agents/qa.md not found at ${path.relative(REPO_ROOT, QA_MD)}`);
}

const text = fs.readFileSync(QA_MD, "utf8");

const frontmatterMatch = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
if (!frontmatterMatch) {
  fail("qa.md has no YAML frontmatter block (--- ... ---) to read a `tools:` key from.");
}
const frontmatter = frontmatterMatch[1];

const toolsLineMatch = frontmatter.match(/^tools:\s*(.*)$/m);
if (!toolsLineMatch || toolsLineMatch[1].trim() === "") {
  fail(
    "qa.md frontmatter has no `tools:` key (or it's empty) -- the blind seat's structural " +
      "allowlist is missing entirely. Without it, nothing stops the seat from being handed " +
      "every built-in tool, including every read-capable one."
  );
}

const rawValue = toolsLineMatch[1].trim();
const tools = rawValue
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const forbiddenNamed = tools.filter((t) => FORBIDDEN_EXACT.includes(t) || t.startsWith("mcp__"));

if (forbiddenNamed.length > 0) {
  fail(
    `qa.md \`tools:\` allowlist names forbidden tool(s): ${forbiddenNamed.join(", ")}. ` +
      "The blind test-author must hold no tool capable of reading the diff, the implementation, " +
      "or the PR -- Write only. (Any mcp__* tool is excluded on the same rule: " +
      "mcp__Linear__get_diff is a diff reader.)"
  );
}

if (tools.length !== 1 || tools[0] !== "Write") {
  fail(`qa.md \`tools:\` allowlist must be exactly "Write", got: ${JSON.stringify(tools)}.`);
}

console.log('OK: qa.md `tools:` allowlist is exactly "Write" -- no read-capable tool, no mcp__* tool.');
