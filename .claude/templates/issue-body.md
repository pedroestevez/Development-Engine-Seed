# Issue body template

Every spec'd issue uses these sections, in this order. The dispatcher parses this
shape; the readiness gate in `.claude/agents/spec.md` checks these fields.
Delete the hint lines, keep the headings.

---

## Why

The problem and the evidence for it — file:line, a failing run, a decision already
recorded. Not a wish.

## What

The intended change, concretely enough that the builder makes no design decisions
you haven't made.

## Acceptance criteria

Numbered. Each one testable from this issue alone, today, with no further
questions (gate 1). One named failure mode per risk label (gate 2) — negative
cases, failure modes, authz paths.

## Invariant

What must never become false, in checkable terms (gate 3).

## Definition of done

The done-state, testable. Which criterion proves the work has teeth rather than
merely being green.

## Files touched (predicted)

Named paths/modules (gate 4). This is the clustering input.

## Reversibility class

One of: `migration` / `money` / `external-send` / `human-action` / `none` (gate 7).
`human-action` → never Ready, never estimated, lives in Needs Pedro.
