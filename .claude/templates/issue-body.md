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

**Outcome only.** Numbered. Each one testable from this issue alone, today,
with no further questions (gate 1). One named failure mode per risk label
(gate 2) — negative cases, failure modes, authz paths. A criterion that
embeds an unpinned literal — a bare line number, file path, count, exact
string, UI control, or command sequence with no evidence block behind it —
fails gate 8. Move it to `## Procedure` below, either pinned with its
evidence block or left as a build-time enumeration.

## Procedure (pinned or enumerated at build time)

Optional. Only for a criterion above that genuinely needs a line number, file
path, count, exact string, UI control, or command sequence. Each such item
carries gate 8's evidence block:

```
SOURCE:   <SHA, URL, or query the literal was read from>
READ AT:  <timestamp>
LITERAL:  <what was read>
```

Unpinned procedural detail belongs here only as an instruction to enumerate
at build time ("read the live tree; do X for every match") — never as a
remembered literal. Outcome and invariant are written at grooming and stay
durable; procedure written at groom time rots before the build runs unless
it is pinned here.

## Invariant

What must never become false, in checkable terms (gate 3).

## Definition of done

**Cite the standing Definition of Done** (`docs/ENGINE.md` §19) — do not
restate its clauses. State here only what is specific to this issue: which
criterion is load-bearing and proves the work has teeth rather than merely
being green, or an issue-specific demonstration the standing bar doesn't
already require.

## Files touched (predicted)

Named paths/modules (gate 4). This is the clustering input.

## Reversibility class

One of: `migration` / `money` / `external-send` / `human-action` / `none` (gate 7).
`human-action` → never Ready, never estimated, lives in Needs Pedro.
