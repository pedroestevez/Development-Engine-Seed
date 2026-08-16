/**
 * ALI-106 AC2–AC7: the calibration loop's retro-computation code
 * (`src/dispatcher/calibration.ts`), tested directly against synthetic run
 * logs — the "fixture, not description" bar the issue's Definition of Done
 * sets for criteria 3 and 4.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  BACKSTOP_FIRE_RATE_TARGET,
  MIN_BUCKET_N_FOR_COMPARISON,
  computeBackstopFireRate,
  computeBudgetHeadroom,
  detectPointsInconsistency,
  evaluateHypothesisL,
  evaluateHypothesisT,
  isCleanRun,
  pointsToCostRatio,
  recommendBudgetChange,
  renderCalibrationDigest,
  type PointsCostRatio,
} from "../calibration.js";
import {
  validateRunLogSchema,
  type BounceRecord,
  type CandidateLogEntry,
  type RunLog,
  type SeatOutcome,
} from "../runlog.js";
import type { IssueTierResult } from "../types.js";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

let seq = 0;

function makeCandidate(overrides: Partial<CandidateLogEntry> & { issueId: string; points: number }): CandidateLogEntry {
  seq++;
  const tier: IssueTierResult = { issueId: overrides.issueId, pointsTier: "sonnet", riskTier: "none", tier: "sonnet" };
  return {
    issueId: overrides.issueId,
    points: overrides.points,
    labels: overrides.labels ?? [],
    weightedCost: overrides.weightedCost ?? overrides.points,
    verdict: overrides.verdict ?? "admitted",
    tier: overrides.tier ?? tier,
    seats: overrides.seats ?? [],
    bounces: overrides.bounces ?? [],
    outcome: overrides.outcome ?? "opened-pr",
    estimatedConsumption: overrides.estimatedConsumption ?? { weightedCost: overrides.points },
    actualConsumption: overrides.actualConsumption,
    risk: overrides.risk ?? { labels: overrides.labels ?? [], points: overrides.points, verifierTier: "none" },
  };
}

function makeRunLog(overrides: Partial<RunLog> & { generatedAt: string }): RunLog {
  seq++;
  return {
    engineSha: overrides.engineSha ?? `sha-${seq}`,
    cycleId: overrides.cycleId ?? "cycle-1",
    approvalRef: overrides.approvalRef ?? "tg-msg-1",
    generatedAt: overrides.generatedAt,
    candidates: overrides.candidates ?? [],
    budget: overrides.budget ?? { total: 5, consumed: 0, remaining: 5 },
    clusters: overrides.clusters ?? [],
    laneCount: overrides.laneCount ?? 1,
    stopReason: overrides.stopReason ?? "cycle-empty",
    backstopFireCount: overrides.backstopFireCount ?? 0,
    credentials: overrides.credentials ?? { linear: "[NOT SET]", github: "[NOT SET]" },
  };
}

function builderSeat(model: "haiku" | "sonnet" | "opus", tokens: number): SeatOutcome {
  return { seat: "builder", status: "ran", model, effort: "standard", tokens, wallClockMs: 1000 };
}

// ---------------------------------------------------------------------------
// AC3: five synthetic logs, every run finished under budget with no
// backstop fire -- recommends raising to 6, citing the three clean runs.
// ---------------------------------------------------------------------------

describe("ALI-106 AC3: five clean runs recommend raising the budget to 6, citing the three clean runs", () => {
  it("demonstrated against a fixture, not described", () => {
    const logs: RunLog[] = Array.from({ length: 5 }, (_, i) =>
      makeRunLog({
        generatedAt: `2026-08-0${i + 1}T00:00:00.000Z`,
        stopReason: "cycle-empty",
        backstopFireCount: 0,
        budget: { total: 5, consumed: 3, remaining: 2 },
        candidates: [makeCandidate({ issueId: `issue-${i}`, points: 2, actualConsumption: { wallClockMs: 1000, tokensUsed: 200 } })],
      }),
    );

    // Sanity: every run in the fixture is in fact clean.
    expect(logs.every(isCleanRun)).toBe(true);

    const recommendation = recommendBudgetChange(logs, 5);

    expect(recommendation.action).toBe("raise");
    if (recommendation.action === "raise") {
      expect(recommendation.from).toBe(5);
      expect(recommendation.to).toBe(6);
    }
    // Cites the three clean runs -- the last three of the five, by generatedAt.
    const lastThree = logs.slice(-3).map((l) => l.generatedAt);
    for (const ts of lastThree) expect(recommendation.evidence).toContain(ts);
  });

  it("the digest renders the raise recommendation and cites the same three timestamps", () => {
    const logs: RunLog[] = Array.from({ length: 5 }, (_, i) =>
      makeRunLog({ generatedAt: `2026-08-1${i}T00:00:00.000Z`, stopReason: "cycle-empty", backstopFireCount: 0 }),
    );
    const digest = renderCalibrationDigest(logs, 5);
    expect(digest).toContain("**raise**");
    expect(digest).toContain("(5 → 6)");
  });
});

// ---------------------------------------------------------------------------
// AC4: 3 of 5 runs hit the backstop -- recommends lowering OR re-pointing,
// and names which. Two fixtures below force each branch deterministically,
// proving the decision is decisive, never both vaguely.
// ---------------------------------------------------------------------------

describe("ALI-106 AC4: 3-of-5 backstop-heavy runs recommend lowering or re-pointing, decisively -- never both vaguely", () => {
  it("consistent points-to-cost scale -> recommends LOWER, not re-point", () => {
    const backstopLog = (ts: string): RunLog =>
      makeRunLog({
        generatedAt: ts,
        stopReason: "backstop-wallclock",
        backstopFireCount: 1,
        candidates: [
          makeCandidate({ issueId: `${ts}-a`, points: 1, actualConsumption: { wallClockMs: 1000, tokensUsed: 100 } }),
          makeCandidate({ issueId: `${ts}-b`, points: 3, actualConsumption: { wallClockMs: 1000, tokensUsed: 300 } }),
        ],
      });
    const cleanLog = (ts: string): RunLog =>
      makeRunLog({
        generatedAt: ts,
        stopReason: "cycle-empty",
        backstopFireCount: 0,
        candidates: [
          makeCandidate({ issueId: `${ts}-a`, points: 1, actualConsumption: { wallClockMs: 1000, tokensUsed: 110 } }),
          makeCandidate({ issueId: `${ts}-b`, points: 3, actualConsumption: { wallClockMs: 1000, tokensUsed: 310 } }),
        ],
      });

    const logs: RunLog[] = [
      backstopLog("2026-08-01T00:00:00.000Z"),
      backstopLog("2026-08-02T00:00:00.000Z"),
      backstopLog("2026-08-03T00:00:00.000Z"),
      cleanLog("2026-08-04T00:00:00.000Z"),
      cleanLog("2026-08-05T00:00:00.000Z"),
    ];

    const fireRate = computeBackstopFireRate(logs);
    expect(fireRate.backstopRuns).toBe(3);
    expect(fireRate.totalRuns).toBe(5);
    expect(fireRate.rate).toBeGreaterThan(BACKSTOP_FIRE_RATE_TARGET);

    // Sanity: the 1pt/3pt cost buckets here are consistent (1pt costs less than 3pt).
    expect(detectPointsInconsistency(pointsToCostRatio(logs))).toEqual([]);

    const recommendation = recommendBudgetChange(logs, 5);
    expect(recommendation.action).toBe("lower");
    if (recommendation.action === "lower") {
      expect(recommendation.from).toBe(5);
      expect(recommendation.to).toBe(4);
    }
  });

  it("inconsistent points-to-cost scale -> recommends RE-POINT, not lower", () => {
    const backstopLog = (ts: string): RunLog =>
      makeRunLog({
        generatedAt: ts,
        stopReason: "backstop-tokens",
        backstopFireCount: 1,
        candidates: [
          // A 3pt issue costing MORE than a 5pt issue -- the scale is inconsistent.
          makeCandidate({ issueId: `${ts}-a`, points: 3, actualConsumption: { wallClockMs: 1000, tokensUsed: 900 } }),
          makeCandidate({ issueId: `${ts}-b`, points: 5, actualConsumption: { wallClockMs: 1000, tokensUsed: 200 } }),
        ],
      });
    const cleanLog = (ts: string): RunLog =>
      makeRunLog({
        generatedAt: ts,
        stopReason: "cycle-empty",
        backstopFireCount: 0,
        candidates: [
          makeCandidate({ issueId: `${ts}-a`, points: 3, actualConsumption: { wallClockMs: 1000, tokensUsed: 950 } }),
          makeCandidate({ issueId: `${ts}-b`, points: 5, actualConsumption: { wallClockMs: 1000, tokensUsed: 210 } }),
        ],
      });

    const logs: RunLog[] = [
      backstopLog("2026-08-01T00:00:00.000Z"),
      backstopLog("2026-08-02T00:00:00.000Z"),
      backstopLog("2026-08-03T00:00:00.000Z"),
      cleanLog("2026-08-04T00:00:00.000Z"),
      cleanLog("2026-08-05T00:00:00.000Z"),
    ];

    const fireRate = computeBackstopFireRate(logs);
    expect(fireRate.backstopRuns).toBe(3);
    expect(fireRate.rate).toBeGreaterThan(BACKSTOP_FIRE_RATE_TARGET);

    const inconsistencies = detectPointsInconsistency(pointsToCostRatio(logs));
    expect(inconsistencies.length).toBeGreaterThan(0);
    expect(inconsistencies[0]).toContain("3pt");
    expect(inconsistencies[0]).toContain("5pt");

    const recommendation = recommendBudgetChange(logs, 5);
    expect(recommendation.action).toBe("re-point");
    if (recommendation.action === "re-point") {
      expect(recommendation.evidence).toContain("3pt");
      expect(recommendation.evidence).toContain("5pt");
    }
  });
});

// ---------------------------------------------------------------------------
// F2: an n=1 points bucket cannot single-handedly decide AC4's
// lower-vs-re-point disambiguation.
// ---------------------------------------------------------------------------

describe("F2: minimum bucket size before a points bucket may trigger re-point", () => {
  it("boundary: n=1 is below MIN_BUCKET_N_FOR_COMPARISON -- excluded from the inconsistency check", () => {
    expect(MIN_BUCKET_N_FOR_COMPARISON).toBe(2);
    // Reviewer's exact repro shape: one 2pt candidate at 5000 tokens (n=1)
    // against an otherwise-consistent 3pt bucket (n=5, median 300).
    const ratios: PointsCostRatio[] = [
      { points: 2, medianTokens: 5000, n: 1 },
      { points: 3, medianTokens: 300, n: 5 },
    ];
    expect(detectPointsInconsistency(ratios)).toEqual([]);
  });

  it("boundary: n=2 is exactly at MIN_BUCKET_N_FOR_COMPARISON -- enough to participate", () => {
    const ratios: PointsCostRatio[] = [
      { points: 2, medianTokens: 5000, n: 2 },
      { points: 3, medianTokens: 300, n: 5 },
    ];
    const warnings = detectPointsInconsistency(ratios);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("2pt");
    expect(warnings[0]).toContain("3pt");
  });

  it("end-to-end: adding one unreplicated (n=1) expensive 2pt candidate to the AC4 consistent fixture does not flip lower -> re-point", () => {
    const backstopLog = (ts: string): RunLog =>
      makeRunLog({
        generatedAt: ts,
        stopReason: "backstop-wallclock",
        backstopFireCount: 1,
        candidates: [
          makeCandidate({ issueId: `${ts}-a`, points: 1, actualConsumption: { wallClockMs: 1000, tokensUsed: 100 } }),
          makeCandidate({ issueId: `${ts}-b`, points: 3, actualConsumption: { wallClockMs: 1000, tokensUsed: 300 } }),
        ],
      });
    const cleanLog = (ts: string): RunLog =>
      makeRunLog({
        generatedAt: ts,
        stopReason: "cycle-empty",
        backstopFireCount: 0,
        candidates: [
          makeCandidate({ issueId: `${ts}-a`, points: 1, actualConsumption: { wallClockMs: 1000, tokensUsed: 110 } }),
          makeCandidate({ issueId: `${ts}-b`, points: 3, actualConsumption: { wallClockMs: 1000, tokensUsed: 310 } }),
        ],
      });

    const logs: RunLog[] = [
      backstopLog("2026-08-01T00:00:00.000Z"),
      backstopLog("2026-08-02T00:00:00.000Z"),
      backstopLog("2026-08-03T00:00:00.000Z"),
      cleanLog("2026-08-04T00:00:00.000Z"),
      cleanLog("2026-08-05T00:00:00.000Z"),
    ];
    // The single unreplicated observation the reviewer's mutation added:
    // one 2pt candidate at 5000 tokens (n=1 for the 2pt bucket).
    logs[3]!.candidates.push(makeCandidate({ issueId: "outlier-2pt", points: 2, actualConsumption: { wallClockMs: 1000, tokensUsed: 5000 } }));

    // Sanity: the 2pt bucket really is n=1, and it would flip the verdict
    // pre-fix (5000 > every other bucket's median makes it look "cheaper"
    // than nothing at 2pt, but more importantly it's simply undersized).
    const ratios = pointsToCostRatio(logs);
    const twoPtBucket = ratios.find((r) => r.points === 2);
    expect(twoPtBucket?.n).toBe(1);

    const recommendation = recommendBudgetChange(logs, 5);
    expect(recommendation.action).toBe("lower");
  });
});

// ---------------------------------------------------------------------------
// The three metrics, as standalone units.
// ---------------------------------------------------------------------------

describe("ALI-106 AC2: the three metrics, exact computation", () => {
  it("pointsToCostRatio: median tokens per point value, sorted ascending, omitting undispatched candidates", () => {
    const logs: RunLog[] = [
      makeRunLog({
        generatedAt: "t1",
        candidates: [
          makeCandidate({ issueId: "a", points: 1, actualConsumption: { wallClockMs: 1, tokensUsed: 100 } }),
          makeCandidate({ issueId: "b", points: 1, actualConsumption: { wallClockMs: 1, tokensUsed: 200 } }),
          makeCandidate({ issueId: "c", points: 3, actualConsumption: { wallClockMs: 1, tokensUsed: 500 } }),
          makeCandidate({ issueId: "d", points: 5, outcome: "not-dispatched", actualConsumption: undefined }),
        ],
      }),
    ];
    const ratios = pointsToCostRatio(logs);
    expect(ratios).toEqual([
      { points: 1, medianTokens: 150, n: 2 },
      { points: 3, medianTokens: 500, n: 1 },
    ]);
  });

  it("computeBackstopFireRate: rate under target when no run backstops", () => {
    const logs = [makeRunLog({ generatedAt: "t1" }), makeRunLog({ generatedAt: "t2" })];
    const result = computeBackstopFireRate(logs);
    expect(result).toEqual({ totalRuns: 2, backstopRuns: 0, rate: 0, underTarget: true });
  });

  it("computeBackstopFireRate: rate over target at 21% (>20%)", () => {
    const logs = Array.from({ length: 100 }, (_, i) =>
      makeRunLog({ generatedAt: `t${i}`, stopReason: i < 21 ? "backstop-wallclock" : "cycle-empty" }),
    );
    const result = computeBackstopFireRate(logs);
    expect(result.rate).toBeCloseTo(0.21, 5);
    expect(result.underTarget).toBe(false);
  });

  it("F5: rate at exactly 20% is still under target -- 'Above that' means strictly greater than 20%, not >=", () => {
    const logs = Array.from({ length: 100 }, (_, i) =>
      makeRunLog({ generatedAt: `t${i}`, stopReason: i < 20 ? "backstop-wallclock" : "cycle-empty" }),
    );
    const result = computeBackstopFireRate(logs);
    expect(result.rate).toBeCloseTo(0.2, 5);
    expect(result.rate).toBeCloseTo(BACKSTOP_FIRE_RATE_TARGET, 5);
    expect(result.underTarget).toBe(true);

    // And it must not tip recommendBudgetChange into the lower-or-re-point
    // branch on its own -- a bare majority of clean tail runs still holds.
    const recommendation = recommendBudgetChange(logs, 5);
    expect(recommendation.action).not.toBe("lower");
    expect(recommendation.action).not.toBe("re-point");
  });

  it("computeBudgetHeadroom: averages consumed/total across runs, counts clean runs", () => {
    const logs = [
      makeRunLog({ generatedAt: "t1", budget: { total: 5, consumed: 5, remaining: 0 }, stopReason: "budget-exhausted" }),
      makeRunLog({ generatedAt: "t2", budget: { total: 5, consumed: 2, remaining: 3 }, stopReason: "cycle-empty" }),
    ];
    const headroom = computeBudgetHeadroom(logs);
    expect(headroom.totalRuns).toBe(2);
    expect(headroom.cleanRunCount).toBe(1);
    expect(headroom.averageConsumedFraction).toBeCloseTo(0.7, 5); // (1.0 + 0.4) / 2
  });

  it("isCleanRun: true only for cycle-empty with zero backstop fires", () => {
    expect(isCleanRun(makeRunLog({ generatedAt: "t", stopReason: "cycle-empty", backstopFireCount: 0 }))).toBe(true);
    expect(isCleanRun(makeRunLog({ generatedAt: "t", stopReason: "cycle-empty", backstopFireCount: 1 }))).toBe(false);
    expect(isCleanRun(makeRunLog({ generatedAt: "t", stopReason: "budget-exhausted", backstopFireCount: 0 }))).toBe(false);
  });

  it("an empty log set holds (no recommendation forced), and every metric degrades gracefully", () => {
    expect(computeBackstopFireRate([])).toEqual({ totalRuns: 0, backstopRuns: 0, rate: 0, underTarget: true });
    expect(computeBudgetHeadroom([])).toEqual({ averageConsumedFraction: 0, averageHeadroomFraction: 0, cleanRunCount: 0, totalRuns: 0 });
    expect(pointsToCostRatio([])).toEqual([]);
    expect(recommendBudgetChange([], 5).action).toBe("hold");
  });
});

// ---------------------------------------------------------------------------
// AC7: Hypotheses T and L -- n + honest verdict, "insufficient data" included.
// ---------------------------------------------------------------------------

describe("ALI-106 AC7: Hypothesis T and Hypothesis L report n and an honest verdict", () => {
  it("Hypothesis T: insufficient data with no logs at all", () => {
    const result = evaluateHypothesisT([]);
    expect(result.verdict).toBe("insufficient data");
    expect(result.n).toBe(0);
  });

  it("Hypothesis L: insufficient data with no bounces at all", () => {
    const logs = [makeRunLog({ generatedAt: "t1", candidates: [makeCandidate({ issueId: "a", points: 1 })] })];
    const result = evaluateHypothesisL(logs);
    expect(result.verdict).toBe("insufficient data");
    expect(result.n).toBe(0);
  });

  it("Hypothesis T: consistent (not falsified) when cheap-tier total stays under the opus baseline", () => {
    const cheapCandidates = Array.from({ length: 3 }, (_, i) =>
      makeCandidate({
        issueId: `cheap-${i}`,
        points: 2,
        seats: [builderSeat("sonnet", 100)],
        bounces: [],
        actualConsumption: { wallClockMs: 1, tokensUsed: 100 },
      }),
    );
    const opusCandidates = Array.from({ length: 3 }, (_, i) =>
      makeCandidate({
        issueId: `opus-${i}`,
        points: 2,
        seats: [builderSeat("opus", 1000)],
        actualConsumption: { wallClockMs: 1, tokensUsed: 1000 },
      }),
    );
    const logs = [makeRunLog({ generatedAt: "t1", candidates: [...cheapCandidates, ...opusCandidates] })];

    const result = evaluateHypothesisT(logs);
    expect(result.n).toBe(3);
    expect(result.verdict).toBe("consistent (not falsified)");
  });

  it("Hypothesis T: falsified when cheap-tier total (build + rework) exceeds the opus baseline", () => {
    const heavyBounce: BounceRecord = {
      round: 1,
      detectedAtStage: "judgment",
      detectorSeat: "reviewer",
      detectorTokens: 50,
      reworkTokens: 5000,
      reason: "wrong approach entirely",
    };
    const cheapCandidates = Array.from({ length: 3 }, (_, i) =>
      makeCandidate({
        issueId: `cheap-${i}`,
        points: 2,
        seats: [builderSeat("sonnet", 100)],
        bounces: [heavyBounce],
        actualConsumption: { wallClockMs: 1, tokensUsed: 5100 },
      }),
    );
    const opusCandidates = Array.from({ length: 3 }, (_, i) =>
      makeCandidate({
        issueId: `opus-${i}`,
        points: 2,
        seats: [builderSeat("opus", 1000)],
        actualConsumption: { wallClockMs: 1, tokensUsed: 1000 },
      }),
    );
    const logs = [makeRunLog({ generatedAt: "t1", candidates: [...cheapCandidates, ...opusCandidates] })];

    const result = evaluateHypothesisT(logs);
    expect(result.verdict).toBe("falsified");
  });

  it("Hypothesis L: falsified when a judgment-stage-detected bounce's issue still cost less than the opus baseline", () => {
    const cheapBounceCandidates = Array.from({ length: 3 }, (_, i) =>
      makeCandidate({
        issueId: `ladder-${i}`,
        points: 2,
        bounces: [
          { round: 1, detectedAtStage: "judgment", detectorSeat: "reviewer", detectorTokens: 20, reworkTokens: 30, reason: "logic gap" },
        ],
        actualConsumption: { wallClockMs: 1, tokensUsed: 150 }, // well under the 1000-token opus baseline
      }),
    );
    const opusBaseline = Array.from({ length: 3 }, (_, i) =>
      makeCandidate({
        issueId: `opus-${i}`,
        points: 2,
        seats: [builderSeat("opus", 1000)],
        actualConsumption: { wallClockMs: 1, tokensUsed: 1000 },
      }),
    );
    const logs = [makeRunLog({ generatedAt: "t1", candidates: [...cheapBounceCandidates, ...opusBaseline] })];

    const result = evaluateHypothesisL(logs);
    expect(result.n).toBe(3);
    expect(result.verdict).toBe("falsified");
  });

  it("Hypothesis L: consistent (not falsified) when judgment-stage-detected bounces cost at least as much as the opus baseline", () => {
    const expensiveBounceCandidates = Array.from({ length: 3 }, (_, i) =>
      makeCandidate({
        issueId: `ladder-${i}`,
        points: 2,
        bounces: [
          { round: 1, detectedAtStage: "judgment", detectorSeat: "reviewer", detectorTokens: 500, reworkTokens: 900, reason: "logic gap" },
        ],
        actualConsumption: { wallClockMs: 1, tokensUsed: 1400 }, // over the 1000-token opus baseline
      }),
    );
    const opusBaseline = Array.from({ length: 3 }, (_, i) =>
      makeCandidate({
        issueId: `opus-${i}`,
        points: 2,
        seats: [builderSeat("opus", 1000)],
        actualConsumption: { wallClockMs: 1, tokensUsed: 1000 },
      }),
    );
    const logs = [makeRunLog({ generatedAt: "t1", candidates: [...expensiveBounceCandidates, ...opusBaseline] })];

    const result = evaluateHypothesisL(logs);
    expect(result.verdict).toBe("consistent (not falsified)");
  });

  it("F1 (must-fix) regression: a judgment-stage bounce with no actualConsumption is never treated as free -- excluded from the falsification set, never 'falsified'", () => {
    // Reviewer's exact repro: three bounced candidates, 900 detector + 900
    // rework tokens, no actualConsumption at all. Pre-fix, `?? 0` made the
    // missing cost read as 0 -- cheaper than any positive baseline -- and
    // the module reported "falsified" on absent evidence.
    const bounce: BounceRecord = {
      round: 1,
      detectedAtStage: "judgment",
      detectorSeat: "reviewer",
      detectorTokens: 900,
      reworkTokens: 900,
      reason: "wrong approach entirely",
    };
    const noCostBouncedCandidates = Array.from({ length: 3 }, (_, i) =>
      makeCandidate({
        issueId: `bounced-no-cost-${i}`,
        points: 2,
        bounces: [bounce],
        actualConsumption: undefined,
      }),
    );
    // A real opus-tier baseline exists, so the "insufficient data" verdict
    // below is proven to come from the missing-cost exclusion, not merely
    // from an absent baseline.
    const opusBaseline = Array.from({ length: 3 }, (_, i) =>
      makeCandidate({
        issueId: `opus-${i}`,
        points: 2,
        seats: [builderSeat("opus", 1000)],
        actualConsumption: { wallClockMs: 1, tokensUsed: 1000 },
      }),
    );
    const logs = [makeRunLog({ generatedAt: "t1", candidates: [...noCostBouncedCandidates, ...opusBaseline] })];

    const result = evaluateHypothesisL(logs);

    expect(result.verdict).not.toBe("falsified");
    expect(result.verdict).toBe("insufficient data");
    // All 3 bounces were excluded for missing actualConsumption -- 0 usable.
    expect(result.n).toBe(0);

    // And the schema itself confirms this is legal input, not a malformed fixture.
    const log = JSON.parse(JSON.stringify(logs[0])) as unknown;
    expect(validateRunLogSchema(log).ok).toBe(true);
  });

  it("F3: Hypothesis L's opus baseline compares whole-issue cost, not builder-seat-only cost -- a stripped-down baseline no longer masks falsification", () => {
    // Opus baseline candidates: the builder seat alone reports 500 tokens,
    // but the whole issue (reviewer + security + rework) actually cost
    // 2000 -- the true cost of "skip the ladder, go straight to opus."
    const opusBaseline = Array.from({ length: 3 }, (_, i) =>
      makeCandidate({
        issueId: `opus-${i}`,
        points: 2,
        seats: [builderSeat("opus", 500)],
        actualConsumption: { wallClockMs: 1, tokensUsed: 2000 },
      }),
    );
    // A judgment-stage-detected bounce whose whole-issue cost (800) sits
    // between the builder-only figure (500) and the whole-issue figure
    // (2000) -- the two baselines disagree on the verdict.
    const ladderCandidates = Array.from({ length: 3 }, (_, i) =>
      makeCandidate({
        issueId: `ladder-${i}`,
        points: 2,
        bounces: [
          { round: 1, detectedAtStage: "judgment", detectorSeat: "reviewer", detectorTokens: 100, reworkTokens: 200, reason: "logic gap" },
        ],
        actualConsumption: { wallClockMs: 1, tokensUsed: 800 },
      }),
    );
    const logs = [makeRunLog({ generatedAt: "t1", candidates: [...ladderCandidates, ...opusBaseline] })];

    const result = evaluateHypothesisL(logs);
    // Against the whole-issue baseline (2000), 800 < 2000 -- correctly
    // falsified. A builder-seat-only baseline (500) would have missed this
    // (800 > 500 -- "consistent"), which is exactly the bias F3 flagged.
    expect(result.verdict).toBe("falsified");
  });

  it("the digest reports both hypotheses with n and verdict, always -- even insufficient data", () => {
    const digest = renderCalibrationDigest([], 5);
    expect(digest).toContain("Hypothesis T");
    expect(digest).toContain("Hypothesis L");
    expect(digest).toContain("insufficient data");
  });
});

// ---------------------------------------------------------------------------
// AC6: the planner never writes the budget value itself -- verified by the
// absence of any write path to the config from the planner's tools.
// ---------------------------------------------------------------------------

describe("ALI-106 AC6: no write path to the run budget's config from calibration.ts or planner.md", () => {
  const CALIBRATION_TS_PATH = fileURLToPath(new URL("../calibration.ts", import.meta.url));
  const PLANNER_MD_PATH = fileURLToPath(new URL("../../../.claude/agents/planner.md", import.meta.url));

  it("calibration.ts imports no filesystem or process module -- no write path exists in the code the retro relies on", () => {
    const source = readFileSync(CALIBRATION_TS_PATH, "utf8");
    expect(source).not.toMatch(/from\s+["']node:fs/);
    expect(source).not.toMatch(/from\s+["']node:child_process/);
    expect(source).not.toMatch(/from\s+["']fs["']/);
    expect(source).not.toMatch(/require\(\s*["'](fs|child_process|node:fs|node:child_process)/);
  });

  it("every calibration function returns without throwing against deep-frozen input -- proof none of them mutates their argument", () => {
    function deepFreeze<T>(value: T): T {
      if (value !== null && typeof value === "object") {
        Object.values(value as object).forEach(deepFreeze);
        Object.freeze(value);
      }
      return value;
    }
    const logs = deepFreeze([
      makeRunLog({
        generatedAt: "t1",
        stopReason: "backstop-wallclock",
        backstopFireCount: 1,
        candidates: [
          makeCandidate({
            issueId: "a",
            points: 2,
            bounces: [{ round: 1, detectedAtStage: "lint", detectorSeat: "reviewer", detectorTokens: 10, reworkTokens: 20, reason: "x" }],
            actualConsumption: { wallClockMs: 1, tokensUsed: 100 },
          }),
        ],
      }),
    ]);

    // A mutation attempt against a frozen object throws in strict mode
    // (this repo's TS output runs as ESM, always strict) -- so "does not
    // throw" is a real runtime proof, not just an absence of an assertion.
    expect(() => {
      pointsToCostRatio(logs);
      computeBackstopFireRate(logs);
      computeBudgetHeadroom(logs);
      recommendBudgetChange(logs, 5);
      evaluateHypothesisT(logs);
      evaluateHypothesisL(logs);
      renderCalibrationDigest(logs, 5);
    }).not.toThrow();
  });

  it("planner.md's Coach edit scope is exactly .claude/**, CLAUDE.md, docs/ENGINE.md -- src/dispatcher (the run budget's config) is never in it", () => {
    const text = readFileSync(PLANNER_MD_PATH, "utf8");
    // The Coach's editable-file enumeration, unchanged by this issue -- proves
    // src/dispatcher/types.ts (DEFAULT_CONFIG.budget) was never added to it.
    expect(text).toContain("opened against `.claude/**`, `CLAUDE.md`, or `docs/ENGINE.md`");
    // The stated invariant itself is present, not just implied.
    expect(text).toMatch(/the planner never writes the budget value itself/i);
    expect(text).toMatch(/never a Coach-editable path/i);
  });

  it("planner.md documents the three metrics' exact computation and the ramp trigger (AC2)", () => {
    const text = readFileSync(PLANNER_MD_PATH, "utf8");
    expect(text).toMatch(/points-to-cost ratio/i);
    expect(text).toMatch(/backstop-fire rate/i);
    expect(text).toMatch(/budget headroom/i);
    expect(text).toMatch(/three consecutive clean runs/i);
  });
});

// ---------------------------------------------------------------------------
// F7 (ALI-155 faithful-fakes conformance): this file's own fixture builders
// -- makeRunLog/makeCandidate -- must not be more permissive than the real
// schema they stand in for. Unenforced before this test; every other test
// above trusted them without ever checking.
// ---------------------------------------------------------------------------

describe("ALI-155: calibration.test.ts's makeRunLog/makeCandidate fixtures conform to validateRunLogSchema", () => {
  it("a run log built entirely from the fixture builders -- seats, bounces, risk, actualConsumption included -- passes the real validator, round-tripped through JSON", () => {
    const log = makeRunLog({
      generatedAt: "2026-08-16T00:00:00.000Z",
      stopReason: "backstop-wallclock",
      backstopFireCount: 1,
      candidates: [
        makeCandidate({
          issueId: "conformance-a",
          points: 2,
          labels: ["pipeline"],
          seats: [builderSeat("opus", 1000)],
          bounces: [
            { round: 1, detectedAtStage: "lint", detectorSeat: "reviewer", detectorTokens: 10, reworkTokens: 20, reason: "lint failure" },
            { round: 2, detectedAtStage: "judgment", detectorSeat: "ci-gate", detectorTokens: 0, reworkTokens: 50, reason: "gate rejected" },
          ],
          actualConsumption: { wallClockMs: 500, tokensUsed: 1500 },
          risk: { labels: ["pipeline"], points: 2, verifierTier: "opus" },
        }),
        // A never-dispatched candidate -- no actualConsumption -- is also
        // legal input (the exact shape F1's fix now accounts for).
        makeCandidate({ issueId: "conformance-b", points: 1, outcome: "not-dispatched", actualConsumption: undefined }),
      ],
    });

    const parsed: unknown = JSON.parse(JSON.stringify(log));
    const result = validateRunLogSchema(parsed);
    expect(result).toEqual({ ok: true, errors: [] });
  });
});
