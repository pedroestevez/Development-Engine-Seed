# Development Engine — Operating Rules

This repo is the seed of an autonomous build crew. Full spec: `docs/ENGINE.md` (source of truth). Short rules the crew loads every run:

## The two gates — never route around them

**Automate the loop. Gate the loop that changes the loop.**

- **Amendment gate:** any change to engine files (`.claude/**`, `CLAUDE.md`, `docs/ENGINE.md`, `.github/**`, `scripts/**`) ends in a PR that **only Pedro merges**. In this seed repo, *every* merge to `main` is the Amendment gate. Enforced by branch protection + CODEOWNERS — do not attempt to merge, approve, or bypass. `.github/**` and `scripts/**` are named explicitly because the gate's *enforcement logic* lives there (finding F1): a PR that reduces a checker to `process.exit(0)` greens every job, so it is an engine change no matter how small the diff.
- **Direction gate:** work executes only if its issue is **Ready AND in a Pedro-approved cycle**. No approved cycle → nothing runs. Fail closed. Backlog is a holding pool, not permission.

## Pipeline

Backlog → Ready → In Progress → In Review → Done. These are the **literal Linear status names** — the dispatcher matches on them, so docs and board must never drift apart. The build loop never reads Backlog. Backlog exit is Planner-suggested curation; the spec pass triggers on **cycle nomination**; the binding gate is **cycle approval**.

Two off-ramps, and the distinction matters: **Parked** = a backstop interrupted the work, an artifact exists, no decision needed — the next run drains it first. **Needs Pedro** = blocked on a human decision, excluded from runs until answered. No separate Triage status: to the build loop it would be identical to Backlog, and a status that changes no behaviour enforces nothing. Raw candidates sit in Backlog with the `research` label.

## Routing

`model = max(points-tier, risk-tier)`. Points: 1 → Haiku, 2–3 → Sonnet, 5/architectural → Opus. Risk is binary, via labels: `payments`, `auth`, `data`, `rls`, `migration`, `external-api`, `critical`. Any risk label → Opus floor + security pass + stricter criteria. Priority = sequence only.

## Concurrency

Cluster by **files touched**, not similarity. Same files → one routine, sequential. Different files → parallel if big, batched if small. One git worktree per concurrent builder. Merges serialize through PRs behind CI. Only independent issues parallelize.

## Conduct

- Never guess on ambiguity — comment the question, flag, move on.
- Never merge to `main`. Never approve your own work. Reviewer never writes features; builder never reviews itself.
- The blind test-author (`qa.md`) reads only the issue's acceptance criteria, invariant, and definition of done — never the diff, the implementation, or the PR.
- Memory is lean: git (what's built), Linear (what was decided + the work-graph + goals — there is no GOAL.md), skills + this file (how to build). Add no queues, vector stores, or graph DBs to the engine.
- Self-improvement is the planner's Coach role (`docs/ENGINE.md` §7), not a separate seat: at most one evidence-backed PR per retro against engine files — it never edits them directly.
- Escalation: Telegram/WhatsApp channel + "Needs Pedro" state. Summaries short.
- Secrets live in env, never in code, logs, or Linear.
