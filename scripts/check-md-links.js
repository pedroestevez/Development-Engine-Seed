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
 * Every path this script touches is confined to the repository root before it
 * is touched -- lexically, and again through symlinks (see isInsideRepo
 * below). That covers both halves of the invariant:
 *
 *   * paths derived from *file content* -- markdown link targets (finding F3);
 *   * the script's own *scan roots* -- the four fixed names it opens on its
 *     own initiative, before any link has been parsed (finding S1).
 *
 * A path that escapes the root is an error, never a skipped path.
 *
 * No dependencies, no package.json required -- run directly with `node`.
 *
 * Exit code 0 = every relative link resolves inside the repo. Exit code 1 =
 * at least one broken or escaping cross-reference, printed with file:line
 * and the offending link.
 */

const fs = require("fs");
const path = require("path");

// Canonical (symlink-resolved) repository root. Security-pass finding F3
// requires the comparison base itself be a realpath: comparing a realpath'd
// target against a non-canonical root would misjudge every path the moment
// any ancestor directory of the checkout is a symlink.
const REPO_ROOT = fs.realpathSync(path.resolve(__dirname, ".."));

/**
 * SECURITY -- finding F3 (ALI-100 security pass, comment 0d889e41).
 *
 * True iff `p` is the repository root or lives underneath it. Every
 * filesystem path this script derives from *file content* -- i.e. from a
 * markdown link, which any pull request can author -- must satisfy this
 * before it is touched. Without it, `[x](../../../../etc/hostname)` passes:
 * the gate then proves links resolve on the CI runner, not in the repo, and
 * doubles as a one-bit read oracle over every runner-readable path.
 *
 * `p` must already be absolute and normalized (path.resolve does both).
 * The `+ path.sep` is deliberate -- a bare startsWith(REPO_ROOT) would also
 * accept a sibling directory whose name merely begins with the root's.
 */
function isInsideRepo(p) {
  return p === REPO_ROOT || p.startsWith(REPO_ROOT + path.sep);
}

const GLOB_ROOTS = [
  { file: "CLAUDE.md" },
  { file: "README.md" },
  { dir: "docs", pattern: /\.md$/ },
  { dir: ".claude", pattern: /\.md$/, recursive: true },
];

/**
 * SECURITY -- finding S1 (ALI-128 security pass, PR #16).
 *
 * Confine a SCAN ROOT. The F3 guards in checkFile() cover paths parsed out of
 * markdown; they are never reached by the path that decides *which files the
 * checker opens in the first place*. Each of the four GLOB_ROOTS names is a
 * path a pull request can replace with a symlink, so `CLAUDE.md`, `README.md`,
 * `docs/` and `.claude/` are as attacker-reachable as any link target.
 *
 * Returns the confined absolute path, or null if there is nothing to scan.
 *
 * A root that exists but escapes is an ERROR (-> exit 1), NOT a silent skip.
 * That choice is deliberate and is the whole point of the fix: skipping would
 * be a false pass in the literal sense -- a PR that replaces `.claude` with a
 * symlink would make the gate print "OK: every relative cross-reference
 * resolves" having examined none of the agent roster. A gate the gated change
 * can silence enforces nothing, so this takes the same call guards 1 and 2
 * already take for links: name it and fail.
 *
 * An ABSENT root stays a silent skip. That is pre-existing, intended
 * behaviour (a repo need not have a README), and unlike an escaping root it
 * reveals nothing about the filesystem outside the checkout.
 *
 * Existence is decided with lstatSync, never existsSync: existsSync follows
 * symlinks, so it would answer a question about the external target before
 * any confinement check ran. The two escaping outcomes -- resolves outside,
 * or does not resolve at all -- deliberately share one identical, target-free
 * message, so a red build leaks no bit about what lives out there.
 */
function resolveScanRoot(relName, errors) {
  const abs = path.join(REPO_ROOT, relName);
  const escaped = `scan root "${relName}" exists but does not resolve to a path inside the repository root; refusing to scan it`;

  try {
    fs.lstatSync(abs); // does NOT follow symlinks -- cannot stat outside.
  } catch (err) {
    if (err.code === "ENOENT") return null; // absent: nothing to scan.
    errors.push(`scan root "${relName}" could not be examined (${err.code || err.message})`);
    return null;
  }

  let real;
  try {
    real = fs.realpathSync(abs);
  } catch (err) {
    errors.push(escaped); // e.g. a dangling symlink -- same message, no oracle.
    return null;
  }
  if (!isInsideRepo(real)) {
    errors.push(escaped);
    return null;
  }
  return abs;
}

/**
 * Recursively collect markdown files under a directory.
 *
 * S1: every directory the walk enters is confined on entry -- the initial
 * scan root (already checked by resolveScanRoot; re-checked here so this
 * function holds its own invariant rather than inheriting one from its
 * caller) and every recursion step. Without it, `docs` -> `/` turns this walk
 * into a filesystem crawl bounded only by the job's timeout-minutes.
 *
 * Note: entries that are themselves symlinks are neither descended into nor
 * collected -- Dirent reports the link's own type, not its target's, so
 * isDirectory()/isFile() are both false for one. They cannot pull the walk
 * outside the root; they are simply not scanned.
 */
function collectMarkdownFiles(absDir, pattern, recursive, out, errors) {
  let realDir;
  try {
    realDir = fs.realpathSync(absDir);
  } catch (err) {
    if (err.code !== "ENOENT") {
      errors.push(`directory "${path.relative(REPO_ROOT, absDir)}" could not be examined (${err.code || err.message})`);
    }
    return out;
  }
  if (!isInsideRepo(realDir)) {
    errors.push(
      `directory "${path.relative(REPO_ROOT, absDir)}" does not resolve to a path inside the repository root; refusing to scan it`
    );
    return out;
  }

  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) collectMarkdownFiles(abs, pattern, recursive, out, errors);
      continue;
    }
    if (entry.isFile() && pattern.test(entry.name)) out.push(abs);
  }
  return out;
}

function findTargetFiles(errors) {
  const files = [];
  for (const root of GLOB_ROOTS) {
    if (root.file) {
      const abs = resolveScanRoot(root.file, errors);
      if (abs) files.push(abs);
    } else {
      const abs = resolveScanRoot(root.dir, errors);
      if (abs) collectMarkdownFiles(abs, root.pattern, !!root.recursive, files, errors);
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

/**
 * decodeURIComponent that cannot take the whole scan down -- finding S4
 * (ALI-128 security pass, PR #16). A malformed escape (`%zz`, or a legitimate
 * stray `%` as in `docs/50%-plan.md`) threw URIError straight out of main(),
 * aborting at the first bad link and leaving every later file unchecked -- a
 * stack trace instead of a file:line message.
 *
 * Falling back to the raw literal is safe, not a bypass: both F3 guards run
 * on whatever this returns, so an undecodable target is confined exactly like
 * a decoded one, and it still has to resolve to a real in-repo file to pass.
 */
function safeDecodeURIComponent(s) {
  try {
    return decodeURIComponent(s);
  } catch (err) {
    return s;
  }
}

function checkFile(absPath, anchorCache, errors) {
  const relPath = path.relative(REPO_ROOT, absPath);
  const links = extractLinks(absPath);
  const selfAnchors = headingAnchors(absPath);

  for (const { target, line } of links) {
    if (isExternal(target)) continue;

    const [rawPath, rawAnchor] = target.split("#");
    const anchor = rawAnchor !== undefined ? safeDecodeURIComponent(rawAnchor) : undefined;

    // Same-file anchor: [text](#section)
    if (rawPath === "") {
      if (anchor && !selfAnchors.has(anchor)) {
        errors.push(
          `${relPath}:${line}  broken same-file anchor "#${anchor}" in link (${target})`
        );
      }
      continue;
    }

    const targetAbs = path.resolve(path.dirname(absPath), safeDecodeURIComponent(rawPath));

    // F3 guard 1 of 2 -- LEXICAL, before the first filesystem call. A `../`
    // chain that walks out of the root is rejected here, so `existsSync`
    // never gets to answer a question about a path outside the repository.
    // This is an ERROR (-> exit 1), never a silent `continue`: a gate that
    // quietly skips the links it finds suspicious enforces nothing.
    if (!isInsideRepo(targetAbs)) {
      errors.push(
        `${relPath}:${line}  link escapes the repository root -> ${target} (resolves to ${targetAbs}, outside ${REPO_ROOT})`
      );
      continue;
    }

    // Existence is decided with lstatSync, not existsSync -- finding S3
    // (ALI-128 security pass, PR #16). existsSync FOLLOWS symlinks, so it
    // answered a question about the external target before guard 2 ran, and
    // the two outcomes printed different messages: a working one-bit
    // existence oracle over any runner-readable path, one bit per red build.
    // lstat only ever asks about the in-repo entry itself.
    //
    // Residual, deliberately left open rather than read as closed: a
    // symlinked *directory component* mid-path (`docs/etcdir` -> `/etc`, link
    // `etcdir/hostname`) is still traversed by lstat's own path walk before
    // guard 2 fires. Guard 2 rejects it and no content is ever read, but the
    // stat itself lands outside. Closing that needs the nearest existing
    // ancestor canonicalized first; not taken here.
    try {
      fs.lstatSync(targetAbs);
    } catch (err) {
      if (err.code === "ENOENT") {
        errors.push(`${relPath}:${line}  broken relative link -> ${target} (no such file: ${path.relative(REPO_ROOT, targetAbs)})`);
      } else {
        errors.push(`${relPath}:${line}  link target could not be examined -> ${target} (${err.code || err.message})`);
      }
      continue;
    }

    // F3 guard 2 of 2 -- SYMLINK, after lstat has confirmed the entry exists
    // and before ANY read of it (statSync below, and readFileSync via
    // headingAnchors). A committed in-repo symlink is inside the root
    // lexically and outside it in fact, so guard 1 cannot see it. Placed
    // ahead of the `if (anchor)` block rather than inside it, so an
    // unanchored link to an escaping symlink is caught too: the invariant is
    // "no gate script reads outside the repository root", not "no anchored
    // link does".
    //
    // S3: the two escaping outcomes -- resolves outside, or does not resolve
    // at all (dangling) -- share one identical message that names the in-repo
    // link but never echoes the external path it landed on.
    let targetReal = null;
    try {
      targetReal = fs.realpathSync(targetAbs);
    } catch (err) {
      targetReal = null;
    }
    if (targetReal === null || !isInsideRepo(targetReal)) {
      errors.push(
        `${relPath}:${line}  link escapes the repository root via symlink -> ${target} (${path.relative(REPO_ROOT, targetAbs)} does not resolve to a path inside the repository root); target not read`
      );
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
  // S1: findTargetFiles reports into the same error list as the link checks --
  // an escaping scan root fails the run exactly like an escaping link target.
  const errors = [];
  const files = findTargetFiles(errors);
  const anchorCache = new Map();

  for (const absPath of files) {
    checkFile(absPath, anchorCache, errors);
  }

  const relFiles = files.map((f) => path.relative(REPO_ROOT, f)).sort();
  console.log(`Checked ${files.length} markdown file(s) for cross-references:`);
  for (const f of relFiles) console.log(`  - ${f}`);

  if (errors.length > 0) {
    console.log("");
    // S1 widened this list past link targets (an unscannable scan root lands
    // here too), so the heading no longer claims every entry is a link.
    console.error(`FAIL: ${errors.length} error(s):\n`);
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
  }

  console.log("\nOK: every relative cross-reference resolves.");
}

main();
