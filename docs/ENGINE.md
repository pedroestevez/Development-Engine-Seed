# Development Engine — Implementation Spec

> **North star (human-set intent):** An autonomous, self-improving build crew that takes a well-defined product backlog in Linear and ships it — cloned into any product repo, governed by two human gates.

This describes the **finished engine**, not a rollout. It is general-purpose: it can build a booking platform, an e-commerce store, a legal system, a property-management system — anything expressed as a Linear backlog. The seed repo (`development-engine-seed`) is canonical; product repos template from it; improvements promote back here so the engine compounds across products.

Pedro is product owner. The engine builds.

---

## 1. Operating principle — constitutional autonomy

**Automate the loop. Gate the loop that changes the loop.**

A loop may run autonomously when its output is **independently verifiable** *and* a mistake is **contained** to one unit of work. It stays **human-gated** when neither holds — when nothing inside the loop can confirm the output is *right*, and a mistake **propagates** to everything built afterward.

Exactly two decisions meet that gated bar, because both are *second-order* — they change the machine rather than run it:

- **Amendment gate** — changes to the **engine itself** (agent/skill/prompt files). A bad change isn't independently checkable and corrupts every future build. Enforced by **permissions, not prompts** — see §16.
- **Direction gate** — what **enters a cycle**: admission to execution. There's no internal oracle for "is this the right thing to build *now*," and a wrong call wastes weeks. Backlog is a **holding pool**, not a commitment; nothing executes unless Pedro approved the cycle it belongs to (**fail closed**). See §3.

Everything between — execute, review, sequence, report — is verifiable and contained, so it loops without a human.

**Lineage:** this is military *mission command*. The commander reserves **intent** (the end state) and **doctrine** (how the force operates) and delegates all execution. Intent = the north star + each product's "first-wave" definition. Doctrine = this document + the agent files. Pedro keeps a commander's two reservations and automates the rest.

---

## 2. The crew — roles, not workers

A subagent file is a **role**, not a worker. The orchestrator spins up as many concurrent instances of a role as needed; concurrency is a dial, not a roster. There is one `builder.md`, never builder1–5.

| Role | Model | What it does | Writes to |
|---|---|---|---|
| **Orchestrator** | Opus | Coordinates one run: reads an issue, calls the chain, routes worker models, logs outcomes. Mechanical dispatch — **never originates work**. | Linear (comments/status) |
| **Spec / BA** | Opus | Turns a promoted issue into **acceptance criteria + story points + risk labels**; runs the readiness check. The judgment seat. | Linear (issue body) |
| **Builder** | Sonnet | Implements the issue in its own git worktree; commits; opens the PR. | repo (branch/PR) |
| **Reviewer** | Sonnet | Independent check: runs the CI gate + tests, diffs against the acceptance criteria, reports pass/fail with reasons. **Does not write the feature.** | Linear (comment), PR |
| **Planner** | Sonnet | Retro, backlog grooming, next-cycle composition, file-overlap clustering. (Opus if you want sharper retros.) | Linear (cycle, retro doc) |
| **Researcher** | Sonnet | Research-labeled issues / external unknowns; gathers + synthesizes **with evidence**; turns findings into spec'd issues. | Linear (Triage, docs) |
| **Scribe** | Haiku | Mechanical writing: README/changelog/playbook sync, retro transcription. | repo, Linear |
| **Explore** | Haiku | Read-only recon (Claude Code built-in): reads a large codebase in its own context, returns a summary. | nothing (read-only) |
| **Security** | Opus | **Conditional pass** — runs only on risk-flagged issues. Reviews payments/auth/RLS/migrations/secrets; reports findings, doesn't rewrite. | Linear (comment), PR |

**Why the tiers:** Opus where judgment lives (coordination, decomposition, security). Sonnet for code that must compile and pass review. Haiku only for mechanical search and transcription — never feature code. A great BA lowers *ambiguity*, not the intrinsic difficulty of writing correct code, so it can't make a Haiku builder safe.

---

## 3. The work pipeline — Linear statuses

**Backlog → Ready → In Progress → In Review → Done**, with **Parked** and **Needs Pedro** as the two off-ramps. Every arrow is an automated pass except one: the Direction gate sits at **cycle admission**, not backlog entry.

> **These must be the literal status names on the product's Linear team board.** A pipeline described here but absent from Linear is unrunnable — the dispatcher matches on status names, so a mismatch means it admits nothing, forever. Any change to this list is a change to the board, and vice versa. When cloning this seed into a new product, creating these statuses is step one.

**A status earns its place only if the engine behaves differently for it.** That test is why there is no separate `Triage`: to the build loop, Triage and Backlog both mean *not admissible*, so a second status for it enforces nothing. Raw candidates go to Backlog carrying the `research` label; the Planner curates from there. Revisit only when researcher volume justifies Linear's native Triage inbox.

1. **Backlog** — the holding pool. Raw candidates and groomed-but-uncommitted work both live here. The build loop **never reads Backlog**. Planner-suggested promotion out of it is curation, **not a gate**; nothing in it is a commitment to build.
2. **→ Ready** — triggered by **cycle nomination**: when the Planner nominates Backlog issues for the next cycle, the Readiness/Spec pass enriches them (points, definition of done, risk labels, ambiguity removed) and **checks each is buildable** against the seven gate questions in `spec.md` — including that `weighted_cost ≤ run budget`, because an issue too large for one run is by definition not Ready. Passes → **Ready**; fails → **Needs Pedro** *now*, in planning, not at 2am mid-build. **Human-action issues** — reversibility class `human-action`, executable only by Pedro — are exempt from the estimate and budget gates, are never estimated, and go to **Needs Pedro** rather than counting as readiness failures. Speccing a nominee Pedro later rejects costs a few tokens — accepted, so approval is over **pointed, spec'd issues, not vibes**.
3. **Cycle approval — the Direction gate.** The Planner composes the proposed cycle from Ready issues; the proposal reaches Pedro on the escalation channel (§12); **one tap approves**. No approved cycle → nothing runs (**fail closed**). Change of mind mid-cycle: pull an item and unstarted work never starts; in-flight work gets its PR **parked, not merged**. Merges happen only for issues still in the approved cycle at merge time.
4. **→ In Progress → In Review → Done** — the build loop pulls **the approved cycle's Ready issues** only and runs them, with the review gate inside. `In Review` means the PR is open and awaiting the reviewer, the blind test-author, and (on risk-labelled issues) the security pass.

### The two off-ramps

- **Parked** *(started)* — work a run's backstop interrupted. An artifact always exists: a preserved worktree and an open draft PR. **No human decision is required** — it simply needs another run, and the next run drains Parked *before* admitting anything new against the budget, since finishing sunk work is strictly cheaper than starting fresh.
- **Needs Pedro** *(unstarted)* — work blocked on a **decision**: an unresolved ambiguity, a failed readiness check, a gate hit — or a **human action** only Pedro can perform. Excluded from every run until Pedro answers.

Keeping these distinct is what keeps the escalation queue worth reading. Parked work in "Needs Pedro" would fill it with items Pedro cannot act on.

**"Ready" means "won't stall."** The mid-sprint pause is an *unreadiness* symptom — cured by gating readiness upstream, not by hoping the build doesn't stall.

**No issue ever ends a run in "In Progress".** After any run, every issue it touched is in exactly one of: `In Review` (PR open), `Parked` (artifact preserved), or `Needs Pedro` (decision required) — plus those never admitted, which stay `Ready` with a logged deferral reason. "In Progress with nothing behind it" is the state that rots silently, so it is asserted against rather than merely discouraged.

---

## 4. Routing — points + risk, two separate fields

Each field drives exactly one decision; never overload one number.

- **Story points = size/effort** → keeps the Planner's velocity honest. Tiers: **1 → Haiku, 2–3 → Sonnet, 5 / architectural → Opus.**
- **Priority = sequence** → order within a cycle.
- **Risk = criticality** → its own signal, **binary**, carried by **labels** the BA sets:
  - **Area labels:** `payments`, `auth`, `data`/`rls`, `migration`, `external-api`. The orchestrator keeps a **danger list**; any issue carrying one auto-routes to the high-risk path.
  - **`critical`** — manual override for danger an area label doesn't capture (tenant-isolation logic, webhook signature verification).

**Model selection: `model = max(points-tier, risk-tier)`.** A 1-point payments task still routes to **Opus**, runs the **security pass**, and gets **stricter acceptance criteria**. Risk floors behavior **up** — that's how "needs more care" is encoded, as gates, not an inflated point value. (Area labels double as the Planner's file-overlap signal, so one label set serves both risk routing and batching.)

Risk also **prices** the work: `weighted_cost = points × (any danger label ? 2.0 : 1.0)`, checked against the run budget at refinement (§3, `spec.md`). **Human-action issues carry neither points nor risk labels** — they never route to a model; they live in `Needs Pedro`.

---

## 5. Concurrency & batching

Subagents **multiply tokens** (each re-reads context in its own window), so they buy *context isolation and parallelism*, never cost savings. Subdivide an issue only when it's genuinely too large for one context. Parallelism across issues comes from running **more routines / worktrees**, not from a swarm inside one run.

**Group by one measurable question: do these issues touch the same files?** ("Similar" is a leaky proxy — the thing that makes issues similar is usually shared files — so cluster on the fact, not the vibe.)

- **Same files** → **one routine, sequential.** Collision-safe, and context loads once (a free token win).
- **Different files** → **parallel routines if big** (high points), **batched into one routine if small** (low points — not worth standing up a worktree for a 10-minute job).

**Worktree isolation:** each concurrent builder gets its own `git worktree` (own directory + branch + `npm install`). The collision risk is at the *filesystem* level, not the branch level. Merges serialize through PRs into `main` behind the CI gate, so any overlap surfaces as an ordinary merge conflict — never a silent overwrite. Only **independent** issues parallelize; dependency chains run in order.

The Planner owns this clustering — a line in its job, not a separate agent.

---

## 6. The loops — routines

A routine wraps a **loop, not an issue**: one run boots the orchestrator, which iterates over many issues. The orchestrator **decides what to call** — the order is not hand-scripted. Depth lives in the files (`orchestrator.md` = routing + gates; each agent file = role/tools/model); a run prompt just points at the work and says go.

- **Build (nightly).** Orchestrator pulls the **approved cycle's Ready** issues in priority + dependency order and runs each **Build → Review → log** (Spec already done upstream). Stops on: sprint empty, a gate hit (flag and move on), or nearing the usage window (logs a resume point). Morning result: a mostly-built sprint + a short summary.
- **Readiness / Spec (on cycle nomination, before the Direction gate).** Enriches nominated issues to **Ready** or flags. Also available as a **by-hand skill** to pressure-test a single issue while validating a proposal.
- **Plan (every 1–3 days).** Planner writes the retro + grooms + composes the next-cycle **proposal** (one-tap approval = the Direction gate); the **Coach** proposes engine PRs; the **PO/Researcher** proposes Triage candidates. Output: one digest for Pedro.

**Triggers:** scheduled; **on-demand API** (an HTTP POST from the phone to run the build loop *now*); minimal **GitHub events** (kept narrow — that's where accidental loops hide).

Routine budget is ample: nightly build + planning every few days is 1–2 runs/day against a 15/day cap — headroom to split runs or add on-demand kicks. The constraint was never routine count; it's the usage window and how fast Pedro refills work, which is why the loop stops and resumes rather than forcing everything into one sitting.

---

## 7. Self-improvement — the Coach

The meta-loop is the one loop that can quietly eat the system, so it is **gated, never autonomous.** The Coach **edits nothing.** From the retro it opens a **PR against the agent/skill files** with evidence ("3 escalations on webhook ambiguity → here's a tighter criteria block"); Pedro merges or rejects (Amendment gate). It points the same PR + CI pipeline the engine already uses at the engine's *own definitions*.

**Promotion to seed:** improvements useful beyond one product are promoted back to `development-engine-seed`, so the next clone starts smarter. Product repos pull engine updates when they choose. In-repo copies may evolve freely; the seed is how the engine compounds across products. The one discipline: promote broadly-useful improvements back.

---

## 8. Metrics — read the logs, not a dashboard

This is not a metrics system; it's the Planner reading the loop's own logs (the orchestrator already comments every outcome + gate result + bounce count on each issue). A five-line retro, no dashboard until volume forces one.

- **First-pass rate** — issues cleared Spec→Build→Review without bouncing. System health; also tunes the Haiku/Sonnet line.
- **Escalation count + reason** — where to invest (tighter criteria vs. infra task).
- **Defect escape** — anything marked Done that later reopened or threw in production (product analytics can feed this). **This is the metric for agents** — their failure mode isn't "too slow," it's "passed review but was wrong."

Each metric maps to one knob: bounces → model tier or spec strictness; escalations → feature-definition or infra; escape → a missing acceptance criterion (add it so the Reviewer catches that whole class next time). Fix the **loudest one** each retro. **Cost** (the Max usage cap) is a budget watched separately — never folded into the velocity definition.

---

## 9. Forecasting

- **Velocity is measured, not assumed** — sprint 1 is a guess; trustworthy by sprint 3–4.
- Measure **quality-adjusted throughput**: points that cleared Review **and** Pedro's sign-off — correct, accepted work only. Rework prices itself in; speed falls out.
- The cadence limiter is **Pedro** (define + approve), not the agents — which is why 1–3 day cycles fit.
- Forecast to a **frozen cut line** (a product's "first-wave" issue set), not "done."
- **weeks-to-first-wave ≈ (remaining MVP points ÷ velocity) × cycle length.** The first BA pass — pointing the backlog — supplies the numerator.

---

## 10. Memory & data — the engine is lean

The engine needs no queue, vector store, or graph DB. Its memory already exists as three durable stores:

- **git** — what's been built.
- **Linear** — what was decided and why (issues, comments, retros) **and the work-graph** (priorities, parent/child, blocks). Linear is also the **goal layer** — there is **no GOAL.md**.
- **skill + `CLAUDE.md` files** — how to build.

**One exception:** if the playbook ever outgrows keyword search — the builder demonstrably missing guidance that's in the docs, or context bloating from over-loading — add a **vector index over the skill docs only**. That's a symptom to feel, not predict.

**Heavy retrieval is product architecture, not engine plumbing.** A legal or property product is itself a vector + graph + memory system (RAG over documents, a graph of clients→matters→deadlines→documents, per-tenant memory) — built on managed providers (Supabase/pgvector, Clerk), not inside the engine. The test that travels: **does the question require traversing edges, or matching meaning? Edges → graph. Meaning → vector. Both → hybrid.**

---

## 11. Isolation & blast radius

The engine is highly autonomous, so it runs under **least privilege**. Cloned into a product repo, it can touch **only that repo's own Linear project** — scoped credentials per repo, no cross-project reach. Each **product repo ↔ one Linear project**, 1:1. New Triage/Ready states and autonomous runs in one product can't affect another.

---

## 12. Escalation

The engine reaches Pedro on **Telegram** (free bot API; WhatsApp via Twilio/Meta as a swap-in) for: **cycle proposals (one-tap approve — the Direction gate)**, gate-blocked issues, decisions needed, and run summaries. The channel is a **deterministic webhook** — proposal out, approve/reject in, anything else lands as a Linear comment — and **fails closed**: no approval, no run. Gated issues also park in a **"Needs Pedro"** state in Linear so nothing is lost if a message is missed.

---

## 13. Credential & billing boundary

The line is **which credential makes the model call.**

- **Native Claude Code subagents** (markdown in `.claude/agents/`) and **Routines** run on the Max subscription legitimately — the genuine `claude` client makes the call. This is the engine's default home.
- A **continuous, unattended, programmatic orchestrator** (Agent SDK / custom framework calling the model itself) must use its **own API key** — not the subscription. That's the later, always-on variant, not the core loop.
- Code runs free on the sub; the moment **code invokes a model instance**, that call needs the API. A deterministic script (no inference) is always free.

---

## 14. Seed repo structure

```
development-engine-seed/
├── .claude/
│   ├── agents/
│   │   ├── orchestrator.md      (Opus — routing table + the two gates)
│   │   ├── spec.md              (Opus — BA: criteria, points, risk labels, readiness)
│   │   ├── builder.md           (Sonnet — implements in a worktree)
│   │   ├── reviewer.md          (Sonnet — CI + criteria check, no writes)
│   │   ├── planner.md           (Sonnet — retro, grooming, cycle composition)
│   │   ├── researcher.md        (Sonnet — discovery with evidence)
│   │   ├── scribe.md            (Haiku — docs/changelog/retro transcription)
│   │   └── security.md          (Opus — conditional risk pass)
│   ├── skills/                  (best-practice build skills)
│   └── templates/
│       └── issue-body.md        (the issue shape the readiness gate checks)
├── docs/
│   ├── ENGINE.md                (this document — source of truth)
│   └── OPERATING-RULES.md       (north star + the two-gate rule)
├── .github/
│   └── CODEOWNERS               (engine files require Pedro's review — see §16)
├── CLAUDE.md                    (entry point / operating rules the crew loads)
└── README.md
```

Templated into each product repo. Improvements PR back here.

---

## 15. The human surface (Pedro)

Everything verifiable and contained runs without Pedro. His entire surface is:

1. **Feed the backlog** — define features well; keep a continuous list.
2. **Answer the two gates** — approve cycle proposals with one tap (**Direction**); merge or reject engine PRs (**Amendment**).
3. **Answer escalations** — the flagged decisions a run surfaces.

That's it. Define and approve; the engine does the rest.

---

## 16. The engine builds the engine

The seed repo is itself a product: `development-engine-seed` has its own Linear project, and the crew works its backlog like any other. The tension — engine self-changes must still clear the Amendment gate — is resolved by **permissions, not prompts**, because an agent can misread an instruction but cannot override branch protection:

- **Seed repo: every merge to `main` *is* the Amendment gate.** Branch protection requires Pedro's review; the crew's credentials cannot approve or merge. The crew runs engine issues autonomously — worktree, branch, PR, reviewer pass — but every run terminates at a PR Pedro merges.
- **Product repos: CODEOWNERS on `.claude/**`, `CLAUDE.md`, and `docs/ENGINE.md`.** Feature PRs merge behind the CI gate as usual; anything touching engine files requires Pedro's review even there.

The Coach (§7) is one caller of this path, not a special case: **all** engine changes, whoever authors them, end in a human-merged PR. Self-building cannot bypass the gate by construction.

---

## 17. Master orchestrator — the cross-project control plane

One tier above the per-project orchestrators, so multiple products build simultaneously without Pedro babysitting one repo at a time. **Not** a separate engine per repo — one control plane over many clones.

**v1 is a deterministic dispatcher, not an agent.** Its jobs — hold the project registry, kick each project's on-demand run endpoint on schedule, collect digests, route cycle proposals and approvals to Pedro's phone — need no inference. Per the credential rule (§13), deterministic code runs free: **no API key needed**. It graduates to an agent with its **own API key** only when it starts making judgment calls (cross-project rebalancing, priority arbitration) — a day that is earned, not assumed.

**Blast radius:** the master holds **zero repo or Linear write credentials**. It can trigger runs and read status; each per-project orchestrator keeps its own scoped creds (§11). A compromised or wrong master produces spurious run triggers — never code writes, never cross-project reach.

**Sequencing:** captured here, built **after** one repo's Spec→Build→Review loop has run by hand. The cross-project plane sits on top of a working single-project loop, never in place of one.

---

## 18. Horizon — one surface, many products

End state: as products are added, the master dispatcher runs approved cycles across all repos in parallel, and Pedro's whole job stays the surface in §15 — feed backlogs, tap approvals, answer escalations. One engine, many products, simultaneous. Every v1 interface above (per-project run endpoints, cycle proposals over the escalation channel, scoped creds per repo) is already shaped for it.
