# GATES.md — every gate, what it protects, and what actually enforces it

This document exists because `docs/ENGINE.md` describes several gates in
prose, and prose is not the same thing as enforcement. ALI-100 exists
because two of them — the Amendment gate and the roster it depends on —
turned out to be pure convention with no enforcing mechanism behind them.

**The rule for this file: never flatter a gate.** If a gate's only backing
is an instruction an agent could misread or skip, the marker says `prompt`,
even where `docs/ENGINE.md` describes it as a hard guarantee. The gap
between "documented" and "enforced" is the thing this file is for — closing
it belongs to the issues linked in each row, not to this file pretending
the gap is already closed.

**Marker vocabulary** — `enforced by:` is always one of:

| Marker | Means |
|---|---|
| `branch protection` | A GitHub ruleset/branch-protection rule rejects the action outright, independent of any agent's behavior. |
| `file` | A checked-in file (CODEOWNERS, config) that GitHub or CI reads mechanically. |
| `script` | Code that runs and can fail the build (a CI job, a checked test). |
| `human` | The only thing standing between "requested" and "happens" is a person choosing to act (or not). |
| `prompt` | An instruction in a `.md` file (agent role, `CLAUDE.md`, skill). An agent can misread or skip it; nothing mechanical stops that. |

A gate can have more than one marker if different halves of what it
promises are backed differently — that split is exactly the kind of detail
this file should not average away.

---

## The gates

| Gate | What it protects | Enforcement mechanism | Enforced by | Gap, today |
|---|---|---|---|---|
| **Amendment** | Engine files (`.claude/**`, `CLAUDE.md`, `docs/**`, `.github/**`) — no self-change to the engine lands without Pedro. | GitHub branch-protection ruleset `main protection` on `main` (Active, bypass list empty, blocks force-push, restricts deletions, requires a PR before merge) + `.github/CODEOWNERS` (this PR). | **branch protection** for "no direct write to `main`" (verified live: a deliberate direct push from the crew's credentials was rejected with `GH013: Repository rule violations`, recorded on ALI-110) · **file** for declared ownership (CODEOWNERS), **staged, not yet load-bearing** | Required approvals are **0** by design — `pedroestevez` is the sole collaborator, and GitHub forbids self-approval, so any non-zero value would make every PR permanently unmergeable. "Require review from Code Owners" is off for the same reason. So today the ruleset guarantees *a PR must exist and nothing bypasses it*, but **not** *Pedro personally reviewed it* — that second half still rests on the fact that only Pedro holds push/merge rights, not on a review requirement. It becomes real enforcement once the crew gets its own GitHub identity and required-approvals goes to 1 (ALI-100's CODEOWNERS comment; tracked informally, not yet a filed issue). Separately, "require status checks" is **off** in the ruleset, deliberately — see the CI row. |
| **Direction** | What enters a build cycle — no issue executes without Pedro approving the cycle it's in. | `docs/ENGINE.md` §12: cycle proposals go to Pedro over the escalation channel; agent files (`orchestrator.md`, `CLAUDE.md`) instruct the build loop to only pull the approved cycle's Ready issues. | **prompt**, in practice backed by **human** — every run today is started by Pedro pointing a builder session at a specific approved issue (this run included); there is no standing autonomous loop yet that a wrong instruction could fool. | The master dispatcher (`docs/ENGINE.md` §17, ALI-102/ALI-103) that would mechanically refuse to dispatch an issue outside an approved cycle does not exist yet. Nothing in code currently stops a misinstructed agent from picking up unapproved work — only the fact that nothing runs unattended does. |
| **CI** | Every PR against this repo, and every push to `main` — a red run is visible before merge. | `.github/workflows/ci.yml` (this PR): markdown cross-reference check, agent-roster consistency check, dispatcher-test placeholder. | **script**, once this PR merges and the workflow has run | Not yet a *required* status check on the `main` protection ruleset — deliberately, per ALI-110: "a required status check that never reports blocks every merge forever," so it was left off until this workflow existed and could run green at least once. Until someone flips that switch in repo settings, a red CI run is visible and honest, but does not itself block the merge button — Pedro merging by hand is still the actual backstop. |
| **Security pass** | Payments/auth/data/RLS/migration/`critical`-labeled issues get an independent Opus review before merge. | `docs/ENGINE.md` §4 + `security.md`: any risk label routes the issue through the Security role as a conditional step in the pipeline. | **prompt** | No mechanical gate currently blocks a risk-labeled PR from merging without a recorded security pass — it's an instruction the orchestrator and reviewer follow, not a check CI or branch protection enforces. Becomes checkable once the dispatcher (ALI-103) emits a run log with the security-pass outcome per issue. |
| **Money gate** | Reversibility-class `money` issues (real financial effect — charges, subscription changes) never execute without a human decision. | `spec.md`'s reversibility-class field, set at the readiness pass; `money`-classed issues are routed to **Needs Pedro** rather than admitted to a cycle. | **prompt** | The classification and the routing are both currently a judgment call by the Spec/BA agent, applied by hand — there is no dispatcher check that refuses to admit a `money`-classed issue the way ALI-102's budget check will refuse an over-budget one. A misclassified issue would not be mechanically caught before it reached Ready. |
| **Run budget** | One build run never admits more `weighted_cost` than it can safely finish (`points × (danger label ? 2.0 : 1.0) ≤ 5`), so overflow is caught at planning time, not mid-run. | `spec.md`'s readiness gate computes and checks this by hand during the Spec/BA pass, before an issue can become Ready. | **prompt** | ALI-102 ("Dispatcher core: story-point admission... as pure, tested functions") is the actual enforcement — a pure, tested `admit()` function that cannot silently admit an over-budget issue the way a model reading a soft numeric instruction sometimes will. ALI-102 is still in **Backlog**, unstarted. Until it lands, the budget check is only as reliable as the BA agent's arithmetic. |
| **Backstop** | A run that's burning more wall-clock/tokens than planned stops cleanly at an issue boundary instead of dying mid-file — work in flight is always preserved (`Parked`, draft PR), never left half-done. | `docs/ENGINE.md` §3/§6: the orchestrator is instructed to stop on "sprint empty, a gate hit, or nearing the usage window" and log a resume point. | **prompt** | ALI-103 ("Dispatcher runtime: backstop, parked work, and the run log") is the actual enforcement — a hard wall-clock/token kill switch that preserves the worktree and opens a `[parked]` draft PR regardless of what the running agent does. ALI-103 is still in **Backlog**, unstarted. Until it lands, "the run stops before it burns the window" depends on the orchestrator noticing and doing the right thing — nothing outside the agent forces the stop. |

---

## Reading this table

Two gates in this list are backed by something that isn't a `.md` file
today: the Amendment gate's no-direct-push property (`branch protection`,
verified by an actual rejected push — ALI-110) and, incidentally, every
merge in this repo (`human`, because `pedroestevez` is the only
collaborator with push rights). Every other row is `prompt` — a real
instruction, followed so far, but not yet a thing that fails loudly on its
own if ignored. That is not a defect in this file; it is the defect this
file's existence is supposed to make impossible to miss.

**What flips a `prompt` row to something stronger**, in order of what's
already scoped:

- Amendment → full strength once the crew has its own GitHub identity and
  required-approvals goes to 1 with Code Owner review on (self-approval
  becomes structurally impossible instead of merely absent because no one
  else can push).
- CI → a hard gate once "require status checks" is turned on in the `main
  protection` ruleset, which needed this workflow to exist and run first.
- Run budget / Backstop → `script`, once ALI-102 and ALI-103 land.
- Direction / Security pass / Money gate → `script`, once the dispatcher
  (`docs/ENGINE.md` §17) exists to mechanically enforce what today are
  agent instructions.

Until then: this repo runs on disciplined agents and one attentive human.
The point of this file is that nobody has to take that on faith.
