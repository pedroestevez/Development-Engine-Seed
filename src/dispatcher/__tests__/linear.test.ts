/**
 * ALI-158 — real `LinearPort` adapter, read half.
 *
 * Covers AC1–AC9. Two kinds of double appear here and the difference is
 * load-bearing:
 *
 *   - **The faithful fake** (`defineFakeWorld` + `createFakeLinear`) models
 *     Linear, including its hard rejections (ALI-155, AC7). It applies the
 *     GraphQL filter itself, so a test that passes through it proves the
 *     adapter *asked the right question*.
 *   - **Hostile transports** (`respondWith`) answer with rows the filter
 *     should have excluded. They prove the adapter's own client-side gate
 *     (AC2) — the half that survives a broadened filter, a proxy, or a future
 *     schema change. A fake alone cannot prove that: it would be testing the
 *     fake's filter, not the adapter's.
 *
 * AC9's live contract test runs only when ALI-157's credential is present and
 * otherwise emits a visible skip naming the missing variable. It never
 * silently passes.
 */

import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import {
  checkStatusDrift,
  createLinearApiPort,
  LinearApiError,
  LINEAR_API_KEY_ENV,
  LINEAR_API_URL,
  LINEAR_TEAM_ID_ENV,
  mapIssueNode,
  parsePredictedFiles,
  PREDICTED_FILES_HEADING,
  READY_STATE_NAME,
  statusDriftMessage,
  type FetchLike,
  type HttpResponseLike,
  type LinearApiConfig,
} from "../linear.js";
import { containsSecretLike } from "../runlog.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEAM_ID = "f93d2168-cb76-433d-8d7e-8401916d05dc";
const CYCLE_ID = "10f69628-b875-4565-b465-381403a874a6";
const OTHER_CYCLE_ID = "22222222-2222-4222-8222-222222222222";
const UNKNOWN_CYCLE_ID = "99999999-9999-4999-8999-999999999999";
const FAKE_ENDPOINT = "https://fake.linear.test/graphql";

/**
 * A dummy credential shaped like a real one — the `lin_api_` prefix is what
 * `scrubSecrets()`/`containsSecretLike()` (runlog.ts) key on, so a test key
 * without it would prove nothing about AC6.
 */
const DUMMY_API_KEY = "lin_api_TESTKEY0123456789";

/** The board's real status names (docs/ENGINE.md §3) plus Linear's defaults. */
const BOARD_STATES = ["Backlog", "Ready", "In Progress", "In Review", "Done", "Parked", "Needs Pedro"];

function issueBody(files: string, extra = ""): string {
  return [
    "## Why",
    "",
    "Fixture reasoning.",
    "",
    "## Acceptance criteria",
    "",
    "1. Something verifiable.",
    "",
    extra,
    `## ${PREDICTED_FILES_HEADING}`,
    "",
    files,
    "",
    "## Reversibility class",
    "",
    "`none`",
    "",
  ].join("\n");
}

const READY_BODY = issueBody("`src/dispatcher/linear.ts` · `src/dispatcher/__tests__/linear.test.ts` (new)");

// ---------------------------------------------------------------------------
// The faithful fake Linear (ALI-155 / AC7)
//
// It models the real system's constraints, not just its happy path:
//
//   1. A team's workflow states are a CLOSED set. An issue cannot be in a
//      state its team does not define — real Linear rejects `issueCreate` /
//      `issueUpdate` carrying a `stateId` from another team's workflow. The
//      fake therefore refuses to build a world containing such an issue.
//   2. `Query.cycle(id: String!): Cycle!` and `Query.team(id: String!): Team!`
//      are NON-NULL in Linear's schema (verified against the published SDK
//      schema — see linear.ts's evidence block). An id Linear cannot resolve
//      cannot come back as `null`, so it comes back as a GraphQL error. The
//      fake errors too.
//   3. GraphQL input objects reject unknown fields. A filter key the schema
//      does not define is a validation error, never a silently ignored one —
//      so a typo in the adapter's filter fails here instead of quietly
//      matching every issue in the workspace.
//   4. Missing/incorrect credentials are rejected before any data is served.
//
// Where the fake is deliberately NOT strict: filtering by a workflow-state
// name the team does not define returns ZERO ROWS, exactly as real Linear
// does. That silence is precisely why `checkStatusDrift()` exists ("a missing
// status is never the same thing as an empty cycle") and modelling it as an
// error here would hide the behaviour the drift check is built to catch.
// ---------------------------------------------------------------------------

interface FakeIssue {
  identifier: string;
  title: string;
  estimate: number | null;
  priority: number;
  description: string | null;
  stateName: string;
  cycleId: string | null;
  teamId: string;
  labels: string[];
  /** Identifiers of issues that block this one (served via `inverseRelations`). */
  blockedBy: string[];
}

interface FakeWorld {
  teamId: string;
  apiKey: string;
  states: string[];
  cycleIds: string[];
  issues: FakeIssue[];
}

function fakeIssue(overrides: Partial<FakeIssue> & { identifier: string }): FakeIssue {
  return {
    title: `${overrides.identifier} title`,
    estimate: 2,
    priority: 2,
    description: READY_BODY,
    stateName: READY_STATE_NAME,
    cycleId: CYCLE_ID,
    teamId: TEAM_ID,
    labels: [],
    blockedBy: [],
    ...overrides,
  };
}

/** Hard-rejection #1 and its sibling: a world that could not exist in Linear is refused at build time. */
function defineFakeWorld(world: Partial<FakeWorld> = {}): FakeWorld {
  const built: FakeWorld = {
    teamId: TEAM_ID,
    apiKey: DUMMY_API_KEY,
    states: BOARD_STATES,
    cycleIds: [CYCLE_ID, OTHER_CYCLE_ID],
    issues: [],
    ...world,
  };

  for (const issue of built.issues) {
    if (!built.states.includes(issue.stateName)) {
      throw new Error(
        `fake Linear rejects ${issue.identifier}: "${issue.stateName}" is not a workflow state on team ` +
          `${built.teamId} (states: ${built.states.join(", ")}). A team's workflow states are a closed set.`,
      );
    }
    if (issue.cycleId !== null && !built.cycleIds.includes(issue.cycleId)) {
      throw new Error(
        `fake Linear rejects ${issue.identifier}: cycle ${issue.cycleId} does not exist on team ${built.teamId}.`,
      );
    }
  }
  return built;
}

interface RecordedCall {
  authorization: string | undefined;
  query: string;
  variables: Record<string, unknown>;
}

function jsonResponse(status: number, payload: unknown, headers: Record<string, string> = {}): HttpResponseLike {
  const body = JSON.stringify(payload);
  const lowered = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null },
    text: async () => body,
  };
}

function graphqlErrors(messages: string[]): HttpResponseLike {
  return jsonResponse(200, { data: null, errors: messages.map((message) => ({ message })) });
}

function issueNode(issue: FakeIssue, nestedPageSize = 50): Record<string, unknown> {
  return {
    identifier: issue.identifier,
    title: issue.title,
    estimate: issue.estimate,
    priority: issue.priority,
    description: issue.description,
    state: { name: issue.stateName },
    cycle: issue.cycleId === null ? null : { id: issue.cycleId },
    team: { id: issue.teamId },
    // Real Linear always returns `pageInfo` on a connection (it is non-null in
    // the schema), so the faithful fake does too — and reports truncation
    // honestly when the world holds more rows than the page asked for.
    labels: {
      nodes: issue.labels.slice(0, nestedPageSize).map((name) => ({ name })),
      pageInfo: { hasNextPage: issue.labels.length > nestedPageSize },
    },
    inverseRelations: {
      nodes: issue.blockedBy
        .slice(0, nestedPageSize)
        .map((blocker) => ({ type: "blocks", issue: { identifier: blocker } })),
      pageInfo: { hasNextPage: issue.blockedBy.length > nestedPageSize },
    },
  };
}

/** Reads `{ eq: "..." }`, rejecting any comparator the adapter has no business sending. */
function readEqComparator(value: unknown, path: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const keys = Object.keys(value as Record<string, unknown>);
  const unknown = keys.filter((key) => key !== "eq");
  if (unknown.length > 0) {
    throw new Error(`Field '${unknown[0]}' is not defined by type '${path}'.`);
  }
  const eq = (value as Record<string, unknown>).eq;
  return typeof eq === "string" ? eq : null;
}

function createFakeLinear(world: FakeWorld): { fetchImpl: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];

  const fetchImpl: FetchLike = async (url, init) => {
    if (url !== FAKE_ENDPOINT) return jsonResponse(404, { message: "Not found" });
    if (init.method !== "POST") return jsonResponse(405, { message: "Method not allowed" });

    const authorization = init.headers.Authorization;
    if (authorization === undefined || authorization.trim() === "") {
      return jsonResponse(400, { data: null, errors: [{ message: "Authentication required, not authenticated" }] });
    }
    if (authorization !== world.apiKey) {
      return jsonResponse(401, { data: null, errors: [{ message: "Invalid API key" }] });
    }
    // Real Linear rejects an OAuth-style prefix on a personal API key.
    if (authorization.startsWith("Bearer ")) {
      return jsonResponse(401, { data: null, errors: [{ message: "Invalid authorization header" }] });
    }

    const parsed = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
    calls.push({ authorization, query: parsed.query, variables: parsed.variables });
    const { query, variables } = parsed;

    if (query.includes("DispatcherWorkflowStates")) {
      if (variables.teamId !== world.teamId) {
        // Non-null `Query.team` ⇒ an unresolvable id is an error, never null.
        return graphqlErrors([`Entity not found: Team - could not find referenced Team.`]);
      }
      const first = typeof variables.first === "number" ? variables.first : 50;
      const start = typeof variables.after === "string" ? Number.parseInt(variables.after, 10) : 0;
      const page = world.states.slice(start, start + first);
      const nextIndex = start + page.length;
      return jsonResponse(200, {
        data: {
          team: {
            states: {
              nodes: page.map((name) => ({ name })),
              pageInfo: {
                hasNextPage: nextIndex < world.states.length,
                endCursor: nextIndex < world.states.length ? String(nextIndex) : null,
              },
            },
          },
        },
      });
    }

    if (query.includes("DispatcherReadyIssues")) {
      const cycleId = variables.cycleId;
      if (typeof cycleId !== "string" || !world.cycleIds.includes(cycleId)) {
        // Hard rejection #2: non-null `Query.cycle` ⇒ error, not zero rows.
        return graphqlErrors([`Entity not found: Cycle - could not find referenced Cycle.`]);
      }

      const filter = (variables.filter ?? {}) as Record<string, unknown>;
      const unknownKeys = Object.keys(filter).filter((key) => !["team", "cycle", "state"].includes(key));
      if (unknownKeys.length > 0) {
        return graphqlErrors([`Field '${unknownKeys[0]}' is not defined by type 'IssueFilter'.`]);
      }

      let wantTeam: string | null;
      let wantCycle: string | null;
      let wantState: string | null;
      try {
        wantTeam = readEqComparator((filter.team as Record<string, unknown> | undefined)?.id, "IDComparator");
        wantCycle = readEqComparator((filter.cycle as Record<string, unknown> | undefined)?.id, "IDComparator");
        wantState = readEqComparator(
          (filter.state as Record<string, unknown> | undefined)?.name,
          "StringComparator",
        );
      } catch (error) {
        return graphqlErrors([(error as Error).message]);
      }

      const matching = world.issues.filter((issue) => {
        if (wantTeam !== null && issue.teamId !== wantTeam) return false;
        if (wantCycle !== null && issue.cycleId !== wantCycle) return false;
        // An unknown state NAME simply matches nothing — real Linear's
        // behaviour, and the reason checkStatusDrift() exists.
        if (wantState !== null && issue.stateName !== wantState) return false;
        return true;
      });

      const first = typeof variables.first === "number" ? variables.first : 50;
      const start = typeof variables.after === "string" ? Number.parseInt(variables.after, 10) : 0;
      const page = matching.slice(start, start + first);
      const nextIndex = start + page.length;
      return jsonResponse(200, {
        data: {
          cycle: { id: cycleId },
          issues: {
            nodes: page.map((issue) => issueNode(issue)),
            pageInfo: {
              hasNextPage: nextIndex < matching.length,
              endCursor: nextIndex < matching.length ? String(nextIndex) : null,
            },
          },
        },
      });
    }

    return graphqlErrors(["Cannot query field on type 'Query'."]);
  };

  return { fetchImpl, calls };
}

/** A transport that answers every request with one canned response — used for the hostile cases. */
function respondWith(...responses: HttpResponseLike[]): { fetchImpl: FetchLike; count: () => number } {
  let index = 0;
  return {
    fetchImpl: async () => {
      const response = responses[Math.min(index, responses.length - 1)];
      index++;
      return response;
    },
    count: () => index,
  };
}

function portFor(world: FakeWorld, overrides: Partial<LinearApiConfig> = {}) {
  const { fetchImpl, calls } = createFakeLinear(world);
  const port = createLinearApiPort({
    apiKey: world.apiKey,
    teamId: world.teamId,
    endpoint: FAKE_ENDPOINT,
    fetchImpl,
    sleep: async () => {},
    ...overrides,
  });
  return { port, calls };
}

/** Rewrites `first` on the way through, so pagination can be forced without a giant fixture. */
function withPageSize(inner: FetchLike, first: number): FetchLike {
  return async (url, init) => {
    const body = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
    const rewritten = JSON.stringify({ ...body, variables: { ...body.variables, first } });
    return inner(url, { ...init, body: rewritten });
  };
}

function portWithTransport(fetchImpl: FetchLike, overrides: Partial<LinearApiConfig> = {}) {
  return createLinearApiPort({
    apiKey: DUMMY_API_KEY,
    teamId: TEAM_ID,
    endpoint: FAKE_ENDPOINT,
    fetchImpl,
    sleep: async () => {},
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// AC1 — getWorkflowStatuses() and the drift check
// ---------------------------------------------------------------------------

describe("AC1: getWorkflowStatuses() returns the team's workflow-state names", () => {
  it("returns every state name, in board order", async () => {
    const { port, calls } = portFor(defineFakeWorld());
    await expect(port.getWorkflowStatuses()).resolves.toEqual(BOARD_STATES);
    expect(calls).toHaveLength(1);
    expect(calls[0].variables.teamId).toBe(TEAM_ID);
  });

  it("a board carrying Ready/Parked/Needs Pedro makes checkStatusDrift() pass", async () => {
    const { port } = portFor(defineFakeWorld());
    const drift = checkStatusDrift(await port.getWorkflowStatuses());
    expect(drift).toEqual({ ok: true, missing: [] });
  });

  it("a board missing Parked fails the drift check, naming exactly Parked", async () => {
    const withoutParked = BOARD_STATES.filter((name) => name !== "Parked");
    const { port } = portFor(defineFakeWorld({ states: withoutParked }));

    const drift = checkStatusDrift(await port.getWorkflowStatuses());
    expect(drift.ok).toBe(false);
    expect(drift.missing).toEqual(["Parked"]);

    const message = statusDriftMessage(drift.missing);
    expect(message).toContain("Parked");
    expect(message).not.toContain("Needs Pedro");
    expect(message).not.toContain("Ready");
  });

  it("walks the cursor when the workflow paginates, rather than truncating the list", async () => {
    // The adapter asks for PAGE_SIZE (50) and the fixture board has 7 states,
    // so pagination is forced by shrinking `first` in flight.
    const fake = createFakeLinear(defineFakeWorld());
    const port = portWithTransport(withPageSize(fake.fetchImpl, 3));

    await expect(port.getWorkflowStatuses()).resolves.toEqual(BOARD_STATES);
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[1].variables.after).toBe("3");
  });

  it("refuses to read an unreadable workflow as an empty one", async () => {
    const port = portWithTransport(respondWith(jsonResponse(200, { data: { team: null } })).fetchImpl);
    await expect(port.getWorkflowStatuses()).rejects.toThrow(/no workflow states for team/);
  });
});

// ---------------------------------------------------------------------------
// AC2 — the read gate: Ready ∩ cycle, both directions, both layers
// ---------------------------------------------------------------------------

describe("AC2: getReadyIssuesInCycle() returns only Ready issues in the requested cycle", () => {
  const world = defineFakeWorld({
    issues: [
      fakeIssue({ identifier: "ALI-201" }),
      fakeIssue({ identifier: "ALI-202", cycleId: OTHER_CYCLE_ID }),
      fakeIssue({ identifier: "ALI-203", stateName: "In Progress" }),
      fakeIssue({ identifier: "ALI-204", stateName: "Backlog" }),
    ],
  });

  it("returns the Ready-in-cycle issue", async () => {
    const { port } = portFor(world);
    const issues = await port.getReadyIssuesInCycle(CYCLE_ID);
    expect(issues.map((issue) => issue.id)).toEqual(["ALI-201"]);
  });

  it("negative: a Ready issue in a DIFFERENT cycle is not returned", async () => {
    const { port } = portFor(world);
    const ids = (await port.getReadyIssuesInCycle(CYCLE_ID)).map((issue) => issue.id);
    expect(ids).not.toContain("ALI-202");
  });

  it("negative: an issue in the cycle but In Progress is not returned", async () => {
    const { port } = portFor(world);
    const ids = (await port.getReadyIssuesInCycle(CYCLE_ID)).map((issue) => issue.id);
    expect(ids).not.toContain("ALI-203");
  });

  it("sends the cycle, state and team filter Linear needs (the question, not just the answer)", async () => {
    const { port, calls } = portFor(world);
    await port.getReadyIssuesInCycle(CYCLE_ID);
    expect(calls[0].variables.filter).toEqual({
      team: { id: { eq: TEAM_ID } },
      cycle: { id: { eq: CYCLE_ID } },
      state: { name: { eq: "Ready" } },
    });
  });

  it("never reads Backlog, even when the cycle contains Backlog issues", async () => {
    const { port } = portFor(world);
    const ids = (await port.getReadyIssuesInCycle(CYCLE_ID)).map((issue) => issue.id);
    expect(ids).not.toContain("ALI-204");
  });

  it("hostile transport: a row in the wrong STATE is dropped by the adapter's own gate", async () => {
    const rogue = fakeIssue({ identifier: "ALI-205", stateName: "In Progress" });
    const port = portWithTransport(
      respondWith(
        jsonResponse(200, {
          data: {
            cycle: { id: CYCLE_ID },
            issues: { nodes: [issueNode(rogue)], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        }),
      ).fetchImpl,
    );
    await expect(port.getReadyIssuesInCycle(CYCLE_ID)).resolves.toEqual([]);
  });

  it("hostile transport: a row in the wrong CYCLE is dropped by the adapter's own gate", async () => {
    const rogue = fakeIssue({ identifier: "ALI-206", cycleId: OTHER_CYCLE_ID });
    const port = portWithTransport(
      respondWith(
        jsonResponse(200, {
          data: {
            cycle: { id: CYCLE_ID },
            issues: { nodes: [issueNode(rogue)], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        }),
      ).fetchImpl,
    );
    await expect(port.getReadyIssuesInCycle(CYCLE_ID)).resolves.toEqual([]);
  });

  it("hostile transport: a row belonging to ANOTHER TEAM is dropped by the adapter's own gate", async () => {
    const rogue = fakeIssue({ identifier: "ALI-207", teamId: "00000000-0000-4000-8000-000000000000" });
    const port = portWithTransport(
      respondWith(
        jsonResponse(200, {
          data: {
            cycle: { id: CYCLE_ID },
            issues: { nodes: [issueNode(rogue)], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        }),
      ).fetchImpl,
    );
    await expect(port.getReadyIssuesInCycle(CYCLE_ID)).resolves.toEqual([]);
  });

  it("a dropped row cannot fail the run: the gate runs before the mapping", async () => {
    // An excluded issue with an unparseable body would throw if the adapter
    // mapped first and gated second.
    const rogue = fakeIssue({ identifier: "ALI-208", stateName: "Done", description: "no sections here" });
    const port = portWithTransport(
      respondWith(
        jsonResponse(200, {
          data: {
            cycle: { id: CYCLE_ID },
            issues: { nodes: [issueNode(rogue)], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        }),
      ).fetchImpl,
    );
    await expect(port.getReadyIssuesInCycle(CYCLE_ID)).resolves.toEqual([]);
  });

  it("refuses an empty cycle id rather than treating it as 'any cycle'", async () => {
    const { port } = portFor(world);
    await expect(port.getReadyIssuesInCycle("  ")).rejects.toThrow(/empty cycle id/);
  });

  it("refuses to read an unresolvable cycle as an empty cycle even if Linear returns no error", async () => {
    const port = portWithTransport(
      respondWith(
        jsonResponse(200, {
          data: { cycle: null, issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        }),
      ).fetchImpl,
    );
    await expect(port.getReadyIssuesInCycle(CYCLE_ID)).rejects.toThrow(/no cycle for id/);
  });
});

// ---------------------------------------------------------------------------
// AC3 — the issue → LinearIssue mapping, every field from the API
// ---------------------------------------------------------------------------

describe("AC3: each returned issue maps to LinearIssue with every field populated", () => {
  const body = issueBody("`src/dispatcher/plan.ts` · `src/dispatcher/run.ts`");
  const world = defineFakeWorld({
    issues: [
      fakeIssue({
        identifier: "ALI-300",
        title: "Round-trip fixture",
        estimate: 3,
        priority: 1,
        description: body,
        labels: ["external-api", "pipeline"],
        blockedBy: ["ALI-157", "ALI-156"],
      }),
    ],
  });

  it("round-trips every field against a fixture response", async () => {
    const { port } = portFor(world);
    const [issue] = await port.getReadyIssuesInCycle(CYCLE_ID);

    expect(issue).toEqual({
      id: "ALI-300",
      title: "Round-trip fixture",
      points: 3,
      priority: 1,
      labels: ["external-api", "pipeline"],
      blockedBy: ["ALI-157", "ALI-156"],
      predictedFiles: ["src/dispatcher/plan.ts", "src/dispatcher/run.ts"],
      body,
      state: "Ready",
    });
  });

  it("carries the description verbatim — the blind seat (ALI-105) reads it and nothing else", async () => {
    const { port } = portFor(world);
    const [issue] = await port.getReadyIssuesInCycle(CYCLE_ID);
    expect(issue.body).toBe(body);
  });

  it("blockedBy reads the BLOCKING direction: inverse `blocks` relations, not what this issue blocks", () => {
    const mapped = mapIssueNode({
      identifier: "ALI-301",
      title: "t",
      estimate: 1,
      priority: 3,
      description: READY_BODY,
      state: { name: "Ready" },
      cycle: { id: CYCLE_ID },
      team: { id: TEAM_ID },
      labels: { nodes: [], pageInfo: { hasNextPage: false } },
      inverseRelations: {
        nodes: [
          { type: "blocks", issue: { identifier: "ALI-100" } },
          { type: "related", issue: { identifier: "ALI-999" } },
          { type: "duplicate", issue: { identifier: "ALI-888" } },
        ],
        pageInfo: { hasNextPage: false },
      },
    });
    expect(mapped.blockedBy).toEqual(["ALI-100"]);
  });

  it("fails loud on a Ready issue with no estimate — unpriced work is never priced at 0", () => {
    expect(() =>
      mapIssueNode({
        identifier: "ALI-302",
        title: "t",
        estimate: null,
        priority: 2,
        description: READY_BODY,
        state: { name: "Ready" },
        cycle: { id: CYCLE_ID },
        team: { id: TEAM_ID },
        labels: { nodes: [], pageInfo: { hasNextPage: false } },
        inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
      }),
    ).toThrow(/ALI-302: is in state Ready with estimate null/);
  });

  it("fails loud rather than assuming an empty label list (labels drive the risk tier)", () => {
    expect(() =>
      mapIssueNode({
        identifier: "ALI-303",
        title: "t",
        estimate: 1,
        priority: 2,
        description: READY_BODY,
        state: { name: "Ready" },
        cycle: { id: CYCLE_ID },
        team: { id: TEAM_ID },
        inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
      }),
    ).toThrow(/ALI-303: Linear returned no `labels` connection/);
  });

  it("fails loud on an issue with no identifier", () => {
    expect(() => mapIssueNode({ title: "t", estimate: 1, priority: 2 })).toThrow(/no `identifier`/);
  });
});

// ---------------------------------------------------------------------------
// AC4 — THE TEETH: an unparseable `## Files touched (predicted)` fails loud
// ---------------------------------------------------------------------------

describe("AC4: an unparseable predicted-files section throws and never yields empty predictedFiles", () => {
  const noHeadingBody = ["## Why", "", "Nothing about files here.", ""].join("\n");
  const emptySectionBody = [`## ${PREDICTED_FILES_HEADING}`, "", "## Reversibility class", "", "`none`", ""].join("\n");
  const proseOnlyBody = [`## ${PREDICTED_FILES_HEADING}`, "", "to be determined", ""].join("\n");

  it("a body with NO such heading fails the fetch, naming the offending issue", async () => {
    const { port } = portFor(
      defineFakeWorld({ issues: [fakeIssue({ identifier: "ALI-401", description: noHeadingBody })] }),
    );
    await expect(port.getReadyIssuesInCycle(CYCLE_ID)).rejects.toThrow(
      /ALI-401: no "## Files touched \(predicted\)" heading/,
    );
  });

  it("a body with the heading but an EMPTY section fails the fetch, naming the offending issue", async () => {
    const { port } = portFor(
      defineFakeWorld({ issues: [fakeIssue({ identifier: "ALI-402", description: emptySectionBody })] }),
    );
    await expect(port.getReadyIssuesInCycle(CYCLE_ID)).rejects.toThrow(
      /ALI-402: the "## Files touched \(predicted\)" section is empty/,
    );
  });

  it("a section with prose but no parseable path fails the fetch, naming the offending issue", async () => {
    const { port } = portFor(
      defineFakeWorld({ issues: [fakeIssue({ identifier: "ALI-403", description: proseOnlyBody })] }),
    );
    await expect(port.getReadyIssuesInCycle(CYCLE_ID)).rejects.toThrow(
      /ALI-403: the "## Files touched \(predicted\)" section contains no parseable file path/,
    );
  });

  it("a null description fails the same way — an issue with no body has no predicted files", async () => {
    const { port } = portFor(
      defineFakeWorld({ issues: [fakeIssue({ identifier: "ALI-404", description: null })] }),
    );
    await expect(port.getReadyIssuesInCycle(CYCLE_ID)).rejects.toThrow(/ALI-404: no "## Files touched/);
  });

  it("the error explains the consequence: clusters with nothing, ALI-133's collision class", () => {
    expect(() => parsePredictedFiles("ALI-405", noHeadingBody)).toThrow(/ALI-133 collision class/);
  });

  it("INVARIANT: no issue this adapter returns ever has an empty predictedFiles list", async () => {
    const { port } = portFor(
      defineFakeWorld({
        issues: [
          fakeIssue({ identifier: "ALI-406" }),
          fakeIssue({ identifier: "ALI-407", description: issueBody("- `src/a.ts`\n- `src/b.ts`") }),
        ],
      }),
    );
    const issues = await port.getReadyIssuesInCycle(CYCLE_ID);
    expect(issues).toHaveLength(2);
    for (const issue of issues) {
      expect(issue.predictedFiles.length).toBeGreaterThan(0);
    }
  });

  it("parses the template's `·`-separated form, the bullet form, and de-duplicates", () => {
    expect(parsePredictedFiles("ALI-408", issueBody("`src/a.ts` · `src/b.ts` (new)"))).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
    expect(parsePredictedFiles("ALI-409", issueBody("- `src/a.ts`\n- `src/a.ts`\n- `src/c/d.ts`"))).toEqual([
      "src/a.ts",
      "src/c/d.ts",
    ]);
    expect(parsePredictedFiles("ALI-410", issueBody("src/plain.ts, docs/ENGINE.md"))).toEqual([
      "src/plain.ts",
      "docs/ENGINE.md",
    ]);
  });
});

// ---------------------------------------------------------------------------
// AC5 — rate limiting is bounded, in both directions
// ---------------------------------------------------------------------------

/**
 * The sleep guard is what makes "gives up" a *deterministic red*, not a hang.
 * An adapter that retried forever would sleep past the guard and reject with
 * UNBOUNDED-RETRY-GUARD instead of the adapter's own named error — so the
 * assertions below fail loudly rather than timing out.
 */
function guardedSleep(limit = 20) {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
      if (delays.length > limit) {
        throw new Error(`UNBOUNDED-RETRY-GUARD: adapter slept ${delays.length} times without giving up`);
      }
    },
  };
}

const rateLimited = (headers: Record<string, string> = {}) =>
  jsonResponse(429, { errors: [{ message: "Too many requests" }] }, headers);

describe("AC5: rate limiting is retried with backoff, up to a fixed maximum", () => {
  it("recovers: two 429s then success returns data", async () => {
    const guard = guardedSleep();
    const world = defineFakeWorld({ issues: [fakeIssue({ identifier: "ALI-501" })] });
    const fake = createFakeLinear(world);
    let calls = 0;
    const port = createLinearApiPort({
      apiKey: DUMMY_API_KEY,
      teamId: TEAM_ID,
      endpoint: FAKE_ENDPOINT,
      sleep: guard.sleep,
      fetchImpl: async (url, init) => (++calls <= 2 ? rateLimited() : fake.fetchImpl(url, init)),
    });

    const issues = await port.getReadyIssuesInCycle(CYCLE_ID);
    expect(issues.map((issue) => issue.id)).toEqual(["ALI-501"]);
    expect(calls).toBe(3);
    expect(guard.delays).toEqual([1_000, 2_000]);
  });

  it("gives up: a forever-429 server produces a named error, not a spin", async () => {
    const guard = guardedSleep();
    const transport = respondWith(rateLimited());
    const port = portWithTransport(transport.fetchImpl, {
      sleep: guard.sleep,
      retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 40 },
    });

    await expect(port.getWorkflowStatuses()).rejects.toThrow(
      /rate limit not cleared: gave up on DispatcherWorkflowStates after 3 attempt/,
    );
    expect(transport.count()).toBe(3);
    expect(guard.delays).toEqual([10, 20]);
  });

  it("treats Linear's documented RATELIMITED error code as a rate limit, not a hard failure", async () => {
    const guard = guardedSleep();
    let calls = 0;
    const fake = createFakeLinear(defineFakeWorld());
    const port = createLinearApiPort({
      apiKey: DUMMY_API_KEY,
      teamId: TEAM_ID,
      endpoint: FAKE_ENDPOINT,
      sleep: guard.sleep,
      fetchImpl: async (url, init) =>
        ++calls === 1
          ? jsonResponse(400, { errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }] })
          : fake.fetchImpl(url, init),
    });

    await expect(port.getWorkflowStatuses()).resolves.toEqual(BOARD_STATES);
    expect(guard.delays).toHaveLength(1);
  });

  it("honours Retry-After but CAPS it at maxDelayMs — a server cannot park an unattended run", async () => {
    const guard = guardedSleep();
    const transport = respondWith(rateLimited({ "Retry-After": "3600" }));
    const port = portWithTransport(transport.fetchImpl, {
      sleep: guard.sleep,
      retry: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 50 },
    });

    await expect(port.getWorkflowStatuses()).rejects.toThrow(/rate limit not cleared/);
    expect(guard.delays).toEqual([50]);
  });

  it("backoff is capped at maxDelayMs as attempts grow", async () => {
    const guard = guardedSleep();
    const transport = respondWith(rateLimited());
    const port = portWithTransport(transport.fetchImpl, {
      sleep: guard.sleep,
      retry: { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 250 },
    });

    await expect(port.getWorkflowStatuses()).rejects.toThrow(/rate limit not cleared/);
    expect(guard.delays).toEqual([100, 200, 250, 250]);
  });

  it("a retry budget that could not terminate is refused at construction", () => {
    expect(() =>
      createLinearApiPort({ apiKey: DUMMY_API_KEY, teamId: TEAM_ID, retry: { maxAttempts: Number.POSITIVE_INFINITY } }),
    ).toThrow(/maxAttempts must be an integer in 1\.\.10/);
    expect(() =>
      createLinearApiPort({ apiKey: DUMMY_API_KEY, teamId: TEAM_ID, retry: { maxAttempts: 0 } }),
    ).toThrow(/maxAttempts must be an integer/);
  });

  it("does NOT retry a non-rate-limit failure — it fails loudly on the first answer", async () => {
    const guard = guardedSleep();
    const transport = respondWith(jsonResponse(500, { message: "boom" }));
    const port = portWithTransport(transport.fetchImpl, { sleep: guard.sleep });

    await expect(port.getWorkflowStatuses()).rejects.toThrow(/HTTP 500/);
    expect(transport.count()).toBe(1);
    expect(guard.delays).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC6 — the credential never escapes through an error path
// ---------------------------------------------------------------------------

describe("AC6: no error message can carry a credential", () => {
  const LEAKED = "lin_api_DEADBEEF";

  const leakPaths: Array<[string, HttpResponseLike]> = [
    ["HTTP error body", jsonResponse(401, { message: `Invalid API key: ${LEAKED}` })],
    [
      "GraphQL errors array",
      jsonResponse(200, { data: null, errors: [{ message: `Authentication failed for key ${LEAKED}` }] }),
    ],
    ["non-JSON body", { ...jsonResponse(502, {}), text: async () => `<html>proxy rejected ${LEAKED}</html>` }],
    ["rate-limit exhaustion body", jsonResponse(429, { errors: [{ message: `slow down ${LEAKED}` }] })],
    ["missing data", jsonResponse(200, { note: `no data for ${LEAKED}` })],
  ];

  for (const [label, response] of leakPaths) {
    it(`redacts a credential echoed through the ${label}`, async () => {
      // The guard, not the wall clock, is what stops an unbounded-retry
      // regression here: with a no-op sleep, a rate-limit path that never
      // gave up would hang this test instead of failing it.
      const port = portWithTransport(respondWith(response).fetchImpl, {
        retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
        sleep: guardedSleep(4).sleep,
      });

      const error = await port.getWorkflowStatuses().then(
        () => {
          throw new Error("expected a rejection");
        },
        (caught: unknown) => caught as Error,
      );

      expect(error).toBeInstanceOf(LinearApiError);
      expect(error.message).toContain("[REDACTED]");
      expect(error.message).not.toContain(LEAKED);
      expect(containsSecretLike(error.message)).toBe(false);
    });
  }

  it("redacts the adapter's OWN key when a transport failure echoes it", async () => {
    const port = portWithTransport(async () => {
      throw new Error(`connect ECONNREFUSED while sending Authorization: ${DUMMY_API_KEY}`);
    });

    const error = await port.getWorkflowStatuses().then(
      () => {
        throw new Error("expected a rejection");
      },
      (caught: unknown) => caught as Error,
    );

    expect(error.message).not.toContain(DUMMY_API_KEY);
    expect(containsSecretLike(error.message)).toBe(false);
  });

  it("redacts a credential that carries NO known prefix (scrubSecrets alone would miss it)", async () => {
    // ALI-156 may require an OAuth-style token rather than a `lin_api_` key.
    // `scrubSecrets()` matches on prefixes, so value-redaction is what covers
    // this case — and this test is what keeps it covered.
    const oauthish = "oauth2-9f3c1a77-not-a-known-prefix";
    const port = createLinearApiPort({
      apiKey: oauthish,
      teamId: TEAM_ID,
      endpoint: FAKE_ENDPOINT,
      sleep: async () => {},
      fetchImpl: respondWith(jsonResponse(403, { message: `token ${oauthish} is not permitted` })).fetchImpl,
    });

    await expect(port.getWorkflowStatuses()).rejects.toThrow(/HTTP 403/);
    const error = await port.getWorkflowStatuses().then(
      () => {
        throw new Error("expected a rejection");
      },
      (caught: unknown) => caught as Error,
    );
    expect(error.message).toContain("[REDACTED]");
    expect(error.message).not.toContain(oauthish);
  });

  it("sends the key as a bare Authorization header — no Bearer prefix (Linear rejects that)", async () => {
    const { port, calls } = portFor(defineFakeWorld());
    await port.getWorkflowStatuses();
    expect(calls[0].authorization).toBe(DUMMY_API_KEY);
    expect(calls[0].authorization?.startsWith("Bearer ")).toBe(false);
  });

  it("refuses to construct an adapter with an empty credential", () => {
    expect(() => createLinearApiPort({ apiKey: "", teamId: TEAM_ID })).toThrow(/LINEAR_API_KEY/);
    expect(() => createLinearApiPort({ apiKey: DUMMY_API_KEY, teamId: "" })).toThrow(/LINEAR_TEAM_ID/);
  });
});

// ---------------------------------------------------------------------------
// AC7 — the fake is faithful: it rejects what real Linear rejects
// ---------------------------------------------------------------------------

describe("AC7: the fake Linear encodes Linear's hard rejections", () => {
  it("rejects an issue in a workflow state the team does not define", () => {
    expect(() =>
      defineFakeWorld({ issues: [fakeIssue({ identifier: "ALI-701", stateName: "Redy" })] }),
    ).toThrow(/"Redy" is not a workflow state on team/);

    // …and accepts the correctly-spelled one, so the rejection is about the
    // name, not about rejecting everything.
    expect(() => defineFakeWorld({ issues: [fakeIssue({ identifier: "ALI-702" })] })).not.toThrow();
  });

  it("rejects a query for a cycle id that does not exist — an unresolvable cycle is never zero rows", async () => {
    const { port } = portFor(defineFakeWorld({ issues: [fakeIssue({ identifier: "ALI-703" })] }));
    await expect(port.getReadyIssuesInCycle(UNKNOWN_CYCLE_ID)).rejects.toThrow(/Entity not found: Cycle/);
  });

  it("rejects an unknown team id the same way (non-null Query.team)", async () => {
    const world = defineFakeWorld();
    const { fetchImpl } = createFakeLinear(world);
    const port = createLinearApiPort({
      apiKey: DUMMY_API_KEY,
      teamId: "11111111-1111-4111-8111-111111111111",
      endpoint: FAKE_ENDPOINT,
      fetchImpl,
      sleep: async () => {},
    });
    await expect(port.getWorkflowStatuses()).rejects.toThrow(/Entity not found: Team/);
  });

  it("rejects a filter key GraphQL does not define, instead of ignoring it", async () => {
    const world = defineFakeWorld({ issues: [fakeIssue({ identifier: "ALI-704" })] });
    const { fetchImpl } = createFakeLinear(world);
    const port = createLinearApiPort({
      apiKey: DUMMY_API_KEY,
      teamId: TEAM_ID,
      endpoint: FAKE_ENDPOINT,
      sleep: async () => {},
      fetchImpl: async (url, init) => {
        const body = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
        const filter = { ...(body.variables.filter as Record<string, unknown>), stat: { name: { eq: "Ready" } } };
        return fetchImpl(url, { ...init, body: JSON.stringify({ ...body, variables: { ...body.variables, filter } }) });
      },
    });
    await expect(port.getReadyIssuesInCycle(CYCLE_ID)).rejects.toThrow(/not defined by type 'IssueFilter'/);
  });

  it("rejects an unauthenticated request", async () => {
    const world = defineFakeWorld();
    const { fetchImpl } = createFakeLinear(world);
    const port = createLinearApiPort({
      apiKey: "lin_api_WRONGKEY",
      teamId: TEAM_ID,
      endpoint: FAKE_ENDPOINT,
      fetchImpl,
      sleep: async () => {},
    });
    await expect(port.getWorkflowStatuses()).rejects.toThrow(/HTTP 401/);
  });

  it("matches nothing (rather than erroring) for a state name the board lacks — real Linear's silence", async () => {
    // The drift check, not the query, is what catches this. Proving the fake
    // is silent here is what makes AC1's drift test meaningful.
    const world = defineFakeWorld({ issues: [fakeIssue({ identifier: "ALI-705" })] });
    const { fetchImpl } = createFakeLinear(world);
    const port = createLinearApiPort({
      apiKey: DUMMY_API_KEY,
      teamId: TEAM_ID,
      endpoint: FAKE_ENDPOINT,
      sleep: async () => {},
      fetchImpl: async (url, init) => {
        const body = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
        const filter = { ...(body.variables.filter as Record<string, unknown>), state: { name: { eq: "Redy" } } };
        return fetchImpl(url, { ...init, body: JSON.stringify({ ...body, variables: { ...body.variables, filter } }) });
      },
    });
    await expect(port.getReadyIssuesInCycle(CYCLE_ID)).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC8 — the four unwired methods are loud stubs that name their owner
// ---------------------------------------------------------------------------

describe("AC8: getApprovedCycle, setIssueStatus, addComment and postCycleSummary are loud stubs", () => {
  const port = createLinearApiPort({ apiKey: DUMMY_API_KEY, teamId: TEAM_ID });

  const stubs: Array<[string, string, () => unknown]> = [
    ["getApprovedCycle", "ALI-163", () => port.getApprovedCycle()],
    ["postCycleSummary", "ALI-163", () => port.postCycleSummary(CYCLE_ID, "summary")],
    ["setIssueStatus", "ALI-159", () => port.setIssueStatus("ALI-1", "Parked", CYCLE_ID)],
    ["addComment", "ALI-159", () => port.addComment("ALI-1", "body")],
  ];

  for (const [method, owningIssue, call] of stubs) {
    it(`${method}() throws, names itself a stub, and names ${owningIssue}`, () => {
      expect(call).toThrow(LinearApiError);
      expect(call).toThrow(new RegExp(`LinearPort\\.${method}\\(\\) is a STUB`));
      expect(call).toThrow(new RegExp(owningIssue));
    });
  }

  it("no method retains the old, owner-less 'not wired in this PR' text", () => {
    for (const [, , call] of stubs) {
      let message = "";
      try {
        call();
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toContain("not wired in this PR");
    }
  });

  it("the three read methods are NOT stubs — they reach the transport", async () => {
    const { port: real, calls } = portFor(defineFakeWorld({ issues: [fakeIssue({ identifier: "ALI-801" })] }));
    await real.getWorkflowStatuses();
    await real.getReadyIssuesInCycle(CYCLE_ID);
    expect(calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Security pass, round 1 (S1–S7). S1 was blocking: a nested connection that
// truncated at the page cap was undetectable, so a danger label past row 50
// mapped to riskTier "none" and skipped the mandatory security pass.
// ---------------------------------------------------------------------------

/** One issue node, served straight back, so a nested-connection shape can be aimed at the mapper. */
function singleIssueResponse(node: Record<string, unknown>): HttpResponseLike {
  return jsonResponse(200, {
    data: {
      cycle: { id: CYCLE_ID },
      issues: { nodes: [node], pageInfo: { hasNextPage: false, endCursor: null } },
    },
  });
}

describe("S1 (blocking): a truncated nested connection fails loud, never maps a partial set", () => {
  it("labels: hasNextPage true throws, naming the skipped security pass as the consequence", async () => {
    const truncated = issueNode(fakeIssue({ identifier: "ALI-910", labels: ["area/a", "external-api"] }), 1);
    const port = portWithTransport(respondWith(singleIssueResponse(truncated)).fetchImpl);

    await expect(port.getReadyIssuesInCycle(CYCLE_ID)).rejects.toThrow(
      /ALI-910: the `labels` connection is TRUNCATED/,
    );
    await expect(port.getReadyIssuesInCycle(CYCLE_ID)).rejects.toThrow(/mandatory security pass/);
  });

  it("a danger label beyond the page cap can never map to a risk-free label set", async () => {
    // The probed failure: `external-api` sits past the cap, riskTier drops to
    // "none", the tier drops off its floor, the security pass is skipped. The
    // adapter must refuse the issue outright rather than return it carrying a
    // label set that silently lost the danger label.
    const truncated = issueNode(fakeIssue({ identifier: "ALI-911", labels: ["area/a", "external-api"] }), 1);
    const port = portWithTransport(respondWith(singleIssueResponse(truncated)).fetchImpl);

    const error = await port.getReadyIssuesInCycle(CYCLE_ID).then(
      (issues) => {
        throw new Error(`expected a rejection, got labels ${JSON.stringify(issues.map((i) => i.labels))}`);
      },
      (caught: unknown) => caught as Error,
    );
    expect(error).toBeInstanceOf(LinearApiError);
  });

  it("inverseRelations: hasNextPage true throws, naming the invisible blocker as the consequence", async () => {
    const truncated = issueNode(fakeIssue({ identifier: "ALI-912", blockedBy: ["ALI-1", "ALI-2"] }), 1);
    const port = portWithTransport(respondWith(singleIssueResponse(truncated)).fetchImpl);

    await expect(port.getReadyIssuesInCycle(CYCLE_ID)).rejects.toThrow(
      /ALI-912: the `inverseRelations` connection is TRUNCATED/,
    );
    await expect(port.getReadyIssuesInCycle(CYCLE_ID)).rejects.toThrow(/invisible to plan\.ts's admit\(\)/);
  });

  it("a nested connection with NO pageInfo throws too — 'cannot tell' fails like 'yes'", async () => {
    const node = issueNode(fakeIssue({ identifier: "ALI-913" }));
    delete (node.labels as Record<string, unknown>).pageInfo;
    const port = portWithTransport(respondWith(singleIssueResponse(node)).fetchImpl);

    await expect(port.getReadyIssuesInCycle(CYCLE_ID)).rejects.toThrow(
      /ALI-913: Linear returned no usable `pageInfo` on the `labels` connection/,
    );
  });

  it("a COMPLETE nested connection still maps normally — the guard is about truncation, not labels", async () => {
    const { port } = portFor(
      defineFakeWorld({
        issues: [fakeIssue({ identifier: "ALI-914", labels: ["external-api", "pipeline"], blockedBy: ["ALI-9"] })],
      }),
    );
    const [issue] = await port.getReadyIssuesInCycle(CYCLE_ID);
    expect(issue.labels).toEqual(["external-api", "pipeline"]);
    expect(issue.blockedBy).toEqual(["ALI-9"]);
  });

  it("the query actually asks for pageInfo on both nested connections", async () => {
    const { port, calls } = portFor(defineFakeWorld({ issues: [fakeIssue({ identifier: "ALI-915" })] }));
    await port.getReadyIssuesInCycle(CYCLE_ID);
    const query = calls[0].query;
    expect(query).toMatch(/labels\(first: \d+\) \{ nodes \{ name \} pageInfo \{ hasNextPage \} \}/);
    expect(query).toMatch(/inverseRelations\(first: \d+\)[\s\S]*?pageInfo \{ hasNextPage \}/);
  });
});

describe("S2: credential value-redaction covers EVERY error path, not just the transport", () => {
  // A key with no known prefix — `scrubSecrets()` cannot see it, so only
  // value-redaction can. ALI-156 may well require exactly this shape.
  const OAUTHISH = "oauthtok_ZZZ9988776655443322";

  it("a non-prefixed credential pasted into an issue BODY is redacted in the parse error", async () => {
    const body = [`## ${PREDICTED_FILES_HEADING}`, "", `oops pasted ${OAUTHISH} in here`, ""].join("\n");
    const leaky = issueNode(fakeIssue({ identifier: "ALI-920", description: body }));
    const port = createLinearApiPort({
      apiKey: OAUTHISH,
      teamId: TEAM_ID,
      endpoint: FAKE_ENDPOINT,
      sleep: async () => {},
      fetchImpl: respondWith(singleIssueResponse(leaky)).fetchImpl,
    });

    const error = await port.getReadyIssuesInCycle(CYCLE_ID).then(
      () => {
        throw new Error("expected a rejection");
      },
      (caught: unknown) => caught as Error,
    );
    expect(error.message).toContain("[REDACTED]");
    expect(error.message).not.toContain(OAUTHISH);
  });

  it("a non-prefixed credential arriving via `identifier` is redacted in a mapping error", async () => {
    const node = issueNode(fakeIssue({ identifier: `ALI-${OAUTHISH}` }));
    delete (node as Record<string, unknown>).labels;
    const port = createLinearApiPort({
      apiKey: OAUTHISH,
      teamId: TEAM_ID,
      endpoint: FAKE_ENDPOINT,
      sleep: async () => {},
      fetchImpl: respondWith(singleIssueResponse(node)).fetchImpl,
    });

    const error = await port.getReadyIssuesInCycle(CYCLE_ID).then(
      () => {
        throw new Error("expected a rejection");
      },
      (caught: unknown) => caught as Error,
    );
    expect(error.message).toContain("labels");
    expect(error.message).not.toContain(OAUTHISH);
  });
});

describe("S3: the cause chain is sanitized too, not just the message", () => {
  it("a transport error whose cause echoes the credential leaks nothing through `cause`", async () => {
    const key = "oauthtok_CAUSECHAIN99887766";
    const port = createLinearApiPort({
      apiKey: key,
      teamId: TEAM_ID,
      endpoint: FAKE_ENDPOINT,
      sleep: async () => {},
      fetchImpl: async () => {
        throw new Error(`socket died with ${key}`);
      },
    });

    const error = await port.getWorkflowStatuses().then(
      () => {
        throw new Error("expected a rejection");
      },
      (caught: unknown) => caught as Error,
    );

    expect(error.message).not.toContain(key);
    const cause = error.cause as Error | undefined;
    expect(cause).toBeInstanceOf(Error);
    expect(cause?.message).not.toContain(key);
    expect(cause?.stack ?? "").not.toContain(key);
    // Whole-object inspection is what an unattended run's default handler prints.
    expect(inspect(error, { depth: 5 })).not.toContain(key);
  });

  it("keeps the cause's diagnostic name, so sanitizing does not cost debuggability", async () => {
    const port = portWithTransport(async () => {
      throw new TypeError("fetch failed");
    });
    const error = await port.getWorkflowStatuses().then(
      () => {
        throw new Error("expected a rejection");
      },
      (caught: unknown) => caught as Error,
    );
    expect((error.cause as Error).name).toBe("TypeError");
    expect((error.cause as Error).message).toBe("fetch failed");
  });
});

describe("S4: an estimate below the routing table's lowest row is rejected, exactly like null", () => {
  const nodeWithEstimate = (estimate: unknown) => ({
    ...issueNode(fakeIssue({ identifier: "ALI-930" })),
    estimate,
  });

  it("rejects 0 — a legal Linear estimate that prices work as FREE against the budget gate", () => {
    expect(() => mapIssueNode(nodeWithEstimate(0))).toThrow(
      /estimate 0, which is not a finite number of at least 1/,
    );
  });

  it("rejects a negative estimate — negative cost ADDS budget headroom", () => {
    expect(() => mapIssueNode(nodeWithEstimate(-5))).toThrow(/estimate -5/);
  });

  it("still rejects null, and still accepts a legitimate 1-point estimate", () => {
    expect(() => mapIssueNode(nodeWithEstimate(null))).toThrow(/estimate null/);
    expect(mapIssueNode(nodeWithEstimate(1)).points).toBe(1);
  });

  it("names the reason as the routing table's floor, not an arbitrary rule", () => {
    expect(() => mapIssueNode(nodeWithEstimate(0))).toThrow(/routing table's lowest row is 1 point/);
  });
});

describe("S5: the read gate fails CLOSED on team, at parity with state and cycle", () => {
  const rowWithTeam = (team: unknown) => {
    const node = issueNode(fakeIssue({ identifier: "ALI-940" }));
    if (team === undefined) delete (node as Record<string, unknown>).team;
    else (node as Record<string, unknown>).team = team;
    return node;
  };

  for (const [label, team] of [
    ["absent", undefined],
    ["null", null],
    ["present but id-less", {}],
    ["another team's id", { id: "team-OTHER" }],
  ] as Array<[string, unknown]>) {
    it(`excludes a row whose team is ${label}`, async () => {
      const port = portWithTransport(respondWith(singleIssueResponse(rowWithTeam(team))).fetchImpl);
      await expect(port.getReadyIssuesInCycle(CYCLE_ID)).resolves.toEqual([]);
    });
  }

  it("admits the row when the team id matches, so the gate is not simply refusing everything", async () => {
    const port = portWithTransport(respondWith(singleIssueResponse(rowWithTeam({ id: TEAM_ID }))).fetchImpl);
    const issues = await port.getReadyIssuesInCycle(CYCLE_ID);
    expect(issues.map((issue) => issue.id)).toEqual(["ALI-940"]);
  });
});

describe("S6: a row served on two pages is returned once", () => {
  it("de-duplicates by identifier rather than relying on plan.ts's id-keyed admit()", async () => {
    const duplicate = issueNode(fakeIssue({ identifier: "ALI-950" }));
    const port = portWithTransport(
      respondWith(
        jsonResponse(200, {
          data: {
            cycle: { id: CYCLE_ID },
            issues: { nodes: [duplicate], pageInfo: { hasNextPage: true, endCursor: "1" } },
          },
        }),
        jsonResponse(200, {
          data: {
            cycle: { id: CYCLE_ID },
            issues: { nodes: [duplicate], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        }),
      ).fetchImpl,
    );

    const issues = await port.getReadyIssuesInCycle(CYCLE_ID);
    expect(issues.map((issue) => issue.id)).toEqual(["ALI-950"]);
  });
});

describe("S7: config ceilings are structural, not left to the caller", () => {
  it("refuses a credential too short for value-redaction to be meaningful", () => {
    expect(() => createLinearApiPort({ apiKey: "abc123", teamId: TEAM_ID })).toThrow(/implausibly short/);
  });

  it("refuses a maxDelayMs above the structural ceiling — it is what caps Retry-After", () => {
    expect(() =>
      createLinearApiPort({ apiKey: DUMMY_API_KEY, teamId: TEAM_ID, retry: { maxDelayMs: 3_600_000 } }),
    ).toThrow(/maxDelayMs must be a finite number in 0\.\.60000 ms/);
  });

  it("refuses an unbounded per-request timeout", () => {
    expect(() =>
      createLinearApiPort({ apiKey: DUMMY_API_KEY, teamId: TEAM_ID, requestTimeoutMs: 10 * 60_000 }),
    ).toThrow(/requestTimeoutMs: must be a finite number in 1\.\.120000 ms/);
  });
});

// ---------------------------------------------------------------------------
// AC9 — live contract test against real Linear, or a VISIBLE skip
// ---------------------------------------------------------------------------

const LIVE_ENV_VARS = [LINEAR_API_KEY_ENV, LINEAR_TEAM_ID_ENV] as const;

/**
 * Which live-contract variables are absent. A variable set to whitespace
 * counts as missing — an empty credential must produce the loud skip, not a
 * confusing 401 from the live path.
 */
function missingLiveEnvVars(env: Record<string, string | undefined>): string[] {
  return LIVE_ENV_VARS.filter((name) => (env[name] ?? "").trim() === "");
}

/** The loud half of AC9's skip: it names every missing variable and its owning issue. */
function liveSkipNotice(missing: readonly string[]): string {
  return (
    `[ALI-158 AC9] SKIPPING the live Linear contract test — missing environment variable(s): ` +
    `${missing.join(", ")}. These are provisioned by ALI-157. Until this test has run green once, ` +
    `the adapter is NOT proven against the real system.`
  );
}

const missingLiveEnv = missingLiveEnvVars(process.env);

describe("AC9: the live-contract gate is loud, never silent", () => {
  it("treats an unset OR blank variable as missing", () => {
    expect(missingLiveEnvVars({})).toEqual([LINEAR_API_KEY_ENV, LINEAR_TEAM_ID_ENV]);
    expect(missingLiveEnvVars({ [LINEAR_API_KEY_ENV]: "   ", [LINEAR_TEAM_ID_ENV]: "team" })).toEqual([
      LINEAR_API_KEY_ENV,
    ]);
    expect(missingLiveEnvVars({ [LINEAR_API_KEY_ENV]: "k", [LINEAR_TEAM_ID_ENV]: "t" })).toEqual([]);
  });

  it("the skip notice names each missing variable, the owning issue, and says it is a skip", () => {
    const notice = liveSkipNotice([LINEAR_API_KEY_ENV]);
    expect(notice).toContain("SKIPPING");
    expect(notice).toContain(LINEAR_API_KEY_ENV);
    expect(notice).toContain("ALI-157");
    expect(notice).toContain("NOT proven against the real system");
  });
});

describe("AC9: live contract test against real Linear", () => {
  if (missingLiveEnv.length > 0) {
    // Visible on every run that does not have the credential: a skipped test
    // is reported as skipped, and this line names exactly which variable is
    // missing so the skip can never be read as a pass.
    console.warn(liveSkipNotice(missingLiveEnv));
    it.skip(`SKIPPED — ${missingLiveEnv.join(", ")} not set (provisioned by ALI-157); adapter unproven against real Linear`, () => {
      throw new Error("unreachable: this test is skipped");
    });
  } else {
    it(
      `hits ${LINEAR_API_URL} and returns a workflow that passes the drift check`,
      async () => {
        const port = createLinearApiPort({
          apiKey: process.env[LINEAR_API_KEY_ENV] as string,
          teamId: process.env[LINEAR_TEAM_ID_ENV] as string,
        });
        const statuses = await port.getWorkflowStatuses();
        expect(statuses.length).toBeGreaterThan(0);

        const drift = checkStatusDrift(statuses);
        expect(drift.ok, drift.ok ? "" : statusDriftMessage(drift.missing)).toBe(true);
      },
      30_000,
    );
  }
});
