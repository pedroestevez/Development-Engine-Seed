/**
 * Dispatcher runtime — the calibration loop (ALI-106).
 *
 * Turns a story point from a guess into a measured unit by computing three
 * metrics across a set of run logs (docs/ENGINE.md §9) and, from them, a
 * budget recommendation the planner's retro reports verbatim. Two invariants
 * shape everything in this file:
 *
 *   1. **Recommend, never apply.** Every exported "recommend" function
 *      returns a plain, descriptive value — a string plus evidence, never a
 *      config mutation, a write call, or a side effect. This module imports
 *      nothing from `node:fs`, `node:child_process`, or any other I/O
 *      surface (verified by `__tests__/calibration.test.ts`'s AC6 checks) —
 *      there is no write path to the run budget's config
 *      (`DEFAULT_CONFIG.budget`, `src/dispatcher/types.ts`) anywhere in the
 *      code the planner's retro relies on for this computation (AC6). The
 *      planner reads the recommendation and puts it in a digest; a human
 *      turns it into a commit.
 *   2. **"Insufficient data" is a valid, expected answer**, not a bug to
 *      average away — both hypothesis evaluators below return it rather
 *      than force a verdict the evidence doesn't support (AC7.6).
 *
 * Pure, synchronous, and total: same input, same output, no clock, no I/O —
 * matching `plan.ts`'s own discipline for the same reason (testability
 * without fakes for anything beyond the `RunLog[]` argument itself).
 */

import type { BounceStage, RunLog, SeatName } from "./runlog.js";
import type { ModelTier } from "./types.js";

// ---------------------------------------------------------------------------
// Metric 1: points-to-cost ratio (docs/ENGINE.md §9)
// ---------------------------------------------------------------------------

/**
 * One point value's measured cost across every dispatched candidate that
 * carries that `points` value, in every log passed in. "Cost" here is raw
 * `actualConsumption.tokensUsed` — the theory-free total ALI-106's own
 * "why this might be wrong" section names as the fallback truth if the
 * newer, hypothesis-shaped fields (`seats[]`, `bounces[]`) turn out to be
 * instrumenting the wrong variable: a wrong bet there costs a column, never
 * this one. No per-model price weighting is applied — this repo carries no
 * pricing table, and inventing one would be exactly the kind of unmeasured
 * assumption the calibration loop exists to replace with evidence.
 */
export interface PointsCostRatio {
  points: number;
  medianTokens: number;
  n: number;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2 : (sorted[mid] as number);
}

/** Every dispatched (has `actualConsumption`) candidate across every log, flattened. */
function dispatchedCandidates(logs: readonly RunLog[]): RunLog["candidates"] {
  return logs.flatMap((log) => log.candidates.filter((c) => c.actualConsumption !== undefined));
}

/**
 * Groups dispatched candidates by `points` and returns each bucket's median
 * actual token cost, sorted ascending by points. Buckets with zero
 * dispatched candidates are omitted (nothing to measure), rather than
 * reported as a zero-cost median.
 */
export function pointsToCostRatio(logs: readonly RunLog[]): PointsCostRatio[] {
  const byPoints = new Map<number, number[]>();
  for (const c of dispatchedCandidates(logs)) {
    const tokens = c.actualConsumption?.tokensUsed;
    if (tokens === undefined) continue;
    const bucket = byPoints.get(c.points);
    if (bucket) bucket.push(tokens);
    else byPoints.set(c.points, [tokens]);
  }
  return [...byPoints.entries()]
    .map(([points, tokens]) => ({ points, medianTokens: median(tokens), n: tokens.length }))
    .sort((a, b) => a.points - b.points);
}

/**
 * "If a '3' reliably costs more than a '5', the scale is being applied
 * inconsistently" (the issue's own example). Flags every out-of-order pair
 * — a higher point value whose median cost is *lower* than a smaller point
 * value's — as a human-readable warning, so the retro can name the exact
 * pair rather than eyeball a table.
 */
export function detectPointsInconsistency(ratios: readonly PointsCostRatio[]): string[] {
  const warnings: string[] = [];
  for (let i = 0; i < ratios.length; i++) {
    for (let j = i + 1; j < ratios.length; j++) {
      const smaller = ratios[i] as PointsCostRatio;
      const larger = ratios[j] as PointsCostRatio;
      if (smaller.medianTokens > larger.medianTokens) {
        warnings.push(
          `${smaller.points}pt issues cost more (median ${smaller.medianTokens} tokens, n=${smaller.n}) than ` +
            `${larger.points}pt issues (median ${larger.medianTokens} tokens, n=${larger.n}) — the scale is being applied inconsistently.`,
        );
      }
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Metric 2: backstop-fire rate (docs/ENGINE.md §9) — target under 20%
// ---------------------------------------------------------------------------

export const BACKSTOP_FIRE_RATE_TARGET = 0.2;

export interface BackstopFireRate {
  totalRuns: number;
  backstopRuns: number;
  rate: number;
  /** `rate < BACKSTOP_FIRE_RATE_TARGET` — the retro's own health check. */
  underTarget: boolean;
}

const BACKSTOP_STOP_REASONS: ReadonlySet<RunLog["stopReason"]> = new Set(["backstop-wallclock", "backstop-tokens"]);

/** % of runs stopped by the backstop rather than by cycle-empty or budget-exhausted. */
export function computeBackstopFireRate(logs: readonly RunLog[]): BackstopFireRate {
  const totalRuns = logs.length;
  const backstopRuns = logs.filter((l) => BACKSTOP_STOP_REASONS.has(l.stopReason)).length;
  const rate = totalRuns === 0 ? 0 : backstopRuns / totalRuns;
  return { totalRuns, backstopRuns, rate, underTarget: rate < BACKSTOP_FIRE_RATE_TARGET };
}

// ---------------------------------------------------------------------------
// Metric 3: budget headroom + the ramp trigger (docs/ENGINE.md §9)
// ---------------------------------------------------------------------------

/**
 * "Finished naturally, with headroom" — `cycle-empty` (nothing left to
 * admit; budget was never the limiting factor) and zero backstop fires.
 * `budget-exhausted` is deliberately excluded: that run used every point of
 * budget it had, the opposite of headroom.
 */
export function isCleanRun(log: RunLog): boolean {
  return log.stopReason === "cycle-empty" && log.backstopFireCount === 0;
}

export interface BudgetHeadroom {
  /** Average fraction of budget consumed, across every run passed in. */
  averageConsumedFraction: number;
  /** 1 - averageConsumedFraction. */
  averageHeadroomFraction: number;
  cleanRunCount: number;
  totalRuns: number;
}

export function computeBudgetHeadroom(logs: readonly RunLog[]): BudgetHeadroom {
  const totalRuns = logs.length;
  const cleanRunCount = logs.filter(isCleanRun).length;
  if (totalRuns === 0) {
    return { averageConsumedFraction: 0, averageHeadroomFraction: 0, cleanRunCount: 0, totalRuns: 0 };
  }
  const fractions = logs.map((l) => (l.budget.total === 0 ? 0 : l.budget.consumed / l.budget.total));
  const averageConsumedFraction = fractions.reduce((sum, f) => sum + f, 0) / fractions.length;
  return { averageConsumedFraction, averageHeadroomFraction: 1 - averageConsumedFraction, cleanRunCount, totalRuns };
}

// ---------------------------------------------------------------------------
// The budget recommendation (AC2/AC3/AC4) — one decisive action, never a
// vague "lower or re-point"; "Recommend, never apply" (the invariant).
// ---------------------------------------------------------------------------

export type BudgetRecommendation =
  | { action: "raise"; from: number; to: number; evidence: string }
  | { action: "lower"; from: number; to: number; evidence: string }
  | { action: "re-point"; evidence: string }
  | { action: "hold"; evidence: string };

/**
 * `logs` must be given in chronological order (oldest first) — "the last
 * three" below reads the array's tail.
 *
 * Decision order, matching docs/ENGINE.md §9 exactly:
 *
 *   1. Backstop-fire rate over `logs` exceeds the 20% target (AC/§9: "Above
 *      that, either the budget is too high or estimates are systematically
 *      low; the retro must say which"). Disambiguated by
 *      `detectPointsInconsistency`: an inconsistent points scale is
 *      evidence of mis-pointing → recommend **re-point**, citing the
 *      inconsistent buckets; a consistent scale (points track cost, the
 *      budget is just admitting too much per run) → recommend **lower**
 *      the budget by 1, citing the fire rate. Never both — exactly one.
 *   2. Otherwise, if the *last three* runs in `logs` are all clean
 *      (`isCleanRun`) → recommend **raise** the budget by 1, citing those
 *      three runs by `generatedAt` (the ramp rule, docs/ENGINE.md §9).
 *   3. Otherwise → **hold**, citing the current rate and headroom.
 */
export function recommendBudgetChange(logs: readonly RunLog[], currentBudget: number): BudgetRecommendation {
  const fireRate = computeBackstopFireRate(logs);

  if (logs.length > 0 && !fireRate.underTarget) {
    const inconsistencies = detectPointsInconsistency(pointsToCostRatio(logs));
    if (inconsistencies.length > 0) {
      return {
        action: "re-point",
        evidence:
          `Backstop-fire rate ${(fireRate.rate * 100).toFixed(0)}% (${fireRate.backstopRuns}/${fireRate.totalRuns} runs) ` +
          `exceeds the ${(BACKSTOP_FIRE_RATE_TARGET * 100).toFixed(0)}% target, and the points scale is inconsistent: ` +
          inconsistencies.join(" "),
      };
    }
    return {
      action: "lower",
      from: currentBudget,
      to: currentBudget - 1,
      evidence:
        `Backstop-fire rate ${(fireRate.rate * 100).toFixed(0)}% (${fireRate.backstopRuns}/${fireRate.totalRuns} runs) ` +
        `exceeds the ${(BACKSTOP_FIRE_RATE_TARGET * 100).toFixed(0)}% target; the points scale is consistent, so the ` +
        "budget is admitting more per run than the estimates can back — lower it.",
    };
  }

  const lastThree = logs.slice(-3);
  if (lastThree.length === 3 && lastThree.every(isCleanRun)) {
    return {
      action: "raise",
      from: currentBudget,
      to: currentBudget + 1,
      evidence:
        "Three consecutive clean runs (cycle-empty, zero backstop fires): " +
        lastThree.map((l) => l.generatedAt).join(", ") + ".",
    };
  }

  const headroom = computeBudgetHeadroom(logs);
  return {
    action: "hold",
    evidence:
      `Backstop-fire rate ${(fireRate.rate * 100).toFixed(0)}% is under target, but fewer than three ` +
      `consecutive clean runs at the tail (${headroom.cleanRunCount}/${headroom.totalRuns} clean overall, ` +
      `average headroom ${(headroom.averageHeadroomFraction * 100).toFixed(0)}%).`,
  };
}

// ---------------------------------------------------------------------------
// Hypotheses T and L (ALI-106 AC7, docs/ENGINE.md §9) — stated hypotheses
// with falsification conditions, reported with n and an honest verdict.
// "insufficient data" is a valid, expected outcome (AC7.6).
// ---------------------------------------------------------------------------

export type HypothesisVerdict = "insufficient data" | "consistent (not falsified)" | "falsified";

export interface HypothesisReport {
  n: number;
  verdict: HypothesisVerdict;
  detail: string;
}

/** Minimum instance count before this module will render a verdict rather than "insufficient data" — an arbitrary but stated bar, not zero. */
const MIN_N_FOR_VERDICT = 3;

const CHEAP_TIERS: ReadonlySet<ModelTier> = new Set(["haiku", "sonnet"]);

interface SeatSample {
  points: number;
  tokens: number;
}

/** Every `builder`-seat sample, split by whether it ran at a cheap tier or opus, keyed by points bucket. */
function builderSamplesByTierAndPoints(logs: readonly RunLog[]): { cheap: SeatSample[]; opus: SeatSample[] } {
  const cheap: SeatSample[] = [];
  const opus: SeatSample[] = [];
  for (const log of logs) {
    for (const candidate of log.candidates) {
      const builder = candidate.seats.find((s: { seat: SeatName }) => s.seat === "builder");
      if (!builder || builder.status !== "ran" || !builder.model || builder.tokens === undefined) continue;
      const sample: SeatSample = { points: candidate.points, tokens: builder.tokens };
      if (builder.model === "opus") opus.push(sample);
      else if (CHEAP_TIERS.has(builder.model)) cheap.push(sample);
    }
  }
  return { cheap, opus };
}

/** Rework tokens booked against one issue's bounces, summed. */
function totalReworkTokens(bounces: RunLog["candidates"][number]["bounces"]): number {
  return bounces.reduce((sum, b) => sum + b.reworkTokens, 0);
}

/**
 * **Hypothesis T** — judgment at the gates, cheap builders downstream
 * (docs/ENGINE.md §9). Claim: a sharp spec plus a cheap builder beats a
 * vague spec plus an expensive one, because bounces dominate cost.
 *
 * Falsified if: cheap-tier seats show a bounce rate high enough that
 * `cheap_tokens + rework_tokens > expensive_tokens` at equal outcome
 * quality (approximated here as "same points bucket," the closest proxy
 * this schema carries for comparable scope).
 */
export function evaluateHypothesisT(logs: readonly RunLog[]): HypothesisReport {
  const { cheap, opus } = builderSamplesByTierAndPoints(logs);
  const n = cheap.length;

  if (n < MIN_N_FOR_VERDICT || opus.length === 0) {
    return {
      n,
      verdict: "insufficient data",
      detail: `${n} cheap-tier builder sample(s), ${opus.length} opus-tier baseline sample(s) — need at least ${MIN_N_FOR_VERDICT} of each to compare cheap_tokens + rework_tokens against an expensive baseline.`,
    };
  }

  // Rework tokens attributable to a cheap-tier builder's own issue.
  const cheapCandidates = logs
    .flatMap((l) => l.candidates)
    .filter((c) => {
      const b = c.seats.find((s: { seat: SeatName }) => s.seat === "builder");
      return b?.status === "ran" && b.model && CHEAP_TIERS.has(b.model);
    });
  const cheapTotal =
    cheapCandidates.reduce((sum, c) => {
      const builderTokens = c.seats.find((s: { seat: SeatName }) => s.seat === "builder")?.tokens ?? 0;
      return sum + builderTokens + totalReworkTokens(c.bounces);
    }, 0) / cheapCandidates.length;
  const opusAverage = opus.reduce((sum, s) => sum + s.tokens, 0) / opus.length;

  if (cheapTotal > opusAverage) {
    return {
      n,
      verdict: "falsified",
      detail: `Average cheap-tier total (build + rework) ${cheapTotal.toFixed(0)} tokens exceeds the average opus-tier baseline ${opusAverage.toFixed(0)} tokens across ${n} cheap / ${opus.length} opus samples.`,
    };
  }
  return {
    n,
    verdict: "consistent (not falsified)",
    detail: `Average cheap-tier total (build + rework) ${cheapTotal.toFixed(0)} tokens stays under the average opus-tier baseline ${opusAverage.toFixed(0)} tokens across ${n} cheap / ${opus.length} opus samples. Consistent, not confirmed — every sample here was also selected by the run mix, not a controlled trial.`,
  };
}

/**
 * **Hypothesis L** — the escalation ladder only pays on cheap detection
 * (docs/ENGINE.md §9). Claim: a bounce round costs roughly as much as the
 * original build, so the ladder only pays where rejection is detected
 * cheaply (lint stage, not judgment stage).
 *
 * Falsified if: ladder runs whose rejection was detected at judgment stage
 * nonetheless came out cheaper than a single expensive (opus) run. "Cheaper
 * than a single expensive run" is approximated as cheaper than the median
 * opus-tier builder cost in the same points bucket — the same baseline
 * Hypothesis T uses, for the same reason (no pricing table to do better).
 */
export function evaluateHypothesisL(logs: readonly RunLog[]): HypothesisReport {
  const judgmentStageBounces = logs.flatMap((log) =>
    log.candidates.flatMap((c) =>
      c.bounces
        .filter((b) => b.detectedAtStage === ("judgment" satisfies BounceStage))
        .map((b) => ({ candidate: c, bounce: b })),
    ),
  );
  const n = judgmentStageBounces.length;

  const opusMedianByPoints = new Map<number, number>();
  for (const { cheap: _cheap, opus } of [builderSamplesByTierAndPoints(logs)]) {
    void _cheap;
    const byPoints = new Map<number, number[]>();
    for (const s of opus) {
      const bucket = byPoints.get(s.points);
      if (bucket) bucket.push(s.tokens);
      else byPoints.set(s.points, [s.tokens]);
    }
    for (const [points, tokens] of byPoints) {
      opusMedianByPoints.set(points, median(tokens));
    }
  }

  if (n < MIN_N_FOR_VERDICT || opusMedianByPoints.size === 0) {
    return {
      n,
      verdict: "insufficient data",
      detail: `${n} judgment-stage bounce(s) found, ${opusMedianByPoints.size} points bucket(s) with an opus-tier baseline — need at least ${MIN_N_FOR_VERDICT} bounces and a baseline to compare against.`,
    };
  }

  const falsifyingInstances = judgmentStageBounces.filter(({ candidate }) => {
    const baseline = opusMedianByPoints.get(candidate.points);
    if (baseline === undefined) return false;
    const totalCost = (candidate.actualConsumption?.tokensUsed ?? 0);
    return totalCost < baseline;
  });

  if (falsifyingInstances.length > 0) {
    return {
      n,
      verdict: "falsified",
      detail: `${falsifyingInstances.length}/${n} judgment-stage-detected bounce(s) still cost less than their points bucket's opus-tier baseline.`,
    };
  }
  return {
    n,
    verdict: "consistent (not falsified)",
    detail: `All ${n} judgment-stage-detected bounce(s) cost at least as much as their points bucket's opus-tier baseline — no instance found where judgment-stage detection was still cheaper than skipping the ladder.`,
  };
}

// ---------------------------------------------------------------------------
// The digest — what the planner's retro reports, verbatim (AC2, AC7.6)
// ---------------------------------------------------------------------------

/** Human-readable retro digest for the three metrics + the budget recommendation + both hypotheses. Never applies anything — text only. */
export function renderCalibrationDigest(logs: readonly RunLog[], currentBudget: number): string {
  const ratios = pointsToCostRatio(logs);
  const inconsistencies = detectPointsInconsistency(ratios);
  const fireRate = computeBackstopFireRate(logs);
  const headroom = computeBudgetHeadroom(logs);
  const recommendation = recommendBudgetChange(logs, currentBudget);
  const hypothesisT = evaluateHypothesisT(logs);
  const hypothesisL = evaluateHypothesisL(logs);

  const lines: string[] = [];
  lines.push(`**Calibration digest — ${logs.length} run(s)**`);
  lines.push("");
  lines.push("Points-to-cost ratio (median actual tokens per point value):");
  for (const r of ratios) lines.push(`- ${r.points}pt: median ${r.medianTokens} tokens (n=${r.n})`);
  for (const w of inconsistencies) lines.push(`  ⚠ ${w}`);
  lines.push("");
  lines.push(
    `Backstop-fire rate: ${(fireRate.rate * 100).toFixed(0)}% (${fireRate.backstopRuns}/${fireRate.totalRuns}) — ` +
      `${fireRate.underTarget ? "under" : "OVER"} the ${(BACKSTOP_FIRE_RATE_TARGET * 100).toFixed(0)}% target.`,
  );
  lines.push(
    `Budget headroom: average ${(headroom.averageHeadroomFraction * 100).toFixed(0)}% unused ` +
      `(${headroom.cleanRunCount}/${headroom.totalRuns} clean runs).`,
  );
  lines.push("");
  lines.push(`Recommendation: **${recommendation.action}**${"to" in recommendation ? ` (${recommendation.from} → ${recommendation.to})` : ""} — ${recommendation.evidence}`);
  lines.push("(Recommend, never apply — every budget change is a human-merged commit, Amendment-gated.)");
  lines.push("");
  lines.push(`Hypothesis T (judgment at the gates, cheap builders downstream): n=${hypothesisT.n} — **${hypothesisT.verdict}**. ${hypothesisT.detail}`);
  lines.push(`Hypothesis L (the ladder only pays on cheap detection): n=${hypothesisL.n} — **${hypothesisL.verdict}**. ${hypothesisL.detail}`);

  return lines.join("\n");
}
