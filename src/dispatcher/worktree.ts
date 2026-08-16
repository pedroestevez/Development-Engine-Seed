/**
 * Dispatcher runtime — the worktree and GitHub ports.
 *
 * Two related, git-shaped concerns share this file: creating/preserving the
 * one-worktree-per-cluster filesystem isolation (docs/ENGINE.md §5), and
 * pushing/opening the PR that makes a worktree's work visible outside it.
 * Both ports are given real adapters here — unlike `AgentPort` and
 * `LinearPort`, `WorktreePort`'s real implementation only needs local git
 * and the filesystem, so it can be both real *and* hermetically tested (no
 * network, no credentials) with an actual temp-dir git repo. `GitHubPort`
 * needs real network + credentials, so its real adapter is a thin stub —
 * same treatment as `LinearPort` (see that file's doc comment).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WorktreeHandle {
  /** Absolute path to the worktree's checkout on disk. */
  path: string;
  branch: string;
}

export interface WorktreePort {
  /**
   * Creates a worktree for `branch` off `baseRef`. One per cluster — call
   * once per cluster and reuse the handle for every issue in it (same
   * files → one routine, sequential; ALI-102's `partition()` already
   * guarantees that grouping).
   */
  createWorktree(branch: string, baseRef: string): Promise<WorktreeHandle>;
  /**
   * Marks a worktree as must-survive. On the hard-kill path this is called
   * *before* anything else — the worktree must never be deleted once work
   * is parked (AC4: "preserve the worktree, do not delete it").
   */
  preserve(handle: WorktreeHandle): Promise<void>;
  /** Cleans up a worktree after a normal, successful completion. Never called on a kill path. */
  remove(handle: WorktreeHandle): Promise<void>;
}

export interface DraftPrParams {
  branch: string;
  base: string;
  title: string;
  body: string;
}

export interface DraftPrResult {
  number: number;
  url: string;
}

export interface GitHubPort {
  pushBranch(worktreePath: string, branch: string): Promise<void>;
  /**
   * Every PR this dispatcher opens is a draft — normal completions and
   * parked artifacts alike. Consistent with the engine's "never merge"
   * conduct rule: a human always promotes a PR out of draft, whether that
   * PR represents finished work awaiting review or interrupted work
   * awaiting resumption.
   */
  openDraftPr(params: DraftPrParams): Promise<DraftPrResult>;
}

/**
 * Real adapter: actual `git worktree` plumbing via subprocess. Kept out of
 * the unit-test suite (no real subprocesses there) but hermetically
 * testable on its own against a throwaway git repo in a temp dir — see
 * `__tests__/run.test.ts`'s dedicated `WorktreePort` block.
 */
export function createGitWorktreePort(repoRoot: string, worktreesDir: string): WorktreePort {
  return {
    async createWorktree(branch, baseRef) {
      const path = `${worktreesDir}/${branch.replace(/[^A-Za-z0-9_.-]/g, "-")}`;
      await execFileAsync("git", ["worktree", "add", path, "-b", branch, baseRef], { cwd: repoRoot });
      return { path, branch };
    },
    async preserve() {
      // A git worktree already survives on disk until explicitly removed —
      // nothing to do beyond simply never calling remove() on this handle,
      // which the hard-kill path guarantees by construction.
    },
    async remove(handle) {
      await execFileAsync("git", ["worktree", "remove", handle.path, "--force"], { cwd: repoRoot });
    },
  };
}

/**
 * Real adapter — intentionally a thin stub for this PR (see `linear.ts`'s
 * `createLinearApiPort` doc comment for the same reasoning): needs real
 * network + a real GitHub token, out of scope for the runtime-logic issue
 * this PR builds. The run loop is fully exercised against a fake instead.
 */
export function createGitHubApiPort(_config: { token: string; owner: string; repo: string }): GitHubPort {
  const notWired = (method: string) => {
    return (): never => {
      throw new Error(
        `GitHubPort real adapter not wired in this PR (${method}) — see the ALI-103 PR's ` +
          '"Decisions the spec left open" section.',
      );
    };
  };
  return {
    pushBranch: notWired("pushBranch"),
    openDraftPr: notWired("openDraftPr"),
  };
}
