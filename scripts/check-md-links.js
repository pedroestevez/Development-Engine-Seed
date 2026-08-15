#!/usr/bin/env node
"use strict";

/**
 * Dependency-free markdown cross-reference checker.
 *
 * Scans CLAUDE.md, README.md, docs (*.md), and .claude (recursively, all
 * .md files) for markdown links -- [text](target) -- and validates every
 * relative link (i.e. not http(s)/mailto/etc.) resolves to a real file (or
 * directory) in the repo, and that any #anchor on the link resolves to a
 * real heading in the target file (or the current file, for same-file
 * anchors).
 *
 * No dependencies, no package.json required -- run directly with `node`.
 *
 * Exit code 0 = every relative link resolves. Exit code 1 = at least one
 * broken cross-reference, printed with file:line and the offending link.
 */

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");

const GLOB_ROOTS = [
  { file: "CLAUDE.md" },
  { file: "README.md" },
  { dir: "docs", pattern: /\.md$/ },
  { dir: ".claude", pattern: /\.md$/, recursive: true },
];

/** Recursively collect markdown files under a directory. */
function collectMarkdownFiles(absDir, pattern, recursive, out) {
  if (!fs.existsSync(absDir)) return out;
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) collectMarkdownFiles(abs, pattern, recursive, out);
      continue;
    }
    if (entry.isFile() && pattern.test(entry.name)) out.push(abs);
  }
  return out;
}

function findTargetFiles() {
  const files = [];
  for (const root of GLOB_ROOTS) {
    if (root.file) {
      const abs = path.join(REPO_ROOT, root.file);
      if (fs.existsSync(abs)) files.push(abs);
    } else {
      collectMarkdownFiles(
        path.join(REPO_ROOT, root.dir),
        root.pattern,
        !!root.recursive,
        files
      );
    }
  }
  // De-dupe (in case globs overlap).
  return [...new Set(files)];
}

/** GitHub-style heading slug: lowercase, strip non [a-z0-9 -_], spaces -> hyphens. */
function slugify(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^\w\- ]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** Return the set of valid anchor slugs for a markdown file (with dedupe suffixes). */
function headingAnchors(absPath) {
  const text = fs.readFileSync(absPath, "utf8");
  const seen = new Map();
  const anchors = new Set();
  const headingRe = /^#{1,6}\s+(.+?)\s*$/gm;
  let m;
  while ((m = headingRe.exec(text))) {
    const base = slugify(m[1]);
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

/** Extract [text](target) links with line numbers, skipping fenced code blocks. */
function extractLinks(absPath) {
  const text = fs.readFileSync(absPath, "utf8");
  const lines = text.split("\n");
  const links = [];
  let inFence = false;
  const linkRe = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  lines.forEach((line, idx) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    let m;
    linkRe.lastIndex = 0;
    while ((m = linkRe.exec(line))) {
      links.push({ target: m[1], line: idx + 1 });
    }
  });
  return links;
}

function isExternal(target) {
  return /^([a-z][a-z0-9+.-]*:)?\/\//i.test(target) || /^mailto:/i.test(target);
}

function checkFile(absPath, anchorCache, errors) {
  const relPath = path.relative(REPO_ROOT, absPath);
  const links = extractLinks(absPath);
  const selfAnchors = headingAnchors(absPath);

  for (const { target, line } of links) {
    if (isExternal(target)) continue;

    const [rawPath, rawAnchor] = target.split("#");
    const anchor = rawAnchor !== undefined ? decodeURIComponent(rawAnchor) : undefined;

    // Same-file anchor: [text](#section)
    if (rawPath === "") {
      if (anchor && !selfAnchors.has(anchor)) {
        errors.push(
          `${relPath}:${line}  broken same-file anchor "#${anchor}" in link (${target})`
        );
      }
      continue;
    }

    const targetAbs = path.resolve(path.dirname(absPath), decodeURIComponent(rawPath));

    if (!fs.existsSync(targetAbs)) {
      errors.push(`${relPath}:${line}  broken relative link -> ${target} (no such file: ${path.relative(REPO_ROOT, targetAbs)})`);
      continue;
    }

    if (anchor) {
      const stat = fs.statSync(targetAbs);
      if (stat.isDirectory()) {
        errors.push(`${relPath}:${line}  anchor "#${anchor}" used on a directory link (${target})`);
        continue;
      }
      if (!anchorCache.has(targetAbs)) {
        anchorCache.set(targetAbs, headingAnchors(targetAbs));
      }
      const anchors = anchorCache.get(targetAbs);
      if (!anchors.has(anchor)) {
        errors.push(`${relPath}:${line}  broken anchor "#${anchor}" in link -> ${target}`);
      }
    }
  }
}

function main() {
  const files = findTargetFiles();
  const errors = [];
  const anchorCache = new Map();

  for (const absPath of files) {
    checkFile(absPath, anchorCache, errors);
  }

  const relFiles = files.map((f) => path.relative(REPO_ROOT, f)).sort();
  console.log(`Checked ${files.length} markdown file(s) for cross-references:`);
  for (const f of relFiles) console.log(`  - ${f}`);

  if (errors.length > 0) {
    console.log("");
    console.error(`FAIL: ${errors.length} broken cross-reference(s):\n`);
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
  }

  console.log("\nOK: every relative cross-reference resolves.");
}

main();
