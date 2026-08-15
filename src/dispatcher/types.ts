/**
 * Dispatcher core — pure types.
 *
 * No I/O, no Linear SDK, no subprocess. These types describe the plain data
 * the dispatcher decision functions (`plan.ts`) operate over. A Linear-facing
 * runtime (ALI-103) is responsible for mapping real Linear issues into
 * `Issue` and reading a `RunPlan` back out — that mapping lives outside this
 * layer on purpose.
 */

/**
 * The engine's danger list (docs/ENGINE.md §4, CLAUDE.md "Routing",
 * .claude/agents/spec.md "Budget gate"). Any issue carrying one of these
 * labels is priced at `riskWeight` and floors its model tier to `opus`.
 *
 * Keep this list identical across CLAUDE.md, docs/ENGINE.md, spec.md and
 * here — the readiness pass cross-checks it (see ALI-102 spec comment).
 */
export const DANGER_LABELS = [
  "payments",
  "auth",
  "data",
  "rls",
  "migration",
  "external-api",
  "critical",
] as const;

export type DangerLabel = (typeof DANGER_LABELS)[number];

/** The Linear pipeline statuses this engine's dispatcher matches on (docs/ENGINE.md §3). */
export type IssueState =
  | "Backlog"
  | "Ready"
  | "In Progress"
  | "In Review"
  | "Done"
  | "Parked"
  | "Needs Pedro";

/**
 * A candidate for admission into a run. Deliberately a plain, serializable
 * shape — no class, no Linear SDK type — so the pure layer never depends on
 * how an issue was fetched.
 */
export interface Issue {
  /** Stable identifier (e.g. a Linear issue identifier like "ALI-102"). */
  id: string;
  title: string;
  /** Size/effort only (spec.md: "never inflate points to signal risk"). */
  points: number;
  /**
   * Sequence only (CLAUDE.md "Priority = sequence only"). Lower number =
   * earlier in the admission order — mirrors Linear's own convention
   * (1 = Urgent … 4 = Low). Ties are broken by dependency order, then by
   * input position, so ordering is fully deterministic.
   */
  priority: number;
  /** Free-form labels; danger labels are a subset checked via DANGER_LABELS. */
  labels: string[];
  /** IDs of issues that block this one. IDs outside the input set are treated as already resolved. */
  blockedBy: string[];
  /** Paths/modules this issue is predicted to touch — the partitioning input. */
  predictedFiles: string[];
  /** Optional — not read by any dispatcher decision function, carried for round-tripping. */
  state?: IssueState;
}

/** The four — and only four — reasons a candidate can be left out of a run. */
export type DeferralReason =
  | "budget"
  | "dependency"
  | "exceeds-budget-must-split"
  | "cluster-conflict";

export interface DeferredIssue {
  issue: Issue;
  reason: DeferralReason;
}

export interface AdmitResult {
  admitted: Issue[];
  deferred: DeferredIssue[];
}

/** A cluster is a set of admitted issues that must run sequentially, in this order. */
export type Cluster = Issue[];

export type ModelTier = "haiku" | "sonnet" | "opus";

/** The risk half of `max(pointsTier, riskTier)`: "none" when no danger label is present. */
export type RiskTier = "none" | "opus";

/** Both routing inputs, recorded alongside the result (AC7). */
export interface IssueTierResult {
  issueId: string;
  pointsTier: ModelTier;
  riskTier: RiskTier;
  tier: ModelTier;
}

export interface DispatcherConfig {
  /** Run budget in weighted points (spec.md "Budget gate"). */
  budget: number;
  /** Multiplier applied to points when any danger label is present. */
  riskWeight: number;
  /** Upper bound on parallel lanes regardless of how many clusters exist. */
  maxConcurrency: number;
}

export const DEFAULT_CONFIG: DispatcherConfig = {
  budget: 5,
  riskWeight: 2.0,
  maxConcurrency: 4,
};

/** The composed output of `plan()` — a full, inspectable record of one run's decisions. */
export interface RunPlan {
  admitted: Issue[];
  deferred: DeferredIssue[];
  clusters: Cluster[];
  laneCount: number;
  /** One entry per input issue (admitted or deferred), in input order. */
  tiers: IssueTierResult[];
  config: DispatcherConfig;
}
