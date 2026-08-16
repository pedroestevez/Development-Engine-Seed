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
 * F2 (bounce round 1): the minimum sample size a points bucket must carry
 * before it may participate in the inconsistency check at all. Without this
 * floor, a single unreplicated observation (`n=1`) could single-handedly
 * decide AC4's lower-vs-re-point disambiguation — e.g. one 2pt candidate
 * that happened to run expensive would flip the whole retro to "re-point"
 * on no more evidence than a coincidence. A bucket below the floor is
 * reported by the digest as not-yet-comparable rather than silently
 * dropped, but never contributes a warning here.
 */
export const MIN_BUCKET_N_FOR_COMPARISON = 2;

/**
 * "If a '3' reliably costs more than a '5', the scale is being applied
 * inconsistently" (the issue's own example). Flags every out-of-order pair
 * — among buckets carrying at least `MIN_BUCKET_N_FOR_COMPARISON` samples
 * (F2) — where a higher point value's median cost is *lower* than a
 * smaller point value's, as a human-readable warning, so the retro can
 * name the exact pair rather than eyeball a table.
 */
export function detectPointsInconsistency(ratios: readonly PointsCostRatio[]): string[] {
  const warnings: string[] = [];
  const comparable = ratios.filter((r) => r.n >= MIN_BUCKET_N_FOR_COMPARISON);
  for (let i = 0; i < comparable.length; i++) {
    for (let j = i + 1; j < comparable.length; j++) {
      const smaller = comparable[i] as PointsCostRatio;
      const larger = comparable[j] as PointsCostRatio;
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
  /**
   * F5 (bounce round 1): `rate <= BACKSTOP_FIRE_RATE_TARGET` — pinned to
   * match the prose exactly ("Target: under 20%. **Above that**, …",
   * docs/ENGINE.md §9): a rate of *exactly* 20% is the target, not above
   * it, so it must not trigger the lower-or-re-point branch. Only a rate
   * strictly greater than 20% is "OVER" / not `underTarget`.
   */
  underTarget: boolean;
}

const BACKSTOP_STOP_REASONS: ReadonlySet<RunLog["stopReason"]> = new Set(["backstop-wallclock", "backstop-tokens"]);

/** % of runs stopped by the backstop rather than by cycle-empty or budget-exhausted. */
export function computeBackstopFireRate(logs: readonly RunLog[]): BackstopFireRate {
  const totalRuns = logs.length;
  const backstopRuns = logs.filter((l) => BACKSTOP_STOP_REASONS.has(l.stopReason)).length;
  const rate = totalRuns === 0 ? 0 : backstopRuns / totalRuns;
  return { totalRuns, backstopRuns, rate, underTarget: rate <= BACKSTOP_FIRE_RATE_TARGET };
}

// ---------------------------------------------------------------------------
// Metric 3: budget headroom + the ramp trigger (docs/ENGINE.md §9)
// ---------------------------------------------------------------------------

/**
 * "Finished naturally, with headroom" — `cycle-empty` (nothing left to
 * admit; budget was never the limiting factor) and zero backstop fires.
 * `budget-exhausted` is deliberately excluded: that run used every point of
 * budget it had, the opposite of headroom.
 *
 * F4 (bounce round 1): the issue and docs/ENGINE.md §9 both phrase the ramp
 * trigger as three runs "finishing **under budget**." This function reads
 * that as `stopReason === "cycle-empty"` alone (plus zero backstop fires),
 * without separately checking `budget.consumed < budget.total` — a
 * deliberate, disclosed choice, not an oversight:
 *
 *   - `cycle-empty` already means the run stopped because the *cycle* ran
 *     out of candidates to admit, not because the *budget* did — if the
 *     budget had been the binding constraint, the stop reason would be
 *     `budget-exhausted`, never `cycle-empty`. So `cycle-empty` is itself
 *     the evidence that the budget wasn't binding on that run.
 *   - A numeric `consumed < total` check is redundant with that and adds a
 *     second, weaker way to read the same signal (e.g. a run that happens
 *     to consume exactly 100% of budget on its last admitted candidate
 *     while nothing was left to admit is still "budget wasn't limiting,"
 *     not "budget was tight").
 *
 * `averageHeadroomFraction` (below) is reported by the digest and the
 * `recommendBudgetChange` "hold" branch for visibility — a numeric sense of
 * *how much* slack recent runs had — but is intentionally not part of this
 * gate; the ramp decision is binary (clean or not), not headroom-sized.
 * docs/ENGINE.md §9 states this reading explicitly so the code and the
 * prose can't drift apart again.
 */
export function isCleanRun(log: RunLog): boolean {
  return log.stopReason === "cycle-empty" && log.backstopFireCount === 0;
}

export interface BudgetHeadroom {
  /** Average fraction of budget consumed, across every run passed in. */
  averageConsumedFraction: number;
  /**
   * 1 - averageConsumedFraction. Reported for visibility (the digest, and
   * the "hold" branch's evidence text) — see the F4 note on `isCleanRun`
   * for why this does not itself gate the ramp trigger.
   */
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
 * F3 (bounce round 1): Hypothesis L's opus baseline, keyed by points bucket,
 * built from the **whole issue's** `actualConsumption.tokensUsed` — every
 * seat plus any rework, exactly the same quantity the ladder side of the
 * comparison uses (see `evaluateHypothesisL` below). Deliberately *not*
 * `builderSamplesByTierAndPoints`'s `builder.tokens` alone: that is a single
 * seat's slice of the run, not "a single expensive run" (docs/ENGINE.md
 * §9's own phrase for the falsification condition) — comparing a
 * judgment-stage bounce's whole-issue cost against a stripped-down,
 * builder-only baseline systematically understates the baseline and biases
 * the test toward "falsified." A candidate qualifies as a baseline sample
 * when its builder seat reported running at `opus` — same tier filter as
 * before — but the cost taken from it is the issue's total, matching units
 * on both sides of the `<` in the falsification check.
 */
function opusWholeIssueTokensByPoints(logs: readonly RunLog[]): Map<number, number[]> {
  const byPoints = new Map<number, number[]>();
  for (const log of logs) {
    for (const candidate of log.candidates) {
      const builder = candidate.seats.find((s: { seat: SeatName }) => s.seat === "builder");
      if (!builder || builder.status !== "ran" || builder.model !== "opus") continue;
      if (candidate.actualConsumption === undefined) continue;
      const tokens = candidate.actualConsumption.tokensUsed;
      const bucket = byPoints.get(candidate.points);
      if (bucket) bucket.push(tokens);
      else byPoints.set(candidate.points, [tokens]);
    }
  }
  return byPoints;
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
 * opus-tier **whole-issue** cost in the same points bucket (F3, bounce
 * round 1: same units on both sides of the comparison — see
 * `opusWholeIssueTokensByPoints`).
 *
 * F1 (bounce round 1, must-fix): a bounce whose candidate carries no
 * `actualConsumption` has no known cost — `validateRunLogSchema` explicitly
 * permits its absence, so this is real, expected input, not a malformed
 * fixture. Such a bounce is excluded from the falsification set entirely
 * (never defaulted to cost 0, which would make it read as the *cheapest*
 * possible instance and falsely falsify the hypothesis) and is instead
 * folded into the `n`/insufficient-data accounting: it counts toward
 * neither `n` nor a verdict, the same as a bounce this module never saw.
 */
export function evaluateHypothesisL(logs: readonly RunLog[]): HypothesisReport {
  const judgmentStageBounces = logs.flatMap((log) =>
    log.candidates.flatMap((c) =>
      c.bounces
        .filter((b) => b.detectedAtStage === ("judgment" satisfies BounceStage))
        .map((b) => ({ candidate: c, bounce: b })),
    ),
  );
  // F1: only bounces whose candidate has a known actual cost are usable
  // evidence. The rest are excluded from `n` and the falsification set,
  // not defaulted to cost 0.
  const costedBounces = judgmentStageBounces.filter(({ candidate }) => candidate.actualConsumption !== undefined);
  const excludedForMissingCost = judgmentStageBounces.length - costedBounces.length;
  const n = costedBounces.length;

  const opusMedianByPoints = new Map<number, number>();
  for (const [points, tokens] of opusWholeIssueTokensByPoints(logs)) {
    opusMedianByPoints.set(points, median(tokens));
  }

  if (n < MIN_N_FOR_VERDICT || opusMedianByPoints.size === 0) {
    return {
      n,
      verdict: "insufficient data",
      detail:
        `${n} judgment-stage bounce(s) with a known actual cost found` +
        (excludedForMissingCost > 0 ? ` (${excludedForMissingCost} more excluded — no actualConsumption recorded)` : "") +
        `, ${opusMedianByPoints.size} points bucket(s) with an opus-tier whole-issue baseline — need at least ${MIN_N_FOR_VERDICT} costed bounces and a baseline to compare against.`,
    };
  }

  const falsifyingInstances = costedBounces.filter(({ candidate }) => {
    const baseline = opusMedianByPoints.get(candidate.points);
    if (baseline === undefined) return false;
    const totalCost = (candidate.actualConsumption as { tokensUsed: number }).tokensUsed;
    return totalCost < baseline;
  });

  if (falsifyingInstances.length > 0) {
    return {
      n,
      verdict: "falsified",
      detail: `${falsifyingInstances.length}/${n} judgment-stage-detected bounce(s) with known cost still cost less than their points bucket's opus-tier whole-issue baseline.`,
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
  for (const r of ratios) {
    const note = r.n < MIN_BUCKET_N_FOR_COMPARISON ? " — not yet comparable (fewer than 2 samples)" : "";
    lines.push(`- ${r.points}pt: median ${r.medianTokens} tokens (n=${r.n})${note}`);
  }
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
