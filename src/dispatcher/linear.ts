/**
 * Dispatcher runtime — the Linear port.
 *
 * All Linear I/O behind one injected interface (ports and adapters — see
 * `run.ts`'s module doc). No Linear SDK type leaks past this file; the rest
 * of the runtime works in terms of `./types.js`'s plain `Issue` shape plus
 * the small amount of Linear-specific context (workflow state, cycle) this
 * file adds on top.
 */

import type { Issue, IssueState } from "./types.js";

/**
 * The approved cycle — the Direction gate's admission ticket. `approvalRef`
 * is an opaque pointer to how it was approved (e.g. an escalation-channel
 * message id), carried into the run log for the "why did this run pick
 * what it picked" record (docs/ENGINE.md §12).
 */
export interface CycleRef {
  id: string;
  name?: string;
  approvalRef: string;
}

/** A candidate as fetched from Linear: the core `Issue` shape, with its workflow state always present. */
export interface LinearIssue extends Issue {
  state: IssueState;
  /**
   * The issue's raw Linear description, verbatim markdown -- the ONLY
   * source `blindqa.ts`'s `extractBlindView()` reads from (ALI-105). Never
   * consumed directly by `plan.ts`'s pure core (it stays plain `Issue`
   * there); carried here so the runtime can extract the blind test-author's
   * view (`## Acceptance criteria` / `## Invariant` / `## Definition of
   * done`) without threading a second fetch or a new port method.
   */
  body: string;
}

export interface LinearPort {
  /** The team's configured workflow-state names, for the drift check (AC8). */
  getWorkflowStatuses(): Promise<string[]>;
  /** `null` when no cycle is Pedro-approved — the Direction gate, fail closed (AC1). */
  getApprovedCycle(): Promise<CycleRef | null>;
  /** Every `Ready` issue in the given cycle. Never Backlog — the build loop never reads it. */
  getReadyIssuesInCycle(cycleId: string): Promise<LinearIssue[]>;
  /**
   * Moves an issue to a new status. `cycleId` is explicit and mandatory —
   * never let Linear auto-assign one (the ALI-103 addendum: moving an issue
   * out of Backlog was observed to silently attach the *current* cycle).
   * Pass the run's approved cycle id to preserve it (`Parked` — interrupted
   * work belongs to the cycle that admitted it), or `null` to clear it
   * (`Needs Pedro` — excluded from runs until answered).
   */
  setIssueStatus(issueId: string, status: IssueState, cycleId: string | null): Promise<void>;
  addComment(issueId: string, body: string): Promise<void>;
  /** The run log's human-readable half: one short summary comment for the cycle. */
  postCycleSummary(cycleId: string, body: string): Promise<void>;
}

/**
 * The three status names the dispatcher's own transitions depend on
 * (docs/ENGINE.md §3). `Ready` is also the candidate-fetch status, but it
 * is checked here too — a board missing it fails exactly like one missing
 * `Parked`.
 */
const REQUIRED_STATUSES = ["Ready", "Parked", "Needs Pedro"] as const;

export interface StatusDriftResult {
  ok: boolean;
  missing: string[];
}

/**
 * AC8: verifies `Ready`, `Parked`, and `Needs Pedro` all resolve against
 * the team's actual workflow. A missing status must fail loud — never be
 * silently read as "no work" (a dispatcher that matches on a status name
 * absent from the board admits zero issues on every run, forever, and that
 * looks identical to an empty cycle unless this check exists).
 */
export function checkStatusDrift(workflowStatuses: readonly string[]): StatusDriftResult {
  const present = new Set(workflowStatuses);
  const missing = REQUIRED_STATUSES.filter((status) => !present.has(status));
  return { ok: missing.length === 0, missing };
}

/** The loud, specific error message AC8 requires — names exactly what's missing. */
export function statusDriftMessage(missing: readonly string[]): string {
  return (
    `Missing required Linear workflow status(es): ${missing.join(", ")}. ` +
    "The dispatcher matches on literal status names (docs/ENGINE.md §3) — " +
    "fix the team's workflow before rerunning. A missing status is never " +
    "the same thing as an empty cycle."
  );
}

/**
 * Real adapter — intentionally a thin stub for this PR, same treatment the
 * spec gives `AgentPort`'s real `claude`-CLI adapter. Building a production
 * Linear API client is out of scope for ALI-103, which is about the
 * backstop/parked-work/run-log runtime logic; that logic is complete and
 * fully tested against fakes (`__tests__/run.test.ts`), per the design
 * guidance. Wire real HTTP calls to Linear's API in a follow-up issue.
 */
export function createLinearApiPort(_config: { apiKey: string; teamId: string }): LinearPort {
  const notWired = (method: string) => {
    return (): never => {
      throw new Error(
        `LinearPort real adapter not wired in this PR (${method}) — see the ALI-103 PR's ` +
          '"Decisions the spec left open" section.',
      );
    };
  };
  return {
    getWorkflowStatuses: notWired("getWorkflowStatuses"),
    getApprovedCycle: notWired("getApprovedCycle"),
    getReadyIssuesInCycle: notWired("getReadyIssuesInCycle"),
    setIssueStatus: notWired("setIssueStatus"),
    addComment: notWired("addComment"),
    postCycleSummary: notWired("postCycleSummary"),
  };
}
