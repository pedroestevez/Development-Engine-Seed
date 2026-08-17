/**
 * Dispatcher runtime — the run log.
 *
 * A decision record, not an outcome record (ALI-103 "why"). Two enumerated
 * vocabularies live here:
 *
 *   - `Verdict` — what happened to one candidate issue. Maps 1:1 onto
 *     `admitted` plus `DeferralReason` from `./types.js` (AC11), plus one
 *     runtime-only addition: `not-reached`, for a candidate `plan()`
 *     admitted but the run stopped before dispatching (settled per the
 *     readiness pass's open question — see the PR body).
 *   - `StopReason` — why the whole run ended. Exactly seven values, always
 *     one of them, never free text (AC7, ALI-103; `engine-drift` added by
 *     ALI-104 — refuse, don't adapt, when a resumed run's required pin no
 *     longer matches the resolved HEAD).
 *
 * This module also owns secret redaction (AC10): the compensating control
 * for the security pass this issue does not get, because it carries no
 * danger label.
 *
 * ALI-106 amends the per-issue schema so the calibration loop has fields to
 * compute on, not just totals: `seats[]` carries the model/effort/tokens
 * each seat *actually* ran at (never the routing table's prediction —
 * AC3), `bounces[]` replaces a bare count with structured records whose
 * `detectedAtStage` is the load-bearing field for Hypothesis L (a
 * lint-stage rejection and a judgment-stage rejection have opposite
 * economics — see docs/ENGINE.md §9), and `risk.verifierTier` records the
 * tier independent verification actually ran at, so a run where
 * verify-by-risk (ALI-152) applied is distinguishable from one where only
 * split-seat did (AC1.4). `estimated_points`/`weighted_cost`/
 * `actual_wallclock_s`/`actual_tokens`/`outcome` from the original spec
 * text already exist under this module's established camelCase names
 * (`points`, `weightedCost`, `actualConsumption.wallClockMs`,
 * `actualConsumption.tokensUsed`, `outcome`) since ALI-103 — unchanged here,
 * on purpose: renaming them would be a schema migration this issue was
 * never asked for, not the amendment Pedro's spec-pass comment named.
 */

import type { DeferralReason, IssueTierResult, ModelTier } from "./types.js";

// ---------------------------------------------------------------------------
// Verdict vocabulary (AC11)
// ---------------------------------------------------------------------------

export type Verdict =
  | "admitted"
  | "deferred (budget)"
  | "deferred (dependency)"
  | "deferred (cluster conflict)"
  | "refused (exceeds budget)"
  | "not-reached";

/** Every legal verdict, for exhaustiveness tests — keep in sync with the union above. */
export const VERDICTS: readonly Verdict[] = [
  "admitted",
  "deferred (budget)",
  "deferred (dependency)",
  "deferred (cluster conflict)",
  "refused (exceeds budget)",
  "not-reached",
] as const;

/** `DeferralReason` (`src/dispatcher/types.ts`, merged at 739f3c2) -> its run-log verdict string. */
const DEFERRAL_TO_VERDICT: Record<DeferralReason, Verdict> = {
  budget: "deferred (budget)",
  dependency: "deferred (dependency)",
  "exceeds-budget-must-split": "refused (exceeds budget)",
  "cluster-conflict": "deferred (cluster conflict)",
};

/** A `plan()` deferral reason renders as exactly this verdict string (AC11). */
export function deferralReasonToVerdict(reason: DeferralReason): Verdict {
  return DEFERRAL_TO_VERDICT[reason];
}

const VERDICT_TO_DEFERRAL: Partial<Record<Verdict, DeferralReason>> = Object.fromEntries(
  (Object.entries(DEFERRAL_TO_VERDICT) as [DeferralReason, Verdict][]).map(([reason, verdict]) => [
    verdict,
    reason,
  ]),
);

/**
 * Inverse of `deferralReasonToVerdict`. `null` for `"admitted"` and
 * `"not-reached"` — both are legal verdicts with no corresponding core
 * `DeferralReason`, by design: `admitted` never was a deferral, and
 * `not-reached` is the runtime-only addition this issue settles (an
 * admitted candidate the run never got to — distinct from every deferral,
 * since `plan()` chose it and only time ran out).
 */
export function verdictToDeferralReason(verdict: Verdict): DeferralReason | null {
  return VERDICT_TO_DEFERRAL[verdict] ?? null;
}

// ---------------------------------------------------------------------------
// Stop-reason vocabulary (AC7)
// ---------------------------------------------------------------------------

export type StopReason =
  | "cycle-empty"
  | "budget-exhausted"
  | "backstop-wallclock"
  | "backstop-tokens"
  | "gate-hit"
  | "no-approved-cycle"
  | "engine-drift";

export const STOP_REASONS: readonly StopReason[] = [
  "cycle-empty",
  "budget-exhausted",
  "backstop-wallclock",
  "backstop-tokens",
  "gate-hit",
  "no-approved-cycle",
  "engine-drift",
] as const;

export function isStopReason(value: string): value is StopReason {
  return (STOP_REASONS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Secret redaction (AC10)
// ---------------------------------------------------------------------------

/**
 * Prefixes the engine's own credentials (Linear, GitHub) and generic API
 * keys are shaped like. Kept identical to AC10's own enumerated list so the
 * compensating control matches exactly what the criterion tests for.
 */
const SECRET_PREFIXES = ["ghp_", "github_pat_", "lin_api_", "sk-"] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True if `text` contains any known secret-shaped substring. */
export function containsSecretLike(text: string): boolean {
  return SECRET_PREFIXES.some((prefix) => text.includes(prefix));
}

/**
 * Replaces any run of `<prefix><token-body>` for every known secret prefix
 * with `[REDACTED]`. Applied as the last step before anything is written to
 * disk or posted to Linear (the run log JSON and the cycle summary comment
 * both pass through this) — defense in depth on top of never placing raw
 * credentials in loggable structures to begin with.
 */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const prefix of SECRET_PREFIXES) {
    const pattern = new RegExp(`${escapeRegExp(prefix)}[A-Za-z0-9_-]*`, "g");
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

/**
 * Renders a credential for inclusion in a loggable structure: presence is
 * recorded, the value never is. Never echoes a prefix of the real value —
 * AC10 checks the output for the bare prefix strings themselves, not just
 * the dummy values, so the label must not contain them either.
 */
export function redact(value: string | undefined | null): string {
  return value ? "[REDACTED]" : "[NOT SET]";
}

// ---------------------------------------------------------------------------
// Run log shape
// ---------------------------------------------------------------------------

export type SeatName = "builder" | "blindQa" | "reviewer" | "security";

/**
 * Bounce round 1 (PR review), F6: the set of things that can *detect* a
 * bounce — a superset of `SeatName`. Most bounces are caught by one of the
 * four dispatch seats' own dispatch call, but a CI gate (the `gate-hit`
 * `StopReason`, `run.ts`) can also reject a candidate without any seat
 * reporting it. `"ci-gate"` gives that class a home in the schema now,
 * while the schema is still unmerged, rather than after the first real gate
 * bounce needs one. `SeatOutcome.seat` stays exactly `SeatName` — a gate is
 * not a seat that runs, so it never appears there, only as a bounce's
 * `detectorSeat`.
 */
export type BounceDetector = SeatName | "ci-gate";

/**
 * ALI-106: the effort level a seat's model call actually ran at, distinct
 * from `model` (which *tier* ran). `"lint"` and `"judgment"` name the two
 * halves of the split-seat structure (mechanical check → cheap lint pass;
 * judgment call → top-tier pass; ALI-121/ALI-152) — a seat that isn't
 * internally split (builder, security, blindQa; a not-yet-split reviewer)
 * reports `"standard"`. A future split-seat reviewer reports two `SeatOutcome`
 * entries for `seat: "reviewer"`, one per effort level, rather than one.
 */
export type SeatEffort = "standard" | "lint" | "judgment";

/** The subset of `SeatEffort` a bounce can be detected at — never `"standard"` (Hypothesis L, docs/ENGINE.md §9). */
export type BounceStage = "lint" | "judgment";

export interface SeatOutcome {
  seat: SeatName;
  /**
   * `"skipped (unparseable criteria)"` is blindQa-specific (ALI-105 AC7):
   * the issue body had no `## Acceptance criteria` heading, or that section
   * was empty — the seat is never dispatched, and this is the loud,
   * enumerated status recorded instead of a silent pass.
   * `"skipped (not applicable)"` stays security-specific (no danger label).
   */
  status: "ran" | "skipped (unparseable criteria)" | "skipped (not applicable)";
  detail?: string;
  /**
   * ALI-106 AC1.3/AC3: the model tier this seat's dispatch call *actually*
   * reported running at — sourced from the agent's own dispatch result,
   * never derived from `CandidateLogEntry.tier` (the routing table's
   * *prediction*). Undefined for a seat that never ran (a skip status).
   */
  model?: ModelTier;
  /** ALI-106: the effort level this seat ran at (see `SeatEffort`). Undefined for a seat that never ran. */
  effort?: SeatEffort;
  /** ALI-106: tokens this seat's own dispatch call consumed. Undefined for a seat that never ran. */
  tokens?: number;
  /** ALI-106: wall-clock this seat's own dispatch call took, in milliseconds. Undefined for a seat that never ran. */
  wallClockMs?: number;
}

export type IssueOutcome = "opened-pr" | "parked" | "needs-pedro" | "not-dispatched";

/**
 * ALI-106 AC1.2: one bounce (rework round), structured rather than counted.
 * `detectedAtStage` is the load-bearing field — Hypothesis L's whole claim
 * (docs/ENGINE.md §9) is that a lint-stage rejection and a judgment-stage
 * rejection have opposite economics, and a bare count cannot tell them
 * apart. `round` is 1-indexed per issue, in detection order.
 */
export interface BounceRecord {
  round: number;
  detectedAtStage: BounceStage;
  /** The seat (or `"ci-gate"`, F6) whose detection reported the rejection that triggered this bounce. */
  detectorSeat: BounceDetector;
  /** Tokens the detecting pass itself consumed (the cost of *finding* the defect). */
  detectorTokens: number;
  /** Tokens the rework/rebuild that followed consumed (the cost of *fixing* it). */
  reworkTokens: number;
  /** Free-text rejection reason, as the detecting seat reported it. */
  reason: string;
}

/**
 * ALI-106 AC1.4: the tier independent verification (reviewer/security)
 * actually ran at for this issue — `"none"` when no verifying seat ran
 * (e.g. a `not-dispatched` candidate). Distinguishes a run where
 * verify-by-risk (ALI-152: verifier tier set by the issue's labels,
 * decoupled from whatever built it) actually escalated the verifier from
 * one where only split-seat's own judgment half did — see
 * `deriveVerifierTier` below.
 */
export type VerifierTier = ModelTier | "none";

/**
 * ALI-106 AC1.4: the risk-and-verification lens on one candidate, additive
 * alongside the existing top-level `points`/`labels` (kept for backward
 * compatibility with every reader since ALI-102/103) rather than replacing
 * them — `risk` is calibration's new, self-contained view: everything the
 * retro needs to reason about "did this issue's verification cost track
 * its risk" without cross-referencing other fields on the entry.
 */
export interface RiskInfo {
  labels: string[];
  points: number;
  verifierTier: VerifierTier;
}

export interface CandidateLogEntry {
  issueId: string;
  points: number;
  labels: string[];
  weightedCost: number;
  verdict: Verdict;
  /** Model tier with its inputs shown: pointsTier=X, riskTier=Y -> max=Z (spec §5). */
  tier: IssueTierResult;
  seats: SeatOutcome[];
  /** ALI-106 AC1.2: structured, not a count — see `BounceRecord`. */
  bounces: BounceRecord[];
  outcome: IssueOutcome;
  estimatedConsumption: { weightedCost: number };
  actualConsumption?: { wallClockMs: number; tokensUsed: number };
  /** ALI-106 AC1.4: the risk/verification lens — see `RiskInfo`. */
  risk: RiskInfo;
}

/**
 * ALI-106 AC1.4: the tier independent verification actually ran at, taken
 * from what the reviewer and (if it ran) security seats *reported*, never
 * from the routing table's prediction — same discipline as `SeatOutcome.model`
 * (AC3). The higher of the two ranks wins (a security pass never runs below
 * the reviewer's tier in this engine's routing, but the max is taken rather
 * than assumed). `"none"` when neither seat produced a reported model
 * (neither ran, or a seat ran but reported none — e.g. every fixture built
 * before this issue).
 */
const VERIFIER_TIER_RANK: Record<VerifierTier, number> = { none: -1, haiku: 0, sonnet: 1, opus: 2 };

export function deriveVerifierTier(seats: readonly SeatOutcome[]): VerifierTier {
  const verifyingSeats = seats.filter((s) => s.seat === "reviewer" || s.seat === "security");
  let best: VerifierTier = "none";
  for (const seat of verifyingSeats) {
    if (seat.status !== "ran" || !seat.model) continue;
    if (VERIFIER_TIER_RANK[seat.model] > VERIFIER_TIER_RANK[best]) best = seat.model;
  }
  return best;
}

/** Renders `pointsTier=X, riskTier=Y -> max=Z` for one issue's tier result (spec §5 format). */
export function formatTier(tier: IssueTierResult): string {
  return `pointsTier=${tier.pointsTier}, riskTier=${tier.riskTier} → max=${tier.tier}`;
}

export interface ClusterLogEntry {
  index: number;
  issueIds: string[];
  /** Union of predicted files across the cluster's issues — the resource(s) that made them one cluster. */
  sharedResources: string[];
}

export interface BudgetLogEntry {
  total: number;
  consumed: number;
  remaining: number;
}

/** Credential-shaped runtime config, always reproduced redacted (AC10) — never the raw value. */
export interface RedactedCredentials {
  linear: string;
  github: string;
}

export interface RunLog {
  engineSha: string;
  cycleId: string | null;
  approvalRef: string | null;
  generatedAt: string;
  candidates: CandidateLogEntry[];
  budget: BudgetLogEntry;
  clusters: ClusterLogEntry[];
  laneCount: number;
  stopReason: StopReason;
  /** AC9: incremented on every backstop fire this run, so the planner's calibration metric can read it. */
  backstopFireCount: number;
  credentials: RedactedCredentials;
  fatalError?: string;
}

/**
 * Final defense before anything leaves the process: JSON-serializes the run
 * log and runs the secret scrubber over the resulting string. Structural
 * avoidance (never putting raw secrets in `RunLog`) is the primary control;
 * this is the compensating one (AC10).
 */
export function serializeRunLog(log: RunLog): string {
  return scrubSecrets(JSON.stringify(log, null, 2));
}

/** Short human summary for the cycle comment — also scrubbed before return. */
export function renderCycleSummary(log: RunLog): string {
  const lines: string[] = [];
  lines.push(`**Run decision record — ${log.generatedAt}**`);
  lines.push("");
  lines.push(
    `Engine SHA: \`${log.engineSha}\` · Cycle: ${log.cycleId ?? "(none)"} · ` +
      `Budget: ${log.budget.consumed}/${log.budget.total} consumed, ${log.budget.remaining} remaining`,
  );
  lines.push(`Stop reason: \`${log.stopReason}\` · Backstop fires this run: ${log.backstopFireCount}`);
  lines.push("");
  lines.push(`Candidates (${log.candidates.length}):`);
  for (const c of log.candidates) {
    lines.push(
      `- ${c.issueId} — ${c.points}pt${c.labels.length > 0 ? ` [${c.labels.join(", ")}]` : ""} ` +
        `weighted ${c.weightedCost} — **${c.verdict}** (${c.outcome}) — ${formatTier(c.tier)}` +
        ` — bounces: ${c.bounces.length} — verifier tier: ${c.risk.verifierTier}`,
    );
  }
  return scrubSecrets(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Schema validation (ALI-106 AC1.1) — hand-rolled, no new dependency: the
// repo carries no schema-validation library, and one field is not worth
// adding one for. Checks shape and type, not semantic correctness (e.g. it
// does not check `round` numbering is contiguous) — that's `calibration.ts`'s
// and its own tests' job, on data this function has already confirmed is
// shaped like a `RunLog`.
// ---------------------------------------------------------------------------

const MODEL_TIERS = ["haiku", "sonnet", "opus"] as const;
const SEAT_NAMES = ["builder", "blindQa", "reviewer", "security"] as const;
/** F6: what a bounce's `detectorSeat` may hold — every real seat, plus `"ci-gate"` for a CI-gate-detected rejection. */
const BOUNCE_DETECTORS = [...SEAT_NAMES, "ci-gate"] as const;
const SEAT_EFFORTS = ["standard", "lint", "judgment"] as const;
const BOUNCE_STAGES = ["lint", "judgment"] as const;

function isString(v: unknown): v is string {
  return typeof v === "string";
}
function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString);
}
function isOneOf<T extends string>(v: unknown, allowed: readonly T[]): v is T {
  return isString(v) && (allowed as readonly string[]).includes(v);
}

/** Structural validation result: `ok` plus every problem found, never just the first (so a fixture failure is diagnosable in one pass). */
export interface SchemaValidationResult {
  ok: boolean;
  errors: string[];
}

function validateSeatOutcome(seat: unknown, path: string, errors: string[]): void {
  if (typeof seat !== "object" || seat === null) {
    errors.push(`${path}: not an object`);
    return;
  }
  const s = seat as Record<string, unknown>;
  if (!isOneOf(s.seat, SEAT_NAMES)) errors.push(`${path}.seat: expected one of ${SEAT_NAMES.join("|")}, got ${JSON.stringify(s.seat)}`);
  if (!isString(s.status)) errors.push(`${path}.status: expected string`);
  if (s.model !== undefined && !isOneOf(s.model, MODEL_TIERS)) errors.push(`${path}.model: expected a ModelTier or undefined, got ${JSON.stringify(s.model)}`);
  if (s.effort !== undefined && !isOneOf(s.effort, SEAT_EFFORTS)) errors.push(`${path}.effort: expected a SeatEffort or undefined, got ${JSON.stringify(s.effort)}`);
  if (s.tokens !== undefined && !isNumber(s.tokens)) errors.push(`${path}.tokens: expected number or undefined`);
  if (s.wallClockMs !== undefined && !isNumber(s.wallClockMs)) errors.push(`${path}.wallClockMs: expected number or undefined`);
}

function validateBounceRecord(bounce: unknown, path: string, errors: string[]): void {
  if (typeof bounce !== "object" || bounce === null) {
    errors.push(`${path}: not an object`);
    return;
  }
  const b = bounce as Record<string, unknown>;
  if (!isNumber(b.round)) errors.push(`${path}.round: expected number`);
  if (!isOneOf(b.detectedAtStage, BOUNCE_STAGES)) errors.push(`${path}.detectedAtStage: expected one of ${BOUNCE_STAGES.join("|")}, got ${JSON.stringify(b.detectedAtStage)}`);
  if (!isOneOf(b.detectorSeat, BOUNCE_DETECTORS)) errors.push(`${path}.detectorSeat: expected one of ${BOUNCE_DETECTORS.join("|")}, got ${JSON.stringify(b.detectorSeat)}`);
  if (!isNumber(b.detectorTokens)) errors.push(`${path}.detectorTokens: expected number`);
  if (!isNumber(b.reworkTokens)) errors.push(`${path}.reworkTokens: expected number`);
  if (!isString(b.reason)) errors.push(`${path}.reason: expected string`);
}

function validateRiskInfo(risk: unknown, path: string, errors: string[]): void {
  if (typeof risk !== "object" || risk === null) {
    errors.push(`${path}: not an object`);
    return;
  }
  const r = risk as Record<string, unknown>;
  if (!isStringArray(r.labels)) errors.push(`${path}.labels: expected string[]`);
  if (!isNumber(r.points)) errors.push(`${path}.points: expected number`);
  if (r.verifierTier !== "none" && !isOneOf(r.verifierTier, MODEL_TIERS)) {
    errors.push(`${path}.verifierTier: expected "none" or a ModelTier, got ${JSON.stringify(r.verifierTier)}`);
  }
}

function validateCandidateLogEntry(candidate: unknown, path: string, errors: string[]): void {
  if (typeof candidate !== "object" || candidate === null) {
    errors.push(`${path}: not an object`);
    return;
  }
  const c = candidate as Record<string, unknown>;
  if (!isString(c.issueId)) errors.push(`${path}.issueId: expected string`);
  if (!isNumber(c.points)) errors.push(`${path}.points: expected number (estimated_points)`);
  if (!isStringArray(c.labels)) errors.push(`${path}.labels: expected string[]`);
  if (!isNumber(c.weightedCost)) errors.push(`${path}.weightedCost: expected number (weighted_cost)`);
  if (!isString(c.verdict)) errors.push(`${path}.verdict: expected string`);
  if (!isString(c.outcome)) errors.push(`${path}.outcome: expected string`);
  if (!Array.isArray(c.seats)) {
    errors.push(`${path}.seats: expected array`);
  } else {
    c.seats.forEach((seat, i) => validateSeatOutcome(seat, `${path}.seats[${i}]`, errors));
  }
  if (!Array.isArray(c.bounces)) {
    errors.push(`${path}.bounces: expected array (structured, not a count — AC1.2)`);
  } else {
    c.bounces.forEach((bounce, i) => validateBounceRecord(bounce, `${path}.bounces[${i}]`, errors));
  }
  validateRiskInfo(c.risk, `${path}.risk`, errors);
  if (c.actualConsumption !== undefined) {
    const ac = c.actualConsumption as Record<string, unknown>;
    if (!isNumber(ac?.wallClockMs)) errors.push(`${path}.actualConsumption.wallClockMs: expected number (actual_wallclock_s, carried in ms)`);
    if (!isNumber(ac?.tokensUsed)) errors.push(`${path}.actualConsumption.tokensUsed: expected number (actual_tokens)`);
  }
}

/**
 * Structural validation of a parsed run log against the amended schema
 * (ALI-106 AC1.1) — call on `JSON.parse(serializeRunLog(log))` (or any
 * `unknown` read back off disk) so the check exercises the same shape a
 * consumer would actually receive, not the compile-time `RunLog` type alone.
 */
export function validateRunLogSchema(log: unknown): SchemaValidationResult {
  const errors: string[] = [];
  if (typeof log !== "object" || log === null) {
    return { ok: false, errors: ["run log: not an object"] };
  }
  const l = log as Record<string, unknown>;
  if (!isString(l.engineSha)) errors.push("engineSha: expected string");
  if (!isString(l.generatedAt)) errors.push("generatedAt: expected string");
  if (!isString(l.stopReason)) errors.push("stopReason: expected string");
  if (!isNumber(l.backstopFireCount)) errors.push("backstopFireCount: expected number");
  if (!Array.isArray(l.candidates)) {
    errors.push("candidates: expected array");
  } else {
    l.candidates.forEach((c, i) => validateCandidateLogEntry(c, `candidates[${i}]`, errors));
  }
  return { ok: errors.length === 0, errors };
}
