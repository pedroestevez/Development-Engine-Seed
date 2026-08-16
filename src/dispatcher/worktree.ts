/**
 * Dispatcher runtime — the worktree, engine-pin, and GitHub ports.
 *
 * Three related, git-shaped concerns share this file: creating/preserving
 * the one-worktree-per-cluster filesystem isolation (docs/ENGINE.md §5),
 * resolving and physically pinning the engine commit every agent this run
 * spawns reads `.claude/**` from (ALI-104), and pushing/opening the PR that
 * makes a worktree's work visible outside it. `WorktreePort` and
 * `EnginePinPort` are given real adapters here — unlike `AgentPort` and
 * `LinearPort`, both only need local git and the filesystem, so they can be
 * both real *and* hermetically tested (no network, no credentials) with an
 * actual temp-dir git repo. `GitHubPort` needs real network + credentials,
 * so its real adapter is a thin stub — same treatment as `LinearPort` (see
 * that file's doc comment).
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
   * guarantees that grouping). The branch this creates is a throwaway
   * scaffold (ALI-133 AC1) — `forkBranch` below immediately moves the
   * worktree onto the first issue's real branch before any work happens, so
   * this call's branch is never pushed and never used as a PR head or base.
   */
  createWorktree(branch: string, baseRef: string): Promise<WorktreeHandle>;
  /**
   * ALI-133: the per-issue branch operation. Moves an existing worktree, in
   * place, onto `branch` (created or reset to point at `baseRef`) —
   * `handle.path` never changes, only what's checked out into it. This is
   * how one shared cluster worktree carries a different branch for each
   * issue in turn: called once per issue, immediately before that issue's
   * builder is dispatched (AC2), with `baseRef` set to the predecessor
   * issue's branch if one exists in this run, else `config.baseRef`
   * (stacked PR bases — see `run.ts`'s cluster lane loop).
   *
   * Discards whatever the worktree held before the call — any uncommitted
   * modifications, any untracked leftover files — so the working tree is
   * guaranteed clean afterward, matching `baseRef`'s tree exactly (AC2,
   * AC9). This is deliberate: an issue's fork point must never carry
   * unrelated debris left behind by a differently-scoped predecessor.
   */
  forkBranch(handle: WorktreeHandle, branch: string, baseRef: string): Promise<WorktreeHandle>;
  /**
   * Marks a worktree as must-survive. On the hard-kill path this is called
   * *before* anything else — the worktree must never be deleted once work
   * is parked (AC4: "preserve the worktree, do not delete it").
   */
  preserve(handle: WorktreeHandle): Promise<void>;
  /** Cleans up a worktree after a normal, successful completion. Never called on a kill path. */
  remove(handle: WorktreeHandle): Promise<void>;
}

/**
 * Resolves and physically pins the engine commit every agent this run
 * spawns reads its definition from (ALI-104). Two capabilities, deliberately
 * kept on one port because both are the same git subprocess plumbing this
 * file already owns:
 *
 *   - `resolveEngineSha` is the run's **sole** source of the pin — a
 *     `git rev-parse HEAD` against the engine repo root, never a value any
 *     caller (config, prompt) supplies (AC1).
 *   - `createPinnedTree` turns that pin into a **read-only, detached**
 *     checkout — a tree distinct from any mutable work worktree, so a
 *     builder issue that legitimately edits `.claude/**` never mutates the
 *     definitions the run itself is currently executing from (AC2). The
 *     port exposes no write operation against this tree by design —
 *     "read-only" is a property of the API surface, not a filesystem
 *     permission bit.
 */
export interface EnginePinPort {
  /** `git rev-parse HEAD` against the engine repo root — the physical pin. */
  resolveEngineSha(): Promise<string>;
  /**
   * Creates exactly one detached checkout at `pin`. Returns its absolute
   * path — the value every `DispatchContext.enginePath` carries for the
   * rest of the run.
   */
  createPinnedTree(pin: string): Promise<string>;
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
    async forkBranch(handle, branch, baseRef) {
      // -f/--force: proceed even though the working tree may hold a
      // predecessor issue's uncommitted debris -- this call's whole job is
      // to discard that, not preserve it (AC2, AC9).
      await execFileAsync("git", ["checkout", "-f", "-B", branch, baseRef], { cwd: handle.path });
      // Belt-and-braces: checkout -f already makes tracked files match
      // baseRef's tree, but reset --hard guarantees index + working tree
      // are byte-identical to it regardless of what path checkout took.
      await execFileAsync("git", ["reset", "--hard", baseRef], { cwd: handle.path });
      // Untracked leftovers (e.g. a builder that touched but never
      // committed a file) survive both of the above -- clean removes them
      // so `git status --porcelain` is empty afterward.
      await execFileAsync("git", ["clean", "-fd"], { cwd: handle.path });
      return { path: handle.path, branch };
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
 * Real adapter for `EnginePinPort`: `git rev-parse HEAD` plus a detached
 * `git worktree add` (no branch — nothing ever commits here). Hermetically
 * testable against a throwaway git repo, same treatment as
 * `createGitWorktreePort` above (see `__tests__/pinning.test.ts`).
 */
export function createGitEnginePinPort(repoRoot: string, pinnedTreesDir: string): EnginePinPort {
  return {
    async resolveEngineSha() {
      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
      return stdout.trim();
    },
    async createPinnedTree(pin) {
      const path = `${pinnedTreesDir}/${pin}`;
      await execFileAsync("git", ["worktree", "add", "--detach", path, pin], { cwd: repoRoot });
      return path;
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
