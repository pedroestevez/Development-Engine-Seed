/**
 * Dispatcher runtime — the real `AgentPort` adapter for the build seats
 * (ALI-161: builder, reviewer, security).
 *
 * `run.ts` is the run loop; this file is everything about *invoking a seat*:
 * prompt assembly, subprocess management, output parsing, and the
 * per-dispatch timeout. Kept separate on purpose — a change to how a seat is
 * invoked and a change to how the run loop sequences seats are different
 * concerns, and clustering them into one file would put every future
 * agent-adapter change in the same lane as every future run-loop change.
 *
 * Three properties are enforced **here and nowhere else**:
 *
 *   1. **The pinned engine tree is the only source of `.claude/**`.** The
 *      seat's definition is read from `DispatchContext.enginePath` — the
 *      run's read-only detached checkout at its resolved pin (ALI-104) — and
 *      never from `worktreePath`, which is mutable and, in this repo, is
 *      routinely *the thing being edited* (docs/ENGINE.md §16: "a builder
 *      issue here legitimately edits `.claude/**` as its actual work"). If
 *      the definition came from the worktree, a run could rewrite the
 *      instructions it is currently executing under, mid-run — the loop
 *      changing the loop, with no diff anyone reads. If `enginePath` is
 *      missing or unreadable this adapter **throws**; there is deliberately
 *      no fallback path to the worktree, because a fallback is exactly the
 *      silent failure the pin exists to prevent.
 *
 *   2. **Every seat's model is explicit.** `--model <id>` is always on the
 *      argv, derived from the issue's computed tier
 *      (`modelTier()`, `max(pointsTier, riskTier)`), never inherited from
 *      whatever session or environment happens to spawn the run (ALI-121
 *      comment 77ef5c9b: trigger-spawned sessions inherit the creating
 *      session's model by default, which would bypass the routing rule at
 *      the session level). `plan()` has always *computed* the tier; this is
 *      the code that finally *applies* it.
 *
 *   3. **A seat cannot hang the run.** The hard backstop is checked at seat
 *      boundaries only (`run.ts`'s `isBeyondHard()` calls), so a seat that
 *      never returns would hold the run past `wallClockHardMs` forever and
 *      the parked-work guarantee would never fire. Every dispatch is bounded
 *      by a wall-clock timeout that kills the child and throws.
 *
 * Ports and adapters, same discipline as `run.ts`: the subprocess boundary is
 * the injected `ProcessRunner`, so every criterion above is testable without
 * spawning a real CLI. The filesystem read of the pinned definition is *not*
 * injected — it is the property under test, and proving it against real
 * directories (two trees holding different text) is stronger than proving it
 * against a fake reader.
 */

import { spawn as spawnProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { modelTier } from "./plan.js";
import { containsSecretLike, scrubSecrets, type SeatEffort } from "./runlog.js";
import type {
  AgentDispatchResult,
  AgentPort,
  BlindQaDispatchResult,
  BounceDetail,
  DispatchContext,
  Seat,
} from "./run.js";
import type { ModelTier } from "./types.js";

// ---------------------------------------------------------------------------
// The subprocess boundary (injected)
// ---------------------------------------------------------------------------

export interface ProcessSpec {
  command: string;
  args: readonly string[];
  /** Working directory for the child. Always the *mutable* worktree — that is where the work happens. */
  cwd: string;
  /** Complete child environment. Built by `buildSeatEnv()` — never a copy of the parent's. */
  env: Readonly<Record<string, string>>;
  /**
   * The assembled prompt, handed to the child on **stdin** rather than argv.
   * Two reasons, both deliberate: argv is world-readable via `ps`, and argv
   * has a length limit a full seat definition plus issue body would breach.
   */
  stdin: string;
}

export interface ProcessResult {
  /** `null` when the child was killed by a signal rather than exiting. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface ProcessHandle {
  /**
   * Settles when the child exits. A hung child never settles this — that is
   * precisely why `dispatch` races it against a timer instead of awaiting it
   * (property 3 above).
   */
  readonly exited: Promise<ProcessResult>;
  /** Terminates the child. Must be safe to call more than once, and after exit. */
  kill(): void;
}

export interface ProcessRunner {
  spawn(spec: ProcessSpec): ProcessHandle;
}

// ---------------------------------------------------------------------------
// Named errors — every failure this adapter can produce is one of these, and
// every one of them is loud. Nothing here degrades into a clean `{ summary }`:
// a seat result with no `ambiguous` field routes an issue to `In Review`
// (`run.ts`'s `finalizeOpenedPr`), so inventing one for a dispatch that
// actually failed would send a genuinely-blocked issue to review instead of
// Needs Pedro — the silent-success class ALI-155 names, applied to the
// "never guess on ambiguity" conduct rule.
// ---------------------------------------------------------------------------

/** Base class for every failure raised by this adapter, so callers can catch the family. */
export class AgentDispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentDispatchError";
  }
}

/** The seat name is not one of the three build seats (also guards the definition path against traversal). */
export class UnknownSeatError extends AgentDispatchError {
  constructor(readonly seat: string) {
    super(
      `unknown seat ${JSON.stringify(seat)} — the build seats are ${BUILD_SEATS.join(", ")}. ` +
        "The blind test-author is a different method (dispatchBlindQa, ALI-162), never a seat name here.",
    );
    this.name = "UnknownSeatError";
  }
}

/**
 * The seat's definition could not be read from the run's pinned engine tree.
 * Terminal by design: there is no fallback to `worktreePath` (property 1).
 */
export class EngineDefinitionUnreadableError extends AgentDispatchError {
  constructor(
    readonly definitionPath: string,
    cause: unknown,
  ) {
    super(
      `cannot read seat definition from the run's pinned engine tree (${definitionPath}): ` +
        `${cause instanceof Error ? cause.message : String(cause)}. ` +
        "Refusing to dispatch: the pinned tree is the only legal source of .claude/** for a seat " +
        "(ALI-104 AC2, docs/ENGINE.md §16) — falling back to the mutable worktree would let a run " +
        "execute under instructions it is itself editing.",
    );
    this.name = "EngineDefinitionUnreadableError";
    this.cause = cause;
  }
}

/** The seat exited non-zero. Never reported as a clean result. */
export class SeatProcessFailedError extends AgentDispatchError {
  constructor(
    readonly seat: Seat,
    readonly exitCode: number | null,
    /** Already scrubbed (AC7) — safe to log. */
    readonly stderrExcerpt: string,
  ) {
    super(
      `seat ${seat} exited ${exitCode === null ? "on a signal" : `with code ${exitCode}`}` +
        (stderrExcerpt ? `: ${stderrExcerpt}` : ""),
    );
    this.name = "SeatProcessFailedError";
  }
}

/**
 * The seat's stdout carried no parseable result envelope, or one that did not
 * validate. `bounced` and `ambiguous.question` are set **only** from the
 * explicit structured signal below — never inferred from free text — so a
 * seat whose output cannot be parsed is a failure, not an empty success.
 */
export class SeatOutputParseError extends AgentDispatchError {
  constructor(
    readonly seat: Seat,
    reason: string,
  ) {
    super(
      `seat ${seat} produced no valid result envelope: ${reason}. ` +
        `Expected exactly one line beginning ${SEAT_RESULT_SENTINEL} followed by a JSON object. ` +
        "Refusing to report a clean summary for output this runtime cannot understand — " +
        "`bounced` and `ambiguous` are only ever read from that envelope, never inferred from prose.",
    );
    this.name = "SeatOutputParseError";
  }
}

/** The per-dispatch wall-clock limit fired; the child was killed. */
export class SeatDispatchTimeoutError extends AgentDispatchError {
  constructor(
    readonly seat: Seat,
    readonly timeoutMs: number,
  ) {
    super(
      `seat ${seat} exceeded its per-dispatch limit of ${timeoutMs}ms and was killed. ` +
        "The run's hard backstop is only checked at seat boundaries, so an unbounded seat would " +
        "hold the run past wallClockHardMs indefinitely and the parked-work guarantee would never fire.",
    );
    this.name = "SeatDispatchTimeoutError";
  }
}

/** Loud stub (ALI-155): the blind QA seat's real adapter is ALI-162's scope, not this issue's. */
export class BlindQaNotWiredError extends Error {
  constructor() {
    super(
      "AgentPort.dispatchBlindQa is a LOUD STUB in this adapter — ALI-161 wires the build seats " +
        "(builder/reviewer/security) only. ALI-162 wires the blind test-author seat: it takes a " +
        "different context type (BlindDispatchContext, see blindqa.ts) and carries a different " +
        "isolation requirement — nothing describing the implementation may reach it — so it is " +
        "deliberately NOT routed through dispatch(). Do not make this method delegate to dispatch().",
    );
    this.name = "BlindQaNotWiredError";
  }
}

// ---------------------------------------------------------------------------
// Seats and the model pin
// ---------------------------------------------------------------------------

/** The three seats this adapter invokes. `blindQa` is deliberately absent — different method, different context type. */
export const BUILD_SEATS: readonly Seat[] = ["builder", "reviewer", "security"] as const;

const BUILD_SEAT_SET: ReadonlySet<string> = new Set(BUILD_SEATS);

export function isBuildSeat(value: string): value is Seat {
  return BUILD_SEAT_SET.has(value);
}

/**
 * Engine tier → the **concrete model id** passed as `--model`.
 *
 * Deliberately concrete ids rather than the CLI's floating family aliases
 * (`opus`, `sonnet`, `haiku`): an alias is a mutable pointer, and this repo
 * already settled that argument for action pins (ALI-144 — pin the SHA, not
 * the tag) for the same reason. A run that records `tier: "opus"` should be
 * reproducible against the model it actually ran on, and a family alias
 * silently re-points when a new model ships mid-cycle.
 *
 * This table is the single place to bump when the engine adopts a newer
 * model — a bump is an engine change and goes through the Amendment gate
 * like any other.
 */
export const TIER_MODEL_IDS: Readonly<Record<ModelTier, string>> = Object.freeze({
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-5",
});

/** Every model id this adapter will ever pass — the faithful fake validates against exactly this set. */
export const PINNED_MODEL_IDS: readonly string[] = Object.freeze(Object.values(TIER_MODEL_IDS));

/**
 * Builds the argv for one seat invocation. Small on purpose: the prompt (seat
 * definition + issue facts + output contract) travels on stdin, so argv
 * carries only the two things that must be *inspectable* from outside the
 * process — which model is pinned, and which seat is running.
 *
 * `--print` is the CLI's non-interactive mode (prompt read from stdin).
 * `--model` is property 2. `--agent` labels the seat; the definition text
 * itself is inlined in the prompt from the pinned tree rather than left to
 * cwd discovery, because cwd is the *worktree* — discovery there is exactly
 * the self-modification hole property 1 closes.
 */
export function buildSeatArgv(seat: Seat, modelId: string): string[] {
  return ["--print", "--model", modelId, "--agent", seat];
}

/** Reads `--model`'s value out of a recorded argv. Exported so tests (and ALI-162) assert on the pin, not on argv shape. */
export function modelArgFrom(args: readonly string[]): string | undefined {
  const index = args.indexOf("--model");
  if (index < 0) return undefined;
  return args[index + 1];
}

/** Reads `--agent`'s value out of a recorded argv (same reasoning as `modelArgFrom`). */
export function seatArgFrom(args: readonly string[]): string | undefined {
  const index = args.indexOf("--agent");
  if (index < 0) return undefined;
  return args[index + 1];
}

// ---------------------------------------------------------------------------
// Child environment (AC7, second half)
// ---------------------------------------------------------------------------

/**
 * The **only** variables a seat's child process inherits. An allowlist, not a
 * denylist: a denylist silently passes every credential someone adds to the
 * run environment later, and the run environment holds several the seat has
 * no business seeing — the Linear and GitHub credentials belong to the run
 * loop's own ports (`LinearPort`, `GitHubPort`), not to the agent. A seat
 * needs enough to run git and tests (`PATH`, `HOME`, locale/TZ) plus its own
 * model credential, and nothing else.
 */
export const SEAT_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  "PATH",
  "HOME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TZ",
  "TMPDIR",
  // The seat's own model credential. Never the run's Linear/GitHub tokens.
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
]);

/**
 * Projects a parent environment down to `SEAT_ENV_ALLOWLIST`. Pure: takes the
 * source explicitly so the projection is testable without mutating
 * `process.env`.
 */
export function buildSeatEnv(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SEAT_ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

// ---------------------------------------------------------------------------
// The result envelope the seat must emit (AC5)
// ---------------------------------------------------------------------------

/**
 * Every seat ends its run by printing exactly one line of this shape:
 *
 *   ENGINE-SEAT-RESULT: {"summary":"…","bounced":false}
 *
 * A sentinel line rather than "parse the whole of stdout as JSON" because a
 * seat's stdout legitimately carries its own narration; and *exactly one*
 * rather than "the last one wins" because two envelopes mean the runtime
 * cannot tell which is authoritative, and guessing there is the same defect
 * class as guessing on ambiguity.
 */
export const SEAT_RESULT_SENTINEL = "ENGINE-SEAT-RESULT:";

const MODEL_TIERS: readonly ModelTier[] = ["haiku", "sonnet", "opus"];
const SEAT_EFFORTS: readonly SeatEffort[] = ["standard", "lint", "judgment"];
const BOUNCE_STAGES = ["lint", "judgment"] as const;

/** Fields the envelope may carry. Anything else is rejected — see `parseSeatResult`. */
const ENVELOPE_KEYS: readonly string[] = [
  "summary",
  "bounced",
  "bounceDetail",
  "ambiguous",
  "tokensUsed",
  "model",
  "effort",
];

const BOUNCE_DETAIL_KEYS: readonly string[] = [
  "detectedAtStage",
  "detectorTokens",
  "reworkTokens",
  "reason",
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

/**
 * Strictly parses the seat's stdout into an `AgentDispatchResult`, or throws
 * `SeatOutputParseError`. Strict in both directions:
 *
 *   - A missing/duplicated/unparseable envelope is an error, never an empty
 *     success (AC5).
 *   - An **unrecognized field** is also an error. A seat emitting a field
 *     this runtime does not understand is a seat speaking a protocol the
 *     runtime does not implement; accepting it silently drops whatever the
 *     field was trying to say — which, if it were a future
 *     `blocked`/`needsHuman` signal, is the silent-success failure again.
 *
 * `scrubSecrets` (AC7) is applied to every string that survives into the
 * result, so nothing secret-shaped can reach a summary, the run log, or a
 * Linear comment.
 */
export function parseSeatResult(seat: Seat, stdout: string): AgentDispatchResult {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(SEAT_RESULT_SENTINEL));

  if (lines.length === 0) throw new SeatOutputParseError(seat, "no result line found in stdout");
  if (lines.length > 1) {
    throw new SeatOutputParseError(
      seat,
      `${lines.length} result lines found — exactly one is required, so the authoritative result is unambiguous`,
    );
  }

  const payload = lines[0].slice(SEAT_RESULT_SENTINEL.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (cause) {
    throw new SeatOutputParseError(
      seat,
      `result line is not valid JSON (${cause instanceof Error ? cause.message : String(cause)})`,
    );
  }

  if (!isPlainObject(parsed)) throw new SeatOutputParseError(seat, "result line is not a JSON object");

  const extra = unknownKeys(parsed, ENVELOPE_KEYS);
  if (extra.length > 0) {
    throw new SeatOutputParseError(
      seat,
      `unrecognized field(s) ${extra.join(", ")} — this runtime cannot honor a signal it does not implement`,
    );
  }

  if (typeof parsed.summary !== "string" || parsed.summary.trim() === "") {
    throw new SeatOutputParseError(seat, "`summary` is required and must be a non-empty string");
  }

  const result: AgentDispatchResult = { summary: scrubSecrets(parsed.summary) };

  if (parsed.bounced !== undefined) {
    if (typeof parsed.bounced !== "boolean") {
      throw new SeatOutputParseError(seat, "`bounced` must be a boolean when present");
    }
    result.bounced = parsed.bounced;
  }

  if (parsed.bounceDetail !== undefined) {
    result.bounceDetail = parseBounceDetail(seat, parsed.bounceDetail);
  }

  if (parsed.ambiguous !== undefined) {
    if (!isPlainObject(parsed.ambiguous)) {
      throw new SeatOutputParseError(seat, "`ambiguous` must be an object when present");
    }
    const ambiguousExtra = unknownKeys(parsed.ambiguous, ["question"]);
    if (ambiguousExtra.length > 0) {
      throw new SeatOutputParseError(seat, `\`ambiguous\` has unrecognized field(s) ${ambiguousExtra.join(", ")}`);
    }
    if (typeof parsed.ambiguous.question !== "string" || parsed.ambiguous.question.trim() === "") {
      throw new SeatOutputParseError(
        seat,
        "`ambiguous.question` is required and must be a non-empty string — an ambiguity with no question " +
          "cannot be escalated, and this runtime never invents one",
      );
    }
    result.ambiguous = { question: scrubSecrets(parsed.ambiguous.question) };
  }

  if (parsed.tokensUsed !== undefined) {
    if (typeof parsed.tokensUsed !== "number" || !Number.isFinite(parsed.tokensUsed) || parsed.tokensUsed < 0) {
      throw new SeatOutputParseError(seat, "`tokensUsed` must be a finite, non-negative number when present");
    }
    result.tokensUsed = parsed.tokensUsed;
  }

  // ALI-106 AC3: `model` is what the seat *reports* it ran at, and this
  // adapter deliberately does NOT fill it in from the tier it pinned. The
  // whole point of the field is that a run can show a seat having run at a
  // different tier than the routing table predicted; defaulting it to the
  // prediction would make that impossible to observe.
  if (parsed.model !== undefined) {
    if (typeof parsed.model !== "string" || !MODEL_TIERS.includes(parsed.model as ModelTier)) {
      throw new SeatOutputParseError(seat, `\`model\` must be one of ${MODEL_TIERS.join("|")} when present`);
    }
    result.model = parsed.model as ModelTier;
  }

  if (parsed.effort !== undefined) {
    if (typeof parsed.effort !== "string" || !SEAT_EFFORTS.includes(parsed.effort as SeatEffort)) {
      throw new SeatOutputParseError(seat, `\`effort\` must be one of ${SEAT_EFFORTS.join("|")} when present`);
    }
    result.effort = parsed.effort as SeatEffort;
  }

  return result;
}

function parseBounceDetail(seat: Seat, value: unknown): BounceDetail {
  if (!isPlainObject(value)) throw new SeatOutputParseError(seat, "`bounceDetail` must be an object when present");

  const extra = unknownKeys(value, BOUNCE_DETAIL_KEYS);
  if (extra.length > 0) {
    throw new SeatOutputParseError(seat, `\`bounceDetail\` has unrecognized field(s) ${extra.join(", ")}`);
  }

  const stage = value.detectedAtStage;
  if (typeof stage !== "string" || !(BOUNCE_STAGES as readonly string[]).includes(stage)) {
    throw new SeatOutputParseError(seat, `\`bounceDetail.detectedAtStage\` must be one of ${BOUNCE_STAGES.join("|")}`);
  }

  const numeric = (key: "detectorTokens" | "reworkTokens"): number => {
    const raw = value[key];
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
      throw new SeatOutputParseError(seat, `\`bounceDetail.${key}\` must be a finite, non-negative number`);
    }
    return raw;
  };

  if (typeof value.reason !== "string" || value.reason.trim() === "") {
    throw new SeatOutputParseError(seat, "`bounceDetail.reason` must be a non-empty string");
  }

  return {
    detectedAtStage: stage as BounceDetail["detectedAtStage"],
    detectorTokens: numeric("detectorTokens"),
    reworkTokens: numeric("reworkTokens"),
    reason: scrubSecrets(value.reason),
  };
}

// ---------------------------------------------------------------------------
// Prompt assembly — read only from the pinned engine tree (AC3)
// ---------------------------------------------------------------------------

/** Where a seat's definition lives inside the pinned tree, relative to its root. */
export function seatDefinitionRelativePath(seat: Seat): string {
  return join(".claude", "agents", `${seat}.md`);
}

/**
 * `Issue` (the type the whole dispatch pipeline is declared against) carries
 * no `body` — only `LinearIssue` does. Same single, explicit reach `run.ts`
 * makes for the same reason: widening `Issue` would leak `body` into every
 * pure planning function that takes one.
 */
function issueBody(issue: DispatchContext["issue"]): string {
  const body = (issue as { body?: unknown }).body;
  return typeof body === "string" ? body : "";
}

/**
 * Assembles the seat's prompt: the pinned definition first, then the issue's
 * facts, then the output contract.
 *
 * Order is a trust boundary, not formatting. The seat's *instructions* come
 * from the pinned tree (`<seat>`); the issue's title and body come from Linear
 * and are therefore lower-trust input — they are enclosed in their own
 * `<issue>` element so the seat reads them as the work item, not as further
 * instructions. Nothing in this function can add to what the pinned definition
 * says a seat may do; that remains a property of the pin and of the seat's own
 * tool allowlist (e.g. `.claude/agents/qa.md`), never of prompt text.
 */
function renderPrompt(params: {
  seat: Seat;
  ctx: DispatchContext;
  definition: string;
  definitionPath: string;
  modelId: string;
}): string {
  const { seat, ctx, definition, definitionPath, modelId } = params;
  const { issue } = ctx;
  const body = issueBody(issue);

  return [
    `<seat name="${seat}" model="${modelId}">`,
    `<!-- Read verbatim from this run's pinned engine tree: ${definitionPath}.`,
    "     Never from the worktree — that tree is mutable and may be the very thing this issue edits. -->",
    definition.trimEnd(),
    "</seat>",
    "",
    `<issue id="${issue.id}" points="${issue.points}" labels="${issue.labels.join(",")}">`,
    `title: ${issue.title}`,
    `predicted files: ${issue.predictedFiles.join(", ") || "(none recorded)"}`,
    `blocked by: ${issue.blockedBy.join(", ") || "(nothing)"}`,
    body ? `\n${body.trimEnd()}` : "\n(no issue body recorded)",
    "</issue>",
    "",
    `<workspace worktree="${ctx.worktreePath}" branch="${ctx.branch}" engine-tree="${ctx.enginePath}" />`,
    "",
    "<output-contract>",
    `End your run by printing EXACTLY ONE line of the form:`,
    `${SEAT_RESULT_SENTINEL} {"summary":"…"}`,
    "",
    "The JSON object accepts only these fields:",
    '  summary       (string, required)  — one-line outcome, the seat detail the run log records.',
    '  bounced       (boolean)           — this stage required a rework round.',
    '  bounceDetail  ({detectedAtStage:"lint"|"judgment", detectorTokens, reworkTokens, reason}).',
    '  ambiguous     ({question})        — an unresolvable ambiguity. Set this rather than guessing;',
    "                                      it is the only thing that routes the issue to Needs Pedro.",
    '  tokensUsed    (number)            — tokens this dispatch consumed.',
    '  model         ("haiku"|"sonnet"|"opus") — the tier you ACTUALLY ran at, as you observe it.',
    '  effort        ("standard"|"lint"|"judgment").',
    "",
    "Any other field, a missing summary, a second result line, or a non-zero exit is a hard failure:",
    "the runtime refuses the dispatch rather than reporting a clean result it cannot substantiate.",
    "</output-contract>",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/**
 * Per-dispatch wall-clock limit. 20 minutes: comfortably longer than a real
 * seat needs, and short enough that several seats plus their overhead still
 * fit inside the run's 4h soft backstop, so this timeout only ever fires on a
 * genuinely stuck seat rather than pre-empting the run-level backstop.
 */
export const DEFAULT_SEAT_TIMEOUT_MS = 20 * 60 * 1000;

/** Default executable. Overridable so a deployment can pin an absolute path. */
export const DEFAULT_AGENT_COMMAND = "claude";

/** How much scrubbed stderr a failure message carries. Bounded so a chatty crash cannot flood the run log. */
const STDERR_EXCERPT_LIMIT = 2000;

export interface ClaudeCliAgentConfig {
  /** The injected subprocess boundary. `createNodeProcessRunner()` is the real one. */
  runner: ProcessRunner;
  /** Per-dispatch wall-clock limit in ms. Defaults to `DEFAULT_SEAT_TIMEOUT_MS`. Must be > 0. */
  timeoutMs?: number;
  /** Executable to invoke. Defaults to `DEFAULT_AGENT_COMMAND`. */
  command?: string;
  /**
   * Environment the child's env is projected from (see `buildSeatEnv`).
   * Defaults to `process.env`. Injectable so the projection is provable
   * without mutating the test process's own environment.
   */
  envSource?: Readonly<Record<string, string | undefined>>;
}

/**
 * The real `AgentPort` for the build seats. Replaces the throw-only stub this
 * port carried since ALI-103 — with one method still stubbed, loudly and by
 * name: `dispatchBlindQa` is ALI-162's scope (AC9).
 */
export function createClaudeCliAgentPort(config: ClaudeCliAgentConfig): AgentPort {
  const timeoutMs = config.timeoutMs ?? DEFAULT_SEAT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new AgentDispatchError(
      `invalid per-dispatch timeout ${String(config.timeoutMs)} — a seat with no finite bound could hold ` +
        "the run past its hard backstop forever, which is the defect this timeout exists to prevent",
    );
  }
  const command = config.command ?? DEFAULT_AGENT_COMMAND;
  const envSource = config.envSource ?? process.env;

  return {
    async dispatch(seat: Seat, ctx: DispatchContext): Promise<AgentDispatchResult> {
      // Validate the seat *before* it is interpolated into a filesystem path
      // or an argv. `Seat` is a compile-time union; a JS caller (or a future
      // seat added to one place and not the other) can still get here with
      // anything, and `.claude/agents/<seat>.md` is path-joined below.
      if (!isBuildSeat(seat)) throw new UnknownSeatError(String(seat));

      const modelId = TIER_MODEL_IDS[modelTier(ctx.issue).tier];
      const definitionPath = join(ctx.enginePath, seatDefinitionRelativePath(seat));

      let definition: string;
      try {
        definition = await readFile(definitionPath, "utf8");
      } catch (cause) {
        // No fallback to ctx.worktreePath. See EngineDefinitionUnreadableError.
        throw new EngineDefinitionUnreadableError(definitionPath, cause);
      }

      const handle = config.runner.spawn({
        command,
        args: buildSeatArgv(seat, modelId),
        cwd: ctx.worktreePath,
        env: buildSeatEnv(envSource),
        stdin: renderPrompt({ seat, ctx, definition, definitionPath, modelId }),
      });

      const result = await raceWithTimeout(seat, handle, timeoutMs);

      // Scrub before anything reaches a message, a summary, or the run log (AC7).
      if (result.exitCode !== 0) {
        throw new SeatProcessFailedError(
          seat,
          result.exitCode,
          scrubSecrets(result.stderr).trim().slice(0, STDERR_EXCERPT_LIMIT),
        );
      }

      return parseSeatResult(seat, result.stdout);
    },

    /**
     * AC9 — loud stub, ALI-162 named. Throws *synchronously* (not a rejected
     * promise) so a caller that forgets to await still fails immediately and
     * visibly, matching the treatment the previous stub had.
     */
    dispatchBlindQa(): Promise<BlindQaDispatchResult> {
      throw new BlindQaNotWiredError();
    },
  };
}

/**
 * Bounds one dispatch. Kills the child and throws `SeatDispatchTimeoutError`
 * if the limit fires first. The loser of the race gets a no-op catch attached
 * so a late rejection from a killed child never surfaces as an unhandled
 * rejection and takes the run down.
 */
async function raceWithTimeout(seat: Seat, handle: ProcessHandle, timeoutMs: number): Promise<ProcessResult> {
  const exited = handle.exited;
  exited.catch(() => {
    /* the timeout path may abandon this promise; never let it go unhandled */
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<ProcessResult>([
      exited,
      new Promise<ProcessResult>((_resolve, reject) => {
        timer = setTimeout(() => {
          try {
            handle.kill();
          } finally {
            reject(new SeatDispatchTimeoutError(seat, timeoutMs));
          }
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// The real process runner
// ---------------------------------------------------------------------------

/**
 * Real adapter for `ProcessRunner`: `node:child_process.spawn`, stdin fed the
 * assembled prompt, stdout/stderr buffered. Not a stub — the whole point of
 * ALI-161 is that a run stops planning perfectly and building nothing.
 *
 * `shell: false` (the default) is load-bearing: the seat name and model id are
 * validated above, but never handing any of it to a shell removes the
 * question entirely. Output is capped so a runaway seat cannot exhaust the
 * dispatcher's memory before the timeout fires.
 */
export function createNodeProcessRunner(maxOutputBytes = 8 * 1024 * 1024): ProcessRunner {
  return {
    spawn(spec) {
      const child = spawnProcess(spec.command, [...spec.args], {
        cwd: spec.cwd,
        env: { ...spec.env },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const exited = new Promise<ProcessResult>((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        const append = (current: string, chunk: Buffer): string =>
          current.length >= maxOutputBytes ? current : current + chunk.toString("utf8");

        child.stdout?.on("data", (chunk: Buffer) => {
          stdout = append(stdout, chunk);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr = append(stderr, chunk);
        });
        child.on("error", reject);
        child.on("close", (code) => resolve({ exitCode: code, stdout, stderr }));
      });

      child.stdin?.end(spec.stdin);

      return {
        exited,
        kill() {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        },
      };
    },
  };
}

/**
 * Convenience guard for callers asserting AC7 on their own records: true when
 * a rendered result carries nothing secret-shaped. Thin wrapper over
 * `containsSecretLike` so the criterion's own vocabulary appears at this
 * adapter's surface rather than only inside `runlog.ts`.
 */
export function resultIsSecretFree(result: AgentDispatchResult): boolean {
  const rendered = [result.summary, result.ambiguous?.question ?? "", result.bounceDetail?.reason ?? ""].join("\n");
  return !containsSecretLike(rendered);
}
