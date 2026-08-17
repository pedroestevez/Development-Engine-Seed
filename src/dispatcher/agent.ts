/**
 * Dispatcher runtime — the real `AgentPort` adapter: the build seats
 * (ALI-161: builder, reviewer, security) and the blind test-author
 * (ALI-162: `dispatchBlindQa`).
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
 *   4. **The blind test-author's process cannot see the implementation**
 *      (ALI-162). `dispatchBlindQa` is the *runtime* half of ALI-105's
 *      guarantee. ALI-105 built the other two halves — extraction (only
 *      `## Acceptance criteria` / `## Invariant` / `## Definition of done`
 *      are read) and type asymmetry (`BlindDispatchContext` has none of
 *      `DispatchContext`'s fields, so the compiler refuses to hand a
 *      worktree path over) — but neither can stop an *adapter* from setting
 *      the child's cwd to a worktree or inheriting an environment pointing
 *      at one. This method is the last place that can break, and the only
 *      place it can be enforced, on all four channels the invariant names:
 *
 *        - **arguments** — argv is `--print`, `--model`, `--setting-sources`
 *          and the `qa.md` definition; nothing issue-shaped but the seat's
 *          own five blind fields, and those travel on stdin.
 *        - **prompt** — assembled from exactly `BlindDispatchContext`'s five
 *          fields. There is no `worktreePath`/`branch`/diff *available* to
 *          leak: this method never receives one, so a leak would require
 *          inventing a path rather than merely forgetting to omit one.
 *        - **working directory** — a fresh, empty staging directory outside
 *          every worktree *and* outside the engine checkout (see
 *          `dispatchBlindQa`'s note on why staging beats writing in place).
 *          Deliberately unlike the build seats, whose cwd *is* the worktree.
 *        - **environment** — the same `SEAT_ENV_ALLOWLIST` projection the
 *          build seats get. It carries no run-specific values at all, so no
 *          worktree path or branch name can ride in on it.
 *
 *      Writes are confined by verification, not by trust: the seat's
 *      reported file list is checked against what is actually on disk in the
 *      staging directory, and only then copied into
 *      `.engine/blind-tests/<ISSUE-ID>/`. A reported path that escapes, a
 *      file written but not declared, or a symlink is a **hard error**. The
 *      `tools: Write` allowlist in `qa.md` (CI-enforced by
 *      `scripts/check-qa-tools-allowlist.js`) is the config half of the same
 *      property, and the two are independent on purpose — either one failing
 *      alone still leaves the other standing.
 *
 * Ports and adapters, same discipline as `run.ts`: the subprocess boundary is
 * the injected `ProcessRunner`, so every criterion above is testable without
 * spawning a real CLI. The filesystem read of the pinned definition is *not*
 * injected — it is the property under test, and proving it against real
 * directories (two trees holding different text) is stronger than proving it
 * against a fake reader.
 */

import { spawn as spawnProcess } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";

import type { BlindDispatchContext } from "./blindqa.js";
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
    readonly seat: DispatchLabel,
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
    readonly seat: DispatchLabel,
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

/**
 * The port was constructed without `blindQa` config, so the run's pinned
 * engine tree — the sole legal source of `.claude/agents/qa.md` — is unknown.
 *
 * Fails closed rather than guessing a tree, for exactly the reason
 * `EngineDefinitionUnreadableError` has no worktree fallback. Deliberately
 * *not* solved by latching `ctx.enginePath` from an earlier `dispatch()` call
 * in the same run: that would make an isolation boundary's most trusted input
 * depend on the order previous seats happened to run in, and would silently
 * change behaviour if a future run loop ever dispatched blind QA first.
 */
export class BlindQaNotConfiguredError extends AgentDispatchError {
  constructor() {
    super(
      "AgentPort.dispatchBlindQa needs the run's pinned engine tree, and this port was built without " +
        "`blindQa.enginePath`. It cannot come from BlindDispatchContext: that type carries exactly the " +
        "five blind fields and none of DispatchContext's, which is ALI-105's compiler-enforced asymmetry " +
        "and must stay that way. Supply `blindQa: { enginePath }` (ALI-104's detached checkout) when " +
        "constructing the port. Wiring note for ALI-121: runDispatcher() creates that tree itself, " +
        "mid-run, after RunDeps exists — so hoisting creation ahead of the port must also make " +
        "EnginePinPort.createPinnedTree idempotent (today `git worktree add` fails on an existing path).",
    );
    this.name = "BlindQaNotConfiguredError";
  }
}

/**
 * The `BlindDispatchContext` handed in is not usable. Two cases, both guarded
 * *before* anything is interpolated into a path or an argv:
 *
 *   - a missing/empty required field — `extractBlindView()` cannot produce
 *     one, but this method is reachable from JS and from future callers, and
 *     dispatching a seat with empty criteria would burn a model call to
 *     produce nothing;
 *   - an `issueId` that is not an issue identifier. It is a **path segment**
 *     (`.engine/blind-tests/<ISSUE-ID>/`), so `../../.claude/agents` there
 *     would relocate the whole artifact directory. Same discipline as
 *     `isBuildSeat()` guarding the seat name before `join()`.
 */
export class BlindQaInvalidContextError extends AgentDispatchError {
  constructor(reason: string) {
    super(
      `blind QA dispatch refused: ${scrubSecrets(reason)}. The blind seat's context is the only input ` +
        "this dispatch has; a malformed one is a caller bug, never something to paper over with a default.",
    );
    this.name = "BlindQaInvalidContextError";
  }
}

/**
 * The blind seat's stdout carried no parseable result envelope, or one that
 * did not validate (AC4).
 *
 * `untestableCriteria` is populated **only** from that envelope. An
 * unparseable result must never degrade into
 * `{ testFilesWritten: [], untestableCriteria: [] }`: that value is
 * indistinguishable from "the seat ran and found every criterion testable",
 * which is the fake-that-only-says-yes class ALI-155 names, and it would
 * silently discard ALI-105's AC8 (untestable criteria named by number, never
 * dropped). The vacuous envelope is refused for the same reason even when the
 * seat states it explicitly — a seat that wrote no artifact and found nothing
 * untestable did not do the job qa.md describes.
 */
export class BlindQaOutputParseError extends AgentDispatchError {
  constructor(reason: string) {
    // `reason` routinely quotes child stdout (a JSON.parse excerpt, an echoed
    // unknown field name). `AgentDispatchError` scrubs the composed message
    // (S4); the explicit call marks this as a child-controlled-text path.
    super(
      `blind QA seat produced no valid result envelope: ${scrubSecrets(reason)}. ` +
        `Expected exactly one line beginning ${BLIND_QA_RESULT_SENTINEL} followed by a JSON object ` +
        "carrying testFilesWritten and untestableCriteria. Refusing to report an empty blind result for " +
        "output this runtime cannot understand — an empty result reads as `every criterion was testable`.",
    );
    this.name = "BlindQaOutputParseError";
  }
}

/**
 * The blind seat's writes were not confined to its artifact directory (AC3).
 *
 * A **hard error, never a warning**: the quarantine is what keeps a
 * diff-authoring seat from ever being able to edit an assertion, and what
 * keeps a Write-only seat from reaching the pinned definitions a later seat in
 * the same run reads (S3's class). Covers a reported path that escapes the
 * directory, a file present on disk but never declared, a declared file that
 * does not exist, and a symlink (a write *through* which lands outside).
 */
export class BlindQaArtifactError extends AgentDispatchError {
  constructor(reason: string) {
    super(
      `blind QA artifact rejected: ${scrubSecrets(reason)}. Writes are confined to ` +
        `${join(...BLIND_TESTS_DIR_SEGMENTS, "<ISSUE-ID>")}/ and that confinement is verified against ` +
        "the filesystem, not taken on trust. qa.md's `tools: Write` allowlist is the independent config " +
        "half of this control, never a substitute for it.",
    );
    this.name = "BlindQaArtifactError";
  }
}

// ---------------------------------------------------------------------------
// Seats and the model pin
// ---------------------------------------------------------------------------

/** The three seats `dispatch()` invokes. `blindQa` is deliberately absent — different method, different context type. */
export const BUILD_SEATS: readonly Seat[] = ["builder", "reviewer", "security"] as const;

const BUILD_SEAT_SET: ReadonlySet<string> = new Set(BUILD_SEATS);

export function isBuildSeat(value: string): value is Seat {
  return BUILD_SEAT_SET.has(value);
}

/**
 * The blind test-author's definition name — `.claude/agents/qa.md`. Not a
 * `Seat`: `Seat` is the union `dispatch()` accepts, and keeping the blind seat
 * out of it is what makes "wired through the wrong method" a type error rather
 * than a convention (see `UnknownSeatError`).
 */
export const BLIND_QA_DEFINITION = "qa" as const;

/** Anything this adapter can invoke, for the error/label surface shared by both methods. */
export type DispatchLabel = Seat | typeof BLIND_QA_DEFINITION;

/**
 * The blind seat's model pin (AC1). A **fixed** tier, unlike the build seats'
 * `max(pointsTier, riskTier)`, and that is not a shortcut: `modelTier()` reads
 * the issue's points and labels, and `BlindDispatchContext` carries neither —
 * by design, since the blind view is exactly five fields. The roster fixes the
 * tier instead (docs/ENGINE.md §2: "Blind QA | Sonnet", the cheap tier,
 * because its output is verified downstream by the reviewer and CI). A test
 * asserts this constant still matches `qa.md`'s own `model:` frontmatter, so
 * the config half and the runtime half cannot drift apart silently.
 */
export const BLIND_QA_TIER: ModelTier = "sonnet";

/**
 * Where the blind seat's artifact lives, relative to the engine checkout root
 * — `.engine/blind-tests/<ISSUE-ID>/`, the location `qa.md`'s artifact
 * contract calls "fixed and non-negotiable", under the same `.engine/` root
 * `run.ts`'s `runLogPath()` already writes into.
 */
export const BLIND_TESTS_DIR_SEGMENTS: readonly string[] = Object.freeze([".engine", "blind-tests"]);

/**
 * Issue identifiers this adapter will interpolate into that path. Anchored and
 * deliberately narrow: the value becomes a directory name, so `..`, a
 * separator, a NUL, or a leading dash must never survive the guard.
 */
export const BLIND_QA_ISSUE_ID_PATTERN = /^[A-Z][A-Z0-9]{0,15}-[0-9]{1,9}$/;

/** `.engine/blind-tests/<ISSUE-ID>` — call only with an `issueId` already checked against the pattern above. */
export function blindTestsRelativeDir(issueId: string): string {
  return join(...BLIND_TESTS_DIR_SEGMENTS, issueId);
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

/**
 * Where a seat's definition lives inside the pinned tree, relative to its root.
 * Accepts the blind seat's name too (`qa.md`) — same tree, same pin, same
 * no-fallback rule.
 */
export function seatDefinitionRelativePath(seat: DispatchLabel): string {
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
function renderSeatSystemPrompt(params: { seat: DispatchLabel; definition: string }): string {
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
// The blind test-author: its own envelope, its own prompt, its own artifact
// verification (ALI-162)
// ---------------------------------------------------------------------------

/**
 * The blind seat ends its run by printing exactly one line of this shape:
 *
 *   ENGINE-BLIND-QA-RESULT: {"testFilesWritten":["manifest.json"],"untestableCriteria":[4]}
 *
 * A **different** sentinel from the build seats' `SEAT_RESULT_SENTINEL`, for
 * the same reason `BlindQaDispatchResult` is a different type from
 * `AgentDispatchResult`: the blind seat has no `summary` and no `ambiguous`,
 * and its "I could not do this" signal must never be able to route through
 * `finalizeNeedsPedro()` (ALI-105 AC8). Sharing one envelope would make that
 * a matter of care; two sentinels make it a matter of shape.
 */
export const BLIND_QA_RESULT_SENTINEL = "ENGINE-BLIND-QA-RESULT:";

/** The only fields the blind envelope may carry. Anything else is refused. */
const BLIND_ENVELOPE_KEYS: readonly string[] = [
  "testFilesWritten",
  "untestableCriteria",
  "tokensUsed",
  "model",
  "effort",
];

/** `manifest.json` is mandatory per `qa.md`'s artifact contract — it is what traces each test file to its criterion. */
export const BLIND_QA_MANIFEST_FILENAME = "manifest.json";

/** What the seat *claims*, straight out of its envelope. Every path here is still unverified. */
export interface BlindQaEnvelope {
  /** Paths as the seat reported them — relative to its working directory, not yet confined. */
  reportedFiles: string[];
  untestableCriteria: number[];
  tokensUsed?: number;
  model?: ModelTier;
  effort?: SeatEffort;
}

/**
 * Strictly parses the blind seat's stdout, or throws `BlindQaOutputParseError`.
 * Same strictness in both directions as `parseSeatResult`, plus one rule of its
 * own: the vacuous envelope (`{ testFilesWritten: [], untestableCriteria: [] }`)
 * is refused, because that exact value is what AC4 names as indistinguishable
 * from a successful run.
 */
export function parseBlindQaResult(stdout: string): BlindQaEnvelope {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(BLIND_QA_RESULT_SENTINEL));

  if (lines.length === 0) throw new BlindQaOutputParseError("no result line found in stdout");
  if (lines.length > 1) {
    throw new BlindQaOutputParseError(
      `${lines.length} result lines found — exactly one is required, so the authoritative result is unambiguous`,
    );
  }

  const payload = lines[0].slice(BLIND_QA_RESULT_SENTINEL.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (cause) {
    throw new BlindQaOutputParseError(
      `result line is not valid JSON (${cause instanceof Error ? cause.message : String(cause)})`,
    );
  }

  if (!isPlainObject(parsed)) throw new BlindQaOutputParseError("result line is not a JSON object");

  const extra = unknownKeys(parsed, BLIND_ENVELOPE_KEYS);
  if (extra.length > 0) {
    throw new BlindQaOutputParseError(
      `unrecognized field(s) ${extra.join(", ")} — this runtime cannot honor a signal it does not implement`,
    );
  }

  const reportedFiles = parseReportedFiles(parsed.testFilesWritten);
  const untestableCriteria = parseUntestableCriteria(parsed.untestableCriteria);

  // AC4, stated as the criterion states it.
  if (reportedFiles.length === 0 && untestableCriteria.length === 0) {
    throw new BlindQaOutputParseError(
      "the envelope reports no test files AND no untestable criteria — that value cannot be told apart from " +
        "`the seat ran and found every criterion testable`, so it is refused rather than recorded",
    );
  }

  const envelope: BlindQaEnvelope = { reportedFiles, untestableCriteria };

  if (parsed.tokensUsed !== undefined) {
    if (typeof parsed.tokensUsed !== "number" || !Number.isFinite(parsed.tokensUsed) || parsed.tokensUsed < 0) {
      throw new BlindQaOutputParseError("`tokensUsed` must be a finite, non-negative number when present");
    }
    envelope.tokensUsed = parsed.tokensUsed;
  }

  // Same discipline as the build seats (ALI-106 AC3): never back-filled from
  // the tier this adapter pinned, or a seat that ran at another tier than the
  // roster predicts becomes unobservable.
  if (parsed.model !== undefined) {
    if (typeof parsed.model !== "string" || !MODEL_TIERS.includes(parsed.model as ModelTier)) {
      throw new BlindQaOutputParseError(`\`model\` must be one of ${MODEL_TIERS.join("|")} when present`);
    }
    envelope.model = parsed.model as ModelTier;
  }

  if (parsed.effort !== undefined) {
    if (typeof parsed.effort !== "string" || !SEAT_EFFORTS.includes(parsed.effort as SeatEffort)) {
      throw new BlindQaOutputParseError(`\`effort\` must be one of ${SEAT_EFFORTS.join("|")} when present`);
    }
    envelope.effort = parsed.effort as SeatEffort;
  }

  return envelope;
}

function parseReportedFiles(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new BlindQaOutputParseError("`testFilesWritten` is required and must be an array of relative paths");
  }
  return value.map((entry) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new BlindQaOutputParseError("`testFilesWritten` entries must be non-empty strings");
    }
    return entry.trim();
  });
}

function parseUntestableCriteria(value: unknown): number[] {
  if (!Array.isArray(value)) {
    throw new BlindQaOutputParseError(
      "`untestableCriteria` is required and must be an array of criterion numbers — ALI-105 AC8 is that an " +
        "untestable criterion is named by number and never dropped, so its absence is not the same as `[]`",
    );
  }
  const numbers = value.map((entry) => {
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 1) {
      throw new BlindQaOutputParseError("`untestableCriteria` entries must be positive integers (criterion numbers)");
    }
    return entry;
  });
  if (new Set(numbers).size !== numbers.length) {
    throw new BlindQaOutputParseError("`untestableCriteria` names the same criterion twice");
  }
  return numbers;
}

/**
 * The blind work prompt. Assembled from exactly `BlindDispatchContext`'s five
 * fields — the compiler cannot hand this function a worktree path, a branch or
 * a diff, because the type it takes has no such field (ALI-105's asymmetry),
 * and this function reaches for nothing else.
 *
 * Carries **no filesystem path at all**, absolute or relative: not the pinned
 * tree (S3 — the seat holds `Write`, and a disclosed engine path is an
 * invitation to edit the definitions a later seat reads), not the artifact
 * root, not even the staging directory the child is already sitting in. The
 * seat writes plain filenames into its own cwd; the runtime does the rest.
 */
function renderBlindWorkPrompt(ctx: BlindDispatchContext): string {
  return [
    `<issue id="${ctx.issueId}">`,
    `title: ${ctx.title}`,
    "</issue>",
    "",
    "<acceptance-criteria>",
    ctx.acceptanceCriteria.trimEnd(),
    "</acceptance-criteria>",
    "",
    "<invariant>",
    ctx.invariant.trim() === "" ? "(none stated)" : ctx.invariant.trimEnd(),
    "</invariant>",
    "",
    "<definition-of-done>",
    ctx.definitionOfDone.trim() === "" ? "(none stated)" : ctx.definitionOfDone.trimEnd(),
    "</definition-of-done>",
    "",
    "<artifact-contract>",
    "Write your test files and " +
      BLIND_QA_MANIFEST_FILENAME +
      " into your CURRENT WORKING DIRECTORY, using plain relative filenames.",
    `The runtime places whatever you write there into ${join(...BLIND_TESTS_DIR_SEGMENTS, "<ISSUE-ID>")}/ at the` +
      " engine checkout root — you do not need, and must not construct, that prefix or any absolute path.",
    "Do not write outside your working directory (no absolute paths, no `..`, no symlinks): the runtime verifies",
    "this against the filesystem and refuses the whole dispatch if a write escapes.",
    `Every file you write must be declared in ${BLIND_QA_RESULT_SENTINEL}'s testFilesWritten — an undeclared file`,
    "is also a refusal, and so is a declared file that is not there.",
    "</artifact-contract>",
    "",
    "<output-contract>",
    "End your run by printing EXACTLY ONE line of the form:",
    `${BLIND_QA_RESULT_SENTINEL} {"testFilesWritten":["${BLIND_QA_MANIFEST_FILENAME}","ac-1.test.ts"],"untestableCriteria":[]}`,
    "",
    "The JSON object accepts only these fields:",
    "  testFilesWritten   (string[], required) — every file you wrote, relative to your working directory.",
    "  untestableCriteria (number[], required) — the NUMBERS of acceptance criteria you could not write a test",
    "                                            for. Never guessed into a test, never silently dropped; `[]`",
    "                                            only if every criterion got one.",
    "  tokensUsed         (number)             — tokens this dispatch consumed.",
    '  model              ("haiku"|"sonnet"|"opus") — the tier you ACTUALLY ran at, as you observe it.',
    '  effort             ("standard"|"lint"|"judgment").',
    "",
    "Any other field, a second result line, a non-zero exit, or an envelope reporting neither files nor",
    "untestable criteria is a hard failure: the runtime refuses the dispatch rather than reporting an empty",
    "blind result, which would read as `every criterion was testable`.",
    "",
    "You never run the tests you write. Nothing here names an implementation, a branch, a diff or a file under",
    "review — that is deliberate, and you do not ask for any of it.",
    "</output-contract>",
  ].join("\n");
}

/**
 * Walks a staging directory and returns every regular file in it, as paths
 * relative to the root, sorted.
 *
 * `withFileTypes` + an explicit type check per entry, rather than a plain
 * `readdir`: a **symlink** inside the artifact is a write-escape vector (the
 * bytes land wherever it points, and the reviewer later reads the target), so
 * it is refused rather than followed. Anything that is not a directory or a
 * regular file is refused for the same reason.
 */
async function walkArtifactFiles(root: string, dir = root): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = join(dir, entry.name);
    const relativePath = absolute.slice(root.length + 1);
    if (entry.isDirectory()) {
      files.push(...(await walkArtifactFiles(root, absolute)));
    } else if (entry.isSymbolicLink()) {
      throw new BlindQaArtifactError(
        `${relativePath} is a symlink — a write through it lands outside the artifact directory, so the ` +
          "artifact is refused rather than followed",
      );
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new BlindQaArtifactError(`${relativePath} is neither a regular file nor a directory`);
    }
  }
  return files.sort();
}

/**
 * Normalizes one reported path and refuses anything that could land outside
 * the staging directory: absolute paths, `..` traversal, and (defensively) a
 * resolved path that is not under the root even after normalization.
 */
function confineReportedPath(stagingDir: string, reported: string): string {
  if (isAbsolute(reported)) {
    throw new BlindQaArtifactError(`reported path ${JSON.stringify(reported)} is absolute`);
  }
  const normalized = normalize(reported);
  if (normalized === "." || normalized === "" || normalized.endsWith(sep)) {
    throw new BlindQaArtifactError(`reported path ${JSON.stringify(reported)} does not name a file`);
  }
  if (normalized === ".." || normalized.startsWith(`..${sep}`)) {
    throw new BlindQaArtifactError(
      `reported path ${JSON.stringify(reported)} escapes the artifact directory via ..`,
    );
  }
  // Belt-and-braces after the syntactic checks above: whatever the path looked
  // like, its resolved form must sit strictly inside the staging root.
  if (!resolve(stagingDir, normalized).startsWith(resolve(stagingDir) + sep)) {
    throw new BlindQaArtifactError(`reported path ${JSON.stringify(reported)} resolves outside the artifact directory`);
  }
  return normalized;
}

/**
 * AC3, end to end: verify what the seat wrote, then publish it.
 *
 * The seat's own list is never taken on trust — it is reconciled against the
 * filesystem in **both** directions, because each direction hides a different
 * failure: a declared-but-absent file means the report is fiction, and a
 * present-but-undeclared file means the seat wrote something it did not admit
 * to. Only after both agree does anything land under
 * `.engine/blind-tests/<ISSUE-ID>/`.
 *
 * Returns the artifact's paths relative to the engine checkout root — the
 * shape `BlindQaDispatchResult.testFilesWritten` documents, and one that keeps
 * absolute paths out of the run log.
 */
async function publishBlindArtifact(params: {
  issueId: string;
  stagingDir: string;
  artifactRoot: string;
  reported: readonly string[];
}): Promise<string[]> {
  const { issueId, stagingDir, artifactRoot, reported } = params;

  const declared = new Set<string>();
  for (const entry of reported) {
    const confined = confineReportedPath(stagingDir, entry);
    if (declared.has(confined)) {
      throw new BlindQaArtifactError(`${confined} is declared twice in testFilesWritten`);
    }
    declared.add(confined);
  }

  const onDisk = new Set(await walkArtifactFiles(stagingDir));

  const missing = [...declared].filter((path) => !onDisk.has(path)).sort();
  if (missing.length > 0) {
    throw new BlindQaArtifactError(`declared but not written: ${missing.join(", ")}`);
  }

  const undeclared = [...onDisk].filter((path) => !declared.has(path)).sort();
  if (undeclared.length > 0) {
    throw new BlindQaArtifactError(`written but not declared: ${undeclared.join(", ")}`);
  }

  // qa.md's artifact contract: the test files "plus one `manifest.json` per
  // issue mapping each test file to the numbered acceptance criterion (or the
  // invariant) it traces to". Without it the artifact cannot be traced back to
  // the criteria, which is the only thing that makes it a blind *test* suite
  // rather than a pile of files.
  const hasManifest = [...declared].some((path) => path.split(sep).pop() === BLIND_QA_MANIFEST_FILENAME);
  if (!hasManifest) {
    throw new BlindQaArtifactError(
      `no ${BLIND_QA_MANIFEST_FILENAME} in the artifact — qa.md's contract requires one per issue, tracing each ` +
        "test file to the numbered criterion (or the invariant) it came from",
    );
  }

  const relativeDir = blindTestsRelativeDir(issueId);
  const destinationDir = join(artifactRoot, relativeDir);
  const published: string[] = [];
  for (const path of [...declared].sort()) {
    const destination = join(destinationDir, path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(stagingDir, path), destination);
    published.push(join(relativeDir, path));
  }
  return published;
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

/**
 * What `dispatchBlindQa` needs and cannot be handed per-dispatch (ALI-162).
 *
 * Both values are **run-level constants**, not per-issue data, which is why
 * they belong on the port rather than on the context: `BlindDispatchContext` is
 * exactly the five blind fields, and widening it — even with something as
 * innocuous as a path to a read-only tree — would reopen the channel ALI-105
 * closed with the compiler.
 */
export interface BlindQaSeatConfig {
  /**
   * The run's pinned engine tree (ALI-104's detached checkout) — the sole legal
   * source of `.claude/agents/qa.md`, on exactly the same no-fallback terms as
   * the build seats' definitions.
   */
  enginePath: string;
  /**
   * Root that `.engine/blind-tests/<ISSUE-ID>/` resolves against: the engine
   * checkout root, per `qa.md`'s artifact contract, and **never** a builder
   * worktree — the quarantine is what stops a diff-authoring seat editing an
   * assertion. Defaults to `process.cwd()`, the same default (and the same
   * reasoning) as `run.ts`'s `writeRunLog(..., baseDir)`.
   *
   * A deployment may point this at a directory outside the engine checkout
   * entirely; this adapter only ever writes under
   * `<artifactRoot>/.engine/blind-tests/<ISSUE-ID>/` and does not care what is
   * above it.
   */
  artifactRoot?: string;
  /**
   * Where each dispatch's throwaway staging directory is created. Defaults to
   * the OS temp dir. Injectable so the confinement tests can watch a real
   * directory without writing into the repo.
   */
  stagingRoot?: string;
}

export interface ClaudeCliAgentConfig {
  /** The injected subprocess boundary. `createNodeProcessRunner()` is the real one. */
  runner: ProcessRunner;
  /**
   * Enables the blind test-author seat. Omitted → `dispatchBlindQa` throws
   * `BlindQaNotConfiguredError`. Loud rather than optional-and-silent: an
   * adapter that quietly reported an empty blind result would be the
   * fake-that-only-says-yes ALI-155 names.
   */
  blindQa?: BlindQaSeatConfig;
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
 * The real `AgentPort`: `dispatch()` for the build seats (ALI-161) and
 * `dispatchBlindQa()` for the blind test-author (ALI-162). No method here is a
 * stub any more; the one thing that is still optional is the blind seat's
 * *configuration*, and its absence fails loudly rather than quietly.
 */
export function createClaudeCliAgentPort(config: ClaudeCliAgentConfig): AgentPort {
  const timeoutMs = config.timeoutMs ?? DEFAULT_SEAT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new AgentDispatchError(
      `invalid per-dispatch timeout ${String(config.timeoutMs)} — a seat with no finite bound could hold ` +
        "the run past its hard backstop forever, which is the defect this timeout exists to prevent",
    );
  }
  // Blind-seat paths are checked at construction, not at dispatch: a relative
  // root resolves against whatever `process.cwd()` happens to be when the run
  // fires, which for an unattended Routine is not a value anyone chose. Better
  // to refuse the port than to publish an artifact somewhere surprising.
  if (config.blindQa !== undefined) {
    for (const [field, value] of Object.entries({
      enginePath: config.blindQa.enginePath,
      artifactRoot: config.blindQa.artifactRoot,
      stagingRoot: config.blindQa.stagingRoot,
    })) {
      if (value === undefined) continue;
      if (typeof value !== "string" || value.trim() === "" || !isAbsolute(value)) {
        throw new AgentDispatchError(
          `blindQa.${field} must be an absolute path (got ${JSON.stringify(value)}) — the blind seat's artifact ` +
            "location and its pinned definition are both resolved without reference to the process's cwd",
        );
      }
    }
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

      const result = await raceWithTimeout(handle, timeoutMs, () => new SeatDispatchTimeoutError(seat, timeoutMs));

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
     * The blind test-author (ALI-162) — property 4 in this file's header.
     *
     * Deliberately **not** routed through `dispatch()`, and not merely for
     * type reasons: every difference below is a place the two seats must not
     * share behaviour.
     *
     *   - **cwd is a fresh staging directory**, not a worktree. The build
     *     seats' cwd *is* the worktree because that is where the work happens;
     *     for this seat, a worktree cwd would hand over the entire
     *     implementation through the one channel neither the extraction nor
     *     the type asymmetry can reach. Staging beats writing straight into
     *     `.engine/blind-tests/<ISSUE-ID>/` on two counts: the directory
     *     starts **empty**, so "exactly the paths written" needs no
     *     before/after bookkeeping to be exact; and its ancestors contain
     *     neither the engine checkout nor any worktree, so even a relative
     *     `../../..` write — the one escape a Write-only seat could still
     *     attempt — reaches nothing load-bearing. The artifact is copied into
     *     place only after verification.
     *   - **The model pin is fixed** (`BLIND_QA_TIER`), because the blind
     *     context carries no points and no labels to compute a tier from.
     *   - **A different result envelope**, so an untestable criterion can
     *     never be mistaken for a builder's `ambiguous` (ALI-105 AC8).
     *
     * Everything the two seats *do* share is shared on purpose: the injected
     * `ProcessRunner`, the pinned-tree read with no fallback, the
     * `--setting-sources user` suppression of cwd-rooted discovery, the
     * `--system-prompt` channel that actually governs, the env allowlist, and
     * the per-dispatch timeout (AC5 — a hung blind seat makes the hard
     * backstop at `run.ts`'s post-builder checkpoint unreachable exactly as a
     * hung builder would).
     */
    async dispatchBlindQa(ctx: BlindDispatchContext): Promise<BlindQaDispatchResult> {
      const blindConfig = config.blindQa;
      if (
        blindConfig === undefined ||
        typeof blindConfig.enginePath !== "string" ||
        blindConfig.enginePath.trim() === ""
      ) {
        throw new BlindQaNotConfiguredError();
      }
      // Guard the context before anything is interpolated into a path or an
      // argv — `issueId` becomes a directory name.
      assertBlindContext(ctx);

      const definitionPath = join(blindConfig.enginePath, seatDefinitionRelativePath(BLIND_QA_DEFINITION));
      let definition: string;
      try {
        definition = await readFile(definitionPath, "utf8");
      } catch (cause) {
        // Same terminal treatment as the build seats: no fallback tree, ever.
        throw new EngineDefinitionUnreadableError(definitionPath, cause);
      }

      const artifactRoot = blindConfig.artifactRoot ?? process.cwd();
      const stagingRoot = blindConfig.stagingRoot ?? tmpdir();
      await mkdir(stagingRoot, { recursive: true });
      // `mkdtemp` gives a directory that did not exist a moment ago and is not
      // shared with any other dispatch — no stale artifact can be mistaken for
      // this seat's output, and no other seat can read this one's.
      const stagingDir = await mkdtemp(join(stagingRoot, "engine-blind-qa-"));

      try {
        const handle = config.runner.spawn({
          command,
          args: buildSeatArgv({
            modelId: TIER_MODEL_IDS[BLIND_QA_TIER],
            systemPrompt: renderSeatSystemPrompt({ seat: BLIND_QA_DEFINITION, definition }),
          }),
          cwd: stagingDir,
          // The same allowlist projection the build seats get. It carries no
          // run-specific value at all, so there is nothing worktree- or
          // branch-shaped for the environment channel to leak.
          env: buildSeatEnv(envSource),
          stdin: renderBlindWorkPrompt(ctx),
        });

        const result = await raceWithTimeout(
          handle,
          timeoutMs,
          () => new SeatDispatchTimeoutError(BLIND_QA_DEFINITION, timeoutMs),
        );

        if (result.exitCode !== 0) {
          throw new SeatProcessFailedError(
            BLIND_QA_DEFINITION,
            result.exitCode,
            scrubSecrets(result.stderr).trim().slice(0, STDERR_EXCERPT_LIMIT),
          );
        }

        // AC4: only the structured envelope populates `untestableCriteria`, and
        // output this runtime cannot understand throws rather than resolving.
        const envelope = parseBlindQaResult(result.stdout);

        // AC3: verified against the filesystem, then published.
        const testFilesWritten = await publishBlindArtifact({
          issueId: ctx.issueId,
          stagingDir,
          artifactRoot,
          reported: envelope.reportedFiles,
        });

        const blindResult: BlindQaDispatchResult = {
          testFilesWritten,
          untestableCriteria: envelope.untestableCriteria,
        };
        if (envelope.tokensUsed !== undefined) blindResult.tokensUsed = envelope.tokensUsed;
        if (envelope.model !== undefined) blindResult.model = envelope.model;
        if (envelope.effort !== undefined) blindResult.effort = envelope.effort;
        return blindResult;
      } finally {
        // The staging directory is throwaway by design: on the happy path its
        // contents are already published, and on every failure path the named
        // error carries what went wrong. Leaving it behind would accumulate
        // partial artifacts under the temp root for every bounced dispatch.
        await rm(stagingDir, { recursive: true, force: true }).catch(() => {
          /* best-effort cleanup: never mask the real outcome of the dispatch */
        });
      }
    },
  };
}

/**
 * Rejects a `BlindDispatchContext` this adapter must not act on. Not paranoia
 * about `extractBlindView()` — it cannot produce either failure — but about the
 * fact that `issueId` is used as a **path segment**, and that a dispatch with
 * empty criteria would spend a model call proving nothing.
 */
function assertBlindContext(ctx: BlindDispatchContext): void {
  if (typeof ctx?.issueId !== "string" || !BLIND_QA_ISSUE_ID_PATTERN.test(ctx.issueId)) {
    throw new BlindQaInvalidContextError(
      `issueId ${JSON.stringify(ctx?.issueId)} is not an issue identifier, and it is used as a directory name`,
    );
  }
  if (typeof ctx.title !== "string" || ctx.title.trim() === "") {
    throw new BlindQaInvalidContextError("title is required");
  }
  if (typeof ctx.acceptanceCriteria !== "string" || ctx.acceptanceCriteria.trim() === "") {
    throw new BlindQaInvalidContextError(
      "acceptanceCriteria is empty — the blind seat writes tests from the criteria and nothing else, so there " +
        "is nothing to dispatch it with (run.ts's unparseable-view branch is the path that handles this loudly)",
    );
  }
  if (typeof ctx.invariant !== "string" || typeof ctx.definitionOfDone !== "string") {
    throw new BlindQaInvalidContextError("invariant and definitionOfDone must be strings (empty is allowed)");
  }
}

/**
 * Bounds one dispatch. Kills the child and throws whatever `onTimeout` builds
 * if the limit fires first. The loser of the race gets a no-op catch attached
 * so a late rejection from a killed child never surfaces as an unhandled
 * rejection and takes the run down.
 *
 * The error arrives as a factory rather than a seat name so both dispatch
 * methods share one bound: ALI-162's blind seat needs the same guarantee for
 * the same reason (a hung seat makes the run-level hard backstop unreachable),
 * and a second copy of this race is a second place for it to drift.
 *
 * `handle.kill()` is wrapped so a throwing implementation cannot escape the
 * timer callback (S5 nit): an uncaught exception inside `setTimeout` is fatal
 * to the whole dispatcher process, which would turn "one seat is stuck" into
 * "the run dies without parking its work".
 */
async function raceWithTimeout(
  handle: ProcessHandle,
  timeoutMs: number,
  onTimeout: () => AgentDispatchError,
): Promise<ProcessResult> {
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
          reject(onTimeout());
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
