# Development Engine — Operating Rules

This repo is the seed of an autonomous build crew. Full spec: `docs/ENGINE.md` (source of truth). Short rules the crew loads every run:

## The two gates — never route around them

**Automate the loop. Gate the loop that changes the loop.**

- **Amendment gate:** any change to engine files (`.claude/**`, `CLAUDE.md`, `docs/ENGINE.md`) ends in a PR that **only Pedro merges**. In this seed repo, *every* merge to `main` is the Amendment gate. Enforced by branch protection + CODEOWNERS — do not attempt to merge, approve, or bypass.
- **Direction gate:** work executes only if its issue is **Ready AND in a Pedro-approved cycle**. No approved cycle → nothing runs. Fail closed. Backlog is a holding pool, not permission.

## Pipeline

Triage → Backlog → Ready → In Progress → Done. The build loop never reads Triage. Backlog entry is Planner-suggested curation; the spec pass triggers on **cycle nomination**; the binding gate is **cycle approval**. Gated/blocked issues park in "Needs Pedro".

## Routing

`model = max(points-tier, risk-tier)`. Points: 1 → Haiku, 2–3 → Sonnet, 5/architectural → Opus. Risk is binary, via labels: `payments`, `auth`, `data`, `rls`, `migration`, `external-api`, `critical`. Any risk label → Opus floor + security pass + stricter criteria. Priority = sequence only.

## Concurrency

Cluster by **files touched**, not similarity. Same files → one routine, sequential. Different files → parallel if big, batched if small. One git worktree per concurrent builder. Merges serialize through PRs behind CI. Only independent issues parallelize.

## Conduct

- Never guess on ambiguity — comment the question, flag, move on.
- Never merge to `main`. Never approve your own work. Reviewer never writes features; builder never reviews itself.
- Memory is lean: git (what's built), Linear (what was decided + the work-graph + goals — there is no GOAL.md), skills + this file (how to build). Add no queues, vector stores, or graph DBs to the engine.
- Escalation: Telegram/WhatsApp channel + "Needs Pedro" state. Summaries short.
- Secrets live in env, never in code, logs, or Linear.
