/**
 * ALI-104 — "Pin every run to an engine commit, physically, not just in the
 * log." Covers AC1–AC5 (AC6 is docs-only, checked by review).
 *
 * AC2 is the load-bearing criterion (DoD): it is proven against a real
 * throwaway git repo, not by inspection against fakes, because that is the
 * only way to demonstrate the pin is physical rather than merely recorded.
 * The harness mirrors `run.test.ts`'s own hermetic real-git block (its
 * `WorktreePort` real-adapter test) for the same reason that one does: no
 * network, no credentials, just local git in a temp dir.
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  runDispatcher,
  type AgentDispatchResult,
  type BlindDispatchContext,
  type BlindQaDispatchResult,
  type Clock,
  type DispatchContext,
  type RunDeps,
  type RuntimeConfig,
} from "../run.js";
import {
  createGitEnginePinPort,
  type DraftPrParams,
  type EnginePinPort,
  type GitHubPort,
  type WorktreeHandle,
  type WorktreePort,
} from "../worktree.js";
import { isStopReason, STOP_REASONS } from "../runlog.js";
import type { CycleRef, LinearIssue, LinearPort } from "../linear.js";
import type { DispatcherConfig, Issue, IssueState } from "../types.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Minimal local fakes -- deliberately not shared with run.test.ts (its
// fixtures are private to that file, matching this codebase's existing
// per-file fixture convention).
// ---------------------------------------------------------------------------

// ALI-105: a body carrying all three sections the blind seat reads, so this
// file's fixtures dispatch blindQa for real by default rather than hitting
// the unparseable-criteria skip -- this file's own tests are about the
// engine pin, not blindQa, so its default behavior should stay out of the way.
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
  readyIssues: LinearIssue[];
  statusChanges: { issueId: string; status: IssueState; cycleId: string | null }[];
  comments: { issueId: string; body: string }[];
  calls: { getReadyIssuesInCycle: number };
}

function createFakeLinear(readyIssues: LinearIssue[] = []): { port: LinearPort; state: FakeLinearState } {
  const state: FakeLinearState = {
    readyIssues,
    statusChanges: [],
    comments: [],
    calls: { getReadyIssuesInCycle: 0 },
  };
  const port: LinearPort = {
    async getWorkflowStatuses() {
      return VALID_WORKFLOW_STATUSES;
    },
    async getApprovedCycle() {
      const cycle: CycleRef = { id: "cycle-1", name: "Cycle 1", approvalRef: "tg-msg-1" };
      return cycle;
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
    async postCycleSummary() {
      // not asserted on in this file
    },
  };
  return { port, state };
}

interface FakeEnginePinState {
  resolveCalls: number;
  createPinnedTreeCalls: string[];
}

function createFakeEnginePin(sha: string): { port: EnginePinPort; state: FakeEnginePinState } {
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

function createFakeWorktree(): {
  port: WorktreePort;
  createdBaseRefs: string[];
  preserved: WorktreeHandle[];
} {
  const createdBaseRefs: string[] = [];
  const preserved: WorktreeHandle[] = [];
  const port: WorktreePort = {
    async createWorktree(branch, baseRef) {
      createdBaseRefs.push(baseRef);
      return { path: `/fake/worktrees/${branch}`, branch };
    },
    // ALI-133: not this file's concern (no test here asserts on fork calls)
    // -- present only so the fake satisfies `WorktreePort`.
    async forkBranch(handle, branch) {
      return { path: handle.path, branch };
    },
    async preserve(handle) {
      preserved.push(handle);
    },
    async remove() {
      // no-op
    },
  };
  return { port, createdBaseRefs, preserved };
}

function createFakeGitHub(): { port: GitHubPort; prs: DraftPrParams[] } {
  const prs: DraftPrParams[] = [];
  let counter = 0;
  const port: GitHubPort = {
    async pushBranch() {
      // no-op
    },
    async openDraftPr(params) {
      counter++;
      prs.push(params);
      return { number: counter, url: `https://github.com/fake/fake/pull/${counter}` };
    },
  };
  return { port, prs };
}

type AgentScript = (seat: "builder" | "reviewer" | "security", ctx: DispatchContext) => AgentDispatchResult;

function createFakeAgent(script?: AgentScript) {
  const calls: { seat: string; ctx: DispatchContext }[] = [];
  const blindCalls: BlindDispatchContext[] = [];
  return {
    calls,
    blindCalls,
    port: {
      async dispatch(seat: "builder" | "reviewer" | "security", ctx: DispatchContext) {
        calls.push({ seat, ctx });
        if (script) return script(seat, ctx);
        return { summary: `${seat} ok` };
      },
      // ALI-105: not under test in this file -- a no-op default is enough
      // to satisfy `AgentPort` and let blindQa dispatch for real (see
      // `FULL_BODY_FIXTURE` above) without any pinning test needing to care.
      async dispatchBlindQa(ctx: BlindDispatchContext): Promise<BlindQaDispatchResult> {
        blindCalls.push(ctx);
        return { testFilesWritten: [], untestableCriteria: [] };
      },
    },
  };
}

interface FakeClock extends Clock {
  advance(ms: number): void;
}

function createFakeClock(startMs = 0): FakeClock {
  let current = startMs;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

const BASE_DISPATCHER_CONFIG: DispatcherConfig = { budget: 5, riskWeight: 2.0, maxConcurrency: 4 };

function makeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    dispatcher: overrides.dispatcher ?? BASE_DISPATCHER_CONFIG,
    backstop: overrides.backstop ?? { wallClockSoftMs: 1_000_000, wallClockHardMs: 2_000_000 },
    baseRef: overrides.baseRef ?? "origin/main",
    // ALI-133: distinct from `baseRef` -- see that file's fixture for why.
    basePrBranch: overrides.basePrBranch ?? "main",
    requiredPin: overrides.requiredPin,
  };
}

function makeDeps(parts: Partial<RunDeps> & { linear: LinearPort; enginePin: EnginePinPort }): RunDeps {
  return {
    linear: parts.linear,
    github: parts.github ?? createFakeGitHub().port,
    worktree: parts.worktree ?? createFakeWorktree().port,
    enginePin: parts.enginePin,
    agent: parts.agent ?? createFakeAgent().port,
    clock: parts.clock ?? createFakeClock(),
    credentials: parts.credentials ?? {},
  };
}

// ---------------------------------------------------------------------------
// AC1: the dispatcher resolves its own pin -- never a caller-supplied field.
// ---------------------------------------------------------------------------

describe("AC1: runDispatcher() resolves its own pin through an injected port", () => {
  it("runLog.engineSha equals exactly what the injected git port resolved", async () => {
    const { port: linear } = createFakeLinear([]);
    const { port: enginePin } = createFakeEnginePin("deadbeef000000000000000000000000000000");

    const result = await runDispatcher(makeConfig(), makeDeps({ linear, enginePin }));

    expect(result.runLog.engineSha).toBe("deadbeef000000000000000000000000000000");
  });

  it("no caller-settable field can put a different value in the run log -- an attempted smuggled `engineSha` on config has zero effect", async () => {
    const { port: linear } = createFakeLinear([]);
    const { port: enginePin } = createFakeEnginePin("cafebabe000000000000000000000000000000");

    // `RuntimeConfig` has no `engineSha` field -- the type system already
    // rejects a caller trying to supply one directly. Simulate a bug or an
    // attacker smuggling one in anyway via an unsafe cast, and prove the
    // resolved run log ignores it entirely: the port is the only source.
    const config = {
      ...makeConfig(),
      engineSha: "not-the-real-sha-at-all",
    } as unknown as RuntimeConfig;

    const result = await runDispatcher(config, makeDeps({ linear, enginePin }));

    expect(result.runLog.engineSha).toBe("cafebabe000000000000000000000000000000");
    expect(result.runLog.engineSha).not.toBe("not-the-real-sha-at-all");
    expect(result.runLogJson).not.toContain("not-the-real-sha-at-all");
  });
});

// ---------------------------------------------------------------------------
// AC2: agent definitions load from a read-only pinned tree.
// ---------------------------------------------------------------------------

describe("AC2 (real git, load-bearing): a mid-run edit never reaches the pinned tree", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("committing an edit to .claude/agents/builder.md in the repo root after the pinned tree exists leaves the pinned copy byte-identical to the pin's version", async () => {
    const repoRoot = await fs.mkdtemp(join(tmpdir(), "ali104-repo-"));
    tempDirs.push(repoRoot);
    const pinnedTreesDir = await fs.mkdtemp(join(tmpdir(), "ali104-pinned-"));
    tempDirs.push(pinnedTreesDir);

    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repoRoot });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: repoRoot });

    const agentFilePath = join(repoRoot, ".claude", "agents", "builder.md");
    await fs.mkdir(join(repoRoot, ".claude", "agents"), { recursive: true });
    const originalContent = "# builder v1 -- the version this run pinned\n";
    await fs.writeFile(agentFilePath, originalContent);
    await execFileAsync("git", ["add", "."], { cwd: repoRoot });
    await execFileAsync("git", ["commit", "-q", "-m", "v1"], { cwd: repoRoot });

    const port = createGitEnginePinPort(repoRoot, pinnedTreesDir);
    const pin = await port.resolveEngineSha();
    const enginePath = await port.createPinnedTree(pin);

    // Sanity: the pinned tree exists and starts out with v1's content.
    const pinnedFilePath = join(enginePath, ".claude", "agents", "builder.md");
    const beforeEdit = await fs.readFile(pinnedFilePath, "utf8");
    expect(beforeEdit).toBe(originalContent);

    // Mid-run edit: commit a change to builder.md in the repo root AFTER
    // the pinned tree already exists -- exactly the scenario the invariant
    // guards against (a builder issue legitimately editing `.claude/**`
    // 40 minutes into a run must never mutate what this run is executing).
    const editedContent = "# builder v2 -- edited mid-run, must NOT appear in the pin\n";
    await fs.writeFile(agentFilePath, editedContent);
    await execFileAsync("git", ["add", "."], { cwd: repoRoot });
    await execFileAsync("git", ["commit", "-q", "-m", "v2 mid-run edit"], { cwd: repoRoot });

    const afterEdit = await fs.readFile(pinnedFilePath, "utf8");
    expect(afterEdit).toBe(originalContent); // byte-identical to the pin's version
    expect(afterEdit).not.toBe(editedContent); // not the edited one
  });
});

describe("AC2 (unit): every DispatchContext carries the pinned tree's path; created exactly once per run", () => {
  it("all agent dispatch calls across every issue see the same enginePath, and createPinnedTree is called exactly once", async () => {
    const a = makeIssue("eng-a", 1, { priority: 1 });
    const b = makeIssue("eng-b", 1, { priority: 2, predictedFiles: ["different.ts"] });
    const { port: linear } = createFakeLinear([a, b]);
    const { port: enginePin, state: pinState } = createFakeEnginePin("cafef00d000000000000000000000000000000");
    const { calls, port: agent } = createFakeAgent();

    await runDispatcher(makeConfig(), makeDeps({ linear, enginePin, agent }));

    expect(pinState.createPinnedTreeCalls).toEqual(["cafef00d000000000000000000000000000000"]);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.ctx.enginePath).toBe("/fake/engine-pin/cafef00d000000000000000000000000000000");
    }
  });
});

// ---------------------------------------------------------------------------
// AC3: work worktrees branch from the pin; PRs still target baseRef.
// ---------------------------------------------------------------------------

describe("AC3: work worktrees branch from the resolved pin; openDraftPr's base is basePrBranch, never baseRef", () => {
  it("createWorktree's baseRef equals runLog.engineSha, and openDraftPr's base equals config.basePrBranch -- never config.baseRef", async () => {
    // ALI-133 AC4 corrects this criterion's own PR-base assertion: the
    // pre-ALI-133 version of this test asserted `prs[0]?.base === config.baseRef`
    // ("origin/main") -- exactly the latent bug ALI-133 found (a remote-tracking
    // git ref real GitHub rejects as a PR base with a 422). `config.basePrBranch`
    // is the corrected field for that purpose; `config.baseRef` stays reserved
    // for what it always was -- the ref a worktree/branch can fork from.
    const issue = makeIssue("wk-1", 1);
    const { port: linear } = createFakeLinear([issue]);
    const { port: enginePin } = createFakeEnginePin("feedface000000000000000000000000000000");
    const { port: worktree, createdBaseRefs } = createFakeWorktree();
    const { port: github, prs } = createFakeGitHub();

    const config = makeConfig({ baseRef: "origin/main", basePrBranch: "main" });
    const result = await runDispatcher(config, makeDeps({ linear, enginePin, worktree, github }));

    // The scaffold worktree still stands up from the resolved pin (ALI-104
    // AC3, unchanged by ALI-133) -- this is the argument `createWorktree`
    // itself received, before any per-issue fork happens.
    expect(createdBaseRefs).toEqual(["feedface000000000000000000000000000000"]);
    expect(createdBaseRefs[0]).toBe(result.runLog.engineSha);

    expect(prs).toHaveLength(1);
    expect(prs[0]?.base).toBe("main");
    expect(prs[0]?.base).toBe(config.basePrBranch);

    // A PR base is a GitHub branch name -- never the remote-tracking ref a
    // worktree/branch forks from, and never the pinned SHA either. All
    // three must stay distinct even though they can name "the same place".
    expect(prs[0]?.base).not.toBe(config.baseRef);
    expect(createdBaseRefs[0]).not.toBe(prs[0]?.base);
  });
});

// ---------------------------------------------------------------------------
// AC4: engine-drift refuses, and is the seventh stop reason.
// ---------------------------------------------------------------------------

describe("AC4: engine-drift refuses -- zero dispatch calls, no worktree, run log still written", () => {
  it("a requiredPin that no longer matches the resolved HEAD stops before any Linear read, worktree creation, or agent dispatch", async () => {
    const issue = makeIssue("drift-1", 1);
    const { port: linear, state: linearState } = createFakeLinear([issue]);
    const { port: enginePin } = createFakeEnginePin("resolved-sha-now-0000000000000000000000");
    const { port: worktree, createdBaseRefs } = createFakeWorktree();
    const { calls, port: agent } = createFakeAgent();

    const config = makeConfig({ requiredPin: "stale-sha-from-a-parked-run-000000000000" });
    const result = await runDispatcher(config, makeDeps({ linear, enginePin, worktree, agent }));

    expect(result.runLog.stopReason).toBe("engine-drift");
    // AC4's own emphasis: assert the call *count*, not merely the reason string.
    expect(calls).toHaveLength(0);
    expect(createdBaseRefs).toEqual([]);
    expect(linearState.calls.getReadyIssuesInCycle).toBe(0);

    // Still writes its run log -- the same fail-closed shape as no-approved-cycle.
    expect(result.runLog.engineSha).toBe("resolved-sha-now-0000000000000000000000");
    expect(result.runLog.candidates).toEqual([]);
    expect(result.runLog.cycleId).toBeNull();
    expect(result.runLog.approvalRef).toBeNull();
    expect(result.runLogJson).toBeTruthy();
  });

  it("a requiredPin that matches the resolved HEAD proceeds normally -- no drift", async () => {
    const issue = makeIssue("nodrift-1", 1);
    const { port: linear } = createFakeLinear([issue]);
    const { port: enginePin } = createFakeEnginePin("same-sha-00000000000000000000000000000");
    const { calls, port: agent } = createFakeAgent();

    const config = makeConfig({ requiredPin: "same-sha-00000000000000000000000000000" });
    const result = await runDispatcher(config, makeDeps({ linear, enginePin, agent }));

    expect(result.runLog.stopReason).not.toBe("engine-drift");
    expect(calls.length).toBeGreaterThan(0);
  });

  it("a fresh run with no requiredPin set is unaffected by drift logic", async () => {
    const issue = makeIssue("fresh-1", 1);
    const { port: linear } = createFakeLinear([issue]);
    const { port: enginePin } = createFakeEnginePin("whatever-sha-0000000000000000000000000");
    const { calls, port: agent } = createFakeAgent();

    const result = await runDispatcher(makeConfig(), makeDeps({ linear, enginePin, agent }));

    expect(result.runLog.stopReason).not.toBe("engine-drift");
    expect(calls.length).toBeGreaterThan(0);
  });

  it("STOP_REASONS has length 7 and includes engine-drift as a recognized value", () => {
    expect(STOP_REASONS).toHaveLength(7);
    expect(STOP_REASONS).toContain("engine-drift");
    expect(isStopReason("engine-drift")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC5: every artifact carries the resolved pin.
// ---------------------------------------------------------------------------

describe("AC5: every artifact carries the resolved pin -- Parked comment and run log, no other SHA-shaped value", () => {
  it("the parked comment and run log both contain exactly the resolved SHA and no other", async () => {
    const issue = makeIssue("park-5", 2, { priority: 1 });
    const { port: linear, state: linearState } = createFakeLinear([issue]);
    const sha = "5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a";
    const { port: enginePin } = createFakeEnginePin(sha);
    const clock = createFakeClock(0);
    const { port: agent } = createFakeAgent((seat) => {
      if (seat === "builder") clock.advance(10_000); // straight past the hard deadline
      return { summary: `${seat} ok` };
    });

    const config = makeConfig({ backstop: { wallClockSoftMs: 900_000, wallClockHardMs: 1_000 } });
    const result = await runDispatcher(config, makeDeps({ linear, enginePin, agent, clock }));

    expect(result.runLog.stopReason).toBe("backstop-wallclock");

    const comment = linearState.comments.find((c) => c.issueId === "park-5");
    expect(comment?.body).toContain(sha);
    expect(result.runLog.engineSha).toBe(sha);

    // No other SHA-shaped (long hex) value appears anywhere in either artifact.
    const shaLike = /\b[0-9a-f]{20,40}\b/gi;
    const commentMatches = comment?.body.match(shaLike) ?? [];
    expect(new Set(commentMatches.map((s) => s.toLowerCase()))).toEqual(new Set([sha]));

    const runLogMatches = result.runLogJson.match(shaLike) ?? [];
    expect(new Set(runLogMatches.map((s) => s.toLowerCase()))).toEqual(new Set([sha]));
  });
});
