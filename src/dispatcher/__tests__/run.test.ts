import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_BACKSTOP,
  runDispatcher,
  runDispatcherAndPersist,
  runLogPath,
  type AgentDispatchResult,
  type AgentPort,
  type BlindDispatchContext,
  type BlindQaDispatchResult,
  type Clock,
  type DispatchContext,
  type RunDeps,
  type RuntimeConfig,
  type RuntimeCredentials,
  type Seat,
} from "../run.js";
import { checkStatusDrift, statusDriftMessage, type CycleRef, type LinearIssue, type LinearPort } from "../linear.js";
import {
  createGitWorktreePort,
  type DraftPrParams,
  type EnginePinPort,
  type GitHubPort,
  type WorktreeHandle,
  type WorktreePort,
} from "../worktree.js";
import {
  STOP_REASONS,
  VERDICTS,
  containsSecretLike,
  deferralReasonToVerdict,
  isStopReason,
  redact,
  scrubSecrets,
  verdictToDeferralReason,
} from "../runlog.js";
import type { DeferralReason, DispatcherConfig, Issue, IssueState } from "../types.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Shared fixtures and fakes
// ---------------------------------------------------------------------------

// ALI-105: a full issue body -- all three sections the blind seat reads,
// plus `## Why`/`## What` it must never see -- so this file's *existing*
// fixtures (criteria 1-11, unrelated to blindQa) dispatch blindQa for real
// by default instead of hitting the unparseable-criteria skip. Tests that
// care about blindQa's own behavior override `body` explicitly.
const FULL_BODY_FIXTURE = [
  "## Why",
  "",
  "Fixture reasoning -- never handed to the blind seat.",
  "",
  "## What",
  "",
  "Fixture implementation sketch -- never handed to the blind seat.",
  "",
  "## Acceptance criteria",
  "",
  "1. It does the thing.",
  "2. It never does the other thing.",
  "",
  "## Invariant",
  "",
  "The thing always holds.",
  "",
  "## Definition of done",
  "",
  "Tests green.",
  "",
].join("\n");

function makeIssue(id: string, points: number, extra: Partial<Issue> & { body?: string } = {}): LinearIssue {
  return {
    id,
    title: extra.title ?? `Issue ${id}`,
    points,
    priority: extra.priority ?? 100,
    labels: extra.labels ?? [],
    blockedBy: extra.blockedBy ?? [],
    predictedFiles: extra.predictedFiles ?? [],
    state: "Ready",
    body: extra.body ?? FULL_BODY_FIXTURE,
  };
}

const VALID_WORKFLOW_STATUSES = ["Backlog", "Ready", "In Progress", "In Review", "Done", "Parked", "Needs Pedro"];

interface FakeLinearState {
  workflowStatuses: string[];
  approvedCycle: CycleRef | null;
  readyIssues: LinearIssue[];
  statusChanges: { issueId: string; status: IssueState; cycleId: string | null }[];
  comments: { issueId: string; body: string }[];
  cycleSummaries: { cycleId: string; body: string }[];
  calls: { getWorkflowStatuses: number; getApprovedCycle: number; getReadyIssuesInCycle: number };
}

function createFakeLinear(overrides: Partial<FakeLinearState> = {}): { port: LinearPort; state: FakeLinearState } {
  const state: FakeLinearState = {
    workflowStatuses: VALID_WORKFLOW_STATUSES,
    approvedCycle: { id: "cycle-1", name: "Cycle 1", approvalRef: "tg-msg-1" },
    readyIssues: [],
    statusChanges: [],
    comments: [],
    cycleSummaries: [],
    calls: { getWorkflowStatuses: 0, getApprovedCycle: 0, getReadyIssuesInCycle: 0 },
    ...overrides,
  };
  const port: LinearPort = {
    async getWorkflowStatuses() {
      state.calls.getWorkflowStatuses++;
      return state.workflowStatuses;
    },
    async getApprovedCycle() {
      state.calls.getApprovedCycle++;
      return state.approvedCycle;
    },
    async getReadyIssuesInCycle() {
      state.calls.getReadyIssuesInCycle++;
      return state.readyIssues;
    },
    async setIssueStatus(issueId, status, cycleId) {
      state.statusChanges.push({ issueId, status, cycleId });
    },
    async addComment(issueId, body) {
      state.comments.push({ issueId, body });
    },
    async postCycleSummary(cycleId, body) {
      state.cycleSummaries.push({ cycleId, body });
    },
  };
  return { port, state };
}

interface FakeForkCall {
  path: string;
  branch: string;
  baseRef: string;
}

interface FakeWorktreeState {
  created: WorktreeHandle[];
  /** ALI-133: every `forkBranch` call, in order -- the per-issue branch operation. */
  forked: FakeForkCall[];
  preserved: WorktreeHandle[];
  removed: WorktreeHandle[];
}

function createFakeWorktree(): { port: WorktreePort; state: FakeWorktreeState } {
  const state: FakeWorktreeState = { created: [], forked: [], preserved: [], removed: [] };
  const port: WorktreePort = {
    async createWorktree(branch) {
      const handle: WorktreeHandle = { path: `/fake/worktrees/${branch}`, branch };
      state.created.push(handle);
      return handle;
    },
    async forkBranch(handle, branch, baseRef) {
      state.forked.push({ path: handle.path, branch, baseRef });
      // Path never changes -- only the branch checked out into it (ALI-133 AC2).
      return { path: handle.path, branch };
    },
    async preserve(handle) {
      state.preserved.push(handle);
    },
    async remove(handle) {
      state.removed.push(handle);
    },
  };
  return { port, state };
}

// ALI-104: the pin -- a fake `EnginePinPort` returning a fixed SHA by
// default, so existing fixtures (e.g. criterion 4's "abc1234" assertion
// below) keep the same observable content without themselves knowing the
// pin moved from a config field to an injected port.
interface FakeEnginePinState {
  resolveCalls: number;
  createPinnedTreeCalls: string[];
}

function createFakeEnginePin(sha = "abc1234"): { port: EnginePinPort; state: FakeEnginePinState } {
  const state: FakeEnginePinState = { resolveCalls: 0, createPinnedTreeCalls: [] };
  const port: EnginePinPort = {
    async resolveEngineSha() {
      state.resolveCalls++;
      return sha;
    },
    async createPinnedTree(pin) {
      state.createPinnedTreeCalls.push(pin);
      return `/fake/engine-pin/${pin}`;
    },
  };
  return { port, state };
}

interface FakeGitHubState {
  pushed: { path: string; branch: string }[];
  prs: DraftPrParams[];
  /** ALI-133 AC5(a): branches real GitHub would accept as a PR base -- seeded with the repo's base branch. */
  branches: Set<string>;
}

/**
 * ALI-133 AC5 (retro-mandated): models the two real-GitHub constraints the
 * pre-fix fake was laxer than reality about, which is exactly what let the
 * head→base collision through undetected:
 *
 *   (a)/(b) a `branches` set, seeded with `baseBranch` (default `"main"`),
 *       that `pushBranch` adds to -- `base` must name a branch that's
 *       actually been pushed (or the seeded base branch itself).
 *   (c) `openDraftPr` throws when `base` is not in `branches`, naming the
 *       offending base.
 *   (d) `openDraftPr` throws when an open PR already exists for the same
 *       `(branch, base)` pair, mirroring GitHub's real 422 ("A pull request
 *       already exists for ..."). PRs are never closed or merged within a
 *       run (non-goal), so this holds for the run's whole duration.
 *
 * AC7 exercises both (c) and (d) directly against this function, independent
 * of the run loop -- deleting either constraint here must fail those tests.
 */
function createFakeGitHub(options: { baseBranch?: string } = {}): { port: GitHubPort; state: FakeGitHubState } {
  const baseBranch = options.baseBranch ?? "main";
  const state: FakeGitHubState = { pushed: [], prs: [], branches: new Set([baseBranch]) };
  let counter = 0;
  const port: GitHubPort = {
    async pushBranch(path, branch) {
      state.pushed.push({ path, branch });
      state.branches.add(branch);
    },
    async openDraftPr(params) {
      if (!state.branches.has(params.base)) {
        throw new Error(
          `GitHub rejected PR ${params.branch} -> ${params.base}: base branch "${params.base}" ` +
            "was never pushed and is not the repo's base branch.",
        );
      }
      const duplicate = state.prs.some((pr) => pr.branch === params.branch && pr.base === params.base);
      if (duplicate) {
        throw new Error(
          `A pull request already exists for ${params.branch} -> ${params.base}. (422-shaped, mirrors real GitHub.)`,
        );
      }
      counter++;
      state.prs.push(params);
      return { number: counter, url: `https://github.com/fake/fake/pull/${counter}` };
    },
  };
  return { port, state };
}

interface FakeClock extends Clock {
  set(ms: number): void;
  advance(ms: number): void;
}

function createFakeClock(startMs = 0): FakeClock {
  let current = startMs;
  return {
    now: () => current,
    set(ms: number) {
      current = ms;
    },
    advance(ms: number) {
      current += ms;
    },
  };
}

interface AgentCall {
  seat: Seat;
  issueId: string;
  worktreePath: string;
}

type AgentScript = (
  seat: Seat,
  ctx: DispatchContext,
  callIndex: number,
) => AgentDispatchResult | Promise<AgentDispatchResult>;

/** ALI-105: the blind seat's own dispatch script -- takes only `BlindDispatchContext`, never `DispatchContext`. */
type BlindAgentScript = (
  ctx: BlindDispatchContext,
  callIndex: number,
) => BlindQaDispatchResult | Promise<BlindQaDispatchResult>;

function createFakeAgent(
  script?: AgentScript,
  blindScript?: BlindAgentScript,
): { port: AgentPort; calls: AgentCall[]; blindCalls: BlindDispatchContext[] } {
  const calls: AgentCall[] = [];
  const blindCalls: BlindDispatchContext[] = [];
  let callIndex = 0;
  let blindCallIndex = 0;
  const port: AgentPort = {
    async dispatch(seat, ctx) {
      calls.push({ seat, issueId: ctx.issue.id, worktreePath: ctx.worktreePath });
      const idx = callIndex++;
      if (script) return script(seat, ctx, idx);
      return { summary: `${seat} ok` };
    },
    async dispatchBlindQa(ctx) {
      blindCalls.push(ctx);
      const idx = blindCallIndex++;
      if (blindScript) return blindScript(ctx, idx);
      return { testFilesWritten: [`${ctx.issueId}.blind.test.ts`], untestableCriteria: [] };
    },
  };
  return { port, calls, blindCalls };
}

const BASE_DISPATCHER_CONFIG: DispatcherConfig = { budget: 5, riskWeight: 2.0, maxConcurrency: 4 };

function makeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    dispatcher: overrides.dispatcher ?? BASE_DISPATCHER_CONFIG,
    // A soft/hard window wide enough that no fixture crosses it unless a
    // test deliberately advances the fake clock to trip it.
    backstop: overrides.backstop ?? { wallClockSoftMs: 1_000_000, wallClockHardMs: 2_000_000 },
    baseRef: overrides.baseRef ?? "origin/main",
    // ALI-133: the fallback PR base for a cluster's first issue -- a real
    // GitHub branch name, distinct from `baseRef`. Matches the default
    // `createFakeGitHub()` seeds as its base branch, so existing fixtures
    // that don't care about this distinction keep passing unmodified.
    basePrBranch: overrides.basePrBranch ?? "main",
    // ALI-104: no `engineSha` field -- the run resolves its own pin via
    // `RunDeps.enginePin` (see `createFakeEnginePin` above), never a config
    // input. `requiredPin` (engine-drift) stays unset by default here.
    requiredPin: overrides.requiredPin,
  };
}

function makeDeps(parts: {
  linear?: LinearPort;
  github?: GitHubPort;
  worktree?: WorktreePort;
  enginePin?: EnginePinPort;
  agent?: AgentPort;
  clock?: Clock;
  credentials?: RuntimeCredentials;
}): RunDeps {
  return {
    linear: parts.linear ?? createFakeLinear().port,
    github: parts.github ?? createFakeGitHub().port,
    worktree: parts.worktree ?? createFakeWorktree().port,
    enginePin: parts.enginePin ?? createFakeEnginePin().port,
    agent: parts.agent ?? createFakeAgent().port,
    clock: parts.clock ?? createFakeClock(),
    credentials: parts.credentials ?? {},
  };
}

// ---------------------------------------------------------------------------
// criterion 1: fail-closed with no approved cycle
// ---------------------------------------------------------------------------

describe("criterion 1: no approved cycle exits immediately, dispatches nothing", () => {
  it("stop_reason is no-approved-cycle and no Linear/agent/worktree call happens beyond the checks", async () => {
    const { port: linear, state: linearState } = createFakeLinear({ approvedCycle: null });
    const { port: worktree, state: worktreeState } = createFakeWorktree();
    const { port: agent, calls: agentCalls } = createFakeAgent();

    const result = await runDispatcher(makeConfig(), makeDeps({ linear, worktree, agent }));

    expect(result.runLog.stopReason).toBe("no-approved-cycle");
    expect(result.runLog.candidates).toEqual([]);
    expect(linearState.calls.getReadyIssuesInCycle).toBe(0);
    expect(worktreeState.created).toEqual([]);
    expect(agentCalls).toEqual([]);
    expect(linearState.statusChanges).toEqual([]);
    expect(linearState.cycleSummaries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// criterion 2: full candidate set, every Ready issue gets a verdict
// ---------------------------------------------------------------------------

describe("criterion 2: run log has a verdict line for every Ready issue, including untouched ones", () => {
  it("candidate set equals the cycle's Ready set, with the expected verdict per issue", async () => {
    // Mirrors ALI-102's own admission fixture: budget 5, one admitted
    // ("expensive" alone fills it), the rest deferred for three different
    // reasons -- none of "blocker"/"dependent"/"too-big" is ever dispatched.
    const expensive = makeIssue("expensive", 5, { priority: 1 });
    const blocker = makeIssue("blocker", 4, { priority: 2 });
    const dependent = makeIssue("dependent", 1, { priority: 3, blockedBy: ["blocker"] });
    const tooBig = makeIssue("too-big", 10, { priority: 4 });
    const readyIssues = [expensive, blocker, dependent, tooBig];

    const { port: linear } = createFakeLinear({ readyIssues });
    const deps = makeDeps({ linear });

    const result = await runDispatcher(makeConfig(), deps);

    const candidateIds = new Set(result.runLog.candidates.map((c) => c.issueId));
    expect(candidateIds).toEqual(new Set(readyIssues.map((i) => i.id)));

    const verdictById = Object.fromEntries(result.runLog.candidates.map((c) => [c.issueId, c.verdict]));
    expect(verdictById).toEqual({
      expensive: "admitted",
      blocker: "deferred (budget)",
      dependent: "deferred (dependency)",
      "too-big": "refused (exceeds budget)",
    });

    // Only the admitted issue was actually dispatched -- the other three are logged, not touched.
    const outcomeById = Object.fromEntries(result.runLog.candidates.map((c) => [c.issueId, c.outcome]));
    expect(outcomeById).toEqual({
      expensive: "opened-pr",
      blocker: "not-dispatched",
      dependent: "not-dispatched",
      "too-big": "not-dispatched",
    });
  });
});

// ---------------------------------------------------------------------------
// criterion 3: soft backstop -- in-flight issue finishes, run stops before the next
// ---------------------------------------------------------------------------

describe("criterion 3: backstop fires at a simulated wall-clock limit", () => {
  it("the in-flight issue reaches a draft PR; the run stops before dispatching the next", async () => {
    const issueA = makeIssue("issue-a", 1, { priority: 1, predictedFiles: ["src/a.ts"] });
    const issueB = makeIssue("issue-b", 1, { priority: 2, predictedFiles: ["src/b.ts"] });
    const { port: linear } = createFakeLinear({ readyIssues: [issueA, issueB] });
    const { port: worktree, state: worktreeState } = createFakeWorktree();
    const { port: github, state: githubState } = createFakeGitHub();
    const clock = createFakeClock(0);

    const { port: agent, calls } = createFakeAgent((seat, ctx) => {
      if (seat === "builder" && ctx.issue.id === "issue-a") {
        // Dispatching issue A alone crosses the soft deadline.
        clock.advance(1_500);
      }
      return { summary: `${seat} ok` };
    });

    const config = makeConfig({
      // maxConcurrency 1 -> a single lane processes both clusters strictly
      // in sequence, so "stops before dispatching the next" is unambiguous.
      dispatcher: { budget: 5, riskWeight: 2.0, maxConcurrency: 1 },
      backstop: { wallClockSoftMs: 1_000, wallClockHardMs: 1_000_000 },
    });

    const result = await runDispatcher(config, makeDeps({ linear, worktree, github, agent, clock }));

    expect(result.runLog.stopReason).toBe("backstop-wallclock");
    expect(githubState.prs).toHaveLength(1);
    expect(githubState.prs[0]?.title).toContain("issue-a");
    expect(calls.some((c) => c.issueId === "issue-b")).toBe(false);
    // issue B's cluster never got far enough to even create its worktree.
    expect(worktreeState.created).toHaveLength(1);

    const byId = Object.fromEntries(result.runLog.candidates.map((c) => [c.issueId, c]));
    expect(byId["issue-a"]?.verdict).toBe("admitted");
    expect(byId["issue-a"]?.outcome).toBe("opened-pr");
    expect(byId["issue-b"]?.verdict).toBe("not-reached");
    expect(byId["issue-b"]?.outcome).toBe("not-dispatched");
  });
});

// ---------------------------------------------------------------------------
// criterion 4: hard kill -- all four artifacts verified in one test
// ---------------------------------------------------------------------------

describe("criterion 4: hard kill preserves the worktree, opens a [parked] draft PR, parks the issue, and comments", () => {
  it("verifies worktree preservation, PR title, Linear status+cycle, and the resume comment together", async () => {
    const issue = makeIssue("issue-x", 2, { priority: 1 });
    const { port: linear, state: linearState } = createFakeLinear({ readyIssues: [issue] });
    const { port: worktree, state: worktreeState } = createFakeWorktree();
    const { port: github, state: githubState } = createFakeGitHub();
    const clock = createFakeClock(0);

    const { port: agent } = createFakeAgent((seat) => {
      if (seat === "builder") clock.advance(10_000); // straight past the hard deadline
      return { summary: `${seat} ok` };
    });

    const config = makeConfig({ backstop: { wallClockSoftMs: 900_000, wallClockHardMs: 1_000 } });
    const result = await runDispatcher(config, makeDeps({ linear, worktree, github, agent, clock }));

    // 1. Worktree preserved, never removed.
    expect(worktreeState.preserved).toHaveLength(1);
    expect(worktreeState.removed).toEqual([]);

    // 2. Draft PR titled [parked].
    expect(githubState.prs).toHaveLength(1);
    expect(githubState.prs[0]?.title).toMatch(/^\[parked\] issue-x/);

    // 3. Issue moved to Parked, cycle preserved (the ALI-103 addendum: never
    //    let Linear auto-assign; interrupted work keeps its admitting cycle).
    const lastChange = linearState.statusChanges.at(-1);
    expect(lastChange).toEqual({ issueId: "issue-x", status: "Parked", cycleId: "cycle-1" });

    // 4. Comment records the resume point and the engine SHA.
    const comment = linearState.comments.find((c) => c.issueId === "issue-x");
    expect(comment?.body).toContain("after builder");
    expect(comment?.body).toContain("abc1234");

    expect(result.runLog.stopReason).toBe("backstop-wallclock");
    expect(result.runLog.candidates[0]?.outcome).toBe("parked");
  });
});

// ---------------------------------------------------------------------------
// criterion 5: never "In Progress" with no artifact -- three kill points
// ---------------------------------------------------------------------------

describe("criterion 5: no issue is ever left In Progress with no PR and no comment", () => {
  function assertNeverStuck(linearState: FakeLinearState, issueId: string): void {
    const changesForIssue = linearState.statusChanges.filter((c) => c.issueId === issueId);
    const last = changesForIssue.at(-1);
    expect(last, `expected at least one status change for ${issueId}`).toBeDefined();
    expect(last?.status).not.toBe("In Progress");
    expect(linearState.comments.some((c) => c.issueId === issueId)).toBe(true);
    expect(linearState.comments.find((c) => c.issueId === issueId)?.body).toBeTruthy();
  }

  it("kill point 1/3: hard deadline crossed after the builder stage", async () => {
    const issue = makeIssue("kill-1", 1);
    const { port: linear, state: linearState } = createFakeLinear({ readyIssues: [issue] });
    const clock = createFakeClock(0);
    const { port: agent, calls } = createFakeAgent((seat) => {
      if (seat === "builder") clock.advance(1_500);
      return { summary: "ok" };
    });
    const config = makeConfig({ backstop: { wallClockSoftMs: 900_000, wallClockHardMs: 1_000 } });

    await runDispatcher(config, makeDeps({ linear, agent, clock }));

    assertNeverStuck(linearState, "kill-1");
    expect(calls.map((c) => c.seat)).toEqual(["builder"]);
  });

  it("kill point 2/3: hard deadline crossed after the reviewer stage", async () => {
    const issue = makeIssue("kill-2", 1);
    const { port: linear, state: linearState } = createFakeLinear({ readyIssues: [issue] });
    const clock = createFakeClock(0);
    const { port: agent, calls } = createFakeAgent((seat) => {
      if (seat === "builder") clock.advance(400); // stays under the hard deadline
      if (seat === "reviewer") clock.advance(700); // now over it
      return { summary: "ok" };
    });
    const config = makeConfig({ backstop: { wallClockSoftMs: 900_000, wallClockHardMs: 1_000 } });

    await runDispatcher(config, makeDeps({ linear, agent, clock }));

    assertNeverStuck(linearState, "kill-2");
    expect(calls.map((c) => c.seat)).toEqual(["builder", "reviewer"]);
  });

  it("kill point 3/3: hard deadline crossed after the security stage", async () => {
    // A danger label so the security seat actually runs (otherwise it's a
    // structural skip, and checkpoint 3 would fire on the skip instead).
    const issue = makeIssue("kill-3", 1, { labels: ["payments"] });
    const { port: linear, state: linearState } = createFakeLinear({ readyIssues: [issue] });
    const clock = createFakeClock(0);
    const { port: agent, calls } = createFakeAgent((seat) => {
      if (seat === "builder") clock.advance(300);
      if (seat === "reviewer") clock.advance(300); // 600, still under
      if (seat === "security") clock.advance(500); // 1100, over
      return { summary: "ok" };
    });
    const config = makeConfig({
      dispatcher: { budget: 5, riskWeight: 2.0, maxConcurrency: 4 },
      backstop: { wallClockSoftMs: 900_000, wallClockHardMs: 1_000 },
    });

    await runDispatcher(config, makeDeps({ linear, agent, clock }));

    assertNeverStuck(linearState, "kill-3");
    expect(calls.map((c) => c.seat)).toEqual(["builder", "reviewer", "security"]);
  });
});

// ---------------------------------------------------------------------------
// criterion 6: concurrent clusters, same-file issues share one worktree
// ---------------------------------------------------------------------------

describe("criterion 6: two clusters dispatch concurrently; same-file issues share one worktree, in order", () => {
  it("issues sharing predicted files land in one worktree and run sequentially, while the other cluster runs in parallel", async () => {
    const sameA = makeIssue("same-a", 1, { priority: 1, predictedFiles: ["src/shared.ts"] });
    const sameB = makeIssue("same-b", 1, { priority: 2, predictedFiles: ["src/shared.ts"] });
    const other = makeIssue("other", 1, { priority: 3, predictedFiles: ["src/other.ts"] });

    const { port: linear } = createFakeLinear({ readyIssues: [sameA, sameB, other] });
    const { port: worktree, state: worktreeState } = createFakeWorktree();
    const { port: github, state: githubState } = createFakeGitHub();

    // Proves genuine concurrency: each cluster-starting builder call blocks
    // until BOTH cluster-starting builders have been invoked. If the run
    // loop were actually sequential (one lane), this would deadlock rather
    // than a false pass -- the failure mode is loud, not silent.
    let startedCount = 0;
    let resolveBothStarted: () => void = () => {};
    const bothStarted = new Promise<void>((resolve) => {
      resolveBothStarted = resolve;
    });

    const { port: agent, calls } = createFakeAgent(async (seat, ctx) => {
      if (seat === "builder" && (ctx.issue.id === "same-a" || ctx.issue.id === "other")) {
        startedCount++;
        if (startedCount === 2) resolveBothStarted();
        await bothStarted;
      }
      return { summary: "ok" };
    });

    const config = makeConfig({ dispatcher: { budget: 5, riskWeight: 2.0, maxConcurrency: 2 } });
    const result = await runDispatcher(config, makeDeps({ linear, worktree, github, agent }));

    // Exactly two worktrees: one per cluster.
    expect(worktreeState.created).toHaveLength(2);

    // same-a and same-b used the identical worktree path.
    const sameAWorktree = calls.find((c) => c.issueId === "same-a")?.worktreePath;
    const sameBWorktree = calls.find((c) => c.issueId === "same-b")?.worktreePath;
    expect(sameAWorktree).toBeDefined();
    expect(sameAWorktree).toBe(sameBWorktree);

    // Ran in order: every same-a call precedes every same-b call.
    const lastSameAIndex = calls.map((c) => c.issueId).lastIndexOf("same-a");
    const firstSameBIndex = calls.map((c) => c.issueId).indexOf("same-b");
    expect(lastSameAIndex).toBeLessThan(firstSameBIndex);

    expect(result.runLog.stopReason).toBe("cycle-empty");
    const outcomeById = Object.fromEntries(result.runLog.candidates.map((c) => [c.issueId, c.outcome]));
    expect(outcomeById).toEqual({ "same-a": "opened-pr", "same-b": "opened-pr", other: "opened-pr" });

    // ALI-133: added, not weakened (AC11) -- one PR per issue, heads name
    // exactly one issue id each, and same-b's PR stacks on same-a's branch
    // (same cluster, chained) while other's PR (a different, independent
    // cluster) targets basePrBranch directly, having no predecessor.
    expect(githubState.prs).toHaveLength(3);
    const prByBranch = Object.fromEntries(githubState.prs.map((pr) => [pr.branch, pr]));
    expect(Object.keys(prByBranch).sort()).toEqual(["dispatcher/other", "dispatcher/same-a", "dispatcher/same-b"]);
    expect(prByBranch["dispatcher/same-a"]?.base).toBe(config.basePrBranch);
    expect(prByBranch["dispatcher/same-b"]?.base).toBe("dispatcher/same-a");
    expect(prByBranch["dispatcher/other"]?.base).toBe(config.basePrBranch);
  });
});

// ---------------------------------------------------------------------------
// ALI-133 AC6: regression -- the exact scenario real GitHub 422s on today.
// Run against the pre-fix `branchNameFor(cluster)` + `base: config.baseRef`,
// this test throws (both issues would share one branch as PR head, and the
// second `openDraftPr` call would collide on an identical (branch, base)
// pair -- rejected by the AC5-hardened fake exactly as real GitHub would).
// ---------------------------------------------------------------------------

describe("ALI-133 AC6: a >=2-issue same-file cluster opens one real-GitHub-shaped PR per issue, stacked", () => {
  it("completes without throwing; PR heads are dispatcher/<id>, pairwise distinct; bases stack predecessor -> successor", async () => {
    const sameA = makeIssue("stack-a", 1, { priority: 1, predictedFiles: ["src/stacked.ts"] });
    const sameB = makeIssue("stack-b", 1, { priority: 2, predictedFiles: ["src/stacked.ts"] });
    const { port: linear } = createFakeLinear({ readyIssues: [sameA, sameB] });
    const { port: worktree } = createFakeWorktree();
    const { port: github, state: githubState } = createFakeGitHub();

    const config = makeConfig();

    // The assertion IS "does not throw" -- an unhandled rejection here (the
    // pre-fix behavior against this hardened fake) fails the test directly.
    const result = await runDispatcher(config, makeDeps({ linear, worktree, github }));

    expect(githubState.prs).toHaveLength(2);

    const heads = githubState.prs.map((pr) => pr.branch);
    expect(new Set(heads).size).toBe(2);
    expect(heads).toEqual(["dispatcher/stack-a", "dispatcher/stack-b"]);

    const prByBranch = Object.fromEntries(githubState.prs.map((pr) => [pr.branch, pr]));
    expect(prByBranch["dispatcher/stack-a"]?.base).toBe(config.basePrBranch);
    expect(prByBranch["dispatcher/stack-b"]?.base).toBe("dispatcher/stack-a");

    const outcomeById = Object.fromEntries(result.runLog.candidates.map((c) => [c.issueId, c.outcome]));
    expect(outcomeById).toEqual({ "stack-a": "opened-pr", "stack-b": "opened-pr" });
  });
});

// ---------------------------------------------------------------------------
// ALI-133 AC7 (retro-mandated): the fake's constraints have teeth, exercised
// directly against `createFakeGitHub()` -- independent of the run loop.
// Deleting either constraint from the fake makes its corresponding test fail.
// ---------------------------------------------------------------------------

describe("ALI-133 AC7: createFakeGitHub() enforces real GitHub's PR rules directly", () => {
  it("a second openDraftPr for the same (branch, base) pair is rejected -- mirrors GitHub's 422", async () => {
    const { port: github } = createFakeGitHub();
    await github.pushBranch("/fake/path", "dispatcher/dup");

    await github.openDraftPr({ branch: "dispatcher/dup", base: "main", title: "first", body: "" });

    await expect(
      github.openDraftPr({ branch: "dispatcher/dup", base: "main", title: "second", body: "" }),
    ).rejects.toThrow(/pull request already exists/i);
  });

  it("an openDraftPr whose base was never pushed is rejected", async () => {
    const { port: github } = createFakeGitHub();
    await github.pushBranch("/fake/path", "dispatcher/orphan");

    await expect(
      github.openDraftPr({ branch: "dispatcher/orphan", base: "dispatcher/never-pushed", title: "t", body: "" }),
    ).rejects.toThrow(/dispatcher\/never-pushed/);
  });
});

// ---------------------------------------------------------------------------
// ALI-133 AC8: an abandoned (Needs Pedro) predecessor is never inherited.
// ---------------------------------------------------------------------------

describe("ALI-133 AC8: negative case -- an ambiguous predecessor is not inherited by the next issue", () => {
  it("B forks from config.baseRef and its PR base is config.basePrBranch, not A's abandoned branch", async () => {
    const issueA = makeIssue("aband-a", 1, { priority: 1, predictedFiles: ["src/abandoned.ts"] });
    const issueB = makeIssue("aband-b", 1, { priority: 2, predictedFiles: ["src/abandoned.ts"] });
    const { port: linear, state: linearState } = createFakeLinear({ readyIssues: [issueA, issueB] });
    const { port: worktree, state: worktreeState } = createFakeWorktree();
    const { port: github, state: githubState } = createFakeGitHub();
    const { port: agent } = createFakeAgent((seat, ctx) => {
      if (seat === "builder" && ctx.issue.id === "aband-a") {
        return { summary: "found a gap", ambiguous: { question: "Which retry policy applies here?" } };
      }
      return { summary: "ok" };
    });

    const config = makeConfig();
    const result = await runDispatcher(config, makeDeps({ linear, worktree, github, agent }));

    // A went to Needs Pedro -- no PR for it.
    const aChange = linearState.statusChanges.filter((c) => c.issueId === "aband-a").at(-1);
    expect(aChange?.status).toBe("Needs Pedro");

    // Exactly one PR opened this run -- B's.
    expect(githubState.prs).toHaveLength(1);
    expect(githubState.prs[0]?.branch).toBe("dispatcher/aband-b");
    expect(githubState.prs[0]?.base).toBe(config.basePrBranch);

    // B's fork used config.baseRef -- never A's abandoned branch, even
    // though A precedes B in the same (same-file) cluster.
    const forkForB = worktreeState.forked.find((f) => f.branch === "dispatcher/aband-b");
    expect(forkForB?.baseRef).toBe(config.baseRef);
    expect(forkForB?.baseRef).not.toBe("dispatcher/aband-a");

    const bEntry = result.runLog.candidates.find((c) => c.issueId === "aband-b");
    expect(bEntry?.outcome).toBe("opened-pr");
  });
});

// ---------------------------------------------------------------------------
// criterion 7: stop_reason is always one of the six enumerated values
// ---------------------------------------------------------------------------

describe("criterion 7: stop_reason is always one of the six enumerated values", () => {
  it("no-approved-cycle", async () => {
    const { port: linear } = createFakeLinear({ approvedCycle: null });
    const result = await runDispatcher(makeConfig(), makeDeps({ linear }));
    expect(result.runLog.stopReason).toBe("no-approved-cycle");
  });

  it("gate-hit (status-name drift)", async () => {
    const { port: linear } = createFakeLinear({ workflowStatuses: ["Backlog", "Ready", "Todo", "Done"] });
    const result = await runDispatcher(makeConfig(), makeDeps({ linear }));
    expect(result.runLog.stopReason).toBe("gate-hit");
  });

  it("cycle-empty (nothing Ready in the approved cycle)", async () => {
    const { port: linear } = createFakeLinear({ readyIssues: [] });
    const result = await runDispatcher(makeConfig(), makeDeps({ linear }));
    expect(result.runLog.stopReason).toBe("cycle-empty");
  });

  it("budget-exhausted (a budget deferral occurred, no backstop fired)", async () => {
    const admitted = makeIssue("fits", 3, { priority: 1 });
    const deferredForBudget = makeIssue("also-fits-alone-not-together", 4, { priority: 2 });
    const { port: linear } = createFakeLinear({ readyIssues: [admitted, deferredForBudget] });
    const result = await runDispatcher(makeConfig(), makeDeps({ linear }));
    expect(result.runLog.stopReason).toBe("budget-exhausted");
  });

  it("backstop-wallclock (soft wall-clock trip)", async () => {
    const a = makeIssue("wc-a", 1, { priority: 1 });
    const b = makeIssue("wc-b", 1, { priority: 2, predictedFiles: ["different.ts"] });
    const { port: linear } = createFakeLinear({ readyIssues: [a, b] });
    const clock = createFakeClock(0);
    const { port: agent } = createFakeAgent((seat) => {
      if (seat === "builder") clock.advance(2_000);
      return { summary: "ok" };
    });
    const config = makeConfig({
      dispatcher: { budget: 5, riskWeight: 2.0, maxConcurrency: 1 },
      backstop: { wallClockSoftMs: 1_000, wallClockHardMs: 1_000_000 },
    });
    const result = await runDispatcher(config, makeDeps({ linear, agent, clock }));
    expect(result.runLog.stopReason).toBe("backstop-wallclock");
  });

  it("backstop-tokens (soft token trip, wall-clock nowhere close)", async () => {
    const a = makeIssue("tok-a", 1, { priority: 1 });
    const b = makeIssue("tok-b", 1, { priority: 2, predictedFiles: ["different.ts"] });
    const { port: linear } = createFakeLinear({ readyIssues: [a, b] });
    const { port: agent } = createFakeAgent((seat) => {
      if (seat === "builder") return { summary: "ok", tokensUsed: 10_000 };
      return { summary: "ok" };
    });
    const config = makeConfig({
      dispatcher: { budget: 5, riskWeight: 2.0, maxConcurrency: 1 },
      backstop: { wallClockSoftMs: 999_999_999, wallClockHardMs: 999_999_999_999, tokenBudgetSoft: 5_000 },
    });
    const result = await runDispatcher(config, makeDeps({ linear, agent }));
    expect(result.runLog.stopReason).toBe("backstop-tokens");
  });

  it("every stop_reason value produced above is a member of the enumerated seven, never free text", () => {
    for (const value of STOP_REASONS) {
      expect(isStopReason(value)).toBe(true);
    }
    // ALI-104 AC4: engine-drift is the seventh stop reason.
    expect(STOP_REASONS).toHaveLength(7);
    expect(isStopReason("something-else")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// criterion 8: status-name drift check
// ---------------------------------------------------------------------------

describe("criterion 8: status-name drift check never silently reads 'missing status' as 'no work'", () => {
  it("checkStatusDrift flags every missing required status by name", () => {
    expect(checkStatusDrift(VALID_WORKFLOW_STATUSES)).toEqual({ ok: true, missing: [] });
    expect(checkStatusDrift(["Backlog", "Todo", "In Progress", "In Review", "Done"])).toEqual({
      ok: false,
      missing: ["Ready", "Parked", "Needs Pedro"],
    });
    expect(checkStatusDrift(["Ready", "Parked"])).toEqual({ ok: false, missing: ["Needs Pedro"] });
  });

  it("the loud error names exactly the missing status(es)", () => {
    const message = statusDriftMessage(["Ready", "Needs Pedro"]);
    expect(message).toContain("Ready");
    expect(message).toContain("Needs Pedro");
  });

  it("a missing status stops the run with stop_reason gate-hit, before the approved-cycle check runs", async () => {
    const { port: linear, state: linearState } = createFakeLinear({
      workflowStatuses: ["Backlog", "Todo", "In Progress", "In Review", "Done"],
    });
    const result = await runDispatcher(makeConfig(), makeDeps({ linear }));

    expect(result.runLog.stopReason).toBe("gate-hit");
    expect(result.runLog.fatalError).toContain("Ready");
    expect(result.runLog.fatalError).toContain("Parked");
    expect(result.runLog.fatalError).toContain("Needs Pedro");
    // The drift check is the very first thing checked -- it never even asks
    // whether a cycle is approved once the board itself can't be trusted.
    expect(linearState.calls.getApprovedCycle).toBe(0);
    expect(result.runLog.candidates).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// criterion 9: a backstop fire increments a counter the planner can read
// ---------------------------------------------------------------------------

describe("criterion 9: a backstop fire increments a readable counter", () => {
  it("stays zero across a run with no backstop trip", async () => {
    const { port: linear } = createFakeLinear({ readyIssues: [makeIssue("clean", 1)] });
    const result = await runDispatcher(makeConfig(), makeDeps({ linear }));
    expect(result.runLog.backstopFireCount).toBe(0);
  });

  it("increments to 1 on a soft backstop trip", async () => {
    const a = makeIssue("soft-a", 1, { priority: 1 });
    const b = makeIssue("soft-b", 1, { priority: 2, predictedFiles: ["x.ts"] });
    const { port: linear } = createFakeLinear({ readyIssues: [a, b] });
    const clock = createFakeClock(0);
    const { port: agent } = createFakeAgent((seat) => {
      if (seat === "builder") clock.advance(2_000);
      return { summary: "ok" };
    });
    const config = makeConfig({
      dispatcher: { budget: 5, riskWeight: 2.0, maxConcurrency: 1 },
      backstop: { wallClockSoftMs: 1_000, wallClockHardMs: 1_000_000 },
    });
    const result = await runDispatcher(config, makeDeps({ linear, agent, clock }));
    expect(result.runLog.backstopFireCount).toBe(1);
  });

  it("increments to 1 on a hard-kill (a more severe backstop fire, still one event)", async () => {
    const issue = makeIssue("hard-fire", 1);
    const { port: linear } = createFakeLinear({ readyIssues: [issue] });
    const clock = createFakeClock(0);
    const { port: agent } = createFakeAgent((seat) => {
      if (seat === "builder") clock.advance(10_000);
      return { summary: "ok" };
    });
    const config = makeConfig({ backstop: { wallClockSoftMs: 900_000, wallClockHardMs: 1_000 } });
    const result = await runDispatcher(config, makeDeps({ linear, agent, clock }));
    expect(result.runLog.backstopFireCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// criterion 10: no secret material in emitted artifacts
// ---------------------------------------------------------------------------

describe("criterion 10: no secret material in emitted artifacts", () => {
  const DUMMY_LINEAR_KEY = "lin_api_1234567890abcdefLINEARDUMMY";
  const DUMMY_GITHUB_TOKEN = "ghp_1234567890abcdefGITHUBDUMMYTOKEN00";
  const SECRET_SUBSTRINGS = ["ghp_", "github_pat_", "lin_api_", "sk-"];

  it("the run log JSON and the cycle summary contain neither the dummy credential values nor any known secret prefix", async () => {
    const expensive = makeIssue("expensive", 5, { priority: 1 });
    const { port: linear } = createFakeLinear({ readyIssues: [expensive] });
    const credentials: RuntimeCredentials = { linearApiKey: DUMMY_LINEAR_KEY, githubToken: DUMMY_GITHUB_TOKEN };

    const result = await runDispatcher(makeConfig(), makeDeps({ linear, credentials }));

    for (const haystack of [result.runLogJson, result.cycleSummary]) {
      expect(haystack).not.toContain(DUMMY_LINEAR_KEY);
      expect(haystack).not.toContain(DUMMY_GITHUB_TOKEN);
      for (const substring of SECRET_SUBSTRINGS) {
        expect(haystack).not.toContain(substring);
      }
    }
  });

  it("an env-sourced credential field reproduced in the log is redacted, not omitted-then-forgotten", async () => {
    const { port: linear } = createFakeLinear({ readyIssues: [] });
    const credentials: RuntimeCredentials = { linearApiKey: DUMMY_LINEAR_KEY, githubToken: DUMMY_GITHUB_TOKEN };
    const result = await runDispatcher(makeConfig(), makeDeps({ linear, credentials }));

    expect(result.runLog.credentials).toEqual({ linear: "[REDACTED]", github: "[REDACTED]" });
  });

  it("an unset credential is rendered distinctly from a redacted one", async () => {
    const { port: linear } = createFakeLinear({ readyIssues: [] });
    const result = await runDispatcher(makeConfig(), makeDeps({ linear, credentials: {} }));
    expect(result.runLog.credentials).toEqual({ linear: "[NOT SET]", github: "[NOT SET]" });
  });

  it("redact() never echoes the value or a recognizable prefix of it", () => {
    expect(redact(DUMMY_LINEAR_KEY)).toBe("[REDACTED]");
    expect(redact(undefined)).toBe("[NOT SET]");
    expect(redact(null)).toBe("[NOT SET]");
    expect(redact("")).toBe("[NOT SET]");
  });

  it("scrubSecrets strips every known prefix wherever it appears, as a defense-in-depth pass", () => {
    const text = `token=${DUMMY_GITHUB_TOKEN} pat=github_pat_abc123 key=${DUMMY_LINEAR_KEY} anthropic=sk-ant-abc123`;
    const scrubbed = scrubSecrets(text);
    for (const substring of SECRET_SUBSTRINGS) {
      expect(scrubbed).not.toContain(substring);
    }
    expect(scrubbed).toContain("[REDACTED]");
  });

  it("containsSecretLike detects each known prefix and rejects clean text", () => {
    for (const prefix of SECRET_SUBSTRINGS) {
      expect(containsSecretLike(`${prefix}abcdef`)).toBe(true);
    }
    expect(containsSecretLike("perfectly ordinary log line")).toBe(false);
  });

  it("a secret-shaped substring inside seat output (not just config) is scrubbed from the final artifact too", async () => {
    // Seat summaries are free text an agent produced -- unlike config, they
    // are not structurally kept secret-free by construction, so this is
    // exactly what the defense-in-depth scrub pass (not structural
    // avoidance alone) exists to catch.
    const issue = makeIssue("leaky-summary", 1);
    const { port: linear } = createFakeLinear({ readyIssues: [issue] });
    const { port: agent } = createFakeAgent((seat) => {
      if (seat === "builder") return { summary: "found a stray sk-abc123leaked in a fixture, removed it" };
      return { summary: "ok" };
    });

    const result = await runDispatcher(makeConfig(), makeDeps({ linear, agent }));

    expect(result.runLogJson).not.toContain("sk-abc123leaked");
    expect(result.runLogJson).toContain("[REDACTED]");
  });

  // AC10 names "the emitted `.engine/runs/<iso-timestamp>.json`" as the test
  // target -- the scan above only ever inspected the in-memory string. This
  // reads the file `runDispatcherAndPersist()` actually wrote back off disk,
  // so the criterion is checked against the real artifact, not a stand-in.
  it("the FILE actually written to .engine/runs/ (not just the in-memory string) contains no dummy credential values or known secret prefixes", async () => {
    const tempDir = await fs.mkdtemp(join(tmpdir(), "ali103-runlog-secrets-"));
    try {
      const expensive = makeIssue("expensive", 5, { priority: 1 });
      const { port: linear } = createFakeLinear({ readyIssues: [expensive] });
      const credentials: RuntimeCredentials = { linearApiKey: DUMMY_LINEAR_KEY, githubToken: DUMMY_GITHUB_TOKEN };

      const result = await runDispatcherAndPersist(makeConfig(), makeDeps({ linear, credentials }), tempDir);
      const onDisk = await fs.readFile(result.runLogFilePath, "utf8");

      expect(onDisk).not.toContain(DUMMY_LINEAR_KEY);
      expect(onDisk).not.toContain(DUMMY_GITHUB_TOKEN);
      for (const substring of SECRET_SUBSTRINGS) {
        expect(onDisk).not.toContain(substring);
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// reviewer finding #13: the run log is actually persisted to disk
//
// ALI-103 §5 says "Emit `.engine/runs/<iso-timestamp>.json`"; AC10 names
// that emitted file as its own test target. `runDispatcher()` only ever
// returned the JSON in memory -- these tests close that gap by exercising
// `runDispatcherAndPersist()`, the thin wrapper that actually writes it.
// ---------------------------------------------------------------------------

describe("finding #13: runDispatcherAndPersist() actually writes .engine/runs/<iso-timestamp>.json", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("writes the file at the computed path, byte-identical to the returned runLogJson", async () => {
    const tempDir = await fs.mkdtemp(join(tmpdir(), "ali103-runlog-write-"));
    tempDirs.push(tempDir);

    const issue = makeIssue("persisted", 1);
    const { port: linear } = createFakeLinear({ readyIssues: [issue] });
    const clock = createFakeClock(1_755_302_400_000); // fixed, so generatedAt is deterministic

    const result = await runDispatcherAndPersist(makeConfig(), makeDeps({ linear, clock }), tempDir);

    const expectedPath = join(tempDir, runLogPath(result.runLog.generatedAt));
    expect(result.runLogFilePath).toBe(expectedPath);

    const onDisk = await fs.readFile(expectedPath, "utf8");
    expect(onDisk).toBe(result.runLogJson);
  });

  it("still persists a record when the run stops at no-approved-cycle (the fail-closed audit trail)", async () => {
    const tempDir = await fs.mkdtemp(join(tmpdir(), "ali103-runlog-no-cycle-"));
    tempDirs.push(tempDir);

    const { port: linear } = createFakeLinear({ approvedCycle: null });
    const result = await runDispatcherAndPersist(makeConfig(), makeDeps({ linear }), tempDir);

    const onDisk = await fs.readFile(result.runLogFilePath, "utf8");
    expect(JSON.parse(onDisk).stopReason).toBe("no-approved-cycle");
  });

  it("still persists a record when the run stops at gate-hit (status-name drift)", async () => {
    const tempDir = await fs.mkdtemp(join(tmpdir(), "ali103-runlog-gate-hit-"));
    tempDirs.push(tempDir);

    const { port: linear } = createFakeLinear({ workflowStatuses: ["Backlog", "Todo", "Done"] });
    const result = await runDispatcherAndPersist(makeConfig(), makeDeps({ linear }), tempDir);

    const onDisk = await fs.readFile(result.runLogFilePath, "utf8");
    expect(JSON.parse(onDisk).stopReason).toBe("gate-hit");
    expect(JSON.parse(onDisk).fatalError).toBeTruthy();
  });

  it("writes into a .engine/runs/ directory it creates itself", async () => {
    const tempDir = await fs.mkdtemp(join(tmpdir(), "ali103-runlog-mkdir-"));
    tempDirs.push(tempDir);
    // Sanity: .engine/runs/ does not exist yet in this fresh temp dir.
    await expect(fs.stat(join(tempDir, ".engine", "runs"))).rejects.toThrow();

    const { port: linear } = createFakeLinear({ approvedCycle: null });
    await runDispatcherAndPersist(makeConfig(), makeDeps({ linear }), tempDir);

    const stat = await fs.stat(join(tempDir, ".engine", "runs"));
    expect(stat.isDirectory()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// criterion 11: verdict vocabulary parity with the merged core
// ---------------------------------------------------------------------------

describe("criterion 11: verdict vocabulary maps 1:1 onto admitted + DeferralReason", () => {
  const ALL_DEFERRAL_REASONS: readonly DeferralReason[] = [
    "budget",
    "dependency",
    "exceeds-budget-must-split",
    "cluster-conflict",
  ];

  it("every DeferralReason maps to a distinct Verdict", () => {
    const verdicts = ALL_DEFERRAL_REASONS.map(deferralReasonToVerdict);
    expect(new Set(verdicts).size).toBe(ALL_DEFERRAL_REASONS.length);
    for (const verdict of verdicts) expect(VERDICTS).toContain(verdict);
  });

  it("the mapping is total in both directions", () => {
    // Forward: every DeferralReason has exactly one Verdict.
    for (const reason of ALL_DEFERRAL_REASONS) {
      const verdict = deferralReasonToVerdict(reason);
      expect(verdict).toBeDefined();
      // Reverse: that Verdict maps back to the same DeferralReason.
      expect(verdictToDeferralReason(verdict)).toBe(reason);
    }
    // The two runtime-only verdicts have no core DeferralReason at all.
    expect(verdictToDeferralReason("admitted")).toBeNull();
    expect(verdictToDeferralReason("not-reached")).toBeNull();
    // Every Verdict is accounted for: either runtime-only, or the image of exactly one DeferralReason.
    const imageOfDeferralReasons = new Set(ALL_DEFERRAL_REASONS.map(deferralReasonToVerdict));
    for (const verdict of VERDICTS) {
      const isRuntimeOnly = verdict === "admitted" || verdict === "not-reached";
      expect(isRuntimeOnly || imageOfDeferralReasons.has(verdict)).toBe(true);
    }
    expect(VERDICTS).toHaveLength(ALL_DEFERRAL_REASONS.length + 2);
  });

  it("a plan() deferral with reason 'dependency' renders in the run log as 'deferred (dependency)'", async () => {
    // The blocker alone costs more than the whole budget, so it can never
    // be admitted -- which forces the dependent's deferral reason to be
    // "dependency" rather than "budget" (its own cost would easily fit).
    const bigBlocker = makeIssue("big-blocker", 10, { priority: 1 });
    const dependent = makeIssue("dependent", 1, { priority: 2, blockedBy: ["big-blocker"] });
    const { port: linear } = createFakeLinear({ readyIssues: [bigBlocker, dependent] });

    const result = await runDispatcher(makeConfig(), makeDeps({ linear }));
    const entry = result.runLog.candidates.find((c) => c.issueId === "dependent");
    expect(entry?.verdict).toBe("deferred (dependency)");
  });
});

// ---------------------------------------------------------------------------
// ALI-106: the amended run-log schema -- seats[] records what actually ran
// (never the routing table's prediction), bounces[] is structured, and
// risk.verifierTier is derived from real seat reports.
// ---------------------------------------------------------------------------

describe("ALI-106 AC1.3: seats[] records what actually ran, not the routing table's prediction", () => {
  it("a 1-point issue predicts pointsTier=haiku, but the builder reports it ran at opus -- the log shows opus", async () => {
    const issue = makeIssue("tier-mismatch", 1, { priority: 1 });
    const { port: linear } = createFakeLinear({ readyIssues: [issue] });
    const { port: agent } = createFakeAgent((seat) => {
      if (seat === "builder") return { summary: "ok", model: "opus", tokensUsed: 500 };
      return { summary: "ok", model: "sonnet", tokensUsed: 100 };
    });

    const result = await runDispatcher(makeConfig(), makeDeps({ linear, agent }));
    const entry = result.runLog.candidates.find((c) => c.issueId === "tier-mismatch");

    // The routing table's own prediction, unchanged -- haiku for a 1-point issue.
    expect(entry?.tier.tier).toBe("haiku");

    // What actually ran, per seats[] -- opus, sourced from the agent's own report.
    const builderSeat = entry?.seats.find((s) => s.seat === "builder");
    expect(builderSeat?.model).toBe("opus");
    expect(builderSeat?.tokens).toBe(500);
    expect(builderSeat?.effort).toBe("standard");
    expect(builderSeat?.wallClockMs).toBeGreaterThanOrEqual(0);
  });

  it("every ran seat carries a wallClockMs, and a skipped seat carries none", async () => {
    const issue = makeIssue("wallclock-check", 1, { priority: 1, labels: ["payments"] });
    const { port: linear } = createFakeLinear({ readyIssues: [issue] });
    const clock = createFakeClock(0);
    const { port: agent } = createFakeAgent(
      (seat) => {
        clock.advance(10);
        return { summary: "ok", model: "sonnet", tokensUsed: 10 };
      },
      (ctx) => {
        clock.advance(10);
        return { testFilesWritten: [`${ctx.issueId}.blind.test.ts`], untestableCriteria: [] };
      },
    );

    const result = await runDispatcher(makeConfig(), makeDeps({ linear, agent, clock }));
    const entry = result.runLog.candidates.find((c) => c.issueId === "wallclock-check");

    for (const seat of ["builder", "blindQa", "reviewer", "security"] as const) {
      const s = entry?.seats.find((x) => x.seat === seat);
      expect(s?.status).toBe("ran");
      expect(s?.wallClockMs).toBeGreaterThan(0);
    }
  });
});

describe("ALI-106 AC1.2: bounces[] is structured, not a count", () => {
  it("a reviewer bounce records round, detectedAtStage, detectorSeat, detectorTokens, reworkTokens, and reason", async () => {
    const issue = makeIssue("bounce-check", 1, { priority: 1 });
    const { port: linear } = createFakeLinear({ readyIssues: [issue] });
    const { port: agent } = createFakeAgent((seat) => {
      if (seat === "reviewer") {
        return {
          summary: "found a lint failure",
          bounced: true,
          bounceDetail: {
            detectedAtStage: "lint",
            detectorTokens: 50,
            reworkTokens: 200,
            reason: "eslint: unused import",
          },
          tokensUsed: 50,
        };
      }
      return { summary: "ok" };
    });

    const result = await runDispatcher(makeConfig(), makeDeps({ linear, agent }));
    const entry = result.runLog.candidates.find((c) => c.issueId === "bounce-check");

    expect(entry?.bounces).toEqual([
      {
        round: 1,
        detectedAtStage: "lint",
        detectorSeat: "reviewer",
        detectorTokens: 50,
        reworkTokens: 200,
        reason: "eslint: unused import",
      },
    ]);
  });

  it("multiple bounces across seats are recorded in order, 1-indexed", async () => {
    const issue = makeIssue("multi-bounce", 1, { priority: 1, labels: ["payments"] });
    const { port: linear } = createFakeLinear({ readyIssues: [issue] });
    const { port: agent } = createFakeAgent((seat) => {
      if (seat === "builder") {
        return {
          summary: "internal rework",
          bounced: true,
          bounceDetail: { detectedAtStage: "judgment", detectorTokens: 10, reworkTokens: 30, reason: "self-caught bug" },
        };
      }
      if (seat === "security") {
        return {
          summary: "found an authz gap",
          bounced: true,
          bounceDetail: { detectedAtStage: "judgment", detectorTokens: 20, reworkTokens: 60, reason: "missing authz check" },
        };
      }
      return { summary: "ok" };
    });

    const result = await runDispatcher(makeConfig(), makeDeps({ linear, agent }));
    const entry = result.runLog.candidates.find((c) => c.issueId === "multi-bounce");

    expect(entry?.bounces.map((b) => b.round)).toEqual([1, 2]);
    expect(entry?.bounces.map((b) => b.detectorSeat)).toEqual(["builder", "security"]);
  });

  it("bounced: true without bounceDetail falls back to the conservative (judgment-stage) default, never guessed cheap", async () => {
    const issue = makeIssue("bounce-no-detail", 1, { priority: 1 });
    const { port: linear } = createFakeLinear({ readyIssues: [issue] });
    const { port: agent } = createFakeAgent((seat) => {
      if (seat === "reviewer") return { summary: "bounced, no detail", bounced: true, tokensUsed: 30 };
      return { summary: "ok" };
    });

    const result = await runDispatcher(makeConfig(), makeDeps({ linear, agent }));
    const entry = result.runLog.candidates.find((c) => c.issueId === "bounce-no-detail");

    expect(entry?.bounces).toHaveLength(1);
    expect(entry?.bounces[0]?.detectedAtStage).toBe("judgment");
    expect(entry?.bounces[0]?.detectorSeat).toBe("reviewer");
  });

  it("no bounce reported -- bounces[] is an empty array, never left as a bare count", async () => {
    const issue = makeIssue("no-bounce", 1, { priority: 1 });
    const { port: linear } = createFakeLinear({ readyIssues: [issue] });
    const result = await runDispatcher(makeConfig(), makeDeps({ linear }));
    const entry = result.runLog.candidates.find((c) => c.issueId === "no-bounce");
    expect(entry?.bounces).toEqual([]);
  });
});

describe("ALI-106 AC1.4: risk.verifierTier distinguishes what verification actually ran at", () => {
  it("a danger-labeled issue whose reviewer reports opus -- verifierTier is opus, matching the risk floor", async () => {
    const issue = makeIssue("risky-verify", 1, { priority: 1, labels: ["payments"] });
    const { port: linear } = createFakeLinear({ readyIssues: [issue] });
    const { port: agent } = createFakeAgent((seat) => {
      if (seat === "reviewer" || seat === "security") return { summary: "ok", model: "opus" };
      return { summary: "ok", model: "sonnet" };
    });

    const result = await runDispatcher(makeConfig(), makeDeps({ linear, agent }));
    const entry = result.runLog.candidates.find((c) => c.issueId === "risky-verify");

    expect(entry?.risk).toEqual({ labels: ["payments"], points: 1, verifierTier: "opus" });
  });

  it("a plain issue whose reviewer reports sonnet, security skipped -- verifierTier is sonnet (max of what ran, not what was predicted)", async () => {
    const issue = makeIssue("plain-verify", 2, { priority: 1 });
    const { port: linear } = createFakeLinear({ readyIssues: [issue] });
    const { port: agent } = createFakeAgent((seat) => {
      if (seat === "reviewer") return { summary: "ok", model: "sonnet" };
      return { summary: "ok" };
    });

    const result = await runDispatcher(makeConfig(), makeDeps({ linear, agent }));
    const entry = result.runLog.candidates.find((c) => c.issueId === "plain-verify");
    expect(entry?.risk.verifierTier).toBe("sonnet");
  });

  it("a candidate never dispatched (deferred) keeps verifierTier 'none' and carries its own labels/points", async () => {
    // "fits-alone" (5pt, no danger label -> weighted cost 5) fills the
    // default budget (5) by itself, exactly as criterion 2's own fixture
    // does -- leaving "never-runs" (4pt) with nothing left to fit into.
    const admitted = makeIssue("fits-alone", 5, { priority: 1 });
    const deferred = makeIssue("never-runs", 4, { priority: 2 });
    const { port: linear } = createFakeLinear({ readyIssues: [admitted, deferred] });

    const result = await runDispatcher(makeConfig(), makeDeps({ linear }));
    const entry = result.runLog.candidates.find((c) => c.issueId === "never-runs");
    expect(entry?.outcome).toBe("not-dispatched");
    expect(entry?.risk).toEqual({ labels: [], points: 4, verifierTier: "none" });
  });

  it("no reported model at all (fixtures that never set one) -- verifierTier stays 'none', never guessed", async () => {
    const issue = makeIssue("no-model-reported", 1, { priority: 1 });
    const { port: linear } = createFakeLinear({ readyIssues: [issue] });
    const result = await runDispatcher(makeConfig(), makeDeps({ linear })); // default fake agent reports no model
    const entry = result.runLog.candidates.find((c) => c.issueId === "no-model-reported");
    expect(entry?.risk.verifierTier).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// supplementary: per-issue ambiguity ("never guess") does not stop the run
// ---------------------------------------------------------------------------

describe("supplementary: an ambiguous issue goes to Needs Pedro (cycle cleared) and the run moves on", () => {
  it("does not stop the run, and does not park the worktree", async () => {
    const ambiguous = makeIssue("ambiguous", 1, { priority: 1, predictedFiles: ["a.ts"] });
    const clean = makeIssue("clean", 1, { priority: 2, predictedFiles: ["b.ts"] });
    const { port: linear, state: linearState } = createFakeLinear({ readyIssues: [ambiguous, clean] });
    const { port: agent } = createFakeAgent((seat, ctx) => {
      if (seat === "builder" && ctx.issue.id === "ambiguous") {
        return { summary: "found a gap", ambiguous: { question: "Which retry policy applies here?" } };
      }
      return { summary: "ok" };
    });

    const result = await runDispatcher(makeConfig(), makeDeps({ linear, agent }));

    const lastChange = linearState.statusChanges.filter((c) => c.issueId === "ambiguous").at(-1);
    expect(lastChange).toEqual({ issueId: "ambiguous", status: "Needs Pedro", cycleId: null });
    expect(linearState.comments.find((c) => c.issueId === "ambiguous")?.body).toContain("retry policy");

    const cleanEntry = result.runLog.candidates.find((c) => c.issueId === "clean");
    expect(cleanEntry?.outcome).toBe("opened-pr");
    expect(result.runLog.stopReason).toBe("cycle-empty");
  });
});

// ---------------------------------------------------------------------------
// ALI-105: the blind test-author seat -- criteria 5-9
// ---------------------------------------------------------------------------

// A body deliberately missing the "## Acceptance criteria" heading entirely.
const NO_AC_HEADING_BODY = ["## Why", "", "stuff", "", "## What", "", "more stuff", ""].join("\n");

// A body with the heading present but nothing under it before the next section.
const EMPTY_AC_SECTION_BODY = ["## Acceptance criteria", "", "## Invariant", "", "holds", ""].join("\n");

describe("ALI-105 criterion 5: blind QA dispatches for real -- no more hardcoded skip", () => {
  it("every dispatched issue's blindQa seat is a real dispatch call, through dispatchBlindQa (never dispatch)", async () => {
    const issue = makeIssue("qa-check", 1);
    const { port: linear } = createFakeLinear({ readyIssues: [issue] });
    const { port: agent, calls, blindCalls } = createFakeAgent();

    const result = await runDispatcher(makeConfig(), makeDeps({ linear, agent }));

    expect(blindCalls).toHaveLength(1);
    expect(blindCalls[0]?.issueId).toBe("qa-check");
    // Went through dispatchBlindQa, not dispatch() -- `calls` (dispatch()'s
    // own call log) has no blindQa entry to find at all, by construction:
    // `Seat` doesn't even include "blindQa" as a value.
    expect(calls.filter((c) => c.issueId === "qa-check")).toHaveLength(2); // builder + reviewer only

    const entry = result.runLog.candidates.find((c) => c.issueId === "qa-check");
    const qaSeat = entry?.seats.find((s) => s.seat === "blindQa");
    expect(qaSeat?.status).toBe("ran");
    // AC5's other half -- the retired status string no longer appearing
    // anywhere in src/** (a repo grep returns no hits) -- is deliberately
    // NOT re-typed here as a string literal: doing so would put a hit back
    // into src/** and defeat the grep this test's own docstring relies on.
    // Verified instead by `SeatOutcome["status"]`'s union (this file
    // wouldn't typecheck if "ran" weren't a legal value) and recorded as a
    // literal grep in the PR body.
  });
});

describe("ALI-105 criterion 6: structural blindness -- the runtime half", () => {
  it("the captured blind context's own keys are exactly the five allowed fields, all non-empty, and none of DispatchContext's fields", async () => {
    const issue = makeIssue("blind-shape", 1, { predictedFiles: ["src/shape.ts"] });
    const { port: linear } = createFakeLinear({ readyIssues: [issue] });
    let captured: BlindDispatchContext | undefined;
    const { port: agent } = createFakeAgent(undefined, async (ctx) => {
      captured = ctx;
      return { testFilesWritten: [], untestableCriteria: [] };
    });

    await runDispatcher(makeConfig(), makeDeps({ linear, agent }));

    expect(captured).toBeDefined();

    // (a) present and non-empty.
    const ALLOWED_KEYS = ["issueId", "title", "acceptanceCriteria", "invariant", "definitionOfDone"] as const;
    const actualKeys = Object.keys(captured as object).sort();
    expect(actualKeys).toEqual([...ALLOWED_KEYS].sort());
    for (const key of ALLOWED_KEYS) {
      expect((captured as unknown as Record<string, unknown>)[key]).toBeTruthy();
    }

    // (b) absent -- asserted against the captured object's OWN keys, so a
    // later field added to BlindDispatchContext by mistake fails this test
    // rather than silently passing.
    const FORBIDDEN_KEYS = ["worktreePath", "branch", "predictedFiles", "diff", "labels", "body"];
    for (const key of FORBIDDEN_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(captured as object, key)).toBe(false);
    }
  });

  it("DispatchContext is not assignable to BlindDispatchContext -- compile-time proof, enforced by npm run typecheck", () => {
    // This function is declared, never called: the value under test is
    // whether the line below type-checks, not any runtime behavior. If a
    // future edit widens BlindDispatchContext (e.g. makes a field optional,
    // or adds `worktreePath?`) such that the assignment below stops being
    // an error, `@ts-expect-error` itself becomes an error ("unused
    // ts-expect-error directive") and `npm run typecheck` goes red -- the
    // proof is the compiler run, not this test's runtime assertion.
    function neverCalled(ctx: DispatchContext): void {
      // @ts-expect-error -- DispatchContext carries worktreePath/branch/enginePath/issue;
      // BlindDispatchContext requires issueId/title/acceptanceCriteria/invariant/definitionOfDone,
      // none of which DispatchContext has. Structural assignability must fail here.
      const blind: BlindDispatchContext = ctx;
      void blind;
    }
    expect(typeof neverCalled).toBe("function");
  });
});

describe("ALI-105 criterion 7: unparseable criteria -- loud skip, never dispatched, run continues", () => {
  it("no '## Acceptance criteria' heading at all: skipped (unparseable criteria), Linear comment posted, reviewer still runs", async () => {
    const issue = makeIssue("no-ac-heading", 1, { body: NO_AC_HEADING_BODY });
    const { port: linear, state: linearState } = createFakeLinear({ readyIssues: [issue] });
    const { port: agent, calls, blindCalls } = createFakeAgent();

    const result = await runDispatcher(makeConfig(), makeDeps({ linear, agent }));

    const entry = result.runLog.candidates.find((c) => c.issueId === "no-ac-heading");
    const qaSeat = entry?.seats.find((s) => s.seat === "blindQa");
    expect(qaSeat?.status).toBe("skipped (unparseable criteria)");
    expect(blindCalls).toEqual([]); // never dispatched -- not even attempted

    const skipComment = linearState.comments.find(
      (c) => c.issueId === "no-ac-heading" && /acceptance criteria/i.test(c.body),
    );
    expect(skipComment).toBeDefined();
    expect(skipComment?.body).toContain("no-ac-heading");
    expect(skipComment?.body).toMatch(/heading/i);

    // Routing unchanged: continues straight to the reviewer, ends opened-pr.
    expect(calls.some((c) => c.issueId === "no-ac-heading" && c.seat === "reviewer")).toBe(true);
    expect(entry?.outcome).toBe("opened-pr");
    const lastStatus = linearState.statusChanges.filter((c) => c.issueId === "no-ac-heading").at(-1);
    expect(lastStatus?.status).toBe("In Review");
  });

  it("'## Acceptance criteria' heading present but empty: same loud skip, distinct reason text", async () => {
    const issue = makeIssue("empty-ac", 1, { body: EMPTY_AC_SECTION_BODY });
    const { port: linear, state: linearState } = createFakeLinear({ readyIssues: [issue] });
    const { port: agent, blindCalls } = createFakeAgent();

    const result = await runDispatcher(makeConfig(), makeDeps({ linear, agent }));

    const entry = result.runLog.candidates.find((c) => c.issueId === "empty-ac");
    const qaSeat = entry?.seats.find((s) => s.seat === "blindQa");
    expect(qaSeat?.status).toBe("skipped (unparseable criteria)");
    expect(blindCalls).toEqual([]);

    const skipComment = linearState.comments.find(
      (c) => c.issueId === "empty-ac" && /acceptance criteria/i.test(c.body),
    );
    expect(skipComment?.body).toMatch(/empty/i);
    expect(entry?.outcome).toBe("opened-pr"); // never Needs Pedro, never Parked
  });
});

describe("ALI-105 criterion 8: an untestable criterion is recorded and commented, routing unchanged", () => {
  it("named by number in the seat detail and the seat-summary comment; never reroutes to Needs Pedro", async () => {
    const issue = makeIssue("untestable-crit", 1);
    const { port: linear, state: linearState } = createFakeLinear({ readyIssues: [issue] });
    const { port: agent } = createFakeAgent(undefined, async () => ({
      testFilesWritten: ["t1.blind.test.ts"],
      untestableCriteria: [3],
    }));

    const result = await runDispatcher(makeConfig(), makeDeps({ linear, agent }));

    const entry = result.runLog.candidates.find((c) => c.issueId === "untestable-crit");
    const qaSeat = entry?.seats.find((s) => s.seat === "blindQa");
    expect(qaSeat?.status).toBe("ran"); // recorded on a "ran" seat -- not a distinct status
    expect(qaSeat?.detail).toContain("3");

    // Routing unchanged: opened-pr, "In Review" -- never Needs Pedro (that
    // path only ever reads the BUILDER's `ambiguous` field, never blindQa's).
    expect(entry?.outcome).toBe("opened-pr");
    const lastStatus = linearState.statusChanges.filter((c) => c.issueId === "untestable-crit").at(-1);
    expect(lastStatus?.status).toBe("In Review");
    expect(lastStatus?.status).not.toBe("Needs Pedro");

    // Named by number in the seat-summary comment `finalizeOpenedPr` posts.
    const openComment = linearState.comments.find(
      (c) => c.issueId === "untestable-crit" && /blindQa/.test(c.body),
    );
    expect(openComment?.body).toContain("3");
  });

  it("multiple untestable criteria are all named, none dropped", async () => {
    const issue = makeIssue("multi-untestable", 1);
    const { port: linear } = createFakeLinear({ readyIssues: [issue] });
    const { port: agent } = createFakeAgent(undefined, async () => ({
      testFilesWritten: [],
      untestableCriteria: [2, 5, 7],
    }));

    const result = await runDispatcher(makeConfig(), makeDeps({ linear, agent }));

    const entry = result.runLog.candidates.find((c) => c.issueId === "multi-untestable");
    const qaSeat = entry?.seats.find((s) => s.seat === "blindQa");
    for (const n of [2, 5, 7]) expect(qaSeat?.detail).toContain(String(n));
    expect(entry?.outcome).toBe("opened-pr");
  });
});

describe("ALI-105 criterion 9: exactly one blindQa seat entry, enumerated status, for every completed issue", () => {
  it("walks every candidate with outcome 'opened-pr' in a multi-issue run", async () => {
    const clean = makeIssue("multi-clean", 1, { priority: 1, predictedFiles: ["a.ts"] });
    const unparseable = makeIssue("multi-unparseable", 1, {
      priority: 2,
      predictedFiles: ["b.ts"],
      body: NO_AC_HEADING_BODY,
    });
    const withDangerLabel = makeIssue("multi-danger", 1, {
      priority: 3,
      predictedFiles: ["c.ts"],
      labels: ["payments"],
    });
    const { port: linear } = createFakeLinear({ readyIssues: [clean, unparseable, withDangerLabel] });

    const result = await runDispatcher(makeConfig(), makeDeps({ linear }));

    const ENUMERATED_BLIND_QA_STATUSES = ["ran", "skipped (unparseable criteria)"];
    const openedPrCandidates = result.runLog.candidates.filter((c) => c.outcome === "opened-pr");
    expect(openedPrCandidates.length).toBeGreaterThan(0); // sanity: this run actually completed some

    for (const candidate of openedPrCandidates) {
      const qaSeats = candidate.seats.filter((s) => s.seat === "blindQa");
      expect(qaSeats).toHaveLength(1);
      expect(ENUMERATED_BLIND_QA_STATUSES).toContain(qaSeats[0]?.status);
    }
    // All three fixtures here fit the default 5-point budget individually
    // and share no files/blockers -- every one should reach opened-pr.
    expect(openedPrCandidates.map((c) => c.issueId).sort()).toEqual(
      ["multi-clean", "multi-danger", "multi-unparseable"].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// supplementary: security pass is conditional on a danger label
// ---------------------------------------------------------------------------

describe("supplementary: security seat dispatches only for danger-labeled issues", () => {
  it("runs security for a payments issue, skips it (not applicable) for a plain one", async () => {
    const risky = makeIssue("risky", 1, { labels: ["payments"] });
    const plain = makeIssue("plain", 1, { predictedFiles: ["different.ts"] });
    const { port: linear } = createFakeLinear({ readyIssues: [risky, plain] });
    const { port: agent, calls } = createFakeAgent();

    const result = await runDispatcher(makeConfig(), makeDeps({ linear, agent }));

    expect(calls.some((c) => c.issueId === "risky" && c.seat === "security")).toBe(true);
    expect(calls.some((c) => c.issueId === "plain" && c.seat === "security")).toBe(false);

    const plainEntry = result.runLog.candidates.find((c) => c.issueId === "plain");
    expect(plainEntry?.seats.find((s) => s.seat === "security")?.status).toBe("skipped (not applicable)");
  });
});

// ---------------------------------------------------------------------------
// supplementary: model tier is recorded with its inputs shown
// ---------------------------------------------------------------------------

describe("supplementary: per-issue model tier is recorded with pointsTier/riskTier/tier all shown", () => {
  it("a 1-point payments issue logs pointsTier=haiku, riskTier=opus, tier=opus", async () => {
    const issue = makeIssue("small-risky", 1, { labels: ["payments"] });
    const { port: linear } = createFakeLinear({ readyIssues: [issue] });
    const result = await runDispatcher(makeConfig(), makeDeps({ linear }));
    const entry = result.runLog.candidates.find((c) => c.issueId === "small-risky");
    expect(entry?.tier).toEqual({ issueId: "small-risky", pointsTier: "haiku", riskTier: "opus", tier: "opus" });
  });
});

// ---------------------------------------------------------------------------
// supplementary: runLogPath is deterministic from generatedAt
// ---------------------------------------------------------------------------

describe("supplementary: runLogPath", () => {
  it("builds .engine/runs/<iso-timestamp>.json", () => {
    expect(runLogPath("2026-08-15T23:47:00.000Z")).toBe(".engine/runs/2026-08-15T23:47:00.000Z.json");
  });
});

// ---------------------------------------------------------------------------
// supplementary: WorktreePort real adapter (hermetic real-git, no network)
// ---------------------------------------------------------------------------

describe("supplementary: WorktreePort real adapter against a real throwaway git repo", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("creates and removes a real worktree via `git worktree`", async () => {
    const repoRoot = await fs.mkdtemp(join(tmpdir(), "ali103-repo-"));
    tempDirs.push(repoRoot);
    const worktreesDir = await fs.mkdtemp(join(tmpdir(), "ali103-worktrees-"));
    tempDirs.push(worktreesDir);

    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repoRoot });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: repoRoot });
    await fs.writeFile(join(repoRoot, "README.md"), "hermetic fixture\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: repoRoot });
    await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });

    const port = createGitWorktreePort(repoRoot, worktreesDir);
    const handle = await port.createWorktree("test-branch", "main");

    const stat = await fs.stat(handle.path);
    expect(stat.isDirectory()).toBe(true);

    await port.remove(handle);
    await expect(fs.stat(handle.path)).rejects.toThrow();
  });

  // ALI-133 AC9: real git, no cross-issue commits, and a dirty tree never
  // leaks across a fork.
  it("chained forkBranch calls carry no cross-issue commits, and a fresh fork discards a dirty tree", async () => {
    const repoRoot = await fs.mkdtemp(join(tmpdir(), "ali133-repo-"));
    tempDirs.push(repoRoot);
    const worktreesDir = await fs.mkdtemp(join(tmpdir(), "ali133-worktrees-"));
    tempDirs.push(worktreesDir);

    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repoRoot });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: repoRoot });
    await fs.writeFile(join(repoRoot, "README.md"), "hermetic fixture\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: repoRoot });
    await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });

    const port = createGitWorktreePort(repoRoot, worktreesDir);
    let handle = await port.createWorktree("scaffold", "main");

    // dispatcher/a forks from main, commits one file.
    handle = await port.forkBranch(handle, "dispatcher/a", "main");
    await fs.writeFile(join(handle.path, "a.txt"), "issue a\n");
    await execFileAsync("git", ["add", "a.txt"], { cwd: handle.path });
    await execFileAsync("git", ["commit", "-q", "-m", "a"], { cwd: handle.path });

    // dispatcher/b forks from dispatcher/a (not main) -- stacked, chained.
    handle = await port.forkBranch(handle, "dispatcher/b", "dispatcher/a");
    await fs.writeFile(join(handle.path, "b.txt"), "issue b\n");
    await execFileAsync("git", ["add", "b.txt"], { cwd: handle.path });
    await execFileAsync("git", ["commit", "-q", "-m", "b"], { cwd: handle.path });

    const { stdout: revListOut } = await execFileAsync(
      "git",
      ["rev-list", "--count", "dispatcher/a..dispatcher/b"],
      { cwd: handle.path },
    );
    expect(revListOut.trim()).toBe("1"); // exactly b's own commit -- none of a's

    const { stdout: statusAfterB } = await execFileAsync("git", ["status", "--porcelain"], { cwd: handle.path });
    expect(statusAfterB.trim()).toBe("");

    // Dirty the working tree with an uncommitted, untracked leftover --
    // simulates a builder that touched a file without committing it.
    await fs.writeFile(join(handle.path, "stray.txt"), "uncommitted leftover\n");
    const { stdout: statusDirty } = await execFileAsync("git", ["status", "--porcelain"], { cwd: handle.path });
    expect(statusDirty.trim()).not.toBe("");

    // dispatcher/c forks from main, with that dirty tree still present.
    handle = await port.forkBranch(handle, "dispatcher/c", "main");

    const { stdout: headSha } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: handle.path });
    const { stdout: mainSha } = await execFileAsync("git", ["rev-parse", "main"], { cwd: repoRoot });
    expect(headSha.trim()).toBe(mainSha.trim());

    const { stdout: statusAfterC } = await execFileAsync("git", ["status", "--porcelain"], { cwd: handle.path });
    expect(statusAfterC.trim()).toBe(""); // no leftovers from a/b, and the dirty file is gone

    await expect(fs.stat(join(handle.path, "a.txt"))).rejects.toThrow();
    await expect(fs.stat(join(handle.path, "b.txt"))).rejects.toThrow();
    await expect(fs.stat(join(handle.path, "stray.txt"))).rejects.toThrow();

    await port.remove(handle);
  });
});
