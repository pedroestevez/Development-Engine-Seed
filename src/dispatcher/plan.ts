/**
 * Dispatcher core — pure decision functions.
 *
 * No I/O, no Linear SDK, no subprocess, no Date.now / Math.random. Every
 * function here is a total function of its arguments: same input, same
 * output, forever. ALI-103 wraps this in a runtime that fetches real Linear
 * issues, calls `plan()`, and acts on the result.
 */

import {
  DANGER_LABELS,
  DEFAULT_CONFIG,
  type AdmitResult,
  type Cluster,
  type DeferredIssue,
  type DispatcherConfig,
  type Issue,
  type IssueTierResult,
  type ModelTier,
  type RiskTier,
  type RunPlan,
} from "./types.js";

const DANGER_LABEL_SET: ReadonlySet<string> = new Set(DANGER_LABELS);

/** True if any of the issue's labels is on the engine's danger list. */
export function hasDangerLabel(labels: readonly string[]): boolean {
  return labels.some((label) => DANGER_LABEL_SET.has(label));
}

/**
 * `points × (hasDangerLabel ? riskWeight : 1.0)`.
 *
 * Danger list: payments, auth, data, rls, migration, external-api, critical.
 */
export function weightedCost(
  issue: Issue,
  config: DispatcherConfig = DEFAULT_CONFIG,
): number {
  return issue.points * (hasDangerLabel(issue.labels) ? config.riskWeight : 1);
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * Priority-then-dependency order: a topological sort over `blockedBy` edges
 * restricted to issues present in this input set (a blocker outside the set
 * is treated as already resolved — e.g. it shipped in an earlier run), with
 * ties among issues that are simultaneously eligible broken by ascending
 * `priority`, and remaining ties broken by original input position so the
 * order — and therefore every downstream function — is fully deterministic.
 *
 * A dependency cycle among the input issues (which a healthy backlog should
 * never produce) is broken defensively by priority alone, rather than
 * looping forever.
 */
function priorityThenDependencyOrder(issues: readonly Issue[]): Issue[] {
  const idSet = new Set(issues.map((issue) => issue.id));
  const inputIndex = new Map(issues.map((issue, index) => [issue.id, index]));

  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // blockerId -> issues waiting on it

  for (const issue of issues) {
    const inSetBlockers = issue.blockedBy.filter((id) => idSet.has(id));
    inDegree.set(issue.id, inSetBlockers.length);
    for (const blockerId of inSetBlockers) {
      const waiting = dependents.get(blockerId);
      if (waiting) waiting.push(issue.id);
      else dependents.set(blockerId, [issue.id]);
    }
  }

  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const remaining = new Set(idSet);
  const order: Issue[] = [];

  const byPriorityThenInput = (a: string, b: string): number => {
    const pa = byId.get(a)!.priority;
    const pb = byId.get(b)!.priority;
    if (pa !== pb) return pa - pb;
    return inputIndex.get(a)! - inputIndex.get(b)!;
  };

  while (remaining.size > 0) {
    let eligible = [...remaining].filter((id) => (inDegree.get(id) ?? 0) === 0);
    // Defensive: an in-set dependency cycle would otherwise never reach
    // in-degree 0. Fall back to every remaining issue, ordered by priority,
    // so the function still terminates and every issue still appears once.
    if (eligible.length === 0) eligible = [...remaining];

    eligible.sort(byPriorityThenInput);
    const nextId = eligible[0];
    order.push(byId.get(nextId)!);
    remaining.delete(nextId);
    for (const waitingId of dependents.get(nextId) ?? []) {
      inDegree.set(waitingId, (inDegree.get(waitingId) ?? 0) - 1);
    }
  }

  return order;
}

// ---------------------------------------------------------------------------
// admit
// ---------------------------------------------------------------------------

/**
 * Greedy admission in priority-then-dependency order. The scan CONTINUES
 * PAST a refused issue rather than stopping at the first one that doesn't
 * fit — a later, cheaper issue can still be admitted (AC2).
 *
 * Per-issue deferral reason:
 *   - `dependency`                 — an in-set blocker was not admitted.
 *   - `exceeds-budget-must-split`  — the issue alone costs more than budget;
 *                                    no amount of remaining headroom fits it.
 *   - `budget`                     — the issue fits within budget alone, but
 *                                    not within what's left after earlier
 *                                    admissions.
 *
 * `cluster-conflict` is reserved for the runtime layer (ALI-103): admit()
 * has no notion of a cluster yet, since clusters are computed from the
 * *admitted* set by `partition()`.
 */
export function admit(
  issues: readonly Issue[],
  config: DispatcherConfig = DEFAULT_CONFIG,
): AdmitResult {
  const order = priorityThenDependencyOrder(issues);
  const idSet = new Set(issues.map((issue) => issue.id));
  const admittedIds = new Set<string>();

  const admitted: Issue[] = [];
  const deferred: DeferredIssue[] = [];
  let runningCost = 0;

  for (const issue of order) {
    const inSetBlockers = issue.blockedBy.filter((id) => idSet.has(id));
    const hasUnmetBlocker = inSetBlockers.some((id) => !admittedIds.has(id));
    if (hasUnmetBlocker) {
      deferred.push({ issue, reason: "dependency" });
      continue;
    }

    const cost = weightedCost(issue, config);

    if (cost > config.budget) {
      deferred.push({ issue, reason: "exceeds-budget-must-split" });
      continue;
    }

    if (runningCost + cost > config.budget) {
      deferred.push({ issue, reason: "budget" });
      continue;
    }

    admitted.push(issue);
    admittedIds.add(issue.id);
    runningCost += cost;
  }

  return { admitted, deferred };
}

// ---------------------------------------------------------------------------
// partition
// ---------------------------------------------------------------------------

function sharesPredictedFile(a: Issue, b: Issue): boolean {
  if (a.predictedFiles.length === 0 || b.predictedFiles.length === 0) return false;
  const bFiles = new Set(b.predictedFiles);
  return a.predictedFiles.some((file) => bFiles.has(file));
}

/** Minimal union-find over admitted-array indices. */
class DisjointSet {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }

  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }

  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent[rootA] = rootB;
  }
}

/**
 * Clusters admitted issues by shared mutable resource, three rules in order:
 *
 *   1. Predicted-files intersection → same cluster.
 *   2. A `blockedBy` edge between two admitted issues → same cluster
 *      (disjoint files are not sufficient: A creates the table B queries).
 *   3. Any two `migration`-labelled issues → same cluster, always — file
 *      overlap can never derive this, since two migration files routinely
 *      have zero filename overlap yet both must apply in a fixed order.
 *
 * Cluster order, and issue order within a cluster, follow admitted order
 * (itself priority-then-dependency order), so a blocker always precedes the
 * issue it blocks within its cluster.
 */
export function partition(admitted: readonly Issue[]): Cluster[] {
  const n = admitted.length;
  const dsu = new DisjointSet(n);
  const indexById = new Map(admitted.map((issue, index) => [issue.id, index]));

  // Rule 1: predicted-files intersection.
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (sharesPredictedFile(admitted[i], admitted[j])) dsu.union(i, j);
    }
  }

  // Rule 2: blockedBy edge between two admitted issues.
  for (let i = 0; i < n; i++) {
    for (const blockerId of admitted[i].blockedBy) {
      const j = indexById.get(blockerId);
      if (j !== undefined) dsu.union(i, j);
    }
  }

  // Rule 3: any two migration-labelled admitted issues share a cluster.
  const migrationIndices: number[] = [];
  for (let i = 0; i < n; i++) {
    if (admitted[i].labels.includes("migration")) migrationIndices.push(i);
  }
  for (let k = 1; k < migrationIndices.length; k++) {
    dsu.union(migrationIndices[0], migrationIndices[k]);
  }

  const groups = new Map<number, Issue[]>();
  for (let i = 0; i < n; i++) {
    const root = dsu.find(i);
    const group = groups.get(root);
    if (group) group.push(admitted[i]);
    else groups.set(root, [admitted[i]]);
  }

  // Deterministic cluster ordering: by the earliest admitted-index among
  // each cluster's members (groups are built in admitted order already, so
  // this is just the order groups were first created).
  return [...groups.values()];
}

// ---------------------------------------------------------------------------
// laneCount
// ---------------------------------------------------------------------------

/** `min(clusters.length, maxConcurrency)` — lanes never exceed the concurrency cap. */
export function laneCount(clusters: readonly Cluster[], maxConcurrency: number): number {
  return Math.min(clusters.length, maxConcurrency);
}

// ---------------------------------------------------------------------------
// modelTier
// ---------------------------------------------------------------------------

/** Points 1 → haiku, 2–4 → sonnet, 5+ → opus (spec.md: "2–3 (standard), 5 (large/architectural)"). */
export function pointsTier(points: number): ModelTier {
  if (points <= 1) return "haiku";
  if (points < 5) return "sonnet";
  return "opus";
}

/** "none" when no danger label is present; any danger label floors this to "opus". */
export function riskTier(issue: Issue): RiskTier {
  return hasDangerLabel(issue.labels) ? "opus" : "none";
}

const TIER_RANK: Record<ModelTier | RiskTier, number> = {
  none: -1,
  haiku: 0,
  sonnet: 1,
  opus: 2,
};
const RANK_TO_TIER: readonly ModelTier[] = ["haiku", "sonnet", "opus"];

/**
 * `max(pointsTier, riskTier)` — risk floors the tier up, never down. Both
 * inputs are recorded alongside the result (AC7), e.g. a 1-point `payments`
 * issue: pointsTier "haiku", riskTier "opus", tier "opus".
 */
export function modelTier(issue: Issue): IssueTierResult {
  const pTier = pointsTier(issue.points);
  const rTier = riskTier(issue);
  const rank = Math.max(TIER_RANK[pTier], TIER_RANK[rTier]);
  return {
    issueId: issue.id,
    pointsTier: pTier,
    riskTier: rTier,
    tier: RANK_TO_TIER[rank],
  };
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

/**
 * Composes admit → partition → laneCount → modelTier into one `RunPlan`.
 * Pure: identical input produces an identical (deep-equal) output, every
 * time — no clock, no randomness, no network, no mutation of the input.
 */
export function plan(
  issues: readonly Issue[],
  config: DispatcherConfig = DEFAULT_CONFIG,
): RunPlan {
  const { admitted, deferred } = admit(issues, config);
  const clusters = partition(admitted);
  const lanes = laneCount(clusters, config.maxConcurrency);
  const tiers = issues.map((issue) => modelTier(issue));

  return {
    admitted,
    deferred,
    clusters,
    laneCount: lanes,
    tiers,
    config,
  };
}
