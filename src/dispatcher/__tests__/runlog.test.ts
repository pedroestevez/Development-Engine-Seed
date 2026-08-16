/**
 * ALI-106 AC1: the amended run-log schema, tested at the `runlog.ts` module
 * boundary -- `validateRunLogSchema` (AC1.1's "a test validates a written
 * log against the schema") and `deriveVerifierTier` (AC1.4's helper) as
 * pure units, independent of the full dispatch pipeline `run.test.ts`
 * exercises them through.
 */

import { describe, expect, it } from "vitest";

import {
  deriveVerifierTier,
  serializeRunLog,
  validateRunLogSchema,
  type BounceRecord,
  type CandidateLogEntry,
  type RunLog,
  type SeatOutcome,
} from "../runlog.js";
import type { IssueTierResult } from "../types.js";

// ---------------------------------------------------------------------------
// A minimal, well-formed candidate/run log -- the positive fixture every
// "breaks one field" test below mutates a copy of.
// ---------------------------------------------------------------------------

const TIER: IssueTierResult = { issueId: "well-formed", pointsTier: "sonnet", riskTier: "none", tier: "sonnet" };

const SEATS: SeatOutcome[] = [
  { seat: "builder", status: "ran", detail: "ok", model: "sonnet", effort: "standard", tokens: 100, wallClockMs: 50 },
  { seat: "blindQa", status: "ran", detail: "1 test file(s) written", model: "sonnet", effort: "standard", tokens: 20, wallClockMs: 10 },
  { seat: "reviewer", status: "ran", detail: "ok", model: "sonnet", effort: "standard", tokens: 80, wallClockMs: 40 },
  { seat: "security", status: "skipped (not applicable)" },
];

const BOUNCES: BounceRecord[] = [
  { round: 1, detectedAtStage: "lint", detectorSeat: "reviewer", detectorTokens: 30, reworkTokens: 90, reason: "lint failure" },
];

function wellFormedCandidate(): CandidateLogEntry {
  return {
    issueId: "well-formed",
    points: 2,
    labels: [],
    weightedCost: 2,
    verdict: "admitted",
    tier: TIER,
    seats: SEATS,
    bounces: BOUNCES,
    outcome: "opened-pr",
    estimatedConsumption: { weightedCost: 2 },
    actualConsumption: { wallClockMs: 100, tokensUsed: 200 },
    risk: { labels: [], points: 2, verifierTier: "sonnet" },
  };
}

function wellFormedRunLog(): RunLog {
  return {
    engineSha: "abc1234",
    cycleId: "cycle-1",
    approvalRef: "tg-msg-1",
    generatedAt: "2026-08-16T00:00:00.000Z",
    candidates: [wellFormedCandidate()],
    budget: { total: 5, consumed: 2, remaining: 3 },
    clusters: [{ index: 0, issueIds: ["well-formed"], sharedResources: [] }],
    laneCount: 1,
    stopReason: "cycle-empty",
    backstopFireCount: 0,
    credentials: { linear: "[REDACTED]", github: "[NOT SET]" },
  };
}

describe("ALI-106 AC1.1: validateRunLogSchema accepts a well-formed amended run log", () => {
  it("passes a well-formed log, including seats[]/bounces[]/risk", () => {
    const result = validateRunLogSchema(wellFormedRunLog());
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it("passes the log round-tripped through serializeRunLog -> JSON.parse -- the actual on-disk shape, not just the compile-time type", () => {
    const json = serializeRunLog(wellFormedRunLog());
    const parsed: unknown = JSON.parse(json);
    const result = validateRunLogSchema(parsed);
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it("passes a log with an empty candidates array", () => {
    const log = wellFormedRunLog();
    log.candidates = [];
    expect(validateRunLogSchema(log)).toEqual({ ok: true, errors: [] });
  });

  it("passes a candidate whose seats never ran (model/effort/tokens/wallClockMs all undefined)", () => {
    const log = wellFormedRunLog();
    log.candidates[0]!.seats = [{ seat: "builder", status: "skipped (not applicable)" }];
    log.candidates[0]!.bounces = [];
    expect(validateRunLogSchema(log)).toEqual({ ok: true, errors: [] });
  });

  it("accepts a bounce whose detectorSeat is 'ci-gate' -- a CI-gate-detected rejection, not a seat's own dispatch call (F6, bounce round 1)", () => {
    const log = wellFormedRunLog();
    log.candidates[0]!.bounces = [
      { round: 1, detectedAtStage: "judgment", detectorSeat: "ci-gate", detectorTokens: 0, reworkTokens: 50, reason: "CI gate rejected: lint check failed" },
    ];
    expect(validateRunLogSchema(log)).toEqual({ ok: true, errors: [] });
  });
});

describe("ALI-106 AC1.1: validateRunLogSchema rejects a log that regresses to the pre-amendment shape", () => {
  it("rejects bounces as a bare count (the exact regression AC1.2 forbids)", () => {
    const log = wellFormedRunLog();
    // @ts-expect-error -- deliberately regressing to the pre-amendment shape to prove the validator catches it.
    log.candidates[0]!.bounces = 3;
    const result = validateRunLogSchema(log);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("bounces") && e.includes("structured"))).toBe(true);
  });

  it("rejects a candidate with no risk field at all", () => {
    const log = wellFormedRunLog();
    const candidate = log.candidates[0] as unknown as Record<string, unknown>;
    delete candidate.risk;
    const result = validateRunLogSchema(log);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.startsWith("candidates[0].risk"))).toBe(true);
  });

  it("rejects risk.verifierTier holding a value outside ModelTier | 'none'", () => {
    const log = wellFormedRunLog();
    // @ts-expect-error -- deliberately invalid verifierTier value.
    log.candidates[0]!.risk.verifierTier = "gpt-5";
    const result = validateRunLogSchema(log);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("verifierTier"))).toBe(true);
  });

  it("rejects a bounce record missing detectedAtStage", () => {
    const log = wellFormedRunLog();
    const bounce = log.candidates[0]!.bounces[0] as unknown as Record<string, unknown>;
    delete bounce.detectedAtStage;
    const result = validateRunLogSchema(log);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("detectedAtStage"))).toBe(true);
  });

  it("still rejects a bounce detectorSeat outside SeatName | 'ci-gate' (F6)", () => {
    const log = wellFormedRunLog();
    const bounce = log.candidates[0]!.bounces[0] as unknown as Record<string, unknown>;
    bounce.detectorSeat = "not-a-real-detector";
    const result = validateRunLogSchema(log);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("detectorSeat"))).toBe(true);
  });

  it("rejects a seat outcome with an unrecognized model value", () => {
    const log = wellFormedRunLog();
    const seat = log.candidates[0]!.seats[0] as unknown as Record<string, unknown>;
    seat.model = "not-a-real-tier";
    const result = validateRunLogSchema(log);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("seats[0].model"))).toBe(true);
  });

  it("reports every problem in one pass, not just the first", () => {
    const log = wellFormedRunLog();
    const candidate = log.candidates[0] as unknown as Record<string, unknown>;
    candidate.bounces = 3; // regression #1
    delete candidate.risk; // regression #2
    const result = validateRunLogSchema(log);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects a non-object input outright", () => {
    expect(validateRunLogSchema(null).ok).toBe(false);
    expect(validateRunLogSchema("a string").ok).toBe(false);
    expect(validateRunLogSchema(42).ok).toBe(false);
  });
});

describe("ALI-106 AC1.4: deriveVerifierTier", () => {
  it("takes the higher of reviewer and security when both ran and reported a model", () => {
    const seats: SeatOutcome[] = [
      { seat: "reviewer", status: "ran", model: "sonnet" },
      { seat: "security", status: "ran", model: "opus" },
    ];
    expect(deriveVerifierTier(seats)).toBe("opus");
  });

  it("ignores the builder and blindQa seats entirely -- only reviewer/security count as verification", () => {
    const seats: SeatOutcome[] = [
      { seat: "builder", status: "ran", model: "opus" },
      { seat: "blindQa", status: "ran", model: "opus" },
      { seat: "reviewer", status: "ran", model: "haiku" },
    ];
    expect(deriveVerifierTier(seats)).toBe("haiku");
  });

  it("a skipped security seat contributes nothing, even if it somehow carried a model value", () => {
    const seats: SeatOutcome[] = [
      { seat: "reviewer", status: "ran", model: "sonnet" },
      { seat: "security", status: "skipped (not applicable)" },
    ];
    expect(deriveVerifierTier(seats)).toBe("sonnet");
  });

  it("is 'none' when no verifying seat ran, or ran but reported no model", () => {
    expect(deriveVerifierTier([])).toBe("none");
    expect(deriveVerifierTier([{ seat: "reviewer", status: "skipped (not applicable)" }])).toBe("none");
    expect(deriveVerifierTier([{ seat: "reviewer", status: "ran" }])).toBe("none");
  });
});
