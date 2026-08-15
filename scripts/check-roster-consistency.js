#!/usr/bin/env node
"use strict";

/**
 * Roster-consistency check (ALI-107 criterion-5, automated).
 *
 * docs/ENGINE.md §14 documents the seed repo's file tree, including the
 * exact set of agent files under .claude/agents/. This script is the
 * enforcement half: it diffs the agent filenames docs/ENGINE.md §14 lists
 * against the agent files that actually exist on disk, in both directions.
 *
 * This guards the "Coach-orphan" class of drift — a role added to the
 * roster tree in prose but never given a file, or a file added/renamed on
 * disk without updating the documented tree — which is exactly the drift
 * ALI-107 found and fixed by hand. Fails CI if the two sets disagree.
 *
 * No dependencies; run directly with `node`.
 */

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const ENGINE_MD = path.join(REPO_ROOT, "docs", "ENGINE.md");
const AGENTS_DIR = path.join(REPO_ROOT, ".claude", "agents");

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(ENGINE_MD)) {
  fail(`docs/ENGINE.md not found at ${path.relative(REPO_ROOT, ENGINE_MD)}`);
}

const engineText = fs.readFileSync(ENGINE_MD, "utf8");

// Isolate §14's fenced tree block specifically, so agent-name mentions
// elsewhere in the doc (prose, the crew table in §2) can't produce false
// matches or false negatives for this check.
const section14Match = engineText.match(
  /## 14\. Seed repo structure\s*\n```([\s\S]*?)```/
);
if (!section14Match) {
  fail(
    "could not find the '## 14. Seed repo structure' fenced tree block in docs/ENGINE.md — " +
      "has the section been renamed or reformatted? Update this script's heading match if so."
  );
}
const treeBlock = section14Match[1];

// Within the tree block, only look at lines under the `agents/` line and
// before the next top-level `.claude/` child (e.g. `skills/`, `templates/`),
// so files listed under other directories can never be mistaken for agents.
const treeLines = treeBlock.split("\n");
const agentsStart = treeLines.findIndex((l) => /\bagents\/\s*$/.test(l.trim()));
if (agentsStart === -1) {
  fail("docs/ENGINE.md §14's tree has no 'agents/' line under .claude/ — roster is undocumented.");
}

const documentedAgents = new Set();
for (let i = agentsStart + 1; i < treeLines.length; i++) {
  const line = treeLines[i];
  // Stop at the next sibling of agents/ (a line whose tree-prefix depth
  // returns to .claude/'s child level, e.g. "│   ├── skills/").
  if (/├──\s+(skills|templates)\/|└──\s+(skills|templates)\//.test(line)) break;
  const m = line.match(/([A-Za-z0-9_-]+\.md)\b/);
  if (m) documentedAgents.add(m[1]);
}

if (documentedAgents.size === 0) {
  fail("parsed zero agent filenames out of docs/ENGINE.md §14's tree — parsing regressed, check the format.");
}

const actualAgents = new Set(
  fs.existsSync(AGENTS_DIR)
    ? fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md"))
    : []
);

const missingOnDisk = [...documentedAgents].filter((f) => !actualAgents.has(f)).sort();
const undocumented = [...actualAgents].filter((f) => !documentedAgents.has(f)).sort();

console.log(`docs/ENGINE.md §14 lists ${documentedAgents.size} agent file(s): ${[...documentedAgents].sort().join(", ")}`);
console.log(`.claude/agents/ contains ${actualAgents.size} agent file(s): ${[...actualAgents].sort().join(", ")}`);

if (missingOnDisk.length > 0 || undocumented.length > 0) {
  console.log("");
  if (missingOnDisk.length > 0) {
    console.error(`Documented in ENGINE.md §14 but missing from .claude/agents/: ${missingOnDisk.join(", ")}`);
  }
  if (undocumented.length > 0) {
    console.error(`Present in .claude/agents/ but not listed in ENGINE.md §14: ${undocumented.join(", ")}`);
  }
  console.error("\nFAIL: roster drift between docs/ENGINE.md §14 and .claude/agents/.");
  process.exit(1);
}

console.log("\nOK: roster in docs/ENGINE.md §14 matches .claude/agents/ exactly.");
