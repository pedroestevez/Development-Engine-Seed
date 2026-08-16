/**
 * Dispatcher runtime — the run loop.
 *
 * Wraps ALI-102's pure planning core (`./plan.js`) in a runtime that reads
 * Linear, dispatches agents, survives being cut off, and answers "why did
 * this run pick what it picked?" (the run log, `./runlog.js`).
 *
 * Two mechanisms, never conflated:
 *   - **Points bound scope**, checked once, before any dispatch: `plan()`.
 *   - **The backstop bounds resources**, checked *during*, because
 *     estimates are wrong. It is never the normal stopping condition —
 *     normal stops are `cycle-empty` and `budget-exhausted`. A backstop
 *     fire is a calibration defect and is counted as one (AC9).
 *
 * Ports and adapters: every side effect is behind an injected interface
 * (`LinearPort`, `GitHubPort`, `WorktreePort`, `EnginePinPort`, `AgentPort`,
 * `Clock`). This file's own logic — the run loop itself — is a deterministic
 * function of those ports' behavior, which is what makes criteria 1–7
 * testable without network, real git, or real subprocesses (see
 * `__tests__/run.test.ts`).
 *
 * The pin (ALI-104): `runDispatcher()` resolves its own engine commit via
 * `EnginePinPort.resolveEngineSha()` — never a caller-supplied config field
 * — and every agent this run spawns reads `.claude/**` from a read-only
 * detached checkout at that pin (`EnginePinPort.createPinnedTree()`), kept
 * separate from the mutable per-cluster work worktrees `WorktreePort`
 * creates. A run resuming interrupted work sets `RuntimeConfig.requiredPin`;
 * if the freshly-resolved HEAD no longer matches it, the run refuses
 * (`stop_reason: "engine-drift"`) rather than execute against a different
 * engine version than the one that parked it.
 *
 * One exception, by design: `runDispatcher()` itself never touches the
 * filesystem, so the run-loop logic above keeps testing purely against
 * fakes. `runDispatcherAndPersist()` is the thin wrapper around it that
 * actually writes `.engine/runs/<iso-timestamp>.json` — the one real `node:fs`
 * call in this file, isolated at the bottom on purpose.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { extractBlindView, type BlindDispatchContext } from "./blindqa.js";
import { hasDangerLabel, plan, weightedCost } from "./plan.js";
import type { DispatcherConfig, Issue, RunPlan } from "./types.js";
import {
  checkStatusDrift,
  statusDriftMessage,
  type CycleRef,
  type LinearIssue,
  type LinearPort,
} from "./linear.js";
import type { DraftPrResult, EnginePinPort, GitHubPort, WorktreeHandle, WorktreePort } from "./worktree.js";
import {
  deferralReasonToVerdict,
  redact,
  renderCycleSummary,
  scrubSecrets,
  serializeRunLog,
  type CandidateLogEntry,
  type ClusterLogEntry,
  type IssueOutcome,
  type RedactedCredentials,
  type RunLog,
  type SeatName,
  type SeatOutcome,
  type StopReason,
} from "./runlog.js";

// ---------------------------------------------------------------------------
// Ports this runtime consumes beyond Linear/GitHub/Worktree
// ---------------------------------------------------------------------------

export type Seat = "builder" | "reviewer" | "security";

/** Re-exported for callers (tests included) that want the blind seat's context type without a second import. */
export type { BlindDispatchContext } from "./blindqa.js";

export interface DispatchContext {
  issue: Issue;
  worktreePath: string;
  branch: string;
  /**
   * Absolute path to this run's read-only pinned engine tree — the sole
   * source of `.claude/**` for the agent this context is handed to (ALI-104
   * AC2). Never the same tree as `worktreePath`: that one is mutable and
   * per-cluster, this one is detached and shared by the whole run.
   */
  enginePath: string;
}

export interface AgentDispatchResult {
  summary: string;
  /** This stage required a bounce (rework round) — counted, not itself re-looped by this runtime. */
  bounced?: boolean;
  /** Set when the seat found an unresolvable ambiguity — "never guess" (CLAUDE.md conduct rule). */
  ambiguous?: { question: string };
  tokensUsed?: number;
}

/**
 * What the blind test-author's dispatch returns (ALI-105). Deliberately not
 * `AgentDispatchResult`: the blind seat never produces a free-text
 * `summary`, and its `ambiguous`-shaped signal (an untestable criterion)
 * must never route through `finalizeNeedsPedro()` the way the builder's
 * does (AC8) — giving it its own result type makes that impossible to wire
 * up by accident, rather than merely undocumented.
 */
export interface BlindQaDispatchResult {
  /** Paths the seat wrote under `.engine/blind-tests/<ISSUE-ID>/` — test files plus `manifest.json`. */
  testFilesWritten: string[];
  /** Acceptance-criterion numbers the seat could not write a test for (AC3, AC8) — never guessed, always named. */
  untestableCriteria: number[];
  tokensUsed?: number;
}

/**
 * Dispatches one seat (builder/reviewer/security). The real adapter shells
 * out to the `claude` CLI; for this PR it is a thin stub clearly marked as
 * wired in a follow-up issue (matching this port's treatment in the spec) —
 * the runtime logic that calls it is complete and fully tested against
 * fakes.
 */
export interface AgentPort {
  dispatch(seat: Seat, ctx: DispatchContext): Promise<AgentDispatchResult>;
  /**
   * The blind test-author's entry point (ALI-105) — deliberately a
   * *different method*, taking a *different context type*, from `dispatch`
   * above. `BlindDispatchContext` carries none of `DispatchContext`'s
   * fields (`worktreePath`, `branch`, `enginePath`, the full `issue`) — see
   * `blindqa.ts`. That asymmetry is what makes "nothing describing the
   * implementation can reach this seat" a property the compiler enforces
   * rather than a convention `dispatch()` callers are trusted to honor.
   */
  dispatchBlindQa(ctx: BlindDispatchContext): Promise<BlindQaDispatchResult>;
}

export interface Clock {
  /** Epoch milliseconds. The run loop's only source of time — no `Date.now()` calls of its own. */
  now(): number;
}

/** Real adapter — intentionally a stub. See `linear.ts`'s `createLinearApiPort` doc comment. */
export function createClaudeCliAgentPort(): AgentPort {
  return {
    dispatch(): Promise<AgentDispatchResult> {
      throw new Error(
        "AgentPort real adapter not wired in this PR (shells out to the claude CLI) — " +
          'see the ALI-103 PR\'s "Decisions the spec left open" section.',
      );
    },
    dispatchBlindQa(): Promise<BlindQaDispatchResult> {
      throw new Error(
        "AgentPort real adapter not wired in this PR (dispatchBlindQa, shells out to the claude CLI) — " +
          'see the ALI-103 PR\'s "Decisions the spec left open" section. ALI-105 wires the runtime dispatch ' +
          "call itself (proven against fakes); the real claude-CLI adapter for it stays a stub, same as " +
          "builder/reviewer/security.",
      );
    },
  };
}

export function createSystemClock(): Clock {
  return { now: () => Date.now() };
}

// ---------------------------------------------------------------------------
// Runtime configuration
// ---------------------------------------------------------------------------

/** Never placed in a `RunLog` directly — always passed through `redact()` first (AC10). */
export interface RuntimeCredentials {
  linearApiKey?: string;
  githubToken?: string;
}

export interface BackstopConfig {
  /** Primary. Checked at issue boundaries only — before dispatching the next issue, never mid-file. */
  wallClockSoftMs: number;
  /**
   * Far beyond the soft deadline — an in-flight issue that is *still*
   * running this long after the run started is hard-killed at its next
   * in-progress checkpoint, regardless of stage. Must be > `wallClockSoftMs`.
   */
  wallClockHardMs: number;
  /** Secondary to wall-clock. Checked at the same issue boundaries; only wall-clock has a hard tier. */
  tokenBudgetSoft?: number;
}

/** 4h wall-clock soft, per spec. Hard tier is a further +2h grace — undocumented exact value upstream. */
export const DEFAULT_BACKSTOP: BackstopConfig = {
  wallClockSoftMs: 4 * 60 * 60 * 1000,
  wallClockHardMs: 6 * 60 * 60 * 1000,
};

export interface RuntimeConfig {
  /** ALI-102's admission/partitioning config — budget, risk weight, max concurrency. */
  dispatcher: DispatcherConfig;
  backstop: BackstopConfig;
  /**
   * The git ref a cluster's *first* issue forks its per-issue branch from
   * when it has no predecessor in this run, e.g. `"origin/main"` — a
   * remote-tracking ref, valid for `git checkout`/`git worktree` but
   * **not** something GitHub will accept as a PR `base` (that's
   * `basePrBranch`, immediately below — the ALI-133 fix: real GitHub 422s
   * on a `base` starting `origin/`). Deliberately **not** the ref the
   * cluster's scaffold worktree branches from (ALI-104 AC3): that is
   * always the resolved pin. A PR opened against a commit rather than a
   * branch could never be merged, so pin / baseRef / basePrBranch must
   * never collapse into each other even though all three are "some git
   * ref" at a glance.
   */
  baseRef: string;
  /**
   * The GitHub branch name (e.g. `"main"`) a cluster's *first* issue's PR
   * targets when it has no predecessor in this run — ALI-133 AC4. Distinct
   * from `baseRef` on purpose: `baseRef` is a git ref `forkBranch` can fork
   * a local branch from (including a remote-tracking ref like
   * `"origin/main"`); `basePrBranch` is a value `openDraftPr`'s `base`
   * hands to GitHub, which must be a real branch in the repo. The two
   * happen to name "the same place" in practice, but only one of them is
   * ever legal as a PR base.
   */
  basePrBranch: string;
  /**
   * Set only when resuming work a previous run parked. That prior run's
   * `runLog.engineSha` — the version `.claude/**` had when it parked. If
   * the freshly-resolved HEAD (`EnginePinPort.resolveEngineSha()`) no
   * longer matches, the run refuses via `stop_reason: "engine-drift"`
   * rather than resume on a version of the engine the parked artifact was
   * never built against (ALI-104 AC4). Unset on a fresh run — no drift
   * check applies. Deliberately **not** named `engineSha`: the run's own
   * pin is never a config input (AC1) — this field only ever *constrains*
   * it, never supplies it.
   */
  requiredPin?: string;
}

export interface RunDeps {
  linear: LinearPort;
  github: GitHubPort;
  worktree: WorktreePort;
  /** ALI-104: resolves the run's own pin and creates the read-only tree every agent reads `.claude/**` from. */
  enginePin: EnginePinPort;
  agent: AgentPort;
  clock: Clock;
  credentials: RuntimeCredentials;
}

export interface RunResult {
  runLog: RunLog;
  /** `JSON.stringify(runLog)`, scrubbed — write this to `.engine/runs/<iso-timestamp>.json`. */
  runLogJson: string;
  /** The short human summary — post this as the cycle comment. Already scrubbed. */
  cycleSummary: string;
}

// ---------------------------------------------------------------------------
// Internal dispatch state — shared across every cluster's lane
// ---------------------------------------------------------------------------

interface DispatchState {
  runStartMs: number;
  totalTokensUsed: number;
  hardKilled: boolean;
  softStopped: boolean;
  softKind?: "wallclock" | "tokens";
}

/** Wall-clock only — a hard *token* kill is out of scope for this PR (see "Decisions the spec left open"). */
function isBeyondHard(clock: Clock, config: RuntimeConfig, state: DispatchState): boolean {
  return clock.now() - state.runStartMs >= config.backstop.wallClockHardMs;
}

/** Wall-clock primary, tokens secondary — whichever trips first, checked in that priority order. */
function evaluateSoftBackstop(
  clock: Clock,
  config: RuntimeConfig,
  state: DispatchState,
): "wallclock" | "tokens" | null {
  if (clock.now() - state.runStartMs >= config.backstop.wallClockSoftMs) return "wallclock";
  if (
    config.backstop.tokenBudgetSoft !== undefined &&
    state.totalTokensUsed >= config.backstop.tokenBudgetSoft
  ) {
    return "tokens";
  }
  return null;
}

// ---------------------------------------------------------------------------
// The candidate ledger — one entry per Ready issue in the cycle (AC2)
// ---------------------------------------------------------------------------

/**
 * `Issue` (the type every dispatch-pipeline function is declared against)
 * carries no `body` — only `LinearIssue` does (`linear.ts`). At runtime the
 * object flowing through this pipeline always originated from
 * `LinearPort.getReadyIssuesInCycle()`, so it always carries one; this is
 * the single, explicit place that reaches for it, rather than widening
 * `Issue` itself and letting `body` leak into every pure function that
 * takes one (`plan.ts`'s core included).
 */
function issueBody(issue: Issue): string {
  const body = (issue as LinearIssue).body;
  return typeof body === "string" ? body : "";
}

function mustGetLedger(ledger: Map<string, CandidateLogEntry>, id: string): CandidateLogEntry {
  const entry = ledger.get(id);
  if (!entry) throw new Error(`internal error: no ledger entry for issue ${id}`);
  return entry;
}

function buildCandidateLedger(runPlan: RunPlan): Map<string, CandidateLogEntry> {
  const ledger = new Map<string, CandidateLogEntry>();
  const tierById = new Map(runPlan.tiers.map((t) => [t.issueId, t]));

  const seed = (issue: Issue, verdict: CandidateLogEntry["verdict"]): void => {
    const tier = tierById.get(issue.id);
    if (!tier) throw new Error(`internal error: no tier result for issue ${issue.id}`);
    ledger.set(issue.id, {
      issueId: issue.id,
      points: issue.points,
      labels: issue.labels,
      weightedCost: weightedCost(issue, runPlan.config),
      verdict,
      tier,
      seats: [],
      bounces: 0,
      outcome: "not-dispatched",
      estimatedConsumption: { weightedCost: weightedCost(issue, runPlan.config) },
    });
  };

  for (const issue of runPlan.admitted) seed(issue, "admitted");
  for (const { issue, reason } of runPlan.deferred) seed(issue, deferralReasonToVerdict(reason));

  return ledger;
}

// ---------------------------------------------------------------------------
// Per-issue dispatch pipeline: builder -> blind QA (ALI-105) -> reviewer -> security?
// ---------------------------------------------------------------------------

interface IssueDispatchResult {
  hardKilled: boolean;
  outcome: IssueOutcome;
  seats: SeatOutcome[];
  bounces: number;
  tokensUsed: number;
}

const SEAT_ORDER: readonly SeatName[] = ["builder", "blindQa", "reviewer", "security"];

function buildResumeNote(seats: readonly SeatOutcome[], resumePoint: string): string {
  const done = seats.filter((s) => s.status === "ran").map((s) => s.seat);
  const touched = new Set(seats.map((s) => s.seat));
  const remaining = SEAT_ORDER.filter((s) => !touched.has(s));
  return (
    `Interrupted by the run backstop, ${resumePoint}.\n\n` +
    `Done: ${done.length > 0 ? done.join(", ") : "(nothing completed yet)"}.\n` +
    `Remaining: ${remaining.length > 0 ? remaining.join(", ") : "(none)"}.`
  );
}

async function finalizeParked(
  issue: Issue,
  worktreeHandle: WorktreeHandle,
  deps: RunDeps,
  prBase: string,
  engineSha: string,
  cycle: CycleRef,
  seats: SeatOutcome[],
  resumePoint: string,
): Promise<DraftPrResult> {
  // Preserve first — a hard kill must never lose the artifact, whatever fails after this line.
  await deps.worktree.preserve(worktreeHandle);
  await deps.github.pushBranch(worktreeHandle.path, worktreeHandle.branch);
  const pr = await deps.github.openDraftPr({
    branch: worktreeHandle.branch,
    // ALI-133 AC3: the predecessor's branch if one exists in this run, else
    // `config.basePrBranch` — computed by the caller (the cluster lane
    // loop), which is the only place that tracks pred(i).
    base: prBase,
    title: `[parked] ${issue.id} ${issue.title}`,
    body: `${buildResumeNote(seats, resumePoint)}\n\nEngine SHA: ${engineSha}.`,
  });
  // Preserve the issue's existing (approved) cycle -- the ALI-103 addendum:
  // moving an issue out of Backlog was observed to silently auto-assign the
  // *current* cycle if the caller doesn't set one explicitly. Interrupted
  // work belongs to the cycle that admitted it.
  await deps.linear.setIssueStatus(issue.id, "Parked", cycle.id);
  await deps.linear.addComment(
    issue.id,
    `${buildResumeNote(seats, resumePoint)}\n\nEngine SHA: \`${engineSha}\`.\nPR: ${pr.url}`,
  );
  return pr;
}

async function finalizeNeedsPedro(
  issue: Issue,
  deps: RunDeps,
  engineSha: string,
  question: string,
): Promise<void> {
  // Clear the cycle -- excluded from every run until Pedro answers (the addendum's other half).
  await deps.linear.setIssueStatus(issue.id, "Needs Pedro", null);
  await deps.linear.addComment(
    issue.id,
    `Ambiguity found — flagged rather than guessed, per conduct.\n\n${question}\n\n` +
      `Engine SHA: \`${engineSha}\`.`,
  );
}

async function finalizeOpenedPr(
  issue: Issue,
  worktreeHandle: WorktreeHandle,
  deps: RunDeps,
  prBase: string,
  engineSha: string,
  cycle: CycleRef,
  seats: SeatOutcome[],
): Promise<DraftPrResult> {
  await deps.github.pushBranch(worktreeHandle.path, worktreeHandle.branch);
  const pr = await deps.github.openDraftPr({
    branch: worktreeHandle.branch,
    // ALI-133 AC3/AC4: predecessor's branch if pred(i) exists, else
    // `config.basePrBranch` — a real GitHub branch name, never `baseRef`
    // (which may be a remote-tracking ref GitHub would 422 on as a base).
    base: prBase,
    title: `${issue.id}: ${issue.title}`,
    body: `Implements ${issue.id}. Engine SHA: ${engineSha}.`,
  });
  await deps.linear.setIssueStatus(issue.id, "In Review", cycle.id);
  const seatSummary = seats.map((s) => `${s.seat}: ${s.status}${s.detail ? ` — ${s.detail}` : ""}`).join("\n");
  await deps.linear.addComment(
    issue.id,
    `Seats:\n${seatSummary}\n\nEngine SHA: \`${engineSha}\`.\nPR: ${pr.url}`,
  );
  return pr;
}

async function dispatchOneIssue(
  issue: Issue,
  worktreeHandle: WorktreeHandle,
  enginePath: string,
  engineSha: string,
  deps: RunDeps,
  config: RuntimeConfig,
  cycle: CycleRef,
  state: DispatchState,
  /** ALI-133 AC3: this issue's PR base, already resolved by the caller (pred(i)'s branch, or config.basePrBranch). */
  prBase: string,
): Promise<IssueDispatchResult> {
  const ctx: DispatchContext = {
    issue,
    worktreePath: worktreeHandle.path,
    branch: worktreeHandle.branch,
    enginePath,
  };
  const seats: SeatOutcome[] = [];
  let bounces = 0;
  let tokensUsed = 0;

  const record = (result: AgentDispatchResult): void => {
    tokensUsed += result.tokensUsed ?? 0;
    if (result.bounced) bounces++;
  };

  // Stage 1: builder.
  const builderResult = await deps.agent.dispatch("builder", ctx);
  record(builderResult);
  seats.push({ seat: "builder", status: "ran", detail: builderResult.summary });

  if (builderResult.ambiguous) {
    await finalizeNeedsPedro(issue, deps, engineSha, builderResult.ambiguous.question);
    return { hardKilled: false, outcome: "needs-pedro", seats, bounces, tokensUsed };
  }

  // Checkpoint 1/3 (AC5): after builder, before blind QA.
  if (isBeyondHard(deps.clock, config, state)) {
    await finalizeParked(issue, worktreeHandle, deps, prBase, engineSha, cycle, seats, "after builder");
    return { hardKilled: true, outcome: "parked", seats, bounces, tokensUsed };
  }

  // Stage 2: blind QA (ALI-105) -- a real dispatch, through an entry point
  // that takes a *different* context type than every other seat's. The
  // extraction below reads only the issue's own id/title/body; it never
  // sees `ctx` (worktreePath/branch/enginePath), so there is no path by
  // which this stage could hand the seat anything describing the
  // implementation, even if a future edit tried to.
  const blindView = extractBlindView({ id: issue.id, title: issue.title, body: issueBody(issue) });
  if (!blindView.ok) {
    // AC7: loud skip, never a silent "ran" with nothing produced. Routing
    // is unchanged -- this never reroutes to Needs Pedro or Parked; the run
    // continues straight to the reviewer, same as every other blindQa exit.
    seats.push({ seat: "blindQa", status: "skipped (unparseable criteria)", detail: blindView.reason });
    await deps.linear.addComment(
      issue.id,
      `Blind QA skipped for ${issue.id}: ${blindView.reason}. This is a spec escape (the issue's ` +
        "acceptance criteria are unparseable), not an ambiguity -- routing is unchanged, and the run " +
        "continues to the reviewer.",
    );
  } else {
    const blindResult = await deps.agent.dispatchBlindQa(blindView.context);
    tokensUsed += blindResult.tokensUsed ?? 0;
    const detailParts = [`${blindResult.testFilesWritten.length} test file(s) written`];
    if (blindResult.untestableCriteria.length > 0) {
      // AC8: named by number, in the seat detail (and therefore in the
      // seat-summary comment `finalizeOpenedPr` renders below) -- never
      // silently dropped, and never routed through finalizeNeedsPedro
      // (that branch only ever reads `builderResult.ambiguous`, above).
      detailParts.push(`untestable criteria: ${blindResult.untestableCriteria.join(", ")}`);
    }
    seats.push({ seat: "blindQa", status: "ran", detail: detailParts.join("; ") });
  }

  // Stage 3: reviewer.
  const reviewerResult = await deps.agent.dispatch("reviewer", ctx);
  record(reviewerResult);
  seats.push({ seat: "reviewer", status: "ran", detail: reviewerResult.summary });

  // Checkpoint 2/3 (AC5): after reviewer, before security (or its skip).
  if (isBeyondHard(deps.clock, config, state)) {
    await finalizeParked(issue, worktreeHandle, deps, prBase, engineSha, cycle, seats, "after reviewer");
    return { hardKilled: true, outcome: "parked", seats, bounces, tokensUsed };
  }

  // Stage 4: security -- conditional on a danger label.
  if (hasDangerLabel(issue.labels)) {
    const securityResult = await deps.agent.dispatch("security", ctx);
    record(securityResult);
    seats.push({ seat: "security", status: "ran", detail: securityResult.summary });
  } else {
    seats.push({ seat: "security", status: "skipped (not applicable)" });
  }

  // Checkpoint 3/3 (AC5): after security (or its skip), before finalize.
  if (isBeyondHard(deps.clock, config, state)) {
    await finalizeParked(issue, worktreeHandle, deps, prBase, engineSha, cycle, seats, "after security");
    return { hardKilled: true, outcome: "parked", seats, bounces, tokensUsed };
  }

  await finalizeOpenedPr(issue, worktreeHandle, deps, prBase, engineSha, cycle, seats);
  return { hardKilled: false, outcome: "opened-pr", seats, bounces, tokensUsed };
}

// ---------------------------------------------------------------------------
// Cluster-level concurrency: one worktree per cluster, sequential within it,
// parallel across clusters up to laneCount (AC6).
// ---------------------------------------------------------------------------

/**
 * ALI-133 AC1: one branch per issue, always — never per cluster. Every
 * branch this run pushes, and every `branch`/`base` `openDraftPr` sees,
 * names exactly one issue id.
 */
function branchNameFor(issue: Issue): string {
  return `dispatcher/${issue.id}`;
}

/**
 * The cluster's throwaway scaffold branch — the argument `createWorktree`
 * gets to stand the shared worktree up in the first place. Deliberately
 * namespaced away from `branchNameFor`'s per-issue output (`_scaffold/`)
 * so it can never collide with a real issue id, and deliberately never
 * passed to `pushBranch` or `openDraftPr` (AC1) — `forkBranch` moves the
 * worktree onto the first issue's real branch before any work happens.
 */
function clusterScaffoldBranchNameFor(cluster: readonly Issue[]): string {
  return `dispatcher/_scaffold/${cluster.map((issue) => issue.id).join("-")}`;
}

async function runClustersWithConcurrency(
  clusters: readonly Issue[][],
  lanes: number,
  worker: (cluster: readonly Issue[]) => Promise<void>,
): Promise<void> {
  if (clusters.length === 0) return;
  let next = 0;
  const laneWorkers = Array.from({ length: Math.max(1, Math.min(lanes, clusters.length)) }, async () => {
    while (next < clusters.length) {
      const index = next++;
      const cluster = clusters[index];
      if (cluster) await worker(cluster);
    }
  });
  await Promise.all(laneWorkers);
}

// ---------------------------------------------------------------------------
// Stop-reason derivation
// ---------------------------------------------------------------------------

/** No backstop, no gate: the run drained on its own. Budget, not emptiness, decided the boundary. */
function deriveNormalStopReason(runPlan: RunPlan): "cycle-empty" | "budget-exhausted" {
  const hadBudgetDeferral = runPlan.deferred.some((d) => d.reason === "budget");
  return hadBudgetDeferral ? "budget-exhausted" : "cycle-empty";
}

// ---------------------------------------------------------------------------
// Run log assembly
// ---------------------------------------------------------------------------

function buildRunLog(params: {
  config: RuntimeConfig;
  /** The pin resolved by AC1, at the top of this run -- the run log's only source for this field. */
  engineSha: string;
  cycleId: string | null;
  approvalRef: string | null;
  runPlan: RunPlan;
  ledger: Map<string, CandidateLogEntry>;
  stopReason: StopReason;
  backstopFireCount: number;
  credentials: RedactedCredentials;
  generatedAt: string;
  fatalError?: string;
}): RunLog {
  const {
    config,
    engineSha,
    cycleId,
    approvalRef,
    runPlan,
    ledger,
    stopReason,
    backstopFireCount,
    credentials,
    generatedAt,
  } = params;

  const candidateOrder = [...runPlan.admitted, ...runPlan.deferred.map((d) => d.issue)];
  const candidates = candidateOrder.map((issue) => mustGetLedger(ledger, issue.id));

  const consumed = runPlan.admitted.reduce((sum, issue) => sum + weightedCost(issue, config.dispatcher), 0);

  const clusters: ClusterLogEntry[] = runPlan.clusters.map((cluster, index) => ({
    index,
    issueIds: cluster.map((issue) => issue.id),
    sharedResources: [...new Set(cluster.flatMap((issue) => issue.predictedFiles))].sort(),
  }));

  const log: RunLog = {
    engineSha,
    cycleId,
    approvalRef,
    generatedAt,
    candidates,
    budget: {
      total: config.dispatcher.budget,
      consumed,
      remaining: config.dispatcher.budget - consumed,
    },
    clusters,
    laneCount: runPlan.laneCount,
    stopReason,
    backstopFireCount,
    credentials,
  };
  return params.fatalError ? { ...log, fatalError: params.fatalError } : log;
}

function finish(runLog: RunLog): RunResult {
  return {
    runLog,
    runLogJson: serializeRunLog(runLog),
    cycleSummary: scrubSecrets(renderCycleSummary(runLog)),
  };
}

// ---------------------------------------------------------------------------
// The run loop
// ---------------------------------------------------------------------------

export async function runDispatcher(config: RuntimeConfig, deps: RunDeps): Promise<RunResult> {
  const runStartMs = deps.clock.now();
  const credentials: RedactedCredentials = {
    linear: redact(deps.credentials.linearApiKey),
    github: redact(deps.credentials.githubToken),
  };
  const emptyPlan: RunPlan = {
    admitted: [],
    deferred: [],
    clusters: [],
    laneCount: 0,
    tiers: [],
    config: config.dispatcher,
  };

  // -1. Resolve the engine's own pin -- physically, via an injected port,
  // never a caller-supplied string (ALI-104 AC1). Every run log this
  // function returns below, however it ends, carries this exact value.
  // Resolved before touching Linear: drift is a purely local, physical
  // question, and refusing early means a stale run never reads or writes
  // Linear state at all (AC4).
  const engineSha = await deps.enginePin.resolveEngineSha();

  // -1.5. engine-drift refusal (ALI-104 AC4) -- the seventh stop reason,
  // fail-closed in the same shape as no-approved-cycle/gate-hit below: a
  // run resuming interrupted work carries the pin its parked artifact was
  // built against (`requiredPin`); if the engine has since moved, refuse
  // rather than execute part of the run against one version of
  // `.claude/**` and the rest against another. A fresh run sets no
  // `requiredPin`, so this never applies to it.
  if (config.requiredPin !== undefined && config.requiredPin !== engineSha) {
    const runLog = buildRunLog({
      config,
      engineSha,
      cycleId: null,
      approvalRef: null,
      runPlan: emptyPlan,
      ledger: new Map(),
      stopReason: "engine-drift",
      backstopFireCount: 0,
      credentials,
      generatedAt: new Date(deps.clock.now()).toISOString(),
    });
    return finish(runLog);
  }

  // 0. Status-name drift check -- on startup, before anything else (AC8).
  // Never let "no matching status" read as "no work": a board/docs mismatch
  // fails loud, not silently as an empty run.
  const workflowStatuses = await deps.linear.getWorkflowStatuses();
  const drift = checkStatusDrift(workflowStatuses);
  if (!drift.ok) {
    const runLog = buildRunLog({
      config,
      engineSha,
      cycleId: null,
      approvalRef: null,
      runPlan: emptyPlan,
      ledger: new Map(),
      stopReason: "gate-hit",
      backstopFireCount: 0,
      credentials,
      generatedAt: new Date(deps.clock.now()).toISOString(),
      fatalError: statusDriftMessage(drift.missing),
    });
    return finish(runLog);
  }

  // 1. Direction gate -- fail closed (AC1). No approved cycle, no work, exit clean.
  const cycle: CycleRef | null = await deps.linear.getApprovedCycle();
  if (!cycle) {
    const runLog = buildRunLog({
      config,
      engineSha,
      cycleId: null,
      approvalRef: null,
      runPlan: emptyPlan,
      ledger: new Map(),
      stopReason: "no-approved-cycle",
      backstopFireCount: 0,
      credentials,
      generatedAt: new Date(deps.clock.now()).toISOString(),
    });
    return finish(runLog);
  }

  // 2. Fetch the full candidate set -- every Ready issue in the approved cycle. Never Backlog.
  const readyIssues = await deps.linear.getReadyIssuesInCycle(cycle.id);

  // 3. Plan (ALI-102's pure core): admit -> partition -> laneCount -> modelTier.
  const runPlan = plan(readyIssues, config.dispatcher);
  const ledger = buildCandidateLedger(runPlan);

  // 4. Create this run's one read-only pinned engine tree (ALI-104 AC2) --
  // a single call site, before any concurrent lane starts, so "exactly one
  // detached checkout" holds regardless of lane count. Every DispatchContext
  // below carries its path; nothing in this runtime ever writes to it.
  const enginePath = await deps.enginePin.createPinnedTree(engineSha);

  const state: DispatchState = {
    runStartMs,
    totalTokensUsed: 0,
    hardKilled: false,
    softStopped: false,
  };
  let backstopFireCount = 0;

  await runClustersWithConcurrency(runPlan.clusters, runPlan.laneCount, async (cluster) => {
    let worktreeHandle: WorktreeHandle | undefined;
    let clusterHardKilled = false;
    // ALI-133: pred(i) — the branch of the nearest preceding issue in THIS
    // cluster whose `openDraftPr` succeeded in THIS run. `undefined` until
    // one does; an issue that goes to Needs Pedro (no PR) never sets this,
    // so it can never be inherited by the next issue (AC8).
    let predBranch: string | undefined;

    for (const issue of cluster) {
      if (state.hardKilled || state.softStopped) break; // leaves this + remaining issues "not-reached" below

      // Backstop, evaluated at issue boundaries only -- before dispatching
      // the next issue, never mid-file (spec §3).
      const soft = evaluateSoftBackstop(deps.clock, config, state);
      if (soft) {
        state.softStopped = true;
        state.softKind = soft;
        backstopFireCount++;
        break;
      }

      if (!worktreeHandle) {
        // The scaffold worktree still stands up FROM the resolved pin, not
        // `config.baseRef` (ALI-104 AC3, preserved) -- its branch is a
        // throwaway (ALI-133 AC1); the fork immediately below moves the
        // worktree onto this issue's real branch before any work happens.
        worktreeHandle = await deps.worktree.createWorktree(clusterScaffoldBranchNameFor(cluster), engineSha);
      }

      // ALI-133 AC1/AC2: one branch per issue, chained. Forks from pred(i)'s
      // branch if this run already opened one for a preceding issue in this
      // cluster, else from `config.baseRef`. Must land before the builder
      // is dispatched -- this call does exactly that, every time through
      // the loop, for every issue.
      const issueBranch = branchNameFor(issue);
      const forkBase = predBranch ?? config.baseRef;
      worktreeHandle = await deps.worktree.forkBranch(worktreeHandle, issueBranch, forkBase);

      // ALI-133 AC3/AC4: the PR base is always a GitHub branch name, never
      // a git ref -- pred(i)'s branch if it exists, else `basePrBranch`
      // (never `baseRef`, which GitHub would reject as a PR base).
      const prBase = predBranch ?? config.basePrBranch;

      await deps.linear.setIssueStatus(issue.id, "In Progress", cycle.id);

      const dispatchStartMs = deps.clock.now();
      const result = await dispatchOneIssue(
        issue,
        worktreeHandle,
        enginePath,
        engineSha,
        deps,
        config,
        cycle,
        state,
        prBase,
      );
      const entry = mustGetLedger(ledger, issue.id);
      entry.seats = result.seats;
      entry.bounces = result.bounces;
      entry.outcome = result.outcome;
      entry.actualConsumption = {
        wallClockMs: deps.clock.now() - dispatchStartMs,
        tokensUsed: result.tokensUsed,
      };
      state.totalTokensUsed += result.tokensUsed;

      // pred(i+1) becomes this issue exactly when this issue's PR actually
      // opened -- "opened-pr" (normal) and "parked" (hard-killed, but
      // `finalizeParked` still calls `openDraftPr`) both count; "needs-pedro"
      // does not (AC8: an abandoned predecessor is never inherited).
      if (result.outcome === "opened-pr" || result.outcome === "parked") {
        predBranch = issueBranch;
      }

      if (result.hardKilled) {
        state.hardKilled = true;
        clusterHardKilled = true;
        backstopFireCount++;
      }
    }

    // Only clean up a cluster's shared worktree once every issue in it has
    // finished normally -- never after a hard kill (preserve() already ran
    // for that issue) and never mid-cluster (later issues still need it).
    if (worktreeHandle && !clusterHardKilled) {
      await deps.worktree.remove(worktreeHandle);
    }
  });

  // Anything `plan()` admitted but this run never actually dispatched --
  // the run stopped (backstop or soft-stop) before reaching it. Distinct
  // from every deferral: `plan()` chose it, only time ran out (AC2, AC11).
  for (const issue of runPlan.admitted) {
    const entry = mustGetLedger(ledger, issue.id);
    if (entry.seats.length === 0 && entry.outcome === "not-dispatched") {
      entry.verdict = "not-reached";
    }
  }

  const stopReason: StopReason = state.hardKilled
    ? "backstop-wallclock"
    : state.softStopped
      ? state.softKind === "tokens"
        ? "backstop-tokens"
        : "backstop-wallclock"
      : deriveNormalStopReason(runPlan);

  const runLog = buildRunLog({
    config,
    engineSha,
    cycleId: cycle.id,
    approvalRef: cycle.approvalRef,
    runPlan,
    ledger,
    stopReason,
    backstopFireCount,
    credentials,
    generatedAt: new Date(deps.clock.now()).toISOString(),
  });

  await deps.linear.postCycleSummary(cycle.id, scrubSecrets(renderCycleSummary(runLog)));

  return finish(runLog);
}

/** `.engine/runs/<iso-timestamp>.json` -- the run log's file path, given its own `generatedAt`. */
export function runLogPath(generatedAt: string): string {
  return `.engine/runs/${generatedAt}.json`;
}

/**
 * Writes an already-scrubbed run-log JSON string to `<baseDir>/<runLogPath(generatedAt)>`,
 * creating `.engine/runs/` if it doesn't exist yet. Returns the absolute
 * path written. `baseDir` defaults to the process's cwd (the repo root, in
 * production) and is overridden in tests to a throwaway temp directory.
 */
export async function writeRunLog(
  runLogJson: string,
  generatedAt: string,
  baseDir: string = process.cwd(),
): Promise<string> {
  const absolutePath = join(baseDir, runLogPath(generatedAt));
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, runLogJson, "utf8");
  return absolutePath;
}

/**
 * Runs the dispatcher and persists its decision record to disk. This is the
 * actual entry point a run invokes (`orchestrator.md`'s "invoke the
 * dispatcher") -- `runDispatcher()` stays a pure function of its ports so
 * the run-loop logic keeps testing without a real filesystem; this wrapper
 * is the one place that writes the artifact spec §5 asks for.
 *
 * Persists on **every** completed run, regardless of `stop_reason` -- a
 * `no-approved-cycle` or `gate-hit` run still emits its record, because
 * that empty-looking record *is* the fail-closed audit trail (AC1/AC8):
 * proof the run fired, checked, and correctly did nothing.
 */
export async function runDispatcherAndPersist(
  config: RuntimeConfig,
  deps: RunDeps,
  baseDir: string = process.cwd(),
): Promise<RunResult & { runLogFilePath: string }> {
  const result = await runDispatcher(config, deps);
  const runLogFilePath = await writeRunLog(result.runLogJson, result.runLog.generatedAt, baseDir);
  return { ...result, runLogFilePath };
}
