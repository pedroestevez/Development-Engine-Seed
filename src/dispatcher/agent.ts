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
 *   1. **The seat's instructions come from the pinned engine tree, and the
 *      mutable worktree cannot contribute any.** This has two halves, and
 *      bounce round 1 (security finding S1) established that only naming the
 *      first is a false claim:
 *
 *      *In-process half* — the definition is read from
 *      `DispatchContext.enginePath`, the run's detached checkout at its
 *      resolved pin (ALI-104), never from `worktreePath`, which is mutable
 *      and, in this repo, routinely *the thing being edited* (docs/ENGINE.md
 *      §16: "a builder issue here legitimately edits `.claude/**` as its
 *      actual work"). If `enginePath` is missing or unreadable this adapter
 *      **throws**; there is deliberately no fallback to the worktree,
 *      because a fallback is exactly the silent failure the pin exists to
 *      prevent.
 *
 *      *Delegated half* — the child process does its own `.claude/**`
 *      discovery, rooted at **cwd**, which is the worktree (AC4). Reading the
 *      right file in the parent does nothing about that, so the invocation
 *      must suppress it. Probed against `claude` 2.1.233 (round 1 shipped
 *      without this and was bounced for it):
 *
 *        - cwd holding `.claude/agents/builder.md`, argv `--agent zz-nope`
 *          → "not found. Available agents: **builder**, claude, …" — the
 *          worktree copy is discovered, and it governs as the session's
 *          system prompt while the pinned text on stdin is mere user prose.
 *        - cwd holding `.claude/settings.json` with a `SessionStart` command
 *          hook → **the hook executes**, before any seat work, with the
 *          child's environment. Arbitrary command execution from a file the
 *          previous seat in the same run may have written.
 *        - Both stop when argv carries `--setting-sources user`: `builder`
 *          disappears from the discovered list and the hook does not run.
 *        - `--system-prompt <text>` then governs (probe: the child obeyed the
 *          flag's instruction over the user message).
 *
 *      So `buildSeatArgv` suppresses project/local setting sources and passes
 *      the pinned definition as the governing system prompt. `--agent` is
 *      deliberately **not** passed: its whole job is to resolve a name
 *      through the discovery hierarchy this adapter is closing off.
 *
 *      **Residual, stated rather than papered over:** `--setting-sources
 *      user` still loads `~/.claude/**`. That scope is operator-controlled,
 *      not issue-controlled — no seat can write it as part of its work — so
 *      it is an accepted residual, but it means "the pinned tree is the only
 *      source of `.claude/**`" is true of *project* scope, not literally of
 *      every scope. ALI-157 owns the unattended run environment's `HOME`.
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

/**
 * Base class for every failure raised by this adapter, so callers can catch the
 * family — and the one place secret scrubbing is applied to error text.
 *
 * Bounce round 1, S4: several of these messages embed data that came from the
 * child (a `JSON.parse` excerpt of stdout, an echoed unknown field name) and
 * `containsSecretLike()` returned **true** on them. A throw is a record path
 * like any other: `run.ts` has no `catch` around `deps.agent.dispatch`, so the
 * message lands wherever the run is logged, and the first catch-and-comment
 * handler anyone adds turns it into a Linear leak. Scrubbing in this
 * constructor covers every subclass and every future construction site, rather
 * than relying on each call site to remember.
 */
export class AgentDispatchError extends Error {
  constructor(message: string) {
    super(scrubSecrets(message));
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
    // `reason` routinely quotes child stdout — a V8 JSON.parse excerpt, or an
    // unrecognized field name echoed in full. `AgentDispatchError` scrubs the
    // composed message (S4); the explicit call here documents that this is the
    // path that carries child-controlled text.
    super(
      `seat ${seat} produced no valid result envelope: ${scrubSecrets(reason)}. ` +
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
 * The setting scopes the child is allowed to load. `user` only: `project` and
 * `local` are rooted at cwd — the worktree — and loading them hands the
 * session's agent definitions and its `settings.json` hooks to whatever the
 * previous seat happened to write there (S1). See the header's probe log.
 */
export const PINNED_SETTING_SOURCES = "user";

/** Scopes that must never appear in `--setting-sources`, because both resolve against cwd. */
const CWD_ROOTED_SETTING_SOURCES: readonly string[] = ["project", "local"];

/**
 * Builds the argv for one seat invocation. Four flags, each load-bearing:
 *
 *   - `--print` — non-interactive; the *work* prompt arrives on stdin.
 *   - `--model <id>` — property 2, the explicit pin.
 *   - `--setting-sources user` — property 1's delegated half: suppresses
 *     cwd-rooted discovery of `.claude/agents/**` and `.claude/settings.json`
 *     hooks in the worktree.
 *   - `--system-prompt <pinned definition>` — because the flag above also
 *     un-discovers the seat's *name*, the definition has to be supplied
 *     explicitly, and this is the flag probed to actually govern the session.
 *
 * `--agent` is deliberately absent (it was present in round 1 and is the
 * mechanism S1 exploits): its purpose is to resolve a name through the
 * discovery hierarchy this argv closes off, and under `--setting-sources user`
 * the real CLI rejects it outright ("not found. Available agents: …").
 *
 * The definition text rides on argv rather than stdin. argv is `ps`-visible,
 * so this is a deliberate trade: the definition is a tracked, non-secret repo
 * file, while the things that must stay off argv — credentials and the issue
 * body — still do. stdin carries the work prompt; nothing secret is anywhere
 * on the command line.
 */
export function buildSeatArgv(params: { modelId: string; systemPrompt: string }): string[] {
  return [
    "--print",
    "--model",
    params.modelId,
    "--setting-sources",
    PINNED_SETTING_SOURCES,
    "--system-prompt",
    params.systemPrompt,
  ];
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  return args[index + 1];
}

/** Reads `--model`'s value out of a recorded argv. Exported so tests (and ALI-162) assert on the pin, not on argv shape. */
export function modelArgFrom(args: readonly string[]): string | undefined {
  return flagValue(args, "--model");
}

/**
 * Reads `--agent`'s value out of a recorded argv. This adapter never emits the
 * flag; the accessor stays because the fake's rejection rule and its
 * regression test are written against it — re-introducing `--agent` must fail
 * loudly rather than quietly restore S1.
 */
export function seatArgFrom(args: readonly string[]): string | undefined {
  return flagValue(args, "--agent");
}

/** Reads `--setting-sources`' value out of a recorded argv. */
export function settingSourcesArgFrom(args: readonly string[]): string | undefined {
  return flagValue(args, "--setting-sources");
}

/** Reads `--system-prompt`'s value out of a recorded argv. */
export function systemPromptArgFrom(args: readonly string[]): string | undefined {
  return flagValue(args, "--system-prompt");
}

/**
 * True when an invocation cannot load cwd-rooted (`project`/`local`) settings —
 * i.e. when the worktree's `.claude/**` cannot govern the child. The predicate
 * the fake and the AC3 tests both assert on, so "what the child would load" is
 * checked rather than "what the parent assembled".
 */
export function suppressesProjectSettingSources(args: readonly string[]): boolean {
  const value = settingSourcesArgFrom(args);
  if (value === undefined) return false;
  const scopes = value
    .split(",")
    .map((scope) => scope.trim().toLowerCase())
    .filter((scope) => scope !== "");
  if (scopes.length === 0) return false;
  return !scopes.some((scope) => CWD_ROOTED_SETTING_SOURCES.includes(scope));
}

// ---------------------------------------------------------------------------
// Child environment (AC7, second half)
// ---------------------------------------------------------------------------

/**
 * The **only** variables a seat's child process inherits. An allowlist, not a
 * denylist: a denylist silently passes every credential someone adds to the
 * run environment later. A seat needs enough to run git and tests (`PATH`,
 * `HOME`, locale/TZ) plus its own model credential, and nothing else.
 *
 * What this does and does not buy (corrected in bounce round 1, S7): no
 * `LINEAR_*`, `GITHUB_*` or `GH_*` **name** reaches the child, so the run's
 * own port credentials are not handed over as environment. It is *not* a
 * credential boundary, because `HOME` is on the list: any command the seat
 * runs can still read `~/.config/gh/hosts.yml`, `~/.claude/.credentials.json`,
 * or a `~/.gitconfig` credential helper. The names are excluded; the access is
 * not. If the unattended run environment authenticates `git`/`gh` through the
 * run user's `HOME`, the seat needs its own `HOME` — ALI-157's scope, noted
 * there rather than papered over here.
 *
 * Related, also from S7: `scrubSecrets` knows exactly four prefixes (`ghp_`,
 * `github_pat_`, `lin_api_`, `sk-`), so AC7 is proven for those and no
 * further — an `ANTHROPIC_AUTH_TOKEN` of arbitrary bearer/JWT shape is outside
 * that vocabulary. Stated rather than silently widened here.
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
 * The seat's **governing** instructions: the definition, verbatim from the
 * pinned tree, passed as `--system-prompt`.
 *
 * Round 1 put this text on stdin, where it was merely part of the user message
 * while the worktree's own copy governed as the system prompt (S1). Which
 * channel the text travels on is the whole property, not a formatting choice:
 * probed against `claude` 2.1.233, `--system-prompt` governs and stdin prose
 * does not.
 *
 * Deliberately carries no filesystem path. Round 1 disclosed the pinned tree's
 * absolute path to the child (S3); the tree is writable by the same uid, so
 * naming it invited a seat to edit the definitions a *later* seat in the same
 * run would read — property 1 defeated through the trusted path. The seat needs
 * no path: its instructions are already here.
 */
function renderSeatSystemPrompt(params: { seat: Seat; definition: string }): string {
  const { seat, definition } = params;
  return [
    `<seat name="${seat}">`,
    "<!-- Verbatim from this run's pinned engine tree (ALI-104). Project-scope",
    "     .claude/** discovery is suppressed for this session, so nothing in the",
    "     working tree can add to, override, or hook these instructions. -->",
    definition.trimEnd(),
    "</seat>",
  ].join("\n");
}

/**
 * The work prompt: what to do, and how to report. Travels on stdin.
 *
 * Order is a trust boundary, not formatting. Instructions arrive through
 * `--system-prompt` (above); the issue's title and body come from Linear and
 * are lower-trust, so they stay here, enclosed in their own `<issue>` element,
 * read as the work item rather than as further instructions. That boundary is
 * currently made of unescaped delimiters — a body containing `</issue>` can
 * still forge frame structure (S6). Escaping and a per-dispatch envelope nonce
 * are tracked as a follow-up, deliberately not bundled into this bounce round;
 * the "exactly one envelope" rule already turns the naive version of that
 * attack into a loud parse failure rather than a silent clean result.
 */
function renderWorkPrompt(params: { ctx: DispatchContext }): string {
  const { ctx } = params;
  const { issue } = ctx;
  const body = issueBody(issue);

  return [
    `<issue id="${issue.id}" points="${issue.points}" labels="${issue.labels.join(",")}">`,
    `title: ${issue.title}`,
    `predicted files: ${issue.predictedFiles.join(", ") || "(none recorded)"}`,
    `blocked by: ${issue.blockedBy.join(", ") || "(nothing)"}`,
    body ? `\n${body.trimEnd()}` : "\n(no issue body recorded)",
    "</issue>",
    "",
    // No engine-tree attribute: the pinned tree's path is deliberately not
    // disclosed to the child (S3). cwd is the worktree, which the seat needs.
    `<workspace worktree="${ctx.worktreePath}" branch="${ctx.branch}" />`,
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
        // The pinned definition governs via --system-prompt, and cwd-rooted
        // setting sources are suppressed, so the worktree at cwd contributes
        // no instructions and runs no hooks (property 1's delegated half).
        args: buildSeatArgv({ modelId, systemPrompt: renderSeatSystemPrompt({ seat, definition }) }),
        cwd: ctx.worktreePath,
        env: buildSeatEnv(envSource),
        stdin: renderWorkPrompt({ ctx }),
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
 *
 * `handle.kill()` is wrapped so a throwing implementation cannot escape the
 * timer callback (S5 nit): an uncaught exception inside `setTimeout` is fatal
 * to the whole dispatcher process, which would turn "one seat is stuck" into
 * "the run dies without parking its work".
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
          } catch {
            // Reclaiming the child is best-effort; an exception here must never
            // escape the timer callback (see this function's doc comment).
          }
          reject(new SeatDispatchTimeoutError(seat, timeoutMs));
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

/** How long a signalled process group gets to exit on SIGTERM before SIGKILL. */
export const KILL_GRACE_MS = 2_000;

/**
 * How long to keep draining stdio after the child itself has exited, before
 * settling anyway. See `exit`-vs-`close` in this factory's doc comment.
 */
export const STDIO_DRAIN_MS = 250;

/**
 * Real adapter for `ProcessRunner`: `node:child_process.spawn`, stdin fed the
 * work prompt, stdout/stderr buffered. Not a stub — the whole point of ALI-161
 * is that a run stops planning perfectly and building nothing.
 *
 * `shell: false` (the default) is load-bearing: every argv element is a literal
 * or comes from a frozen table, but never handing any of it to a shell removes
 * the question entirely. Output is capped so a runaway seat cannot exhaust the
 * dispatcher's memory before the timeout fires.
 *
 * Two behaviours here were bounce-round-1 findings (S5), and both matter
 * specifically because the child is `claude`, which spawns children of its own
 * (Bash-tool subprocesses, MCP servers, node processes):
 *
 *   - **`detached: true` + process-group kill.** SIGKILL to the direct pid
 *     leaves the grandchildren running, holding the child's environment
 *     (including its model credential) and a cwd inside the worktree — free to
 *     keep writing there *after* the run has parked that worktree and opened
 *     its PR. Commits appearing behind a review, from a run that already ended.
 *     `detached` makes the child a process-group leader so `kill(-pid)` reaches
 *     the whole tree; SIGTERM first, then SIGKILL after `KILL_GRACE_MS`, so a
 *     seat mid-write gets a chance to finish cleanly.
 *   - **Settle on `exit`, not `close`.** `close` waits for stdio EOF, which a
 *     grandchild inheriting the pipes can hold open indefinitely — making a
 *     *finished* seat look timed out, at which point the old `kill()` was a
 *     no-op (the child had already exited) and the pipe-holder was never
 *     signalled at all. Resolving on `exit` after a bounded drain reports the
 *     seat's real outcome; the group kill on the timeout path handles the
 *     leftovers.
 */
export function createNodeProcessRunner(maxOutputBytes = 8 * 1024 * 1024): ProcessRunner {
  return {
    spawn(spec) {
      const child = spawnProcess(spec.command, [...spec.args], {
        cwd: spec.cwd,
        env: { ...spec.env },
        shell: false,
        // Own process group, so the whole tree can be signalled at once.
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      let drainTimer: ReturnType<typeof setTimeout> | undefined;

      const exited = new Promise<ProcessResult>((resolve, reject) => {
        const append = (current: string, chunk: Buffer): string =>
          current.length >= maxOutputBytes ? current : current + chunk.toString("utf8");

        const settle = (exitCode: number | null): void => {
          if (settled) return;
          settled = true;
          if (drainTimer !== undefined) clearTimeout(drainTimer);
          // Release the pipes. A grandchild holding the write end would
          // otherwise keep these read streams — and so the dispatcher's event
          // loop — alive long after the seat is done.
          child.stdout?.destroy();
          child.stderr?.destroy();
          resolve({ exitCode, stdout, stderr });
        };

        child.stdout?.on("data", (chunk: Buffer) => {
          stdout = append(stdout, chunk);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr = append(stderr, chunk);
        });
        child.on("error", reject);

        // The child is gone; give its stdio a bounded moment to flush, then
        // report regardless of who else is still holding the pipes.
        child.on("exit", (code) => {
          drainTimer = setTimeout(() => settle(code), STDIO_DRAIN_MS);
        });
        // Pipes closed first (the common case) — report immediately.
        child.on("close", (code) => settle(code));
      });

      child.stdin?.end(spec.stdin);

      return {
        exited,
        kill() {
          const { pid } = child;
          if (pid === undefined) return;
          // Signal the group (negative pid), not just the leader. ESRCH simply
          // means it is already gone — a kill is best-effort by nature.
          const signalGroup = (signal: NodeJS.Signals): void => {
            try {
              process.kill(-pid, signal);
            } catch {
              /* already dead, or no permission — nothing further to do */
            }
          };
          signalGroup("SIGTERM");
          const hardKill = setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
          // Never let the grace timer hold the dispatcher's event loop open.
          hardKill.unref?.();
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
