/**
 * Dispatcher runtime — the Linear port.
 *
 * All Linear I/O behind one injected interface (ports and adapters — see
 * `run.ts`'s module doc). No Linear SDK type leaks past this file; the rest
 * of the runtime works in terms of `./types.js`'s plain `Issue` shape plus
 * the small amount of Linear-specific context (workflow state, cycle) this
 * file adds on top.
 *
 * ALI-158 lands the REAL adapter's read half — `getWorkflowStatuses()`,
 * `getReadyIssuesInCycle()` and the issue→`LinearIssue` mapping — over Node
 * 22's built-in `fetch`, with no new npm dependency. The write half
 * (ALI-159) and the cycle-approval surface (ALI-163) remain unimplemented
 * and are loud stubs that name their owning issue.
 */

import { scrubSecrets } from "./runlog.js";
import type { Issue, IssueState } from "./types.js";

/**
 * The approved cycle — the Direction gate's admission ticket. `approvalRef`
 * is an opaque pointer to how it was approved (e.g. an escalation-channel
 * message id), carried into the run log for the "why did this run pick
 * what it picked" record (docs/ENGINE.md §12).
 */
export interface CycleRef {
  id: string;
  name?: string;
  approvalRef: string;
}

/** A candidate as fetched from Linear: the core `Issue` shape, with its workflow state always present. */
export interface LinearIssue extends Issue {
  state: IssueState;
  /**
   * The issue's raw Linear description, verbatim markdown -- the ONLY
   * source `blindqa.ts`'s `extractBlindView()` reads from (ALI-105). Never
   * consumed directly by `plan.ts`'s pure core (it stays plain `Issue`
   * there); carried here so the runtime can extract the blind test-author's
   * view (`## Acceptance criteria` / `## Invariant` / `## Definition of
   * done`) without threading a second fetch or a new port method.
   */
  body: string;
}

export interface LinearPort {
  /** The team's configured workflow-state names, for the drift check (AC8). */
  getWorkflowStatuses(): Promise<string[]>;
  /** `null` when no cycle is Pedro-approved — the Direction gate, fail closed (AC1). */
  getApprovedCycle(): Promise<CycleRef | null>;
  /** Every `Ready` issue in the given cycle. Never Backlog — the build loop never reads it. */
  getReadyIssuesInCycle(cycleId: string): Promise<LinearIssue[]>;
  /**
   * Moves an issue to a new status. `cycleId` is explicit and mandatory —
   * never let Linear auto-assign one (the ALI-103 addendum: moving an issue
   * out of Backlog was observed to silently attach the *current* cycle).
   * Pass the run's approved cycle id to preserve it (`Parked` — interrupted
   * work belongs to the cycle that admitted it), or `null` to clear it
   * (`Needs Pedro` — excluded from runs until answered).
   */
  setIssueStatus(issueId: string, status: IssueState, cycleId: string | null): Promise<void>;
  addComment(issueId: string, body: string): Promise<void>;
  /** The run log's human-readable half: one short summary comment for the cycle. */
  postCycleSummary(cycleId: string, body: string): Promise<void>;
}

/**
 * The three status names the dispatcher's own transitions depend on
 * (docs/ENGINE.md §3). `Ready` is also the candidate-fetch status, but it
 * is checked here too — a board missing it fails exactly like one missing
 * `Parked`.
 */
const REQUIRED_STATUSES = ["Ready", "Parked", "Needs Pedro"] as const;

export interface StatusDriftResult {
  ok: boolean;
  missing: string[];
}

/**
 * AC8: verifies `Ready`, `Parked`, and `Needs Pedro` all resolve against
 * the team's actual workflow. A missing status must fail loud — never be
 * silently read as "no work" (a dispatcher that matches on a status name
 * absent from the board admits zero issues on every run, forever, and that
 * looks identical to an empty cycle unless this check exists).
 */
export function checkStatusDrift(workflowStatuses: readonly string[]): StatusDriftResult {
  const present = new Set(workflowStatuses);
  const missing = REQUIRED_STATUSES.filter((status) => !present.has(status));
  return { ok: missing.length === 0, missing };
}

/** The loud, specific error message AC8 requires — names exactly what's missing. */
export function statusDriftMessage(missing: readonly string[]): string {
  return (
    `Missing required Linear workflow status(es): ${missing.join(", ")}. ` +
    "The dispatcher matches on literal status names (docs/ENGINE.md §3) — " +
    "fix the team's workflow before rerunning. A missing status is never " +
    "the same thing as an empty cycle."
  );
}

// ---------------------------------------------------------------------------
// Real adapter (ALI-158, read half)
//
// Node 22's built-in `fetch` against Linear's GraphQL endpoint. NO new npm
// dependency, deliberately: this is the first code in the repo that holds a
// credential and calls a third-party API, and the repo has just closed two
// supply-chain issues (ALI-137 untrusted install scripts, ALI-144 mutable
// action tags). A dependency in the credential-holding path is not free.
//
// Contract evidence (gate 8 grammar, docs/ENGINE.md §19):
//   SOURCE  https://linear.app/developers/graphql
//   READ AT 2026-08-17
//   LITERAL endpoint `https://api.linear.app/graphql`; a personal API key is
//           sent as `Authorization: <API_KEY>` with NO `Bearer ` prefix (that
//           prefix is OAuth2-only) — sending the prefix is a 401, so this is
//           load-bearing, not stylistic.
//
//   SOURCE  https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql
//   READ AT 2026-08-17
//   LITERAL `Query.team(id: String!): Team!`, `Query.cycle(id: String!): Cycle!`
//           (both NON-NULL — an id Linear cannot resolve therefore cannot come
//           back as `null`, it must come back as a GraphQL error; that is the
//           hard rejection the faithful fake models, AC7),
//           `Team.states(first, after, ...): WorkflowStateConnection!`,
//           `WorkflowState.name: String!`,
//           `Query.issues(filter: IssueFilter, first, after, ...): IssueConnection!`,
//           `IssueFilter.cycle: NullableCycleFilter` → `id: IDComparator` → `eq: ID`,
//           `IssueFilter.state: WorkflowStateFilter` → `name: StringComparator` → `eq: String`,
//           `IssueFilter.team: TeamFilter` → `id: IDComparator`,
//           `Issue.identifier: String!`, `Issue.estimate: Float`,
//           `Issue.priority: Float!`, `Issue.description: String`,
//           `Issue.state: WorkflowState!`, `Issue.cycle: Cycle`,
//           `IssueRelation { issue: Issue!, relatedIssue: Issue!, type: String! }`,
//           `enum IssueRelationType { blocks duplicate related similar }`.
//
//   SOURCE  https://linear.app/developers/rate-limiting
//   READ AT 2026-08-17
//   LITERAL 5,000 requests/hour for API-key auth; rate limiting is surfaced
//           via a `RATELIMITED` error code in the response's `errors` field
//           (and, on the HTTP layer, a 429). BOTH are treated as rate limits
//           here — AC5 names the 429; the docs name the error code; an
//           adapter that handled only one of them would spin or die on the
//           other.
//
// NOT PROVEN AGAINST THE REAL SYSTEM until AC9's live contract test has run
// green once (needs ALI-157's credential). Everything below is proven against
// a faithful fake, which is a different and weaker claim — see the PR body.
// ---------------------------------------------------------------------------

/** Linear's GraphQL endpoint. Overridable per-adapter only so tests can point at a fake. */
export const LINEAR_API_URL = "https://api.linear.app/graphql";

/**
 * Environment variables the live contract test (AC9) reads. Named here rather
 * than inline so ALI-157 provisions exactly these strings and the loud skip
 * can quote them. This repo reads no other environment variable — there is
 * still no config loader, and this issue does not add one.
 */
export const LINEAR_API_KEY_ENV = "LINEAR_API_KEY";
export const LINEAR_TEAM_ID_ENV = "LINEAR_TEAM_ID";

/**
 * The one status the build loop fetches candidates from. A literal, matched
 * exactly (docs/ENGINE.md §3, CLAUDE.md "Pipeline") — never a prefix, never
 * case-insensitive: `Ready` and `ready` are different states on a Linear
 * board, and admitting the wrong one is the Direction gate failing open.
 */
export const READY_STATE_NAME = "Ready" as const satisfies IssueState;

/** The Linear relation type that means "the other issue blocks this one" (see schema evidence above). */
const BLOCKS_RELATION_TYPE = "blocks";

/** The issue-body section `predictedFiles` is parsed from (`.claude/templates/issue-body.md`). */
export const PREDICTED_FILES_HEADING = "Files touched (predicted)";

/** Page size for both paginated reads. 50 is Linear's own default for `first`. */
const PAGE_SIZE = 50;

/**
 * Hard cap on pages walked per read. Same doctrine as the retry cap below:
 * an unattended run must terminate. A board that somehow paginates past this
 * fails loud rather than looping — a truncated candidate list would silently
 * change what the run builds.
 */
const MAX_PAGES = 20;

/** Bytes of an error response body echoed into a thrown message (after scrubbing). */
const ERROR_BODY_SNIPPET_CHARS = 500;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Every error this adapter throws. The constructor is the single choke point
 * for AC6: `scrubSecrets()` (runlog.ts) runs over the message here, so there
 * is no path that builds a message and forgets — including messages that
 * quote a Linear response body, which is exactly where an echoed credential
 * would arrive.
 */
export class LinearApiError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(scrubSecrets(message), options);
    this.name = "LinearApiError";
  }
}

// ---------------------------------------------------------------------------
// Transport seam
// ---------------------------------------------------------------------------

/** The subset of `Response` this adapter uses — structurally satisfied by Node's `fetch`. */
export interface HttpResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface HttpRequestInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

/**
 * The injectable transport. Defaults to the global `fetch`; tests pass a
 * faithful fake (ALI-155). Declared structurally rather than as `typeof fetch`
 * so this module compiles without DOM lib types and so the fake needs no
 * `Response` construction.
 */
export type FetchLike = (url: string, init: HttpRequestInit) => Promise<HttpResponseLike>;

/**
 * Bounded retry (AC5). `maxAttempts` counts the FIRST attempt, so
 * `maxAttempts: 1` means "never retry". Worst-case added wall clock is
 * `(maxAttempts - 1) * maxDelayMs` — finite by construction, which is the
 * whole point: an unattended run must never spin against a rate limit.
 */
export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  /** Hard ceiling on any single sleep, INCLUDING a server-supplied `Retry-After`. */
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 1_000,
  maxDelayMs: 8_000,
};

/** Refuses a policy that could not terminate — a config-level guard on the same property AC5 tests. */
const MAX_ALLOWED_ATTEMPTS = 10;

/** Per-request timeout. Node's `fetch` has none by default; a stalled socket would hang the run forever. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface LinearApiConfig {
  apiKey: string;
  /** Linear team UUID (or key) — scopes both reads. */
  teamId: string;
  /** Defaults to `LINEAR_API_URL`. */
  endpoint?: string;
  /** Defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Defaults to `setTimeout`-backed sleep. Injected in tests so backoff is asserted, not waited on. */
  sleep?: (ms: number) => Promise<void>;
  retry?: Partial<RetryPolicy>;
  requestTimeoutMs?: number;
}

interface AdapterRuntime {
  endpoint: string;
  apiKey: string;
  teamId: string;
  fetchImpl: FetchLike;
  sleep: (ms: number) => Promise<void>;
  retry: RetryPolicy;
  requestTimeoutMs: number;
}

function resolveGlobalFetch(): FetchLike {
  const candidate = (globalThis as { fetch?: unknown }).fetch;
  if (typeof candidate !== "function") {
    throw new LinearApiError(
      "No global fetch is available. This adapter requires Node >= 18 (package.json pins >= 22); " +
        "pass `fetchImpl` explicitly if running somewhere else.",
    );
  }
  return candidate as FetchLike;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateConfig(config: LinearApiConfig): AdapterRuntime {
  if (typeof config.apiKey !== "string" || config.apiKey.trim() === "") {
    throw new LinearApiError(
      `Linear API key is empty. Set ${LINEAR_API_KEY_ENV} (provisioned by ALI-157) — an adapter ` +
        "constructed without a credential would fail on every call at run time instead of here.",
    );
  }
  if (typeof config.teamId !== "string" || config.teamId.trim() === "") {
    throw new LinearApiError(`Linear team id is empty. Set ${LINEAR_TEAM_ID_ENV} (provisioned by ALI-157).`);
  }

  const retry: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...config.retry };
  if (!Number.isInteger(retry.maxAttempts) || retry.maxAttempts < 1 || retry.maxAttempts > MAX_ALLOWED_ATTEMPTS) {
    throw new LinearApiError(
      `Invalid retry policy: maxAttempts must be an integer in 1..${MAX_ALLOWED_ATTEMPTS}, got ` +
        `${String(retry.maxAttempts)}. An unbounded retry budget is the failure AC5 exists to prevent.`,
    );
  }
  if (!Number.isFinite(retry.baseDelayMs) || retry.baseDelayMs < 0) {
    throw new LinearApiError(`Invalid retry policy: baseDelayMs must be a finite, non-negative number.`);
  }
  if (!Number.isFinite(retry.maxDelayMs) || retry.maxDelayMs < 0) {
    throw new LinearApiError(`Invalid retry policy: maxDelayMs must be a finite, non-negative number.`);
  }

  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new LinearApiError(`Invalid requestTimeoutMs: must be a finite, positive number.`);
  }

  return {
    endpoint: config.endpoint ?? LINEAR_API_URL,
    apiKey: config.apiKey,
    teamId: config.teamId,
    fetchImpl: config.fetchImpl ?? ((url, init) => resolveGlobalFetch()(url, init)),
    sleep: config.sleep ?? defaultSleep,
    retry,
    requestTimeoutMs,
  };
}

// ---------------------------------------------------------------------------
// GraphQL transport: one bounded, scrubbing request function
// ---------------------------------------------------------------------------

interface GraphQLErrorLike {
  message?: unknown;
  extensions?: Record<string, unknown>;
}

interface GraphQLEnvelope {
  data?: unknown;
  errors?: GraphQLErrorLike[];
}

const RATE_LIMIT_CODE = "RATELIMITED";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isRateLimitedEnvelope(status: number, envelope: GraphQLEnvelope | null): boolean {
  if (status === 429) return true;
  return (envelope?.errors ?? []).some((error) => {
    const extensions = asRecord(error?.extensions) ?? {};
    return [extensions.code, extensions.type].some(
      (value) => typeof value === "string" && value.toUpperCase() === RATE_LIMIT_CODE,
    );
  });
}

function renderGraphQLErrors(envelope: GraphQLEnvelope | null): string {
  const messages = (envelope?.errors ?? []).map((error) =>
    typeof error?.message === "string" ? error.message : JSON.stringify(error),
  );
  return messages.length > 0 ? messages.join("; ") : "(no error messages)";
}

function snippet(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > ERROR_BODY_SNIPPET_CHARS
    ? `${trimmed.slice(0, ERROR_BODY_SNIPPET_CHARS)}…[truncated]`
    : trimmed;
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return String(cause);
}

/**
 * AC6, second control. `scrubSecrets()` matches on the four known credential
 * PREFIXES (`runlog.ts`), which covers a Linear personal API key
 * (`lin_api_…`) but not, say, an OAuth access token that ALI-156 might make
 * necessary. This removes the credential this adapter actually holds, by
 * value, whatever shape it has. Both controls run on every message: prefix
 * matching catches credentials belonging to *other* systems that a response
 * body might echo, value matching catches ours.
 *
 * The primary control remains structural — this module never interpolates
 * `apiKey` into a message; it only ever goes into the `Authorization` header.
 */
function scrubCredential(text: string, apiKey: string): string {
  return apiKey.length >= 8 ? text.split(apiKey).join("[REDACTED]") : text;
}

/**
 * `Retry-After` is honoured but CAPPED at `maxDelayMs`: a server (or a
 * man-in-the-middle) asking us to sleep for an hour must not be able to park
 * an unattended run for an hour. Exponential backoff is the floor.
 */
function backoffDelayMs(attempt: number, retryAfterHeader: string | null, policy: RetryPolicy): number {
  const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
  const retryAfterSeconds = retryAfterHeader === null ? Number.NaN : Number.parseFloat(retryAfterHeader);
  const requested = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
    ? Math.max(exponential, retryAfterSeconds * 1_000)
    : exponential;
  return Math.min(requested, policy.maxDelayMs);
}

/**
 * The single HTTP path. Every exit is either parsed `data` or a
 * `LinearApiError` whose message has been through `scrubSecrets()` (AC6).
 *
 * Only rate limits are retried (AC5). A network failure, a timeout, a 5xx or
 * a GraphQL error fails immediately and loudly: this runs unattended behind
 * the Direction gate, where "stop and say why" beats "keep trying quietly".
 */
async function executeGraphQL(
  runtime: AdapterRuntime,
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { retry } = runtime;
  /** Every throw below goes through here: value-redaction, then `LinearApiError`'s prefix-scrub. */
  const failure = (message: string, options?: { cause?: unknown }): LinearApiError =>
    new LinearApiError(scrubCredential(message, runtime.apiKey), options);

  for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
    let response: HttpResponseLike;
    try {
      response = await runtime.fetchImpl(runtime.endpoint, {
        method: "POST",
        headers: {
          // Personal API key: NO "Bearer " prefix (see contract evidence above).
          Authorization: runtime.apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(runtime.requestTimeoutMs),
      });
    } catch (cause) {
      throw failure(
        `Linear API request failed (${operationName}, attempt ${attempt}/${retry.maxAttempts}): ` +
          `${describeCause(cause)}`,
        { cause },
      );
    }

    let bodyText: string;
    try {
      bodyText = await response.text();
    } catch (cause) {
      throw failure(
        `Linear API response body could not be read (${operationName}, HTTP ${response.status}): ` +
          `${describeCause(cause)}`,
        { cause },
      );
    }

    let envelope: GraphQLEnvelope | null = null;
    try {
      const parsed: unknown = JSON.parse(bodyText);
      envelope = asRecord(parsed) as GraphQLEnvelope | null;
    } catch {
      envelope = null;
    }

    if (isRateLimitedEnvelope(response.status, envelope)) {
      if (attempt >= retry.maxAttempts) {
        throw failure(
          `Linear API rate limit not cleared: gave up on ${operationName} after ${retry.maxAttempts} ` +
            `attempt(s) (HTTP ${response.status}). Retries are bounded on purpose — an unattended run ` +
            `must never spin against a rate limit. Last response: ${snippet(bodyText)}`,
        );
      }
      await runtime.sleep(backoffDelayMs(attempt, response.headers.get("retry-after"), retry));
      continue;
    }

    if (!response.ok) {
      throw failure(
        `Linear API returned HTTP ${response.status} for ${operationName}: ${snippet(bodyText)}`,
      );
    }
    if (envelope === null) {
      throw failure(
        `Linear API returned a non-JSON body for ${operationName} (HTTP ${response.status}): ${snippet(bodyText)}`,
      );
    }
    if (Array.isArray(envelope.errors) && envelope.errors.length > 0) {
      throw failure(
        `Linear API returned GraphQL errors for ${operationName}: ${renderGraphQLErrors(envelope)}`,
      );
    }

    const data = asRecord(envelope.data);
    if (data === null) {
      throw failure(
        `Linear API returned no \`data\` for ${operationName} (HTTP ${response.status}): ${snippet(bodyText)}`,
      );
    }
    return data;
  }

  /* c8 ignore next 4 -- unreachable: the loop either returns, throws, or exhausts into the rate-limit branch. */
  throw failure(
    `Linear API retry loop exited without a result for ${operationName} — this is a bug in the adapter.`,
  );
}

// ---------------------------------------------------------------------------
// `## Files touched (predicted)` parsing — AC4, the teeth
// ---------------------------------------------------------------------------

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Text under a level-2 markdown heading, up to the next level-2 heading or
 * end of string. `undefined` = the heading is absent; `""` = present but
 * empty. Deliberately a local copy of `blindqa.ts`'s `extractSection` (same
 * end-of-string subtlety, same reasoning) rather than a shared export:
 * this issue's predicted files are `linear.ts` and its test, and editing
 * `blindqa.ts` would put this change in a clustering lane it does not belong
 * in (CLAUDE.md "Concurrency"). Unifying the two is a follow-up, not a
 * drive-by.
 */
function extractSection(body: string, headingName: string): string | undefined {
  const pattern = new RegExp(
    `^##[ \\t]+${escapeRegExp(headingName)}[ \\t]*\\r?\\n([\\s\\S]*?)(?=\\r?\\n##[ \\t]+|(?![\\s\\S]))`,
    "m",
  );
  const match = body.match(pattern);
  return match ? match[1].trim() : undefined;
}

function looksLikePath(token: string): boolean {
  if (token === "" || /\s/.test(token)) return false;
  return token.includes("/") || /\.[A-Za-z0-9]+$/.test(token);
}

function splitPlainList(section: string): string[] {
  return section
    .split(/[\n,;·]+/)
    .map((line) => line.replace(/^\s*[-*+]\s+/, "").trim())
    .filter((line) => line !== "");
}

/**
 * AC4 — the load-bearing criterion. An issue whose `## Files touched
 * (predicted)` section cannot be parsed makes this THROW, naming the issue.
 * It never returns `[]`.
 *
 * Why a hard error and not a shrug: `sharesPredictedFile()`
 * (`plan.ts:171-175`) returns `false` whenever either side's list is empty,
 * so an issue with `predictedFiles: []` clusters with NOTHING — it gets its
 * own cluster and runs in a parallel lane against issues touching the same
 * files. That is precisely the head→base PR collision class ALI-133 was
 * filed to fix, reintroduced through the front door and silently. The engine
 * already holds this doctrine one level up: "A missing status is never the
 * same thing as an empty cycle" (`statusDriftMessage` above).
 */
export function parsePredictedFiles(issueIdentifier: string, body: string): string[] {
  const consequence =
    "An issue with no predicted files clusters with nothing (plan.ts sharesPredictedFile) and would run " +
    "in a parallel lane against issues touching the same files — the ALI-133 collision class. Fix the " +
    "issue body; this is never defaulted to an empty list.";

  const section = extractSection(body, PREDICTED_FILES_HEADING);
  if (section === undefined) {
    throw new LinearApiError(
      `${issueIdentifier}: no "## ${PREDICTED_FILES_HEADING}" heading found in the issue body. ${consequence}`,
    );
  }
  if (section === "") {
    throw new LinearApiError(
      `${issueIdentifier}: the "## ${PREDICTED_FILES_HEADING}" section is empty. ${consequence}`,
    );
  }

  const backticked = [...section.matchAll(/`([^`\n]+)`/g)].map((match) => match[1].trim());
  const candidates = backticked.length > 0 ? backticked : splitPlainList(section);

  const files: string[] = [];
  for (const candidate of candidates) {
    if (!looksLikePath(candidate)) continue;
    if (!files.includes(candidate)) files.push(candidate);
  }

  if (files.length === 0) {
    throw new LinearApiError(
      `${issueIdentifier}: the "## ${PREDICTED_FILES_HEADING}" section contains no parseable file path ` +
        `(read: ${JSON.stringify(snippet(section))}). ${consequence}`,
    );
  }
  return files;
}

// ---------------------------------------------------------------------------
// Issue mapping (AC3) and the read gate (AC2)
// ---------------------------------------------------------------------------

function connectionNodes(value: unknown): unknown[] | null {
  const record = asRecord(value);
  if (record === null) return null;
  return Array.isArray(record.nodes) ? record.nodes : null;
}

/**
 * AC2, client side. The GraphQL filter already asks Linear for exactly
 * `Ready` ∩ `cycleId` ∩ this team; this re-checks the answer. Defense in
 * depth on the gate that decides what executes unattended — the same "also
 * filter in app code" discipline the platform repo applies to `customer_id`.
 *
 * Non-matching rows are EXCLUDED, not thrown on: exclusion is the fail-closed
 * direction for a gate whose job is to admit less, and one anomalous row
 * should not halt an otherwise healthy run.
 */
function matchesReadGate(node: Record<string, unknown>, cycleId: string, teamId: string): boolean {
  const stateName = asRecord(node.state)?.name;
  if (stateName !== READY_STATE_NAME) return false;
  const nodeCycleId = asRecord(node.cycle)?.id;
  if (nodeCycleId !== cycleId) return false;
  const nodeTeamId = asRecord(node.team)?.id;
  return nodeTeamId === undefined || nodeTeamId === teamId;
}

function readLabelNames(node: Record<string, unknown>, identifier: string): string[] {
  const nodes = connectionNodes(node.labels);
  if (nodes === null) {
    // Not defaulted to `[]` on purpose: labels carry the risk half of
    // `max(pointsTier, riskTier)`. A silently empty label list drops an
    // `external-api` issue below its risk floor and skips the mandatory
    // security pass — the same class of silent failure as AC4, one field over.
    throw new LinearApiError(
      `${identifier}: Linear returned no \`labels\` connection. Labels drive the risk tier and the ` +
        "mandatory security pass (CLAUDE.md \"Routing\") — an empty label list is never assumed.",
    );
  }
  return nodes.map((label) => {
    const name = asRecord(label)?.name;
    if (typeof name !== "string") {
      throw new LinearApiError(`${identifier}: Linear returned a label with no \`name\`.`);
    }
    return name;
  });
}

/**
 * `blockedBy` = the issues that block THIS one. In Linear that is the
 * *inverse* side of a `blocks` relation: for "A blocks B", the single
 * relation row has `issue = A`, `relatedIssue = B`, `type = "blocks"`, so it
 * appears in B's `inverseRelations` and the blocker is `issue.identifier`.
 * Reading `relations` instead would return what this issue blocks — the
 * dependency edge pointing the wrong way, which `plan.ts` would then order
 * backwards.
 */
function readBlockedBy(node: Record<string, unknown>, identifier: string): string[] {
  const nodes = connectionNodes(node.inverseRelations);
  if (nodes === null) {
    throw new LinearApiError(
      `${identifier}: Linear returned no \`inverseRelations\` connection — dependency order (plan.ts) ` +
        "is derived from it, so an empty list is never assumed.",
    );
  }
  const blockers: string[] = [];
  for (const relation of nodes) {
    const record = asRecord(relation);
    if (record?.type !== BLOCKS_RELATION_TYPE) continue;
    const blockerId = asRecord(record.issue)?.identifier;
    if (typeof blockerId !== "string" || blockerId === "") {
      throw new LinearApiError(`${identifier}: a \`blocks\` relation has no source issue identifier.`);
    }
    if (!blockers.includes(blockerId)) blockers.push(blockerId);
  }
  return blockers;
}

/**
 * AC3: one Linear issue node → `LinearIssue`, every field populated from the
 * API. Throws (never partially fills) on anything it cannot map — an issue
 * the dispatcher cannot price or partition is not a candidate, it is a defect
 * in the board that must surface.
 */
export function mapIssueNode(rawNode: unknown): LinearIssue {
  const node = asRecord(rawNode);
  if (node === null) {
    throw new LinearApiError("Linear returned an issue node that is not an object.");
  }

  const identifier = node.identifier;
  if (typeof identifier !== "string" || identifier.trim() === "") {
    throw new LinearApiError(
      "Linear returned an issue with no `identifier`. Every downstream record (run log, worktree branch, " +
        "PR body) keys on it, so it is never synthesised.",
    );
  }

  const title = node.title;
  if (typeof title !== "string") {
    throw new LinearApiError(`${identifier}: Linear returned no \`title\`.`);
  }

  const estimate = node.estimate;
  if (typeof estimate !== "number" || !Number.isFinite(estimate)) {
    // Fail-closed by analogy to AC4: `Issue.estimate` is nullable in Linear's
    // schema, and a `Ready` issue with no estimate is unpriced work. Defaulting
    // it to 0 would make it free against the budget gate and admit it on every
    // run forever — a silent gate failure, not a missing nicety.
    throw new LinearApiError(
      `${identifier}: is in state ${READY_STATE_NAME} with no numeric \`estimate\`. Points are the budget ` +
        "gate's only input (docs/ENGINE.md §4) — unpriced work is never admitted at a default of 0. " +
        "Estimate the issue in Linear, or move it out of Ready.",
    );
  }

  const priority = node.priority;
  if (typeof priority !== "number" || !Number.isFinite(priority)) {
    throw new LinearApiError(`${identifier}: Linear returned a non-numeric \`priority\`.`);
  }

  const body = typeof node.description === "string" ? node.description : "";

  return {
    id: identifier,
    title,
    points: estimate,
    priority,
    labels: readLabelNames(node, identifier),
    blockedBy: readBlockedBy(node, identifier),
    predictedFiles: parsePredictedFiles(identifier, body),
    body,
    state: READY_STATE_NAME,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const WORKFLOW_STATES_QUERY = `
  query DispatcherWorkflowStates($teamId: String!, $first: Int!, $after: String) {
    team(id: $teamId) {
      states(first: $first, after: $after) {
        nodes { name }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

/**
 * `cycle(id:)` is selected alongside `issues` in the SAME document — one
 * round trip, and it is the reason an unresolvable cycle id can never be read
 * as "the cycle is empty": `Query.cycle` is non-null in Linear's schema, so
 * an id Linear cannot resolve comes back as a GraphQL error rather than as
 * zero rows.
 */
const READY_ISSUES_QUERY = `
  query DispatcherReadyIssues($cycleId: String!, $filter: IssueFilter!, $first: Int!, $after: String) {
    cycle(id: $cycleId) { id }
    issues(filter: $filter, first: $first, after: $after) {
      nodes {
        identifier
        title
        estimate
        priority
        description
        state { name }
        cycle { id }
        team { id }
        labels(first: ${PAGE_SIZE}) { nodes { name } }
        inverseRelations(first: ${PAGE_SIZE}) { nodes { type issue { identifier } } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

interface PageCursor {
  hasNextPage: boolean;
  endCursor: string | null;
}

function readPageInfo(connection: Record<string, unknown>): PageCursor {
  const pageInfo = asRecord(connection.pageInfo);
  const hasNextPage = pageInfo?.hasNextPage === true;
  const endCursor = typeof pageInfo?.endCursor === "string" ? pageInfo.endCursor : null;
  return { hasNextPage, endCursor };
}

// ---------------------------------------------------------------------------
// Loud stubs (AC8) — the four methods this issue does NOT wire
// ---------------------------------------------------------------------------

/**
 * ALI-155's other half: a stub is named debt, not an implementation. Each
 * message names the issue that wires it, says it is a stub, and says what
 * returning a value instead would cost. None of them carries the old
 * "not wired in this PR" text, which named no owner and so aged into
 * furniture.
 */
function loudStub(method: string, owningIssue: string, consequence: string): () => never {
  return (): never => {
    throw new LinearApiError(
      `LinearPort.${method}() is a STUB — not implemented by the read-half adapter (ALI-158). ` +
        `It is wired by ${owningIssue}. ${consequence} Until ${owningIssue} lands this method fails ` +
        "loudly by design (docs/ENGINE.md §6, loud stubs).",
    );
  };
}

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/**
 * Real `LinearPort` adapter — READ half (ALI-158).
 *
 * Implemented here: `getWorkflowStatuses`, `getReadyIssuesInCycle`, and the
 * issue→`LinearIssue` mapping. The write half (`setIssueStatus`,
 * `addComment`) is ALI-159; the cycle-approval surface (`getApprovedCycle`,
 * `postCycleSummary`) is ALI-163, itself blocked on ALI-156 naming the
 * approval token. Those four are loud stubs, by name (AC8).
 */
export function createLinearApiPort(config: LinearApiConfig): LinearPort {
  const runtime = validateConfig(config);

  return {
    async getWorkflowStatuses(): Promise<string[]> {
      const names: string[] = [];
      let after: string | null = null;

      for (let page = 1; page <= MAX_PAGES; page++) {
        const data = await executeGraphQL(runtime, "DispatcherWorkflowStates", WORKFLOW_STATES_QUERY, {
          teamId: runtime.teamId,
          first: PAGE_SIZE,
          after,
        });

        const team = asRecord(data.team);
        const states = asRecord(team?.states);
        const nodes = states === null ? null : connectionNodes(states);
        if (team === null || states === null || nodes === null) {
          throw new LinearApiError(
            `Linear returned no workflow states for team ${runtime.teamId}. The dispatcher matches on ` +
              "literal status names (docs/ENGINE.md §3) — an unreadable workflow is never read as an " +
              "empty one.",
          );
        }

        for (const stateNode of nodes) {
          const name = asRecord(stateNode)?.name;
          if (typeof name !== "string") {
            throw new LinearApiError(`Linear returned a workflow state with no \`name\` for team ${runtime.teamId}.`);
          }
          names.push(name);
        }

        const { hasNextPage, endCursor } = readPageInfo(states);
        if (!hasNextPage || endCursor === null) return names;
        after = endCursor;
      }

      throw new LinearApiError(
        `Workflow-state pagination for team ${runtime.teamId} exceeded ${MAX_PAGES} pages — refusing to ` +
          "keep paging. A truncated status list would silently change which statuses the drift check sees.",
      );
    },

    async getReadyIssuesInCycle(cycleId: string): Promise<LinearIssue[]> {
      if (typeof cycleId !== "string" || cycleId.trim() === "") {
        throw new LinearApiError(
          "getReadyIssuesInCycle() was called with an empty cycle id. The Direction gate fails closed: " +
            "no cycle, no candidates — and an empty id is never treated as 'any cycle'.",
        );
      }

      const filter = {
        team: { id: { eq: runtime.teamId } },
        cycle: { id: { eq: cycleId } },
        state: { name: { eq: READY_STATE_NAME } },
      };

      const issues: LinearIssue[] = [];
      let after: string | null = null;

      for (let page = 1; page <= MAX_PAGES; page++) {
        const data = await executeGraphQL(runtime, "DispatcherReadyIssues", READY_ISSUES_QUERY, {
          cycleId,
          filter,
          first: PAGE_SIZE,
          after,
        });

        // Belt to the schema's braces: `Query.cycle` is non-null, so real
        // Linear errors on an id it cannot resolve rather than returning
        // null. If a proxy or a future schema change ever softened that, an
        // unresolvable cycle would arrive as zero rows — indistinguishable
        // from an approved-but-empty cycle. It is checked, not assumed.
        const cycleNode = asRecord(data.cycle);
        if (cycleNode === null || typeof cycleNode.id !== "string") {
          throw new LinearApiError(
            `Linear returned no cycle for id ${cycleId}. An unresolvable cycle is never read as an empty ` +
              "cycle — the run must fail closed instead of quietly building nothing.",
          );
        }

        const connection = asRecord(data.issues);
        const nodes = connection === null ? null : connectionNodes(connection);
        if (connection === null || nodes === null) {
          throw new LinearApiError(`Linear returned no \`issues\` connection for cycle ${cycleId}.`);
        }

        for (const rawNode of nodes) {
          const node = asRecord(rawNode);
          if (node === null) {
            throw new LinearApiError(`Linear returned an issue node that is not an object for cycle ${cycleId}.`);
          }
          // Gate first, map second: a row the gate excludes must not be able
          // to fail the run by having an unparseable body.
          if (!matchesReadGate(node, cycleId, runtime.teamId)) continue;
          issues.push(mapIssueNode(node));
        }

        const { hasNextPage, endCursor } = readPageInfo(connection);
        if (!hasNextPage || endCursor === null) return issues;
        after = endCursor;
      }

      throw new LinearApiError(
        `Ready-issue pagination for cycle ${cycleId} exceeded ${MAX_PAGES} pages — refusing to keep paging. ` +
          "A truncated candidate list would silently change what the run builds.",
      );
    },

    getApprovedCycle: loudStub(
      "getApprovedCycle",
      "ALI-163",
      "Returning a cycle from a stub would forge the Direction gate's admission ticket — the one thing " +
        "that must never be synthesised (ALI-156 names the approval token first).",
    ),
    setIssueStatus: loudStub(
      "setIssueStatus",
      "ALI-159",
      "Silently succeeding would leave Linear's board disagreeing with what actually ran, which is the " +
        "state the verify-and-correct half exists to prevent.",
    ),
    addComment: loudStub(
      "addComment",
      "ALI-159",
      "Escalations and blind-QA skip notices are posted through it; a silent no-op would drop the " +
        "escalation path (docs/ENGINE.md §12).",
    ),
    postCycleSummary: loudStub(
      "postCycleSummary",
      "ALI-163",
      "The run log's human-readable half would silently vanish, leaving a run with no decision record " +
        "where Pedro looks for one.",
    ),
  };
}
