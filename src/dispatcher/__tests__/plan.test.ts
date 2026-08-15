import { describe, expect, it } from "vitest";
import { admit, hasDangerLabel, laneCount, modelTier, partition, plan, weightedCost } from "../plan.js";
import { DEFAULT_CONFIG, type Cluster, type DispatcherConfig, type Issue } from "../types.js";

/** Build a fully-populated Issue, defaulting every field the test doesn't care about. */
function makeIssue(id: string, points: number, extra: Partial<Issue> = {}): Issue {
  return {
    id,
    title: extra.title ?? `Issue ${id}`,
    points,
    priority: extra.priority ?? 100,
    labels: extra.labels ?? [],
    blockedBy: extra.blockedBy ?? [],
    predictedFiles: extra.predictedFiles ?? [],
    ...(extra.state !== undefined ? { state: extra.state } : {}),
  };
}

const BUDGET_5: DispatcherConfig = DEFAULT_CONFIG; // { budget: 5, riskWeight: 2.0, maxConcurrency: 4 }

// ---------------------------------------------------------------------------
// AC1 — plan() is a pure function
// ---------------------------------------------------------------------------

describe("AC1: plan() is pure — same input produces identical output", () => {
  it("calling plan() twice on the same input deep-equals both times", () => {
    const issues: Issue[] = [
      makeIssue("a", 3, { priority: 1, predictedFiles: ["src/a.ts"] }),
      makeIssue("b", 2, {
        priority: 2,
        labels: ["migration"],
        predictedFiles: ["migrations/0001.sql"],
      }),
      makeIssue("c", 2, {
        priority: 3,
        labels: ["migration"],
        predictedFiles: ["migrations/0002.sql"],
      }),
      makeIssue("d", 1, { priority: 4, labels: ["payments"], predictedFiles: ["src/pay.ts"] }),
      makeIssue("e", 5, { priority: 5, blockedBy: ["a"], predictedFiles: ["src/e.ts"] }),
    ];

    const first = plan(issues, BUDGET_5);
    const second = plan(issues, BUDGET_5);

    expect(second).toEqual(first);
    // Also guard against the input itself being mutated between calls.
    expect(issues).toEqual([
      makeIssue("a", 3, { priority: 1, predictedFiles: ["src/a.ts"] }),
      makeIssue("b", 2, {
        priority: 2,
        labels: ["migration"],
        predictedFiles: ["migrations/0001.sql"],
      }),
      makeIssue("c", 2, {
        priority: 3,
        labels: ["migration"],
        predictedFiles: ["migrations/0002.sql"],
      }),
      makeIssue("d", 1, { priority: 4, labels: ["payments"], predictedFiles: ["src/pay.ts"] }),
      makeIssue("e", 5, { priority: 5, blockedBy: ["a"], predictedFiles: ["src/e.ts"] }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// AC2 — budget admission, continue-past-refusal
// ---------------------------------------------------------------------------

describe("AC2: budget admission continues past a refused issue", () => {
  it("costs 3, 4, 1, 10, 2 @ budget 5 admits {3, 1}; 10 is exceeds-budget-must-split; 4 and 2 are budget", () => {
    const issues: Issue[] = [
      makeIssue("cost-3", 3, { priority: 1 }),
      makeIssue("cost-4", 4, { priority: 2 }),
      makeIssue("cost-1", 1, { priority: 3 }),
      makeIssue("cost-10", 10, { priority: 4 }),
      makeIssue("cost-2", 2, { priority: 5 }),
    ];

    const { admitted, deferred } = admit(issues, BUDGET_5);

    expect(admitted.map((i) => i.id).sort()).toEqual(["cost-1", "cost-3"]);

    const reasonById = Object.fromEntries(deferred.map((d) => [d.issue.id, d.reason]));
    expect(reasonById).toEqual({
      "cost-4": "budget",
      "cost-10": "exceeds-budget-must-split",
      "cost-2": "budget",
    });
  });
});

// ---------------------------------------------------------------------------
// AC3 — risk weight
// ---------------------------------------------------------------------------

describe("AC3: risk weight prices and can refuse a labeled issue", () => {
  it("a 3-point payments issue has weightedCost 6 and is refused at budget 5", () => {
    const paymentsIssue = makeIssue("pay-3", 3, { labels: ["payments"] });

    expect(weightedCost(paymentsIssue, BUDGET_5)).toBe(6);

    const { admitted, deferred } = admit([paymentsIssue], BUDGET_5);
    expect(admitted).toEqual([]);
    expect(deferred).toEqual([{ issue: paymentsIssue, reason: "exceeds-budget-must-split" }]);
  });

  it("the same issue without the label has weightedCost 3 and is admitted", () => {
    const plainIssue = makeIssue("plain-3", 3, { labels: [] });

    expect(weightedCost(plainIssue, BUDGET_5)).toBe(3);

    const { admitted, deferred } = admit([plainIssue], BUDGET_5);
    expect(admitted).toEqual([plainIssue]);
    expect(deferred).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC4 — migration serialization
// ---------------------------------------------------------------------------

describe("AC4: migration serialization", () => {
  it("two migration issues with completely disjoint predicted files land in the same cluster", () => {
    const migrationA = makeIssue("mig-a", 1, {
      priority: 1,
      labels: ["migration"],
      predictedFiles: ["migrations/0001_customers.sql"],
    });
    const migrationB = makeIssue("mig-b", 1, {
      priority: 2,
      labels: ["migration"],
      predictedFiles: ["migrations/0002_bookings.sql"],
    });

    // Sanity: the files genuinely don't overlap, so only the migration rule
    // (not the file-intersection rule) can be responsible for clustering.
    expect(migrationA.predictedFiles).not.toEqual(
      expect.arrayContaining(migrationB.predictedFiles),
    );

    const { admitted } = admit([migrationA, migrationB], BUDGET_5);
    const clusters = partition(admitted);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].map((i) => i.id).sort()).toEqual(["mig-a", "mig-b"]);
  });
});

// ---------------------------------------------------------------------------
// AC5 — dependency clustering
// ---------------------------------------------------------------------------

describe("AC5: dependency clustering", () => {
  it("two issues with disjoint files but a blocked-by edge land in the same cluster, in dependency order", () => {
    const blocker = makeIssue("blocker", 1, { priority: 1, predictedFiles: ["src/table.ts"] });
    const dependent = makeIssue("dependent", 1, {
      priority: 2,
      blockedBy: ["blocker"],
      predictedFiles: ["src/query.ts"],
    });

    expect(blocker.predictedFiles).not.toEqual(expect.arrayContaining(dependent.predictedFiles));

    const { admitted } = admit([blocker, dependent], BUDGET_5);
    const clusters = partition(admitted);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].map((i) => i.id)).toEqual(["blocker", "dependent"]);
  });
});

// ---------------------------------------------------------------------------
// AC6 — lane count
// ---------------------------------------------------------------------------

describe("AC6: lane count caps at maxConcurrency", () => {
  it("three disjoint clusters with maxConcurrency: 2 gives laneCount === 2", () => {
    const clusters: Cluster[] = [
      [makeIssue("x", 1)],
      [makeIssue("y", 1)],
      [makeIssue("z", 1)],
    ];

    expect(laneCount(clusters, 2)).toBe(2);
  });

  it("does not exceed the number of actual clusters when concurrency headroom is larger", () => {
    const clusters: Cluster[] = [[makeIssue("x", 1)], [makeIssue("y", 1)]];
    expect(laneCount(clusters, 4)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AC7 — model tier: risk floors up, both inputs recorded
// ---------------------------------------------------------------------------

describe("AC7: model tier floors up on risk, recording both inputs", () => {
  it("a 1-point payments issue routes to opus, not haiku", () => {
    const issue = makeIssue("small-risky", 1, { labels: ["payments"] });

    const tier = modelTier(issue);

    expect(tier).toEqual({
      issueId: "small-risky",
      pointsTier: "haiku",
      riskTier: "opus",
      tier: "opus",
    });
  });

  it("the RunPlan carries pointsTier and riskTier alongside the final tier for every input issue", () => {
    const risky = makeIssue("small-risky", 1, { labels: ["payments"] });
    const plain = makeIssue("small-plain", 1, { priority: 2 });

    const result = plan([risky, plain], BUDGET_5);

    expect(result.tiers).toEqual([
      { issueId: "small-risky", pointsTier: "haiku", riskTier: "opus", tier: "opus" },
      { issueId: "small-plain", pointsTier: "haiku", riskTier: "none", tier: "haiku" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// AC8 — no silent drop, exactly one reason each
// ---------------------------------------------------------------------------

describe("AC8: no issue is silently dropped", () => {
  it("every deferred issue carries exactly one reason from the enumerated set", () => {
    const issues: Issue[] = [
      makeIssue("admit-1", 3, { priority: 1 }),
      makeIssue("budget-1", 4, { priority: 2 }),
      makeIssue("admit-2", 1, { priority: 3 }),
      makeIssue("too-big", 10, { priority: 4 }),
      makeIssue("budget-2", 2, { priority: 5 }),
    ];

    const { admitted, deferred } = admit(issues, BUDGET_5);
    const validReasons = new Set(["budget", "dependency", "exceeds-budget-must-split", "cluster-conflict"]);

    for (const d of deferred) {
      expect(validReasons.has(d.reason)).toBe(true);
    }
  });

  it("admitted.length + deferred.length === input.length", () => {
    const issues: Issue[] = [
      makeIssue("admit-1", 3, { priority: 1 }),
      makeIssue("budget-1", 4, { priority: 2 }),
      makeIssue("admit-2", 1, { priority: 3 }),
      makeIssue("too-big", 10, { priority: 4 }),
      makeIssue("budget-2", 2, { priority: 5 }),
    ];

    const { admitted, deferred } = admit(issues, BUDGET_5);

    expect(admitted.length + deferred.length).toBe(issues.length);
  });
});

// ---------------------------------------------------------------------------
// Invariants (property-style over several fixtures)
// ---------------------------------------------------------------------------

const FIXTURES: { name: string; issues: Issue[]; config: DispatcherConfig }[] = [
  {
    name: "empty input",
    issues: [],
    config: BUDGET_5,
  },
  {
    name: "single issue over budget",
    issues: [makeIssue("solo", 20, { labels: ["critical"] })],
    config: BUDGET_5,
  },
  {
    name: "mixed labels, priorities, and a dependency chain",
    issues: [
      makeIssue("a", 3, { priority: 1, predictedFiles: ["src/a.ts"] }),
      makeIssue("b", 4, { priority: 2, labels: ["external-api"] }),
      makeIssue("c", 1, { priority: 3, blockedBy: ["b"] }),
      makeIssue("d", 10, { priority: 4 }),
      makeIssue("e", 2, { priority: 5, labels: ["migration"], predictedFiles: ["migrations/1.sql"] }),
      makeIssue("f", 2, { priority: 6, labels: ["migration"], predictedFiles: ["migrations/2.sql"] }),
      makeIssue("g", 1, { priority: 7, blockedBy: ["not-in-this-run"] }),
    ],
    config: BUDGET_5,
  },
  {
    name: "tighter budget, larger maxConcurrency",
    issues: [
      makeIssue("p1", 2, { priority: 1 }),
      makeIssue("p2", 2, { priority: 2 }),
      makeIssue("p3", 2, { priority: 3 }),
      makeIssue("p4", 2, { priority: 4 }),
    ],
    config: { budget: 3, riskWeight: 2.0, maxConcurrency: 10 },
  },
];

describe("Invariant: sum(weightedCost of admitted) <= budget", () => {
  for (const { name, issues, config } of FIXTURES) {
    it(`holds for fixture: ${name}`, () => {
      const { admitted } = admit(issues, config);
      const total = admitted.reduce((sum, i) => sum + weightedCost(i, config), 0);
      expect(total).toBeLessThanOrEqual(config.budget);
    });
  }
});

describe("Invariant: every input issue appears in exactly one of admitted ∪ deferred", () => {
  for (const { name, issues, config } of FIXTURES) {
    it(`holds for fixture: ${name}`, () => {
      const { admitted, deferred } = admit(issues, config);
      const outputIds = [...admitted.map((i) => i.id), ...deferred.map((d) => d.issue.id)];

      expect(outputIds.sort()).toEqual(issues.map((i) => i.id).sort());
      // "exactly one" — no id appears twice across the two collections.
      expect(new Set(outputIds).size).toBe(outputIds.length);
    });
  }
});

describe("Invariant: every deferred entry carries exactly one enumerated reason", () => {
  const validReasons = new Set(["budget", "dependency", "exceeds-budget-must-split", "cluster-conflict"]);

  for (const { name, issues, config } of FIXTURES) {
    it(`holds for fixture: ${name}`, () => {
      const { deferred } = admit(issues, config);
      for (const d of deferred) {
        expect(validReasons.has(d.reason)).toBe(true);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Supplementary coverage (beyond the 8 named ACs)
// ---------------------------------------------------------------------------

describe("supplementary: hasDangerLabel matches the full danger list", () => {
  const cases: [string, boolean][] = [
    ["payments", true],
    ["auth", true],
    ["data", true],
    ["rls", true],
    ["migration", true],
    ["external-api", true],
    ["critical", true],
    ["pipeline", false],
    ["infra", false],
  ];

  it.each(cases)("label %s -> danger=%s", (label, expected) => {
    expect(hasDangerLabel([label])).toBe(expected);
  });
});

describe("supplementary: an issue whose in-run blocker was refused is deferred as 'dependency'", () => {
  it("defers the dependent even though its own cost would otherwise fit", () => {
    // "expensive" consumes the whole budget, so "blocker" is refused (budget).
    const expensive = makeIssue("expensive", 5, { priority: 1 });
    const blocker = makeIssue("blocker", 4, { priority: 2 });
    const dependent = makeIssue("dependent", 1, { priority: 3, blockedBy: ["blocker"] });

    const { admitted, deferred } = admit([expensive, blocker, dependent], BUDGET_5);

    expect(admitted.map((i) => i.id)).toEqual(["expensive"]);
    const reasonById = Object.fromEntries(deferred.map((d) => [d.issue.id, d.reason]));
    expect(reasonById).toEqual({ blocker: "budget", dependent: "dependency" });
  });

  it("a blockedBy id outside the input set is treated as already resolved", () => {
    const issue = makeIssue("free-to-run", 1, { blockedBy: ["already-done-elsewhere"] });
    const { admitted, deferred } = admit([issue], BUDGET_5);
    expect(admitted).toEqual([issue]);
    expect(deferred).toEqual([]);
  });
});

describe("supplementary: partition rules compose (predicted-files intersection)", () => {
  it("two issues that touch the same file land in the same cluster", () => {
    const a = makeIssue("a", 1, { priority: 1, predictedFiles: ["src/shared.ts"] });
    const b = makeIssue("b", 1, { priority: 2, predictedFiles: ["src/shared.ts", "src/only-b.ts"] });
    const c = makeIssue("c", 1, { priority: 3, predictedFiles: ["src/unrelated.ts"] });

    const clusters = partition([a, b, c]);

    expect(clusters).toHaveLength(2);
    const clusterOfA = clusters.find((cluster) => cluster.some((i) => i.id === "a"))!;
    expect(clusterOfA.map((i) => i.id).sort()).toEqual(["a", "b"]);
  });
});
