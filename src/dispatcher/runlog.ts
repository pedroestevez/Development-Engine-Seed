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
 *   - `StopReason` — why the whole run ended. Exactly six values, always
 *     one of them, never free text (AC7).
 *
 * This module also owns secret redaction (AC10): the compensating control
 * for the security pass this issue does not get, because it carries no
 * danger label.
 */

import type { DeferralReason, IssueTierResult } from "./types.js";

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
  | "no-approved-cycle";

export const STOP_REASONS: readonly StopReason[] = [
  "cycle-empty",
  "budget-exhausted",
  "backstop-wallclock",
  "backstop-tokens",
  "gate-hit",
  "no-approved-cycle",
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

export interface SeatOutcome {
  seat: SeatName;
  /** "skipped (seat not built)" is reserved for blindQa until ALI-105 lands — never a silent pass. */
  status: "ran" | "skipped (seat not built)" | "skipped (not applicable)";
  detail?: string;
}

export type IssueOutcome = "opened-pr" | "parked" | "needs-pedro" | "not-dispatched";

export interface CandidateLogEntry {
  issueId: string;
  points: number;
  labels: string[];
  weightedCost: number;
  verdict: Verdict;
  /** Model tier with its inputs shown: pointsTier=X, riskTier=Y -> max=Z (spec §5). */
  tier: IssueTierResult;
  seats: SeatOutcome[];
  bounces: number;
  outcome: IssueOutcome;
  estimatedConsumption: { weightedCost: number };
  actualConsumption?: { wallClockMs: number; tokensUsed: number };
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
        `weighted ${c.weightedCost} — **${c.verdict}** (${c.outcome}) — ${formatTier(c.tier)}`,
    );
  }
  return scrubSecrets(lines.join("\n"));
}
