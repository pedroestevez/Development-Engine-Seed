/**
 * Dispatcher runtime — the blind view (ALI-105).
 *
 * Extracts exactly what the blind test-author seat is allowed to see out of
 * a Linear issue's raw description: the `## Acceptance criteria`,
 * `## Invariant`, and `## Definition of done` sections, verbatim — never
 * `## Why` or `## What`, which routinely carry the implementation sketch
 * (ALI-105's own body: ALI-98's `## What` is literally the SQL fix). This
 * module is the runtime half of blindness; the seat's own `tools: Write`
 * allowlist (`.claude/agents/qa.md`) is the config half, and the two are
 * independent controls on purpose — either one failing alone still leaves
 * the other standing.
 *
 * Pure and synchronous: no I/O, no Linear SDK. `run.ts` is the only caller,
 * and it supplies the already-fetched issue body.
 */

/**
 * Exactly what reaches the blind seat. Every field required — a caller
 * cannot construct this type while omitting one, and (AC6) `DispatchContext`
 * is not structurally assignable to it, because `DispatchContext` has none
 * of these five field names on it at all.
 */
export interface BlindDispatchContext {
  issueId: string;
  title: string;
  acceptanceCriteria: string;
  invariant: string;
  definitionOfDone: string;
}

/** AC7: the issue body had no `## Acceptance criteria` heading, or the section under it was empty. */
export interface UnparseableBlindView {
  ok: false;
  /** Names the missing/empty heading — the loud-skip Linear comment quotes this verbatim. */
  reason: string;
}

export interface ParsedBlindView {
  ok: true;
  context: BlindDispatchContext;
}

export type BlindViewResult = ParsedBlindView | UnparseableBlindView;

const REQUIRED_HEADING = "Acceptance criteria";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extracts the text under a level-2 markdown heading (`## <name>`), up to
 * the next level-2 heading or end of string. Returns `undefined` if the
 * heading itself is absent — distinct from an empty string, which means the
 * heading exists but nothing follows it before the next section.
 */
function extractSection(body: string, headingName: string): string | undefined {
  // The trailing alternative is `(?![\s\S])` -- true end-of-*string* --
  // rather than a bare `$`. With the `m` flag (needed so `^` can anchor to
  // any line, not just the start of the whole body), a bare `$` also
  // matches end-of-*line*, which falsely terminates the lazy capture one
  // character in whenever the heading is immediately followed by a blank
  // line (the common case): the empty line's start is simultaneously its
  // own end, so `[\s\S]*?` would stop having captured nothing at all.
  const pattern = new RegExp(
    `^##[ \\t]+${escapeRegExp(headingName)}[ \\t]*\\r?\\n([\\s\\S]*?)(?=\\r?\\n##[ \\t]+|(?![\\s\\S]))`,
    "m",
  );
  const match = body.match(pattern);
  return match ? match[1].trim() : undefined;
}

/**
 * The one entry point `run.ts` calls. Given the issue's `id`, `title`, and
 * raw markdown `body` — nothing else, in particular never a worktree path,
 * a branch, or predicted files — either returns the blind context (AC1 of
 * the invariant: nothing describing the implementation is in it) or an
 * `UnparseableBlindView` naming exactly what's missing (AC7).
 *
 * `## Invariant` and `## Definition of done` are extracted the same way but
 * are not gates: a body missing either section still parses, with that
 * field carried through as an empty string — only `## Acceptance criteria`
 * (missing or empty) makes the view unparseable, per AC7's literal scope.
 */
export function extractBlindView(issue: { id: string; title: string; body: string }): BlindViewResult {
  const acceptanceCriteria = extractSection(issue.body, REQUIRED_HEADING);

  if (acceptanceCriteria === undefined) {
    return {
      ok: false,
      reason: `no "## Acceptance criteria" heading found in ${issue.id}'s issue body`,
    };
  }
  if (acceptanceCriteria === "") {
    return {
      ok: false,
      reason: `"## Acceptance criteria" section in ${issue.id}'s issue body is empty`,
    };
  }

  const invariant = extractSection(issue.body, "Invariant") ?? "";
  const definitionOfDone = extractSection(issue.body, "Definition of done") ?? "";

  return {
    ok: true,
    context: {
      issueId: issue.id,
      title: issue.title,
      acceptanceCriteria,
      invariant,
      definitionOfDone,
    },
  };
}
