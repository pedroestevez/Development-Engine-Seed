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

function makeIssue(id: string, points: number, extra: Partial<Issue> = {}): LinearIssue {
  return {
    id,
    title: extra.title ?? `Issue ${id}`,
    points,
    priority: extra.priority ?? 100,
    labels: extra.labels ?? [],
    blockedBy: extra.blockedBy ?? [],
    predictedFiles: extra.predictedFiles ?? [],
    state: "Ready",
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

interface FakeWorktreeState {
  created: WorktreeHandle[];
  preserved: WorktreeHandle[];
  removed: WorktreeHandle[];
}

function createFakeWorktree(): { port: WorktreePort; state: FakeWorktreeState } {
  const state: FakeWorktreeState = { created: [], preserved: [], removed: [] };
  const port: WorktreePort = {
    async createWorktree(branch) {
      const handle: WorktreeHandle = { path: `/fake/worktrees/${branch}`, branch };
      state.created.push(handle);
      return handle;
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

interface FakeGitHubState {
  pushed: { path: string; branch: string }[];
  prs: DraftPrParams[];
}

function createFakeGitHub(): { port: GitHubPort; state: FakeGitHubState } {
  const state: FakeGitHubState = { pushed: [], prs: [] };
  let counter = 0;
  const port: GitHubPort = {
    async pushBranch(path, branch) {
      state.pushed.push({ path, branch });
    },
    async openDraftPr(params) {
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

function createFakeAgent(script?: AgentScript): { port: AgentPort; calls: AgentCall[] } {
  const calls: AgentCall[] = [];
  let callIndex = 0;
  const port: AgentPort = {
    async dispatch(seat, ctx) {
      calls.push({ seat, issueId: ctx.issue.id, worktreePath: ctx.worktreePath });
      const idx = callIndex++;
      if (script) return script(seat, ctx, idx);
      return { summary: `${seat} ok` };
    },
  };
  return { port, calls };
}

const BASE_DISPATCHER_CONFIG: DispatcherConfig = { budget: 5, riskWeight: 2.0, maxConcurrency: 4 };

function makeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    dispatcher: overrides.dispatcher ?? BASE_DISPATCHER_CONFIG,
    // A soft/hard window wide enough that no fixture crosses it unless a
    // test deliberately advances the fake clock to trip it.
    backstop: overrides.backstop ?? { wallClockSoftMs: 1_000_000, wallClockHardMs: 2_000_000 },
    engineSha: overrides.engineSha ?? "abc1234",
    baseRef: overrides.baseRef ?? "origin/main",
  };
}

function makeDeps(parts: {
  linear?: LinearPort;
  github?: GitHubPort;
  worktree?: WorktreePort;
  agent?: AgentPort;
  clock?: Clock;
  credentials?: RuntimeCredentials;
}): RunDeps {
  return {
    linear: parts.linear ?? createFakeLinear().port,
    github: parts.github ?? createFakeGitHub().port,
    worktree: parts.worktree ?? createFakeWorktree().port,
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
    const result = await runDispatcher(config, makeDeps({ linear, worktree, agent }));

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

  it("every stop_reason value produced above is a member of the enumerated six, never free text", () => {
    for (const value of STOP_REASONS) {
      expect(isStopReason(value)).toBe(true);
    }
    expect(STOP_REASONS).toHaveLength(6);
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
// supplementary: blind QA seat is always an explicit, loud skip
// ---------------------------------------------------------------------------

describe("supplementary: blind QA (ALI-105) is never a silent pass", () => {
  it("every dispatched issue records blindQa as 'skipped (seat not built)'", async () => {
    const issue = makeIssue("qa-check", 1);
    const { port: linear } = createFakeLinear({ readyIssues: [issue] });
    const result = await runDispatcher(makeConfig(), makeDeps({ linear }));
    const entry = result.runLog.candidates.find((c) => c.issueId === "qa-check");
    const qaSeat = entry?.seats.find((s) => s.seat === "blindQa");
    expect(qaSeat?.status).toBe("skipped (seat not built)");
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
});
