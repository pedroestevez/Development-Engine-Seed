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
 * (`LinearPort`, `GitHubPort`, `WorktreePort`, `AgentPort`, `Clock`). This
 * file's own logic — the run loop itself — is a deterministic function of
 * those ports' behavior, which is what makes criteria 1–7 testable without
 * network, real git, or real subprocesses (see `__tests__/run.test.ts`).
 */

import { hasDangerLabel, plan, weightedCost } from "./plan.js";
import type { DispatcherConfig, Issue, RunPlan } from "./types.js";
import {
  checkStatusDrift,
  statusDriftMessage,
  type CycleRef,
  type LinearPort,
} from "./linear.js";
import type { DraftPrResult, GitHubPort, WorktreeHandle, WorktreePort } from "./worktree.js";
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

export interface DispatchContext {
  issue: Issue;
  worktreePath: string;
  branch: string;
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
 * Dispatches one seat (builder/reviewer/security). The real adapter shells
 * out to the `claude` CLI; for this PR it is a thin stub clearly marked as
 * wired in a follow-up issue (matching this port's treatment in the spec) —
 * the runtime logic that calls it is complete and fully tested against
 * fakes.
 */
export interface AgentPort {
  dispatch(seat: Seat, ctx: DispatchContext): Promise<AgentDispatchResult>;
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
  /** The commit this run executed against — pinned into every run log (ALI-104 pins it physically). */
  engineSha: string;
  /** Git ref new cluster worktrees branch from, e.g. `"origin/main"`. */
  baseRef: string;
}

export interface RunDeps {
  linear: LinearPort;
  github: GitHubPort;
  worktree: WorktreePort;
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
// Per-issue dispatch pipeline: builder -> blind QA (skipped) -> reviewer -> security?
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
  config: RuntimeConfig,
  cycle: CycleRef,
  seats: SeatOutcome[],
  resumePoint: string,
): Promise<DraftPrResult> {
  // Preserve first — a hard kill must never lose the artifact, whatever fails after this line.
  await deps.worktree.preserve(worktreeHandle);
  await deps.github.pushBranch(worktreeHandle.path, worktreeHandle.branch);
  const pr = await deps.github.openDraftPr({
    branch: worktreeHandle.branch,
    base: config.baseRef,
    title: `[parked] ${issue.id} ${issue.title}`,
    body: `${buildResumeNote(seats, resumePoint)}\n\nEngine SHA: ${config.engineSha}.`,
  });
  // Preserve the issue's existing (approved) cycle -- the ALI-103 addendum:
  // moving an issue out of Backlog was observed to silently auto-assign the
  // *current* cycle if the caller doesn't set one explicitly. Interrupted
  // work belongs to the cycle that admitted it.
  await deps.linear.setIssueStatus(issue.id, "Parked", cycle.id);
  await deps.linear.addComment(
    issue.id,
    `${buildResumeNote(seats, resumePoint)}\n\nEngine SHA: \`${config.engineSha}\`.\nPR: ${pr.url}`,
  );
  return pr;
}

async function finalizeNeedsPedro(
  issue: Issue,
  deps: RunDeps,
  config: RuntimeConfig,
  question: string,
): Promise<void> {
  // Clear the cycle -- excluded from every run until Pedro answers (the addendum's other half).
  await deps.linear.setIssueStatus(issue.id, "Needs Pedro", null);
  await deps.linear.addComment(
    issue.id,
    `Ambiguity found — flagged rather than guessed, per conduct.\n\n${question}\n\n` +
      `Engine SHA: \`${config.engineSha}\`.`,
  );
}

async function finalizeOpenedPr(
  issue: Issue,
  worktreeHandle: WorktreeHandle,
  deps: RunDeps,
  config: RuntimeConfig,
  cycle: CycleRef,
  seats: SeatOutcome[],
): Promise<DraftPrResult> {
  await deps.github.pushBranch(worktreeHandle.path, worktreeHandle.branch);
  const pr = await deps.github.openDraftPr({
    branch: worktreeHandle.branch,
    base: config.baseRef,
    title: `${issue.id}: ${issue.title}`,
    body: `Implements ${issue.id}. Engine SHA: ${config.engineSha}.`,
  });
  await deps.linear.setIssueStatus(issue.id, "In Review", cycle.id);
  const seatSummary = seats.map((s) => `${s.seat}: ${s.status}${s.detail ? ` — ${s.detail}` : ""}`).join("\n");
  await deps.linear.addComment(
    issue.id,
    `Seats:\n${seatSummary}\n\nEngine SHA: \`${config.engineSha}\`.\nPR: ${pr.url}`,
  );
  return pr;
}

async function dispatchOneIssue(
  issue: Issue,
  worktreeHandle: WorktreeHandle,
  deps: RunDeps,
  config: RuntimeConfig,
  cycle: CycleRef,
  state: DispatchState,
): Promise<IssueDispatchResult> {
  const ctx: DispatchContext = { issue, worktreePath: worktreeHandle.path, branch: worktreeHandle.branch };
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
    await finalizeNeedsPedro(issue, deps, config, builderResult.ambiguous.question);
    return { hardKilled: false, outcome: "needs-pedro", seats, bounces, tokensUsed };
  }

  // Checkpoint 1/3 (AC5): after builder, before blind QA.
  if (isBeyondHard(deps.clock, config, state)) {
    await finalizeParked(issue, worktreeHandle, deps, config, cycle, seats, "after builder");
    return { hardKilled: true, outcome: "parked", seats, bounces, tokensUsed };
  }

  // Stage 2: blind QA -- ALI-105's seat does not exist yet. An explicit,
  // loud skip -- never a silent pass.
  seats.push({ seat: "blindQa", status: "skipped (seat not built)" });

  // Stage 3: reviewer.
  const reviewerResult = await deps.agent.dispatch("reviewer", ctx);
  record(reviewerResult);
  seats.push({ seat: "reviewer", status: "ran", detail: reviewerResult.summary });

  // Checkpoint 2/3 (AC5): after reviewer, before security (or its skip).
  if (isBeyondHard(deps.clock, config, state)) {
    await finalizeParked(issue, worktreeHandle, deps, config, cycle, seats, "after reviewer");
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
    await finalizeParked(issue, worktreeHandle, deps, config, cycle, seats, "after security");
    return { hardKilled: true, outcome: "parked", seats, bounces, tokensUsed };
  }

  await finalizeOpenedPr(issue, worktreeHandle, deps, config, cycle, seats);
  return { hardKilled: false, outcome: "opened-pr", seats, bounces, tokensUsed };
}

// ---------------------------------------------------------------------------
// Cluster-level concurrency: one worktree per cluster, sequential within it,
// parallel across clusters up to laneCount (AC6).
// ---------------------------------------------------------------------------

function branchNameFor(cluster: readonly Issue[]): string {
  return `dispatcher/${cluster.map((issue) => issue.id).join("-")}`;
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
  const { config, cycleId, approvalRef, runPlan, ledger, stopReason, backstopFireCount, credentials, generatedAt } =
    params;

  const candidateOrder = [...runPlan.admitted, ...runPlan.deferred.map((d) => d.issue)];
  const candidates = candidateOrder.map((issue) => mustGetLedger(ledger, issue.id));

  const consumed = runPlan.admitted.reduce((sum, issue) => sum + weightedCost(issue, config.dispatcher), 0);

  const clusters: ClusterLogEntry[] = runPlan.clusters.map((cluster, index) => ({
    index,
    issueIds: cluster.map((issue) => issue.id),
    sharedResources: [...new Set(cluster.flatMap((issue) => issue.predictedFiles))].sort(),
  }));

  const log: RunLog = {
    engineSha: config.engineSha,
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

  // 0. Status-name drift check -- on startup, before anything else (AC8).
  // Never let "no matching status" read as "no work": a board/docs mismatch
  // fails loud, not silently as an empty run.
  const workflowStatuses = await deps.linear.getWorkflowStatuses();
  const drift = checkStatusDrift(workflowStatuses);
  if (!drift.ok) {
    const runLog = buildRunLog({
      config,
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
        worktreeHandle = await deps.worktree.createWorktree(branchNameFor(cluster), config.baseRef);
      }

      await deps.linear.setIssueStatus(issue.id, "In Progress", cycle.id);

      const dispatchStartMs = deps.clock.now();
      const result = await dispatchOneIssue(issue, worktreeHandle, deps, config, cycle, state);
      const entry = mustGetLedger(ledger, issue.id);
      entry.seats = result.seats;
      entry.bounces = result.bounces;
      entry.outcome = result.outcome;
      entry.actualConsumption = {
        wallClockMs: deps.clock.now() - dispatchStartMs,
        tokensUsed: result.tokensUsed,
      };
      state.totalTokensUsed += result.tokensUsed;

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
