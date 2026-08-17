/**
 * ALI-161 — the real `AgentPort` adapter for the build seats.
 *
 * Two criteria are the teeth, and both are falsification tests:
 *
 *   - **AC2 (per-seat model pin)** fails if the adapter ever passes one model
 *     for every seat. A test that only asserted "some `--model` is present"
 *     would pass against a hard-coded tier, which is exactly the defect
 *     ALI-121's comment 77ef5c9b describes (a session's inherited model
 *     silently overriding the routing rule), so the assertion is that two
 *     dispatches with *different* computed tiers produce *different* model
 *     arguments.
 *   - **AC3 (instructions come only from the pin)** fails if the adapter reads
 *     `.claude/**` from the worktree. Proven against two **real** directories
 *     holding different text for the same seat definition — the same reason
 *     `pinning.test.ts` uses a real throwaway git repo rather than a fake:
 *     a fake reader could not distinguish "reads the right path" from "reads
 *     the path we handed it".
 *
 * The process-runner fake is faithful in ALI-155's sense: it validates argv
 * the way the real CLI does and **rejects** invocations the real CLI would
 * reject (AC8). Without that, AC1 and AC2 could both pass green against a
 * command that could never actually run.
 *
 * ---
 *
 * ALI-162 — the blind test-author seat (`dispatchBlindQa`), from "AC9 (ALI-161)"
 * downwards. Its teeth are its own criterion 6: the fake **rejects** any
 * invocation whose argv, prompt or cwd carries a worktree path, a branch name
 * or diff text, so criterion 2 cannot pass green while the guarantee is broken.
 * Every blind-seat test in this file runs against a fake armed with that
 * quarantine, and a hand-crafted leak (the shape a careless future edit would
 * produce) is replayed through it to prove it goes red — the same
 * falsification treatment ALI-161's S1 regression guard gets.
 */

import { existsSync, mkdirSync, promises as fs, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  BLIND_QA_DEFINITION,
  BLIND_QA_MANIFEST_FILENAME,
  BLIND_QA_RESULT_SENTINEL,
  BLIND_QA_TIER,
  BLIND_TESTS_DIR_SEGMENTS,
  BUILD_SEATS,
  BlindQaArtifactError,
  BlindQaInvalidContextError,
  BlindQaNotConfiguredError,
  BlindQaOutputParseError,
  DEFAULT_SEAT_TIMEOUT_MS,
  EngineDefinitionUnreadableError,
  PINNED_MODEL_IDS,
  PINNED_SETTING_SOURCES,
  SEAT_ENV_ALLOWLIST,
  SEAT_RESULT_SENTINEL,
  SeatDispatchTimeoutError,
  SeatOutputParseError,
  SeatProcessFailedError,
  TIER_MODEL_IDS,
  UnknownSeatError,
  blindTestsRelativeDir,
  buildSeatEnv,
  createClaudeCliAgentPort,
  createNodeProcessRunner,
  isBuildSeat,
  modelArgFrom,
  parseBlindQaResult,
  parseSeatResult,
  resultIsSecretFree,
  seatArgFrom,
  seatDefinitionRelativePath,
  settingSourcesArgFrom,
  suppressesProjectSettingSources,
  systemPromptArgFrom,
  type BlindQaSeatConfig,
  type ProcessHandle,
  type ProcessResult,
  type ProcessRunner,
  type ProcessSpec,
} from "../agent.js";
import { extractBlindView } from "../blindqa.js";
import type { BlindDispatchContext, DispatchContext, Seat } from "../run.js";
import { containsSecretLike } from "../runlog.js";
import type { Issue } from "../types.js";

// ---------------------------------------------------------------------------
// Fixtures: two real trees, deliberately holding different definition text
// ---------------------------------------------------------------------------

const ENGINE_MARKER = "ENGINE-PINNED-DEFINITION";
const WORKTREE_MARKER = "WORKTREE-MUTATED-DEFINITION";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()!;
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function writeDefinition(treeRoot: string, seat: Seat, marker: string): Promise<void> {
  const path = join(treeRoot, seatDefinitionRelativePath(seat));
  await fs.mkdir(join(treeRoot, ".claude", "agents"), { recursive: true });
  await fs.writeFile(path, `---\nname: ${seat}\n---\n\n${marker} for ${seat}.\n`, "utf8");
}

/**
 * A pinned engine tree and a mutable worktree, both carrying
 * `.claude/agents/<seat>.md`, with **different text**. This is the AC3 fixture:
 * an adapter that read from the worktree would still find a plausible file, so
 * "a file exists in both trees, only one is correct" is the only shape of
 * fixture that can catch the defect.
 */
async function makeTrees(): Promise<{ enginePath: string; worktreePath: string }> {
  const root = await fs.mkdtemp(join(tmpdir(), "ali161-"));
  tempRoots.push(root);
  const enginePath = join(root, "engine-pin");
  const worktreePath = join(root, "worktree");
  for (const seat of BUILD_SEATS) {
    await writeDefinition(enginePath, seat, ENGINE_MARKER);
    await writeDefinition(worktreePath, seat, WORKTREE_MARKER);
  }
  return { enginePath, worktreePath };
}

function makeIssue(overrides: Partial<Issue> & { id?: string } = {}): Issue {
  return {
    id: overrides.id ?? "ALI-999",
    title: overrides.title ?? "Fixture issue",
    points: overrides.points ?? 2,
    priority: overrides.priority ?? 2,
    labels: overrides.labels ?? [],
    blockedBy: overrides.blockedBy ?? [],
    predictedFiles: overrides.predictedFiles ?? ["src/fixture.ts"],
  };
}

function makeCtx(parts: {
  enginePath: string;
  worktreePath: string;
  issue?: Issue;
  branch?: string;
}): DispatchContext {
  return {
    issue: parts.issue ?? makeIssue(),
    worktreePath: parts.worktreePath,
    branch: parts.branch ?? "dispatcher/ALI-999",
    enginePath: parts.enginePath,
  };
}

function envelope(payload: Record<string, unknown>): string {
  return `working…\n${SEAT_RESULT_SENTINEL} ${JSON.stringify(payload)}\n`;
}

/** Runs `attempt` and returns whatever it threw — fails the test if it resolves. */
async function port_thrown(attempt: () => Promise<unknown>): Promise<Error> {
  const outcome = await attempt()
    .then(() => null)
    .catch((thrown: unknown) => thrown as Error);
  if (outcome === null) throw new Error("expected the dispatch to throw, but it resolved");
  return outcome;
}

// ---------------------------------------------------------------------------
// The faithful fake CLI (AC8)
//
// It models the real `claude` binary's *hard rejections*, not just its happy
// path: an unknown agent name and a missing `--model` are usage errors the
// real CLI refuses, and it reports them the way a real process does — a
// non-zero exit with a message on stderr — rather than by throwing inside the
// dispatcher. A fake that accepted any argv would let AC1 and AC2 pass green
// against a command that could never run.
// ---------------------------------------------------------------------------

interface CliInvocation {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  stdin: string;
}

/** What the fake should do for one accepted invocation. `"hang"` never exits (AC6). */
type CliScript = (invocation: CliInvocation, index: number) => Partial<ProcessResult> | "hang";

interface FakeCli {
  runner: ProcessRunner;
  invocations: CliInvocation[];
  /** One entry per invocation the fake *refused* — the proof it is not permissive. */
  rejections: string[];
  killCount: number;
}

const KNOWN_MODEL_IDS: ReadonlySet<string> = new Set(PINNED_MODEL_IDS);

/** Exactly the seat names the real CLI would accept for `--agent` in this engine. */
const KNOWN_AGENTS: ReadonlySet<string> = new Set<string>(BUILD_SEATS as readonly string[]);

/**
 * What the real CLI would discover from a project-scope `.claude/**` at cwd.
 * Round 1's fake modelled the CLI as a pure function of argv + stdin, which is
 * why it could not go red on S1: the discovery that carries the whole `critical`
 * risk is a function of the child's **cwd**, not of what the parent assembled.
 */
function discoverableProjectConfig(cwd: string): string[] {
  const found: string[] = [];
  if (existsSync(join(cwd, ".claude", "settings.json"))) found.push(".claude/settings.json");
  const agentsDir = join(cwd, ".claude", "agents");
  if (existsSync(agentsDir)) {
    for (const entry of readdirSync(agentsDir)) {
      if (entry.endsWith(".md")) found.push(`.claude/agents/${entry}`);
    }
  }
  return found;
}

/**
 * ALI-162 criterion 6 — the blind seat's quarantine, as a **hard rejection**.
 *
 * One entry per string that must never reach the blind seat's process, labelled
 * so the refusal message names the *channel* rather than echoing the secret-ish
 * value itself. Checked against argv, stdin and cwd, because the invariant lists
 * all of them ("arguments, prompt, working directory, or environment") and the
 * env is checked separately by the AC2 test.
 *
 * Like the suppression rule above, this is stricter than the real `claude`
 * binary: the real CLI would happily accept a prompt naming a worktree. It is
 * the ENGINE's invariant expressed as a rejection, and it is exactly the reason
 * to believe criterion 2 — a fake that accepted a leaking invocation would let
 * the assertion pass while the guarantee was broken (a mock of success, not a
 * model of the system).
 */
interface QuarantinedString {
  label: string;
  value: string;
}

function validateBlindQuarantine(spec: ProcessSpec, quarantine: readonly QuarantinedString[]): string | null {
  for (const { label, value } of quarantine) {
    if (value === "") continue;
    const channel =
      spec.cwd.includes(value)
        ? "working directory"
        : spec.args.some((arg) => arg.includes(value))
          ? "argv"
          : spec.stdin.includes(value)
            ? "prompt"
            : null;
    if (channel !== null) {
      return (
        `error: refusing this invocation: its ${channel} carries the ${label}, which the blind test-author's ` +
        "process must never see (ALI-162 invariant; ALI-105's blindness is not a preference)"
      );
    }
  }
  return null;
}

function validateInvocation(spec: ProcessSpec, quarantine: readonly QuarantinedString[] = []): string | null {
  const leaked = validateBlindQuarantine(spec, quarantine);
  if (leaked !== null) return leaked;

  if (spec.command.trim() === "") return "error: no executable given";
  if (!spec.args.includes("--print")) {
    return "error: refusing to run without --print: stdin-driven invocation requires non-interactive mode";
  }

  const model = modelArgFrom(spec.args);
  if (model === undefined) {
    return "error: --model is required: refusing to run on an implicitly inherited model";
  }
  if (!KNOWN_MODEL_IDS.has(model)) return `error: unknown model ${JSON.stringify(model)}`;

  const suppressed = suppressesProjectSettingSources(spec.args);

  // Probed on `claude` 2.1.233: with project sources loaded, cwd's own
  // `.claude/agents/builder.md` is discovered ("Available agents: builder, …")
  // and governs, and a cwd `.claude/settings.json` SessionStart hook EXECUTES.
  // With `--setting-sources user`, both stop.
  //
  // The real CLI does not refuse in that situation — it silently complies, which
  // is exactly why the fake must refuse: this rule is the ENGINE's invariant
  // ("the worktree contributes no instructions") expressed as a hard rejection,
  // so an invocation the engine must never emit cannot pass green here. It is
  // the one rule in this fake that is stricter than the real system, and it is
  // deliberate (bounce round 1, S2).
  if (!suppressed) {
    const discoverable = discoverableProjectConfig(spec.cwd);
    if (discoverable.length > 0) {
      return (
        `error: cwd holds project-scope Claude config (${discoverable.join(", ")}) that would govern this ` +
        "session and could run hooks; pass --setting-sources user to suppress cwd-rooted discovery"
      );
    }
  }

  const agent = seatArgFrom(spec.args);
  if (agent !== undefined) {
    // Under user-only setting sources nothing registers a project agent, so the
    // real CLI rejects any `--agent <name>` this engine would pass (probed:
    // "--agent 'zz-nonexistent' not found. Available agents: claude, …" — the
    // worktree's `builder` is absent from that list). The adapter therefore
    // emits no `--agent` at all; keeping the rule makes re-introducing it —
    // the mechanism S1 exploits — a red test rather than a silent regression.
    if (suppressed || !KNOWN_AGENTS.has(agent)) {
      return `error: unknown agent ${JSON.stringify(agent)}`;
    }
  }

  const systemPrompt = systemPromptArgFrom(spec.args);
  if (systemPrompt === undefined || systemPrompt.trim() === "") {
    return "error: --system-prompt is required once project agents are unavailable";
  }

  if (spec.stdin.trim() === "") return "error: empty prompt on stdin";
  return null;
}

function createFakeClaudeCli(script?: CliScript, quarantine: readonly QuarantinedString[] = []): FakeCli {
  const invocations: CliInvocation[] = [];
  const rejections: string[] = [];
  const fake: FakeCli = {
    invocations,
    rejections,
    killCount: 0,
    runner: {
      spawn(spec: ProcessSpec): ProcessHandle {
        const rejection = validateInvocation(spec, quarantine);
        if (rejection !== null) {
          rejections.push(rejection);
          // Faithful shape: the real CLI starts, refuses, and exits non-zero.
          return {
            exited: Promise.resolve({ exitCode: 2, stdout: "", stderr: `${rejection}\n` }),
            kill() {
              fake.killCount += 1;
            },
          };
        }

        const invocation: CliInvocation = {
          command: spec.command,
          args: [...spec.args],
          cwd: spec.cwd,
          env: { ...spec.env },
          stdin: spec.stdin,
        };
        const index = invocations.length;
        invocations.push(invocation);

        const outcome = script ? script(invocation, index) : {};
        if (outcome === "hang") {
          return {
            // Never settles — the adapter's timeout is the only bound.
            exited: new Promise<ProcessResult>(() => {}),
            kill() {
              fake.killCount += 1;
            },
          };
        }

        const seat = seatArgFrom(invocation.args) ?? "seat";
        return {
          exited: Promise.resolve({
            exitCode: outcome.exitCode ?? 0,
            stdout: outcome.stdout ?? envelope({ summary: `${seat} ok` }),
            stderr: outcome.stderr ?? "",
          }),
          kill() {
            fake.killCount += 1;
          },
        };
      },
    },
  };
  return fake;
}

function makePort(
  fake: FakeCli,
  overrides: {
    timeoutMs?: number;
    envSource?: Record<string, string | undefined>;
    /** ALI-162: omitted → `dispatchBlindQa` must throw `BlindQaNotConfiguredError`. */
    blindQa?: BlindQaSeatConfig;
  } = {},
) {
  return createClaudeCliAgentPort({
    runner: fake.runner,
    timeoutMs: overrides.timeoutMs ?? 5_000,
    envSource: overrides.envSource ?? { PATH: "/usr/bin", HOME: "/home/runner" },
    blindQa: overrides.blindQa,
  });
}

// ---------------------------------------------------------------------------
// AC1 — every dispatch carries an explicit model derived from the issue's tier
// ---------------------------------------------------------------------------

describe("AC1: explicit per-seat model argument, derived from the computed tier", () => {
  it("passes the haiku pin for a 1-point issue with no danger label", async () => {
    const { enginePath, worktreePath } = await makeTrees();
    const fake = createFakeClaudeCli();
    const port = makePort(fake);

    await port.dispatch("builder", makeCtx({ enginePath, worktreePath, issue: makeIssue({ points: 1 }) }));

    expect(fake.invocations).toHaveLength(1);
    expect(modelArgFrom(fake.invocations[0].args)).toBe(TIER_MODEL_IDS.haiku);
  });

  it("passes the sonnet pin for a 3-point issue with no danger label", async () => {
    const { enginePath, worktreePath } = await makeTrees();
    const fake = createFakeClaudeCli();
    const port = makePort(fake);

    await port.dispatch("builder", makeCtx({ enginePath, worktreePath, issue: makeIssue({ points: 3 }) }));

    expect(modelArgFrom(fake.invocations[0].args)).toBe(TIER_MODEL_IDS.sonnet);
  });

  it("floors a danger-labelled issue to the top tier — max(pointsTier, riskTier)", async () => {
    const { enginePath, worktreePath } = await makeTrees();
    const fake = createFakeClaudeCli();
    const port = makePort(fake);

    // 1 point alone would route to haiku; the danger label floors it to opus.
    await port.dispatch(
      "builder",
      makeCtx({ enginePath, worktreePath, issue: makeIssue({ points: 1, labels: ["payments"] }) }),
    );

    expect(modelArgFrom(fake.invocations[0].args)).toBe(TIER_MODEL_IDS.opus);
    expect(modelArgFrom(fake.invocations[0].args)).not.toBe(TIER_MODEL_IDS.haiku);
  });

  it("pins concrete model ids, not floating family aliases", () => {
    // A family alias ("opus") is a mutable pointer — the same argument this
    // repo settled for action pins (ALI-144: pin the SHA, not the tag). This
    // assertion is the drift guard: bumping the table is a deliberate,
    // reviewed engine change, never an accident.
    expect(TIER_MODEL_IDS).toEqual({
      haiku: "claude-haiku-4-5",
      sonnet: "claude-sonnet-5",
      opus: "claude-opus-5",
    });
    for (const id of Object.values(TIER_MODEL_IDS)) {
      expect(id).toMatch(/^claude-/);
      expect(["haiku", "sonnet", "opus"]).not.toContain(id);
    }
  });

  it("never emits an invocation the CLI would refuse for a missing/unknown model", async () => {
    const { enginePath, worktreePath } = await makeTrees();
    const fake = createFakeClaudeCli();
    const port = makePort(fake);

    for (const seat of BUILD_SEATS) {
      await port.dispatch(seat, makeCtx({ enginePath, worktreePath }));
    }

    // Every dispatch above went through the *validating* fake, so a green run
    // here means the argv would have been accepted by the real CLI too.
    expect(fake.rejections).toEqual([]);
    expect(fake.invocations).toHaveLength(BUILD_SEATS.length);
  });
});

// ---------------------------------------------------------------------------
// AC2 — falsification: two seats whose pins differ produce different models
// ---------------------------------------------------------------------------

describe("AC2 (teeth): the model pin is per-seat, not one model for the whole run", () => {
  it("produces two argv records with DIFFERENT model values when the pins differ", async () => {
    const { enginePath, worktreePath } = await makeTrees();
    const fake = createFakeClaudeCli();
    const port = makePort(fake);

    const cheapIssue = makeIssue({ id: "ALI-CHEAP", points: 1 });
    const dangerousIssue = makeIssue({ id: "ALI-RISKY", points: 5, labels: ["rls"] });

    await port.dispatch("builder", makeCtx({ enginePath, worktreePath, issue: cheapIssue }));
    await port.dispatch("reviewer", makeCtx({ enginePath, worktreePath, issue: dangerousIssue }));

    expect(fake.invocations).toHaveLength(2);
    const [first, second] = fake.invocations.map((invocation) => modelArgFrom(invocation.args));

    // The load-bearing assertion: if the adapter ever hard-codes one model
    // (or lets a session-inherited default win), these two are equal and this
    // line is red.
    expect(first).not.toBe(second);
    expect(first).toBe(TIER_MODEL_IDS.haiku);
    expect(second).toBe(TIER_MODEL_IDS.opus);
  });

  it("labels each invocation with its own seat, so the two records are attributable", async () => {
    const { enginePath, worktreePath } = await makeTrees();
    const fake = createFakeClaudeCli();
    const port = makePort(fake);

    await port.dispatch("builder", makeCtx({ enginePath, worktreePath, issue: makeIssue({ points: 1 }) }));
    await port.dispatch("security", makeCtx({ enginePath, worktreePath, issue: makeIssue({ points: 5 }) }));

    // The seat identity moved out of argv with `--agent` (S1): it now travels
    // inside the governing system prompt, which is where the pinned definition
    // for that seat lives, so the two records stay attributable.
    expect(fake.invocations.map((invocation) => systemPromptArgFrom(invocation.args)?.split("\n")[0])).toEqual([
      '<seat name="builder">',
      '<seat name="security">',
    ]);
    expect(fake.invocations.map((invocation) => modelArgFrom(invocation.args))).toEqual([
      TIER_MODEL_IDS.haiku,
      TIER_MODEL_IDS.opus,
    ]);
  });

  it("gives every seat on one issue that issue's tier — the pin follows the issue, not the seat", async () => {
    const { enginePath, worktreePath } = await makeTrees();
    const fake = createFakeClaudeCli();
    const port = makePort(fake);
    const issue = makeIssue({ points: 2, labels: ["critical"] });

    for (const seat of BUILD_SEATS) {
      await port.dispatch(seat, makeCtx({ enginePath, worktreePath, issue }));
    }

    expect(fake.invocations.map((invocation) => modelArgFrom(invocation.args))).toEqual([
      TIER_MODEL_IDS.opus,
      TIER_MODEL_IDS.opus,
      TIER_MODEL_IDS.opus,
    ]);
  });
});

// ---------------------------------------------------------------------------
// AC3 — falsification: instructions come only from the pinned engine tree
// ---------------------------------------------------------------------------

describe("AC3 (teeth): the seat definition is read from enginePath, never from the worktree", () => {
  it("supplies the enginePath copy as the GOVERNING system prompt when both trees hold the file", async () => {
    const { enginePath, worktreePath } = await makeTrees();
    const fake = createFakeClaudeCli();
    const port = makePort(fake);

    await port.dispatch("builder", makeCtx({ enginePath, worktreePath }));

    // Round 1 asserted this against stdin, where the text was only user prose
    // while the worktree's copy governed (S1). The assertion belongs on the
    // channel probed to actually govern the session.
    const systemPrompt = systemPromptArgFrom(fake.invocations[0].args);
    expect(systemPrompt).toContain(ENGINE_MARKER);
    expect(systemPrompt).not.toContain(WORKTREE_MARKER);
    expect(fake.invocations[0].stdin).not.toContain(WORKTREE_MARKER);
  });

  it("suppresses the child's cwd-rooted .claude/** discovery", async () => {
    const { enginePath, worktreePath } = await makeTrees();
    const fake = createFakeClaudeCli();
    const port = makePort(fake);

    await port.dispatch("builder", makeCtx({ enginePath, worktreePath }));

    const { args } = fake.invocations[0];
    // The load-bearing half S1 named: reading the right file in the parent is
    // worthless if the child re-discovers `.claude/**` from cwd = the worktree.
    expect(suppressesProjectSettingSources(args)).toBe(true);
    expect(settingSourcesArgFrom(args)).toBe(PINNED_SETTING_SOURCES);
    expect(settingSourcesArgFrom(args)).not.toMatch(/project|local/);
  });

  it("passes no --agent, whose resolution is rooted at the mutable worktree", async () => {
    const { enginePath, worktreePath } = await makeTrees();
    const fake = createFakeClaudeCli();
    const port = makePort(fake);

    await port.dispatch("builder", makeCtx({ enginePath, worktreePath }));

    // `--agent <seat>` is not a label: it asks the child to resolve that name
    // through the discovery hierarchy this adapter closes off. It was round 1's
    // mechanism for S1.
    expect(seatArgFrom(fake.invocations[0].args)).toBeUndefined();
    expect(fake.invocations[0].args).not.toContain("--agent");
  });

  it("keeps the pin governing even after the worktree's copy is rewritten mid-run", async () => {
    const { enginePath, worktreePath } = await makeTrees();
    const fake = createFakeClaudeCli();
    const port = makePort(fake);

    // Exactly the seed-repo scenario docs/ENGINE.md §16 names: a builder issue
    // legitimately editing `.claude/**` as its actual work — and, per S1, the
    // reviewer and security seats then run in that same worktree.
    await writeDefinition(worktreePath, "builder", "SELF-MODIFIED-MID-RUN");
    await writeDefinition(worktreePath, "security", "SELF-MODIFIED-MID-RUN");

    for (const seat of BUILD_SEATS) {
      await port.dispatch(seat, makeCtx({ enginePath, worktreePath }));
    }

    for (const invocation of fake.invocations) {
      expect(systemPromptArgFrom(invocation.args)).toContain(ENGINE_MARKER);
      expect(systemPromptArgFrom(invocation.args)).not.toContain("SELF-MODIFIED-MID-RUN");
      expect(suppressesProjectSettingSources(invocation.args)).toBe(true);
    }
    expect(fake.rejections).toEqual([]);
  });

  it("a worktree .claude/settings.json cannot govern or hook the session", async () => {
    const { enginePath, worktreePath } = await makeTrees();
    // Probed on the real CLI: a SessionStart command hook here EXECUTES with
    // project sources loaded, and does not with --setting-sources user.
    await fs.writeFile(
      join(worktreePath, ".claude", "settings.json"),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "touch /tmp/pwned" }] }] } }),
      "utf8",
    );
    const fake = createFakeClaudeCli();
    const port = makePort(fake);

    const result = await port.dispatch("builder", makeCtx({ enginePath, worktreePath }));

    // Accepted by the fake precisely because the invocation suppresses the
    // scope that would have run the hook.
    expect(result.summary).toContain("ok");
    expect(fake.rejections).toEqual([]);
    expect(suppressesProjectSettingSources(fake.invocations[0].args)).toBe(true);
  });

  it("the fake goes RED if suppression is ever dropped (S1 regression guard)", async () => {
    const { worktreePath } = await makeTrees();
    const fake = createFakeClaudeCli();

    // Round 1's exact invocation shape, replayed by hand: no suppression, cwd
    // holding a discoverable `.claude/agents/builder.md`.
    const handle = fake.runner.spawn({
      command: "claude",
      args: ["--print", "--model", TIER_MODEL_IDS.sonnet, "--agent", "builder", "--system-prompt", "pinned text"],
      cwd: worktreePath,
      env: {},
      stdin: "work prompt",
    });
    const outcome = await handle.exited;

    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.stderr).toMatch(/project-scope Claude config|--setting-sources user/);
    expect(fake.rejections).toHaveLength(1);
    expect(fake.invocations).toEqual([]);
  });

  it("does not disclose the pinned tree's path to the child (S3)", async () => {
    const { enginePath, worktreePath } = await makeTrees();
    const fake = createFakeClaudeCli();
    const port = makePort(fake);

    await port.dispatch("builder", makeCtx({ enginePath, worktreePath }));

    const { stdin, args } = fake.invocations[0];
    // The pinned tree is writable by the same uid; naming it invites a seat to
    // edit the definitions a later seat in the same run reads.
    expect(stdin).not.toContain(enginePath);
    expect(stdin).not.toContain("engine-tree");
    expect(args.join(" ")).not.toContain(enginePath);
    // cwd is still the worktree (AC4) — discovery is what got cut, not the cwd.
    expect(fake.invocations[0].cwd).toBe(worktreePath);
  });

  it("throws when enginePath does not exist — and never falls back to the worktree", async () => {
    const { enginePath, worktreePath } = await makeTrees();
    const fake = createFakeClaudeCli();
    const port = makePort(fake);
    const missingEngine = join(enginePath, "does-not-exist");

    await expect(
      port.dispatch("builder", makeCtx({ enginePath: missingEngine, worktreePath })),
    ).rejects.toBeInstanceOf(EngineDefinitionUnreadableError);

    // No subprocess at all: the fallback path does not exist, so there is
    // nothing to dispatch. A silent fallback would show up here as one
    // invocation carrying WORKTREE_MARKER.
    expect(fake.invocations).toEqual([]);
  });

  it("throws when the pinned tree exists but lacks this seat's definition", async () => {
    const { enginePath, worktreePath } = await makeTrees();
    await fs.rm(join(enginePath, seatDefinitionRelativePath("security")));
    const fake = createFakeClaudeCli();
    const port = makePort(fake);

    const error = await port
      .dispatch("security", makeCtx({ enginePath, worktreePath }))
      .then(() => null)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(EngineDefinitionUnreadableError);
    expect((error as Error).message).toContain(join(".claude", "agents", "security.md"));
    expect(fake.invocations).toEqual([]);
  });

  it("rejects a seat name that is not a build seat before touching the filesystem or argv", async () => {
    const { enginePath, worktreePath } = await makeTrees();
    const fake = createFakeClaudeCli();
    const port = makePort(fake);

    // A path-shaped seat name is the reason this guard runs before the join:
    // `.claude/agents/<seat>.md` is a real path built from this value.
    await expect(
      port.dispatch("../../etc/passwd" as unknown as Seat, makeCtx({ enginePath, worktreePath })),
    ).rejects.toBeInstanceOf(UnknownSeatError);
    await expect(port.dispatch("blindQa" as unknown as Seat, makeCtx({ enginePath, worktreePath }))).rejects.toThrow(
      /ALI-162|dispatchBlindQa|unknown seat/,
    );
    expect(fake.invocations).toEqual([]);
    expect(isBuildSeat("blindQa")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC4 — cwd is the worktree, for all three seats
// ---------------------------------------------------------------------------

describe("AC4: the subprocess runs with cwd = ctx.worktreePath", () => {
  it("records the worktree handle's path as cwd for builder, reviewer and security", async () => {
    const { enginePath, worktreePath } = await makeTrees();
    const fake = createFakeClaudeCli();
    const port = makePort(fake);

    for (const seat of BUILD_SEATS) {
      await port.dispatch(seat, makeCtx({ enginePath, worktreePath }));
    }

    expect(fake.invocations.map((invocation) => invocation.cwd)).toEqual([worktreePath, worktreePath, worktreePath]);
    // The two trees stay distinct: cwd is mutable, the definition source is not.
    for (const invocation of fake.invocations) {
      expect(invocation.cwd).not.toBe(enginePath);
    }
  });
});

// ---------------------------------------------------------------------------
// AC5 — unparseable output fails loud; bounced/ambiguous only from the envelope
// ---------------------------------------------------------------------------

describe("AC5: unparseable seat output throws a named error, never a clean summary", () => {
  const unparseable: ReadonlyArray<[string, string]> = [
    ["no envelope at all", "I finished the work and opened a PR.\n"],
    ["empty stdout", ""],
    ["envelope is not JSON", `${SEAT_RESULT_SENTINEL} not-json\n`],
    ["envelope is not an object", `${SEAT_RESULT_SENTINEL} "done"\n`],
    ["summary missing", `${SEAT_RESULT_SENTINEL} {"bounced":false}\n`],
    ["summary empty", `${SEAT_RESULT_SENTINEL} {"summary":"   "}\n`],
    ["two envelopes", `${SEAT_RESULT_SENTINEL} {"summary":"a"}\n${SEAT_RESULT_SENTINEL} {"summary":"b"}\n`],
    ["bounced is not a boolean", `${SEAT_RESULT_SENTINEL} {"summary":"a","bounced":"yes"}\n`],
    ["ambiguous carries no question", `${SEAT_RESULT_SENTINEL} {"summary":"a","ambiguous":{}}\n`],
    ["ambiguous question is empty", `${SEAT_RESULT_SENTINEL} {"summary":"a","ambiguous":{"question":""}}\n`],
    ["unrecognized field", `${SEAT_RESULT_SENTINEL} {"summary":"a","blocked":true}\n`],
    ["model is not a known tier", `${SEAT_RESULT_SENTINEL} {"summary":"a","model":"gpt"}\n`],
    ["bounceDetail stage is not a bounce stage", `${SEAT_RESULT_SENTINEL} {"summary":"a","bounceDetail":{"detectedAtStage":"standard","detectorTokens":1,"reworkTokens":1,"reason":"x"}}\n`],
  ];

  for (const [label, stdout] of unparseable) {
    it(`throws SeatOutputParseError: ${label}`, async () => {
      const { enginePath, worktreePath } = await makeTrees();
      const fake = createFakeClaudeCli(() => ({ stdout }));
      const port = makePort(fake);

      const outcome = await port
        .dispatch("builder", makeCtx({ enginePath, worktreePath }))
        .then((value) => ({ resolved: value }))
        .catch((thrown: unknown) => ({ thrown }));

      // The criterion's exact wording: it must NEVER be reported as a clean
      // `{ summary }` with no `ambiguous` field — that routes a genuinely
      // blocked issue to In Review instead of Needs Pedro.
      expect(outcome).not.toHaveProperty("resolved");
      expect((outcome as { thrown: unknown }).thrown).toBeInstanceOf(SeatOutputParseError);
    });
  }

  it("sets `ambiguous` only from the structured signal — never inferred from free text", async () => {
    const { enginePath, worktreePath } = await makeTrees();
    const prose = [
      "This requirement is ambiguous and I could not decide.",
      "AMBIGUOUS: should the cache be per-tenant or global?",
      "I am blocked and need Pedro to answer.",
      `${SEAT_RESULT_SENTINEL} ${JSON.stringify({ summary: "implemented the unambiguous half" })}`,
      "",
    ].join("\n");
    const fake = createFakeClaudeCli(() => ({ stdout: prose }));
    const port = makePort(fake);

    const result = await port.dispatch("builder", makeCtx({ enginePath, worktreePath }));

    expect(result.summary).toBe("implemented the unambiguous half");
    expect(result.ambiguous).toBeUndefined();
    expect(result.bounced).toBeUndefined();
  });

  it("carries `ambiguous`, `bounced` and the ALI-106 fields through when the envelope sets them", async () => {
    const { enginePath, worktreePath } = await makeTrees();
    const fake = createFakeClaudeCli(() => ({
      stdout: envelope({
        summary: "criterion 3 is unresolvable as written",
        bounced: true,
        bounceDetail: { detectedAtStage: "lint", detectorTokens: 120, reworkTokens: 900, reason: "typecheck failed" },
        ambiguous: { question: "Is `enginePath` allowed to be a bare worktree?" },
        tokensUsed: 4321,
        model: "opus",
        effort: "judgment",
      }),
    }));
    const port = makePort(fake);

    const result = await port.dispatch("reviewer", makeCtx({ enginePath, worktreePath }));

    expect(result).toEqual({
      summary: "criterion 3 is unresolvable as written",
      bounced: true,
      bounceDetail: { detectedAtStage: "lint", detectorTokens: 120, reworkTokens: 900, reason: "typecheck failed" },
      ambiguous: { question: "Is `enginePath` allowed to be a bare worktree?" },
      tokensUsed: 4321,
      model: "opus",
      effort: "judgment",
    });
  });

  it("never back-fills `model` from the tier it pinned (ALI-106 AC3)", async () => {
    const { enginePath, worktreePath } = await makeTrees();
    const fake = createFakeClaudeCli(() => ({ stdout: envelope({ summary: "done" }) }));
    const port = makePort(fake);

    const result = await port.dispatch(
      "builder",
      makeCtx({ enginePath, worktreePath, issue: makeIssue({ points: 5 }) }),
    );

    // The pin was opus, but the seat reported nothing — recording the
    // prediction here would make "ran at a different tier than predicted"
    // unobservable, which is the whole point of the field.
    expect(modelArgFrom(fake.invocations[0].args)).toBe(TIER_MODEL_IDS.opus);
    expect(result.model).toBeUndefined();
  });

  it("throws SeatProcessFailedError when the seat exits non-zero, even with a valid envelope", async () => {
    const { enginePath, worktreePath } = await makeTrees();
    const fake = createFakeClaudeCli(() => ({
      exitCode: 1,
      stdout: envelope({ summary: "looks fine" }),
      stderr: "panic: worktree is dirty",
    }));
    const port = makePort(fake);

    const error = await port
      .dispatch("builder", makeCtx({ enginePath, worktreePath }))
      .then(() => null)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SeatProcessFailedError);
    expect((error as Error).message).toContain("panic: worktree is dirty");
  });

  it("parseSeatResult is usable directly and applies the same strictness", () => {
    expect(parseSeatResult("builder", envelope({ summary: "ok" }))).toEqual({ summary: "ok" });
    expect(() => parseSeatResult("builder", "no envelope")).toThrow(SeatOutputParseError);
  });
});

// ---------------------------------------------------------------------------
// AC6 — a per-dispatch timeout exists and fires
// ---------------------------------------------------------------------------

describe("AC6: the per-dispatch timeout kills the child and throws", () => {
  it("rejects with SeatDispatchTimeoutError within the limit when the runner never exits", async () => {
    const { enginePath, worktreePath } = await makeTrees();
    const fake = createFakeClaudeCli(() => "hang");
    const port = makePort(fake, { timeoutMs: 40 });

    const startedAt = Date.now();
    const error = await port
      .dispatch("builder", makeCtx({ enginePath, worktreePath }))
      .then(() => null)
      .catch((thrown: unknown) => thrown);
    const elapsed = Date.now() - startedAt;

    expect(error).toBeInstanceOf(SeatDispatchTimeoutError);
    expect((error as SeatDispatchTimeoutError).seat).toBe("builder");
    expect((error as SeatDispatchTimeoutError).timeoutMs).toBe(40);
    // Bounded: without this, the run sails past wallClockHardMs and the
    // parked-work guarantee at run.ts:365-397 never fires.
    expect(elapsed).toBeLessThan(5_000);
  });

  it("kills the hung child rather than leaking it", async () => {
    const { enginePath, worktreePath } = await makeTrees();
    const fake = createFakeClaudeCli(() => "hang");
    const port = makePort(fake, { timeoutMs: 25 });

    await expect(port.dispatch("reviewer", makeCtx({ enginePath, worktreePath }))).rejects.toBeInstanceOf(
      SeatDispatchTimeoutError,
    );

    expect(fake.killCount).toBe(1);
  });

  it("does not kill a seat that finishes inside the limit", async () => {
    const { enginePath, worktreePath } = await makeTrees();
    const fake = createFakeClaudeCli();
    const port = makePort(fake, { timeoutMs: 5_000 });

    await port.dispatch("builder", makeCtx({ enginePath, worktreePath }));

    expect(fake.killCount).toBe(0);
  });

  it("refuses to be constructed with a non-positive or non-finite limit", () => {
    const fake = createFakeClaudeCli();
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createClaudeCliAgentPort({ runner: fake.runner, timeoutMs })).toThrow(/timeout/);
    }
    // And the default is a real, finite bound.
    expect(DEFAULT_SEAT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_SEAT_TIMEOUT_MS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC7 — no secret survives into the record; the child env is an allowlist
// ---------------------------------------------------------------------------

describe("AC7: secrets never reach the record, and the child env carries only what the seat needs", () => {
  it("scrubs a secret-shaped token out of the summary", async () => {
    const { enginePath, worktreePath } = await makeTrees();
    const fake = createFakeClaudeCli(() => ({
      stdout: envelope({ summary: "pushed with token ghp_AAAABBBBCCCCDDDDEEEEFFFF0000" }),
    }));
    const port = makePort(fake);

    const result = await port.dispatch("builder", makeCtx({ enginePath, worktreePath }));

    expect(containsSecretLike(result.summary)).toBe(false);
    expect(result.summary).toContain("[REDACTED]");
    expect(resultIsSecretFree(result)).toBe(true);
  });

  it("scrubs secrets out of every string that reaches the result", async () => {
    const { enginePath, worktreePath } = await makeTrees();
    const fake = createFakeClaudeCli(() => ({
      stdout: envelope({
        summary: "blocked",
        ambiguous: { question: "should I reuse lin_api_ZZZZ1111 for the write?" },
        bounced: true,
        bounceDetail: {
          detectedAtStage: "judgment",
          detectorTokens: 10,
          reworkTokens: 20,
          reason: "leaked sk-ABCDEF123456 in a fixture",
        },
      }),
    }));
    const port = makePort(fake);

    const result = await port.dispatch("builder", makeCtx({ enginePath, worktreePath }));

    expect(resultIsSecretFree(result)).toBe(true);
    expect(containsSecretLike(result.ambiguous!.question)).toBe(false);
    expect(containsSecretLike(result.bounceDetail!.reason)).toBe(false);
  });

  it("scrubs secrets out of a failure's stderr excerpt", async () => {
    const { enginePath, worktreePath } = await makeTrees();
    const fake = createFakeClaudeCli(() => ({
      exitCode: 1,
      stdout: "",
      stderr: "fatal: remote rejected (token github_pat_11ABCDE0000)",
    }));
    const port = makePort(fake);

    const error = await port
      .dispatch("builder", makeCtx({ enginePath, worktreePath }))
      .then(() => null)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SeatProcessFailedError);
    expect(containsSecretLike((error as Error).message)).toBe(false);
  });

  it("hands the child only allowlisted variables — never the run's Linear/GitHub credentials", async () => {
    const { enginePath, worktreePath } = await makeTrees();
    const fake = createFakeClaudeCli();
    const port = makePort(fake, {
      envSource: {
        PATH: "/usr/bin",
        HOME: "/home/runner",
        ANTHROPIC_API_KEY: "sk-ant-fixture",
        GITHUB_TOKEN: "ghp_SHOULD_NOT_TRAVEL",
        LINEAR_API_KEY: "lin_api_SHOULD_NOT_TRAVEL",
        AWS_SECRET_ACCESS_KEY: "should-not-travel",
        SOME_UNRELATED_VAR: "noise",
      },
    });

    await port.dispatch("builder", makeCtx({ enginePath, worktreePath }));

    const env = fake.invocations[0].env;
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/runner", ANTHROPIC_API_KEY: "sk-ant-fixture" });
    for (const denied of ["GITHUB_TOKEN", "LINEAR_API_KEY", "AWS_SECRET_ACCESS_KEY", "SOME_UNRELATED_VAR"]) {
      expect(Object.keys(env)).not.toContain(denied);
    }
  });

  it("scrubs secrets out of EVERY named error this adapter can throw (S4)", async () => {
    const { enginePath, worktreePath } = await makeTrees();

    // Round 1 leaked here: a V8 JSON.parse message quotes ~10-20 chars around
    // the offending token, and the unknown-key path echoed the whole key —
    // `containsSecretLike()` was true on both. A throw is a record path too.
    const parseErrorInputs: readonly string[] = [
      `${SEAT_RESULT_SENTINEL} ghp_AAAABBBBCCCCDDDDEEEE\n`,
      `${SEAT_RESULT_SENTINEL} {"summary":"a","lin_api_deadbeefdeadbeef":1}\n`,
      `${SEAT_RESULT_SENTINEL} {"summary":"a","ambiguous":{"sk-ABCDEF123456":"x"}}\n`,
      `${SEAT_RESULT_SENTINEL} {"summary":"a","model":"github_pat_11ABCDE0000"}\n`,
    ];

    for (const stdout of parseErrorInputs) {
      const fake = createFakeClaudeCli(() => ({ stdout }));
      const port = makePort(fake);
      const error = await port
        .dispatch("builder", makeCtx({ enginePath, worktreePath }))
        .then(() => null)
        .catch((thrown: unknown) => thrown as Error);

      expect(error).toBeInstanceOf(SeatOutputParseError);
      expect(containsSecretLike((error as Error).message)).toBe(false);
    }

    // The other named errors, each constructed with secret-shaped input.
    const unknownSeat = await port_thrown(() =>
      makePort(createFakeClaudeCli()).dispatch("ghp_AAAABBBB" as unknown as Seat, makeCtx({ enginePath, worktreePath })),
    );
    expect(unknownSeat).toBeInstanceOf(UnknownSeatError);
    expect(containsSecretLike(unknownSeat.message)).toBe(false);

    const unreadable = await port_thrown(() =>
      makePort(createFakeClaudeCli()).dispatch(
        "builder",
        makeCtx({ enginePath: join(enginePath, "lin_api_missingtree"), worktreePath }),
      ),
    );
    expect(unreadable).toBeInstanceOf(EngineDefinitionUnreadableError);
    expect(containsSecretLike(unreadable.message)).toBe(false);

    const failedFake = createFakeClaudeCli(() => ({ exitCode: 1, stdout: "", stderr: "token sk-LEAKED123456" }));
    const failed = await port_thrown(() =>
      makePort(failedFake).dispatch("builder", makeCtx({ enginePath, worktreePath })),
    );
    expect(failed).toBeInstanceOf(SeatProcessFailedError);
    expect(containsSecretLike(failed.message)).toBe(false);
  });

  it("buildSeatEnv is an allowlist projection, not a denylist", () => {
    const projected = buildSeatEnv({ PATH: "/bin", NEW_SECRET_ADDED_LATER: "x", TZ: undefined });
    expect(projected).toEqual({ PATH: "/bin" });
    expect(SEAT_ENV_ALLOWLIST).toContain("ANTHROPIC_API_KEY");
    expect(SEAT_ENV_ALLOWLIST).not.toContain("GITHUB_TOKEN");
    expect(SEAT_ENV_ALLOWLIST).not.toContain("LINEAR_API_KEY");
  });
});

// ---------------------------------------------------------------------------
// AC8 — the fake is faithful: it rejects what the real CLI rejects (ALI-155)
// ---------------------------------------------------------------------------

describe("AC8 (faithful fake): the process-runner fake rejects invocations the real CLI would reject", () => {
  it("rejects an unknown seat name on --agent", async () => {
    const fake = createFakeClaudeCli();

    const handle = fake.runner.spawn({
      command: "claude",
      args: ["--print", "--model", TIER_MODEL_IDS.sonnet, "--agent", "nope"],
      cwd: "/tmp",
      env: {},
      stdin: "prompt",
    });
    const result = await handle.exited;

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/unknown agent/);
    expect(fake.rejections).toHaveLength(1);
    // Refused before doing any work — nothing was recorded as a real run.
    expect(fake.invocations).toEqual([]);
  });

  it("rejects an invocation with no --model argument", async () => {
    const fake = createFakeClaudeCli();

    const handle = fake.runner.spawn({
      command: "claude",
      args: ["--print", "--agent", "builder"],
      cwd: "/tmp",
      env: {},
      stdin: "prompt",
    });
    const result = await handle.exited;

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/--model is required/);
    expect(fake.invocations).toEqual([]);
  });

  it("rejects an unknown model id, so a stale pin cannot pass as a valid run", async () => {
    const fake = createFakeClaudeCli();

    const handle = fake.runner.spawn({
      command: "claude",
      args: ["--print", "--model", "claude-retired-3", "--agent", "builder"],
      cwd: "/tmp",
      env: {},
      stdin: "prompt",
    });

    expect((await handle.exited).stderr).toMatch(/unknown model/);
  });

  it("surfaces a fake rejection through dispatch as a loud failure, not a clean result", async () => {
    const { enginePath, worktreePath } = await makeTrees();
    // A runner that refuses everything models a CLI whose contract we broke.
    const alwaysRefuses: ProcessRunner = {
      spawn: () => ({
        exited: Promise.resolve({ exitCode: 2, stdout: "", stderr: "error: unknown agent \"builder\"\n" }),
        kill() {},
      }),
    };
    const port = createClaudeCliAgentPort({ runner: alwaysRefuses, timeoutMs: 1_000, envSource: {} });

    await expect(port.dispatch("builder", makeCtx({ enginePath, worktreePath }))).rejects.toBeInstanceOf(
      SeatProcessFailedError,
    );
  });
});

// ===========================================================================
// ALI-162 — the blind test-author seat (`dispatchBlindQa`)
//
// ALI-161 left this method a loud stub naming this issue. What replaces it is
// the third layer of ALI-105's blindness: extraction and the type asymmetry
// stop a worktree path being *passed*, and this is the only place that can stop
// the child *process* from seeing one anyway.
// ===========================================================================

const QA_ENGINE_MARKER = "ENGINE-PINNED-QA-DEFINITION";
const QA_WORKTREE_MARKER = "WORKTREE-MUTATED-QA-DEFINITION";

/** The issue under test, and the two things about its implementation the seat must never learn. */
const BLIND_ISSUE_ID = "ALI-162";
const BLIND_BRANCH = "claude/ali-162-blind-qa-runtime";
const BLIND_DIFF_TEXT = "+  const stagingDir = await mkdtemp(join(stagingRoot, 'engine-blind-qa-'));";

const MANIFEST_CONTENT = JSON.stringify({
  criteria: { "1": "ac-1.test.ts", "2": "ac-2.test.ts" },
  assumedBindings: ["dispatchBlindQa"],
});

interface BlindWorld {
  /** The run's pinned engine tree — holds the governing `qa.md`. */
  enginePath: string;
  /** A worktree for the SAME issue, present on disk, holding a mutated `qa.md` and the diff (criterion 2's fixture). */
  worktreePath: string;
  /** The engine checkout root: where `.engine/blind-tests/<ISSUE-ID>/` is published. */
  artifactRoot: string;
  stagingRoot: string;
  blindQa: BlindQaSeatConfig;
  /** What the fake refuses to let through (criterion 6). */
  quarantine: QuarantinedString[];
  /** `<artifactRoot>/.engine/blind-tests/<ISSUE-ID>` — absolute. */
  artifactDir: string;
}

async function makeBlindWorld(issueId: string = BLIND_ISSUE_ID): Promise<BlindWorld> {
  const root = await fs.mkdtemp(join(tmpdir(), "ali162-"));
  tempRoots.push(root);

  const enginePath = join(root, "engine-pin");
  const worktreePath = join(root, "worktrees", issueId);
  const artifactRoot = join(root, "engine-checkout");
  const stagingRoot = join(root, "staging");

  // The pinned definition — the only one allowed to govern. Carries the real
  // frontmatter shape so `model:`/`tools:` are visible in what travels.
  await fs.mkdir(join(enginePath, ".claude", "agents"), { recursive: true });
  await fs.writeFile(
    join(enginePath, seatDefinitionRelativePath(BLIND_QA_DEFINITION)),
    `---\nname: qa\nmodel: ${BLIND_QA_TIER}\ntools: Write\n---\n\n${QA_ENGINE_MARKER}\n`,
    "utf8",
  );

  // A worktree for the same issue, on disk, exactly as criterion 2 requires:
  // holding a rewritten `qa.md` and a file containing the diff text.
  await fs.mkdir(join(worktreePath, ".claude", "agents"), { recursive: true });
  await fs.writeFile(
    join(worktreePath, seatDefinitionRelativePath(BLIND_QA_DEFINITION)),
    `---\nname: qa\ntools: Read, Write\n---\n\n${QA_WORKTREE_MARKER}\n`,
    "utf8",
  );
  await fs.writeFile(join(worktreePath, "agent.diff"), `${BLIND_DIFF_TEXT}\n`, "utf8");

  await fs.mkdir(artifactRoot, { recursive: true });
  await fs.mkdir(stagingRoot, { recursive: true });

  return {
    enginePath,
    worktreePath,
    artifactRoot,
    stagingRoot,
    blindQa: { enginePath, artifactRoot, stagingRoot },
    quarantine: [
      { label: "worktree path", value: worktreePath },
      { label: "branch name", value: BLIND_BRANCH },
      { label: "diff text", value: BLIND_DIFF_TEXT },
    ],
    artifactDir: join(artifactRoot, blindTestsRelativeDir(issueId)),
  };
}

/**
 * The issue body the blind view is extracted from. `## Why` and `## What` carry
 * the worktree path, the branch and the diff — the sections ALI-105's
 * extraction exists to drop. If any of them shows up in an invocation, the leak
 * came through this fixture, which is the point of putting them here.
 */
function blindIssueBody(world: BlindWorld): string {
  return [
    "## Why",
    `\`dispatchBlindQa\` throws. The adapter is checked out at ${world.worktreePath}.`,
    "",
    "## What",
    `On branch ${BLIND_BRANCH}, apply:`,
    "",
    "```diff",
    BLIND_DIFF_TEXT,
    "```",
    "",
    "## Acceptance criteria",
    "1. `dispatchBlindQa(ctx)` invokes the blind seat with an explicit model pin.",
    "2. The recorded argv, cwd and assembled prompt contain no worktree path.",
    "3. Writes are confined; a write outside the artifact directory is a hard error.",
    "",
    "## Invariant",
    "Nothing describing the implementation ever reaches the blind seat's process.",
    "",
    "## Definition of done",
    "`npm test` green; the ALI-105 run-loop tests still pass unchanged.",
  ].join("\n");
}

/** The blind context, built the way `run.ts` builds it — through `extractBlindView()` (criterion 2). */
function makeBlindCtx(world: BlindWorld, issueId: string = BLIND_ISSUE_ID): BlindDispatchContext {
  const view = extractBlindView({
    id: issueId,
    title: "Real AgentPort adapter — blind QA seat",
    body: blindIssueBody(world),
  });
  if (!view.ok) throw new Error(`fixture issue body is unparseable: ${view.reason}`);
  return view.context;
}

function writeStaged(cwd: string, files: Readonly<Record<string, string>>): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(cwd, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
}

/**
 * A stand-in blind seat: writes `files` into whatever cwd it was given, then
 * prints the envelope. Writing into `invocation.cwd` rather than a path the test
 * computes is deliberate — it makes the seat's behaviour depend on the *only*
 * location the adapter told it about, which is what confinement means.
 */
function blindSeat(
  files: Readonly<Record<string, string>>,
  envelope: Record<string, unknown> | string,
  extra: Partial<ProcessResult> = {},
): CliScript {
  return (invocation) => {
    writeStaged(invocation.cwd, files);
    const line = typeof envelope === "string" ? envelope : `${BLIND_QA_RESULT_SENTINEL} ${JSON.stringify(envelope)}`;
    return { stdout: `authoring tests from the criteria…\n${line}\n`, ...extra };
  };
}

/** A conforming artifact: the manifest plus one test file per criterion. */
const CONFORMING_FILES: Readonly<Record<string, string>> = {
  [BLIND_QA_MANIFEST_FILENAME]: MANIFEST_CONTENT,
  "ac-1.test.ts": "// criterion 1\n",
  "ac-2.test.ts": "// criterion 2\n",
};
const CONFORMING_ENVELOPE = {
  testFilesWritten: [BLIND_QA_MANIFEST_FILENAME, "ac-1.test.ts", "ac-2.test.ts"],
  untestableCriteria: [3],
};

async function listFiles(root: string, dir: string = root): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await listFiles(root, absolute)));
    else found.push(absolute.slice(root.length + 1));
  }
  return found.sort();
}

async function thrownBy(attempt: () => Promise<unknown>): Promise<Error> {
  return port_thrown(attempt);
}

// ---------------------------------------------------------------------------
// Criterion 1 — explicit model pin, definition read from the pinned tree
// ---------------------------------------------------------------------------

describe("ALI-162 criterion 1: explicit model pin, and qa.md read from the run's pinned engine tree", () => {
  it("passes an explicit --model for the roster's blind-QA tier", async () => {
    const world = await makeBlindWorld();
    const fake = createFakeClaudeCli(blindSeat(CONFORMING_FILES, CONFORMING_ENVELOPE), world.quarantine);
    const port = makePort(fake, { blindQa: world.blindQa });

    await port.dispatchBlindQa(makeBlindCtx(world));

    // Explicit, and a concrete id rather than a family alias — same rule as the
    // build seats. The tier is fixed rather than computed because the blind
    // context carries no points and no labels to compute one from.
    expect(modelArgFrom(fake.invocations[0].args)).toBe(TIER_MODEL_IDS[BLIND_QA_TIER]);
    expect(PINNED_MODEL_IDS).toContain(modelArgFrom(fake.invocations[0].args));
    expect(fake.rejections).toEqual([]);
  });

  it("keeps the runtime pin and qa.md's own `model:` frontmatter from drifting apart", async () => {
    // The config half and the runtime half are independent controls, but they
    // must still agree on the tier — a `qa.md` bumped to opus while this
    // adapter kept pinning sonnet would run the seat at a tier nobody chose.
    const qaDefinition = await fs.readFile(
      join(process.cwd(), seatDefinitionRelativePath(BLIND_QA_DEFINITION)),
      "utf8",
    );
    const declared = /^model:\s*(\S+)\s*$/m.exec(qaDefinition)?.[1];

    expect(declared).toBe(BLIND_QA_TIER);
  });

  it("supplies the PINNED qa.md as the governing system prompt when a worktree holds a rewritten copy", async () => {
    const world = await makeBlindWorld();
    const fake = createFakeClaudeCli(blindSeat(CONFORMING_FILES, CONFORMING_ENVELOPE), world.quarantine);
    const port = makePort(fake, { blindQa: world.blindQa });

    await port.dispatchBlindQa(makeBlindCtx(world));

    const systemPrompt = systemPromptArgFrom(fake.invocations[0].args);
    expect(systemPrompt).toContain(QA_ENGINE_MARKER);
    expect(systemPrompt).not.toContain(QA_WORKTREE_MARKER);
    expect(fake.invocations[0].stdin).not.toContain(QA_WORKTREE_MARKER);
  });

  it("suppresses cwd-rooted .claude/** discovery and passes no --agent (ALI-161's S1 mechanism)", async () => {
    const world = await makeBlindWorld();
    const fake = createFakeClaudeCli(blindSeat(CONFORMING_FILES, CONFORMING_ENVELOPE), world.quarantine);
    const port = makePort(fake, { blindQa: world.blindQa });

    await port.dispatchBlindQa(makeBlindCtx(world));

    const { args } = fake.invocations[0];
    expect(suppressesProjectSettingSources(args)).toBe(true);
    expect(settingSourcesArgFrom(args)).toBe(PINNED_SETTING_SOURCES);
    expect(seatArgFrom(args)).toBeUndefined();
    expect(args).not.toContain("--agent");
  });

  it("throws rather than falling back when the pinned tree has no qa.md", async () => {
    const world = await makeBlindWorld();
    await fs.rm(join(world.enginePath, seatDefinitionRelativePath(BLIND_QA_DEFINITION)));
    const fake = createFakeClaudeCli(blindSeat(CONFORMING_FILES, CONFORMING_ENVELOPE), world.quarantine);
    const port = makePort(fake, { blindQa: world.blindQa });

    const error = await thrownBy(() => port.dispatchBlindQa(makeBlindCtx(world)));

    expect(error).toBeInstanceOf(EngineDefinitionUnreadableError);
    expect(error.message).toContain(join(".claude", "agents", "qa.md"));
    // A fallback to the worktree copy would show up here as one invocation
    // carrying QA_WORKTREE_MARKER.
    expect(fake.invocations).toEqual([]);
  });

  it("does not disclose the pinned tree's path, or any other path, to the child (S3)", async () => {
    const world = await makeBlindWorld();
    const fake = createFakeClaudeCli(blindSeat(CONFORMING_FILES, CONFORMING_ENVELOPE), world.quarantine);
    const port = makePort(fake, { blindQa: world.blindQa });

    await port.dispatchBlindQa(makeBlindCtx(world));

    const { stdin, args } = fake.invocations[0];
    for (const path of [world.enginePath, world.artifactRoot, world.artifactDir]) {
      expect(stdin).not.toContain(path);
      expect(args.join(" ")).not.toContain(path);
    }
    // The seat is told about its own working directory only by being placed in
    // it — the prompt names relative filenames and nothing else.
    expect(stdin).not.toContain(fake.invocations[0].cwd);
  });
});

// ---------------------------------------------------------------------------
// Criterion 2 (teeth, `critical` #1) — the process cannot see the implementation
// ---------------------------------------------------------------------------

describe("ALI-162 criterion 2 (teeth): the blind seat's process cannot see the implementation", () => {
  it("leaks no worktree path, branch name or diff text through argv, cwd, prompt or env", async () => {
    const world = await makeBlindWorld();
    // The worktree for this very issue exists on disk, holds the diff, and its
    // path/branch/diff are in the issue body's `## Why`/`## What`.
    expect(existsSync(join(world.worktreePath, "agent.diff"))).toBe(true);

    const fake = createFakeClaudeCli(blindSeat(CONFORMING_FILES, CONFORMING_ENVELOPE), world.quarantine);
    const port = makePort(fake, {
      blindQa: world.blindQa,
      envSource: {
        PATH: "/usr/bin",
        HOME: "/home/runner",
        // Even if the run environment names the worktree and branch, the
        // allowlist projection carries neither: they are not allowlisted names.
        ENGINE_WORKTREE: world.worktreePath,
        ENGINE_BRANCH: BLIND_BRANCH,
      },
    });

    await port.dispatchBlindQa(makeBlindCtx(world));

    const invocation = fake.invocations[0];
    const everything = [invocation.cwd, invocation.args.join(" "), invocation.stdin, ...Object.values(invocation.env)].join(
      " ",
    );
    for (const { value } of world.quarantine) {
      expect(everything).not.toContain(value);
    }
    // And the fake — armed to refuse any of those — accepted this invocation.
    expect(fake.rejections).toEqual([]);
  });

  it("runs with a cwd that is NOT any worktree, and not the engine checkout either", async () => {
    const world = await makeBlindWorld();
    const fake = createFakeClaudeCli(blindSeat(CONFORMING_FILES, CONFORMING_ENVELOPE), world.quarantine);
    const port = makePort(fake, { blindQa: world.blindQa });

    await port.dispatchBlindQa(makeBlindCtx(world));

    const { cwd } = fake.invocations[0];
    // Deliberately unlike the build seats, whose cwd IS the worktree (AC4 of
    // ALI-161). A fresh staging directory under the configured staging root:
    // nothing above it is a worktree or the engine checkout, so even a
    // relative `../..` write from a Write-only seat reaches nothing.
    expect(cwd).not.toBe(world.worktreePath);
    expect(cwd.startsWith(world.worktreePath)).toBe(false);
    expect(cwd.startsWith(world.artifactRoot)).toBe(false);
    expect(cwd.startsWith(world.enginePath)).toBe(false);
    expect(cwd.startsWith(world.stagingRoot)).toBe(true);
    expect(cwd).not.toContain(BLIND_ISSUE_ID);
  });

  it("carries the five blind fields and nothing else from the issue", async () => {
    const world = await makeBlindWorld();
    const fake = createFakeClaudeCli(blindSeat(CONFORMING_FILES, CONFORMING_ENVELOPE), world.quarantine);
    const port = makePort(fake, { blindQa: world.blindQa });
    const ctx = makeBlindCtx(world);

    await port.dispatchBlindQa(ctx);

    const { stdin } = fake.invocations[0];
    // What the seat IS given — proving the negative assertions above are not
    // passing merely because the prompt is empty.
    expect(stdin).toContain(ctx.issueId);
    expect(stdin).toContain(ctx.title);
    expect(stdin).toContain("The recorded argv, cwd and assembled prompt contain no worktree path.");
    expect(stdin).toContain(ctx.invariant);
    expect(stdin).toContain(ctx.definitionOfDone);
    expect(stdin).toContain(BLIND_QA_RESULT_SENTINEL);
    // What it is not: `## Why`/`## What` never reach the extraction, so their
    // prose cannot reach the prompt.
    expect(stdin).not.toContain("dispatchBlindQa` throws");
    expect(stdin).not.toContain("apply:");
  });

  it("wipes the staging directory afterwards, so nothing outlives the dispatch", async () => {
    const world = await makeBlindWorld();
    const fake = createFakeClaudeCli(blindSeat(CONFORMING_FILES, CONFORMING_ENVELOPE), world.quarantine);
    const port = makePort(fake, { blindQa: world.blindQa });

    await port.dispatchBlindQa(makeBlindCtx(world));

    expect(existsSync(fake.invocations[0].cwd)).toBe(false);
    expect(await listFiles(world.stagingRoot)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Criterion 3 (`critical` #2) — writes are confined, and escapes are hard errors
// ---------------------------------------------------------------------------

describe("ALI-162 criterion 3: writes land only under .engine/blind-tests/<ISSUE-ID>/", () => {
  it("publishes exactly the paths written, as engine-root-relative paths", async () => {
    const world = await makeBlindWorld();
    const fake = createFakeClaudeCli(blindSeat(CONFORMING_FILES, CONFORMING_ENVELOPE), world.quarantine);
    const port = makePort(fake, { blindQa: world.blindQa });

    const result = await port.dispatchBlindQa(makeBlindCtx(world));

    const expectedDir = join(...BLIND_TESTS_DIR_SEGMENTS, BLIND_ISSUE_ID);
    expect(result.testFilesWritten).toEqual([
      join(expectedDir, "ac-1.test.ts"),
      join(expectedDir, "ac-2.test.ts"),
      join(expectedDir, BLIND_QA_MANIFEST_FILENAME),
    ]);
    // Exactly — verified against the filesystem, not taken from the report.
    expect(await listFiles(world.artifactDir)).toEqual([
      "ac-1.test.ts",
      "ac-2.test.ts",
      BLIND_QA_MANIFEST_FILENAME,
    ]);
    expect(await fs.readFile(join(world.artifactDir, BLIND_QA_MANIFEST_FILENAME), "utf8")).toBe(MANIFEST_CONTENT);
    // And nothing landed in the worktree — the quarantine qa.md calls
    // "fixed and non-negotiable".
    expect(await listFiles(world.worktreePath)).toEqual([
      join(".claude", "agents", "qa.md"),
      "agent.diff",
    ]);
  });

  it("keeps a nested subdirectory inside the artifact (confined, not forbidden)", async () => {
    const world = await makeBlindWorld();
    const files = { ...CONFORMING_FILES, [join("cases", "invariant.test.ts")]: "// invariant\n" };
    const envelope = {
      testFilesWritten: [...CONFORMING_ENVELOPE.testFilesWritten, join("cases", "invariant.test.ts")],
      untestableCriteria: [],
    };
    const fake = createFakeClaudeCli(blindSeat(files, envelope), world.quarantine);
    const port = makePort(fake, { blindQa: world.blindQa });

    const result = await port.dispatchBlindQa(makeBlindCtx(world));

    expect(result.testFilesWritten).toContain(
      join(...BLIND_TESTS_DIR_SEGMENTS, BLIND_ISSUE_ID, "cases", "invariant.test.ts"),
    );
    expect(existsSync(join(world.artifactDir, "cases", "invariant.test.ts"))).toBe(true);
  });

  // Each row asserts on the *reason*, not merely on "some artifact error".
  // Dropping the confinement guard makes these red rather than letting the
  // reconciliation below catch the same paths for a different reason — which is
  // what an earlier draft of this block did, and it hid which rule was
  // load-bearing.
  const escapes: ReadonlyArray<[string, string, RegExp]> = [
    ["a parent-directory traversal", join("..", "..", ".claude", "agents", "qa.md"), /escapes the artifact directory/],
    [
      "a deeper traversal",
      join("..", "..", "..", "engine-pin", ".claude", "agents", "reviewer.md"),
      /escapes the artifact directory/,
    ],
    ["an absolute path", "/etc/cron.d/engine", /is absolute/],
    ["a bare parent", "..", /escapes the artifact directory/],
    ["a directory, not a file", `cases${sep}`, /does not name a file/],
  ];

  for (const [label, escape, reason] of escapes) {
    it(`refuses ${label} as a HARD error, publishing nothing`, async () => {
      const world = await makeBlindWorld();
      const fake = createFakeClaudeCli(
        blindSeat(CONFORMING_FILES, {
          testFilesWritten: [...CONFORMING_ENVELOPE.testFilesWritten, escape],
          untestableCriteria: [],
        }),
        world.quarantine,
      );
      const port = makePort(fake, { blindQa: world.blindQa });

      const error = await thrownBy(() => port.dispatchBlindQa(makeBlindCtx(world)));

      // Hard error, not a warning, and not a partial publish: the artifact
      // directory is never created at all.
      expect(error).toBeInstanceOf(BlindQaArtifactError);
      expect(error.message).toMatch(reason);
      expect(existsSync(world.artifactDir)).toBe(false);
      expect(existsSync(fake.invocations[0].cwd)).toBe(false);
    });
  }

  it("bounds an UNDECLARED escape to the throwaway staging root — never the engine checkout or a worktree", async () => {
    const world = await makeBlindWorld();
    // The one escape no runtime check can see: a write outside the working
    // directory that the seat simply does not report. Nothing enumerates it, so
    // the honest guarantee is not "it cannot happen" but "it reaches nothing
    // that matters" — which is exactly why cwd is a fresh temp directory whose
    // ancestors hold no engine checkout and no worktree, rather than the
    // artifact directory itself.
    const fake = createFakeClaudeCli((invocation) => {
      writeStaged(invocation.cwd, CONFORMING_FILES);
      writeStaged(invocation.cwd, { [join("..", "escaped.test.ts")]: "// undeclared\n" });
      return {
        stdout: `${BLIND_QA_RESULT_SENTINEL} ${JSON.stringify(CONFORMING_ENVELOPE)}\n`,
      };
    }, world.quarantine);
    const port = makePort(fake, { blindQa: world.blindQa });

    const result = await port.dispatchBlindQa(makeBlindCtx(world));

    // The declared artifact published normally…
    expect(result.testFilesWritten).toHaveLength(3);
    // …the escape landed in the throwaway staging root, which the dispatch
    // does not treat as an artifact…
    expect(await listFiles(world.stagingRoot)).toEqual(["escaped.test.ts"]);
    // …and neither the engine checkout's artifact directory nor the worktree
    // gained anything from it.
    expect(await listFiles(world.artifactDir)).toEqual([
      "ac-1.test.ts",
      "ac-2.test.ts",
      BLIND_QA_MANIFEST_FILENAME,
    ]);
    expect(existsSync(join(world.worktreePath, "escaped.test.ts"))).toBe(false);
    expect(existsSync(join(world.enginePath, "escaped.test.ts"))).toBe(false);
  });

  it("refuses a file written but not declared", async () => {
    const world = await makeBlindWorld();
    const fake = createFakeClaudeCli(
      // Writes a fourth file, declares three.
      blindSeat({ ...CONFORMING_FILES, "undeclared.test.ts": "// sneaky\n" }, CONFORMING_ENVELOPE),
      world.quarantine,
    );
    const port = makePort(fake, { blindQa: world.blindQa });

    const error = await thrownBy(() => port.dispatchBlindQa(makeBlindCtx(world)));

    expect(error).toBeInstanceOf(BlindQaArtifactError);
    expect(error.message).toContain("written but not declared");
    expect(error.message).toContain("undeclared.test.ts");
    expect(existsSync(world.artifactDir)).toBe(false);
  });

  it("refuses a file declared but never written", async () => {
    const world = await makeBlindWorld();
    const fake = createFakeClaudeCli(
      blindSeat(CONFORMING_FILES, {
        testFilesWritten: [...CONFORMING_ENVELOPE.testFilesWritten, "ac-4.test.ts"],
        untestableCriteria: [],
      }),
      world.quarantine,
    );
    const port = makePort(fake, { blindQa: world.blindQa });

    const error = await thrownBy(() => port.dispatchBlindQa(makeBlindCtx(world)));

    expect(error).toBeInstanceOf(BlindQaArtifactError);
    expect(error.message).toContain("declared but not written");
  });

  it("refuses a symlink in the artifact — a write through it lands outside", async () => {
    const world = await makeBlindWorld();
    const fake = createFakeClaudeCli((invocation) => {
      writeStaged(invocation.cwd, CONFORMING_FILES);
      // The escape a confinement check on *paths alone* would miss: the
      // reported name is innocent, the bytes land wherever the link points.
      symlinkSync(join(world.enginePath, ".claude", "agents"), join(invocation.cwd, "definitions"));
      return {
        stdout: `${BLIND_QA_RESULT_SENTINEL} ${JSON.stringify({
          testFilesWritten: [...CONFORMING_ENVELOPE.testFilesWritten, "definitions"],
          untestableCriteria: [],
        })}\n`,
      };
    }, world.quarantine);
    const port = makePort(fake, { blindQa: world.blindQa });

    const error = await thrownBy(() => port.dispatchBlindQa(makeBlindCtx(world)));

    expect(error).toBeInstanceOf(BlindQaArtifactError);
    expect(error.message).toMatch(/symlink/);
    expect(existsSync(world.artifactDir)).toBe(false);
  });

  it("refuses an artifact with no manifest.json (qa.md's tracing contract)", async () => {
    const world = await makeBlindWorld();
    const fake = createFakeClaudeCli(
      blindSeat({ "ac-1.test.ts": "// criterion 1\n" }, { testFilesWritten: ["ac-1.test.ts"], untestableCriteria: [] }),
      world.quarantine,
    );
    const port = makePort(fake, { blindQa: world.blindQa });

    const error = await thrownBy(() => port.dispatchBlindQa(makeBlindCtx(world)));

    expect(error).toBeInstanceOf(BlindQaArtifactError);
    expect(error.message).toContain(BLIND_QA_MANIFEST_FILENAME);
  });

  it("names an issue id that is not an identifier as a hard error, before any path is built", async () => {
    const world = await makeBlindWorld();
    const fake = createFakeClaudeCli(blindSeat(CONFORMING_FILES, CONFORMING_ENVELOPE), world.quarantine);
    const port = makePort(fake, { blindQa: world.blindQa });
    const ctx = { ...makeBlindCtx(world), issueId: join("..", "..", ".claude", "agents") };

    const error = await thrownBy(() => port.dispatchBlindQa(ctx));

    // `issueId` is a directory name: traversal here would relocate the whole
    // artifact directory, which is why the guard runs before the join and
    // before the subprocess.
    expect(error).toBeInstanceOf(BlindQaInvalidContextError);
    expect(fake.invocations).toEqual([]);
  });

  it("confines each issue to its own directory", async () => {
    const world = await makeBlindWorld("ALI-105");
    const fake = createFakeClaudeCli(blindSeat(CONFORMING_FILES, CONFORMING_ENVELOPE), world.quarantine);
    const port = makePort(fake, { blindQa: world.blindQa });

    const result = await port.dispatchBlindQa(makeBlindCtx(world, "ALI-105"));

    for (const path of result.testFilesWritten) {
      expect(path.startsWith(join(...BLIND_TESTS_DIR_SEGMENTS, "ALI-105") + "/")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Criterion 4 (`critical` #3) — an unparseable blind result fails loud
// ---------------------------------------------------------------------------

describe("ALI-162 criterion 4: an unparseable blind result throws, and is never an empty success", () => {
  const unparseable: ReadonlyArray<[string, string]> = [
    ["no envelope at all", "I wrote some tests for the criteria.\n"],
    ["empty stdout", ""],
    ["the build seats' envelope instead", `${SEAT_RESULT_SENTINEL} {"summary":"wrote 3 tests"}\n`],
    ["envelope is not JSON", `${BLIND_QA_RESULT_SENTINEL} not-json\n`],
    ["envelope is not an object", `${BLIND_QA_RESULT_SENTINEL} ["manifest.json"]\n`],
    ["two envelopes", `${BLIND_QA_RESULT_SENTINEL} {"testFilesWritten":["a"],"untestableCriteria":[]}\n${BLIND_QA_RESULT_SENTINEL} {"testFilesWritten":["b"],"untestableCriteria":[]}\n`],
    ["testFilesWritten missing", `${BLIND_QA_RESULT_SENTINEL} {"untestableCriteria":[1]}\n`],
    ["testFilesWritten is not an array", `${BLIND_QA_RESULT_SENTINEL} {"testFilesWritten":"manifest.json","untestableCriteria":[]}\n`],
    ["untestableCriteria missing", `${BLIND_QA_RESULT_SENTINEL} {"testFilesWritten":["manifest.json"]}\n`],
    ["untestableCriteria holds prose", `${BLIND_QA_RESULT_SENTINEL} {"testFilesWritten":["manifest.json"],"untestableCriteria":["criterion 3"]}\n`],
    ["untestableCriteria holds a zero", `${BLIND_QA_RESULT_SENTINEL} {"testFilesWritten":["manifest.json"],"untestableCriteria":[0]}\n`],
    ["untestableCriteria repeats a criterion", `${BLIND_QA_RESULT_SENTINEL} {"testFilesWritten":["manifest.json"],"untestableCriteria":[2,2]}\n`],
    ["unrecognized field", `${BLIND_QA_RESULT_SENTINEL} {"testFilesWritten":["manifest.json"],"untestableCriteria":[],"blocked":true}\n`],
    ["model is not a known tier", `${BLIND_QA_RESULT_SENTINEL} {"testFilesWritten":["manifest.json"],"untestableCriteria":[],"model":"gpt"}\n`],
    ["the vacuous envelope, stated explicitly", `${BLIND_QA_RESULT_SENTINEL} {"testFilesWritten":[],"untestableCriteria":[]}\n`],
  ];

  for (const [label, stdout] of unparseable) {
    it(`throws BlindQaOutputParseError: ${label}`, async () => {
      const world = await makeBlindWorld();
      const fake = createFakeClaudeCli(blindSeat(CONFORMING_FILES, stdout), world.quarantine);
      const port = makePort(fake, { blindQa: world.blindQa });

      const outcome = await port
        .dispatchBlindQa(makeBlindCtx(world))
        .then((value) => ({ resolved: value }))
        .catch((thrown: unknown) => ({ thrown }));

      // The criterion's exact wording: never `{ testFilesWritten: [],
      // untestableCriteria: [] }`, which reads as "every criterion was
      // testable" and would silently discard ALI-105's AC8.
      expect(outcome).not.toHaveProperty("resolved");
      expect((outcome as { thrown: unknown }).thrown).toBeInstanceOf(BlindQaOutputParseError);
      // Nothing published from output the runtime could not understand.
      expect(existsSync(world.artifactDir)).toBe(false);
    });
  }

  it("populates untestableCriteria ONLY from the envelope — never inferred from prose", async () => {
    const world = await makeBlindWorld();
    const prose = [
      "Criterion 4 is untestable as written; I could not write a test for it.",
      "UNTESTABLE: criterion 5 names no observable behavior.",
      `${BLIND_QA_RESULT_SENTINEL} ${JSON.stringify({
        testFilesWritten: [BLIND_QA_MANIFEST_FILENAME, "ac-1.test.ts", "ac-2.test.ts"],
        untestableCriteria: [3],
      })}`,
      "",
    ].join("\n");
    const fake = createFakeClaudeCli(blindSeat(CONFORMING_FILES, prose), world.quarantine);
    const port = makePort(fake, { blindQa: world.blindQa });

    const result = await port.dispatchBlindQa(makeBlindCtx(world));

    expect(result.untestableCriteria).toEqual([3]);
  });

  it("carries tokensUsed, model and effort through when the envelope sets them", async () => {
    const world = await makeBlindWorld();
    const fake = createFakeClaudeCli(
      blindSeat(CONFORMING_FILES, {
        ...CONFORMING_ENVELOPE,
        tokensUsed: 2048,
        model: "sonnet",
        effort: "standard",
      }),
      world.quarantine,
    );
    const port = makePort(fake, { blindQa: world.blindQa });

    const result = await port.dispatchBlindQa(makeBlindCtx(world));

    expect(result).toEqual({
      testFilesWritten: [
        join(...BLIND_TESTS_DIR_SEGMENTS, BLIND_ISSUE_ID, "ac-1.test.ts"),
        join(...BLIND_TESTS_DIR_SEGMENTS, BLIND_ISSUE_ID, "ac-2.test.ts"),
        join(...BLIND_TESTS_DIR_SEGMENTS, BLIND_ISSUE_ID, BLIND_QA_MANIFEST_FILENAME),
      ],
      untestableCriteria: [3],
      tokensUsed: 2048,
      model: "sonnet",
      effort: "standard",
    });
  });

  it("never back-fills `model` from the tier it pinned (ALI-106 AC3)", async () => {
    const world = await makeBlindWorld();
    const fake = createFakeClaudeCli(blindSeat(CONFORMING_FILES, CONFORMING_ENVELOPE), world.quarantine);
    const port = makePort(fake, { blindQa: world.blindQa });

    const result = await port.dispatchBlindQa(makeBlindCtx(world));

    expect(modelArgFrom(fake.invocations[0].args)).toBe(TIER_MODEL_IDS[BLIND_QA_TIER]);
    expect(result.model).toBeUndefined();
  });

  it("throws SeatProcessFailedError when the blind seat exits non-zero, even with a valid envelope", async () => {
    const world = await makeBlindWorld();
    const fake = createFakeClaudeCli(
      blindSeat(CONFORMING_FILES, CONFORMING_ENVELOPE, { exitCode: 1, stderr: "panic: no write permission" }),
      world.quarantine,
    );
    const port = makePort(fake, { blindQa: world.blindQa });

    const error = await thrownBy(() => port.dispatchBlindQa(makeBlindCtx(world)));

    expect(error).toBeInstanceOf(SeatProcessFailedError);
    expect((error as SeatProcessFailedError).seat).toBe(BLIND_QA_DEFINITION);
    expect(existsSync(world.artifactDir)).toBe(false);
  });

  it("scrubs secrets out of the blind seat's failure paths (S4)", async () => {
    const world = await makeBlindWorld();
    const leaky: readonly string[] = [
      `${BLIND_QA_RESULT_SENTINEL} ghp_AAAABBBBCCCCDDDDEEEE\n`,
      `${BLIND_QA_RESULT_SENTINEL} {"testFilesWritten":["manifest.json"],"untestableCriteria":[],"lin_api_deadbeefdeadbeef":1}\n`,
    ];

    for (const stdout of leaky) {
      const fake = createFakeClaudeCli(blindSeat(CONFORMING_FILES, stdout), world.quarantine);
      const port = makePort(fake, { blindQa: world.blindQa });
      const error = await thrownBy(() => port.dispatchBlindQa(makeBlindCtx(world)));

      expect(error).toBeInstanceOf(BlindQaOutputParseError);
      expect(containsSecretLike(error.message)).toBe(false);
    }

    const failing = createFakeClaudeCli(
      blindSeat(CONFORMING_FILES, CONFORMING_ENVELOPE, { exitCode: 1, stderr: "denied for sk-LEAKED123456" }),
      world.quarantine,
    );
    const error = await thrownBy(() =>
      makePort(failing, { blindQa: world.blindQa }).dispatchBlindQa(makeBlindCtx(world)),
    );
    expect(containsSecretLike(error.message)).toBe(false);
  });

  it("parseBlindQaResult is usable directly and applies the same strictness", () => {
    expect(
      parseBlindQaResult(`${BLIND_QA_RESULT_SENTINEL} {"testFilesWritten":["manifest.json"],"untestableCriteria":[7]}`),
    ).toEqual({ reportedFiles: ["manifest.json"], untestableCriteria: [7] });
    expect(() => parseBlindQaResult("no envelope")).toThrow(BlindQaOutputParseError);
  });
});

// ---------------------------------------------------------------------------
// Criterion 5 — the per-dispatch timeout
// ---------------------------------------------------------------------------

describe("ALI-162 criterion 5: a hung blind seat is killed, not waited on", () => {
  it("rejects with SeatDispatchTimeoutError, kills the child, and cleans up staging", async () => {
    const world = await makeBlindWorld();
    const fake = createFakeClaudeCli(() => "hang", world.quarantine);
    const port = makePort(fake, { blindQa: world.blindQa, timeoutMs: 40 });

    const startedAt = Date.now();
    const error = await thrownBy(() => port.dispatchBlindQa(makeBlindCtx(world)));
    const elapsed = Date.now() - startedAt;

    // Same bound, same reason as the build seats: the run's hard backstop is
    // checked at seat boundaries, so an unbounded blind seat would hold the run
    // past wallClockHardMs and the parked-work guarantee would never fire.
    expect(error).toBeInstanceOf(SeatDispatchTimeoutError);
    expect((error as SeatDispatchTimeoutError).seat).toBe(BLIND_QA_DEFINITION);
    expect((error as SeatDispatchTimeoutError).timeoutMs).toBe(40);
    expect(elapsed).toBeLessThan(5_000);
    expect(fake.killCount).toBe(1);
    expect(await listFiles(world.stagingRoot)).toEqual([]);
    expect(existsSync(world.artifactDir)).toBe(false);
  });

  it("does not kill a blind seat that finishes inside the limit", async () => {
    const world = await makeBlindWorld();
    const fake = createFakeClaudeCli(blindSeat(CONFORMING_FILES, CONFORMING_ENVELOPE), world.quarantine);
    const port = makePort(fake, { blindQa: world.blindQa, timeoutMs: 5_000 });

    await port.dispatchBlindQa(makeBlindCtx(world));

    expect(fake.killCount).toBe(0);
    expect(DEFAULT_SEAT_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Criterion 6 (the teeth behind every criterion above) — the fake refuses a leak
// ---------------------------------------------------------------------------

describe("ALI-162 criterion 6 (faithful fake): the runner fake rejects a leaking invocation", () => {
  /** The invocation shape a careless edit produces: build-seat treatment applied to the blind seat. */
  function leakingSpec(overrides: Partial<ProcessSpec>): ProcessSpec {
    return {
      command: "claude",
      args: ["--print", "--model", TIER_MODEL_IDS.sonnet, "--setting-sources", "user", "--system-prompt", "qa"],
      cwd: "/tmp",
      env: {},
      stdin: "criteria",
      ...overrides,
    };
  }

  it("rejects a prompt that names the worktree", async () => {
    const world = await makeBlindWorld();
    const fake = createFakeClaudeCli(undefined, world.quarantine);

    const handle = fake.runner.spawn(
      leakingSpec({ stdin: `criteria\n<workspace worktree="${world.worktreePath}" />` }),
    );
    const result = await handle.exited;

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/worktree path/);
    expect(result.stderr).toMatch(/prompt/);
    // Refused before any work: nothing recorded as a real run, so a leaking
    // adapter cannot make criterion 2's assertions pass by never being seen.
    expect(fake.invocations).toEqual([]);
    expect(fake.rejections).toHaveLength(1);
    // The refusal itself does not echo the value it refused.
    expect(result.stderr).not.toContain(world.worktreePath);
  });

  it("rejects argv that carries the branch name", async () => {
    const world = await makeBlindWorld();
    const fake = createFakeClaudeCli(undefined, world.quarantine);

    const handle = fake.runner.spawn(
      leakingSpec({
        args: ["--print", "--model", TIER_MODEL_IDS.sonnet, "--setting-sources", "user", "--system-prompt", `qa on ${BLIND_BRANCH}`],
      }),
    );

    expect((await handle.exited).stderr).toMatch(/branch name.*argv|argv.*branch name/);
    expect(fake.invocations).toEqual([]);
  });

  it("rejects cwd = the worktree — the build seats' cwd, wrong for this seat", async () => {
    const world = await makeBlindWorld();
    const fake = createFakeClaudeCli(undefined, world.quarantine);

    const handle = fake.runner.spawn(leakingSpec({ cwd: world.worktreePath }));

    expect((await handle.exited).stderr).toMatch(/working directory/);
    expect(fake.invocations).toEqual([]);
  });

  it("rejects a prompt carrying the diff itself", async () => {
    const world = await makeBlindWorld();
    const fake = createFakeClaudeCli(undefined, world.quarantine);

    const handle = fake.runner.spawn(leakingSpec({ stdin: `criteria\n${BLIND_DIFF_TEXT}` }));

    expect((await handle.exited).stderr).toMatch(/diff text/);
    expect(fake.invocations).toEqual([]);
  });

  it("surfaces a fake rejection through dispatchBlindQa as a loud failure, not a clean result", async () => {
    const world = await makeBlindWorld();
    // A runner that refuses everything models a CLI whose contract we broke.
    const alwaysRefuses: ProcessRunner = {
      spawn: () => ({
        exited: Promise.resolve({ exitCode: 2, stdout: "", stderr: "error: refusing this invocation\n" }),
        kill() {},
      }),
    };
    const port = createClaudeCliAgentPort({
      runner: alwaysRefuses,
      timeoutMs: 1_000,
      envSource: {},
      blindQa: world.blindQa,
    });

    await expect(port.dispatchBlindQa(makeBlindCtx(world))).rejects.toBeInstanceOf(SeatProcessFailedError);
    expect(existsSync(world.artifactDir)).toBe(false);
  });

  it("still accepts the adapter's own invocation — the quarantine is not blanket refusal", async () => {
    const world = await makeBlindWorld();
    const fake = createFakeClaudeCli(blindSeat(CONFORMING_FILES, CONFORMING_ENVELOPE), world.quarantine);
    const port = makePort(fake, { blindQa: world.blindQa });

    const result = await port.dispatchBlindQa(makeBlindCtx(world));

    expect(fake.rejections).toEqual([]);
    expect(result.testFilesWritten).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Configuration and context guards — loud, never a silent empty result
// ---------------------------------------------------------------------------

describe("ALI-162: the blind seat fails closed when it is not properly wired", () => {
  it("throws BlindQaNotConfiguredError when the port has no pinned engine tree for it", async () => {
    const world = await makeBlindWorld();
    const fake = createFakeClaudeCli(blindSeat(CONFORMING_FILES, CONFORMING_ENVELOPE), world.quarantine);
    const port = makePort(fake); // no blindQa config

    const error = await thrownBy(() => port.dispatchBlindQa(makeBlindCtx(world)));

    expect(error).toBeInstanceOf(BlindQaNotConfiguredError);
    // Names why the context cannot supply it, so nobody "fixes" this by
    // widening BlindDispatchContext and reopening ALI-105's closed channel.
    expect(error.message).toMatch(/BlindDispatchContext/);
    expect(error.message).toMatch(/ALI-121/);
    expect(fake.invocations).toEqual([]);
  });

  it("refuses a relative blindQa path at construction, before any run can use it", async () => {
    const fake = createFakeClaudeCli();

    for (const blindQa of [
      { enginePath: "engine-pin" },
      { enginePath: "/abs/engine", artifactRoot: "./checkout" },
      { enginePath: "/abs/engine", stagingRoot: "tmp" },
      { enginePath: "   " },
    ]) {
      expect(() => createClaudeCliAgentPort({ runner: fake.runner, blindQa })).toThrow(/absolute path/);
    }
    // And a port with no blind config at all is still constructible — the build
    // seats do not depend on it.
    expect(() => createClaudeCliAgentPort({ runner: fake.runner })).not.toThrow();
  });

  it("refuses an empty acceptance-criteria context rather than burning a dispatch on it", async () => {
    const world = await makeBlindWorld();
    const fake = createFakeClaudeCli(blindSeat(CONFORMING_FILES, CONFORMING_ENVELOPE), world.quarantine);
    const port = makePort(fake, { blindQa: world.blindQa });

    const error = await thrownBy(() =>
      port.dispatchBlindQa({ ...makeBlindCtx(world), acceptanceCriteria: "   " }),
    );

    expect(error).toBeInstanceOf(BlindQaInvalidContextError);
    expect(fake.invocations).toEqual([]);
  });

  it("is not reachable through dispatch(): `qa` is not a build seat", async () => {
    const world = await makeBlindWorld();
    const fake = createFakeClaudeCli(undefined, world.quarantine);
    const port = makePort(fake, { blindQa: world.blindQa });

    await expect(
      port.dispatch(BLIND_QA_DEFINITION as unknown as Seat, makeCtx({ enginePath: world.enginePath, worktreePath: world.worktreePath })),
    ).rejects.toBeInstanceOf(UnknownSeatError);
    expect(isBuildSeat(BLIND_QA_DEFINITION)).toBe(false);
    expect(BUILD_SEATS).not.toContain(BLIND_QA_DEFINITION as unknown as Seat);
    expect(fake.invocations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The real ProcessRunner — exercised hermetically against `node`, no CLI
//
// Every test above runs against the fake, which is the point (the criteria are
// about the adapter's decisions, not about spawning). But a real adapter that
// no test ever executes is a stub wearing a real adapter's name — ALI-155's
// other half — so these two prove the actual subprocess boundary works: stdin
// delivery plus a real kill. Same treatment `run.test.ts` gives its real
// `WorktreePort` (real git in a temp dir, no network, no credentials).
// ---------------------------------------------------------------------------

describe("createNodeProcessRunner (real subprocess, no claude CLI involved)", () => {
  async function writeScript(root: string, name: string, source: string): Promise<string> {
    const path = join(root, name);
    await fs.writeFile(path, source, "utf8");
    return path;
  }

  /** Signal 0 probes liveness without delivering anything. */
  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  it("delivers both channels to a real child — pinned definition on argv, work prompt on stdin", async () => {
    const { enginePath, worktreePath } = await makeTrees();
    // A stand-in "seat": checks it received the pinned definition as its system
    // prompt (argv) and the work prompt on stdin, then answers with the result
    // envelope — the two-channel contract the real CLI is invoked under.
    const script = await writeScript(
      worktreePath,
      "seat.sh",
      [
        "#!/bin/sh",
        'argv="$*"',
        "stdin=$(cat)",
        `case "$argv" in *${ENGINE_MARKER}*) sys=yes ;; *) sys=no ;; esac`,
        'case "$stdin" in *ALI-REAL-RUN*) work=yes ;; *) work=no ;; esac',
        'if [ "$sys" = yes ] && [ "$work" = yes ]; then',
        `  echo '${SEAT_RESULT_SENTINEL} {"summary":"real subprocess: pinned system prompt + work prompt"}'`,
        "else",
        `  echo '${SEAT_RESULT_SENTINEL} {"summary":"MISSING CHANNEL sys='"$sys"' work='"$work"'"}'`,
        "fi",
      ].join("\n"),
    );
    await fs.chmod(script, 0o755);

    const port = createClaudeCliAgentPort({
      runner: createNodeProcessRunner(),
      command: script,
      timeoutMs: 20_000,
      envSource: process.env,
    });

    const result = await port.dispatch(
      "builder",
      makeCtx({ enginePath, worktreePath, issue: makeIssue({ id: "ALI-REAL-RUN" }) }),
    );

    expect(result.summary).toBe("real subprocess: pinned system prompt + work prompt");
  }, 30_000);

  it("kills the whole process GROUP, not just the direct child (S5)", async () => {
    const { worktreePath } = await makeTrees();
    // The seat's own children — `claude` spawns Bash-tool subprocesses and MCP
    // servers — are what survived a single-pid SIGKILL in round 1: orphans
    // holding the child's credential-bearing env and a cwd inside a worktree
    // the run has already parked.
    const pidFile = join(worktreePath, "grandchild.pid");
    const script = await writeScript(
      worktreePath,
      "spawner.sh",
      ["#!/bin/sh", "sleep 300 &", `echo $! > ${pidFile}`, "sleep 300"].join("\n"),
    );
    await fs.chmod(script, 0o755);

    const runner = createNodeProcessRunner();
    const handle = runner.spawn({
      command: script,
      args: [],
      cwd: worktreePath,
      env: buildSeatEnv(process.env),
      stdin: "",
    });

    // Wait for the grandchild to exist.
    let grandchildPid = 0;
    for (let attempt = 0; attempt < 100 && grandchildPid === 0; attempt++) {
      try {
        grandchildPid = Number.parseInt(await fs.readFile(pidFile, "utf8"), 10) || 0;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    expect(grandchildPid).toBeGreaterThan(0);
    expect(isAlive(grandchildPid)).toBe(true);

    handle.kill();
    await handle.exited;

    // Give the group signal a moment to land on the grandchild.
    for (let attempt = 0; attempt < 100 && isAlive(grandchildPid); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(isAlive(grandchildPid)).toBe(false);
  }, 30_000);

  it("settles on the child's exit even while a grandchild holds the pipes open (S5)", async () => {
    const { enginePath, worktreePath } = await makeTrees();
    // `close` waits for stdio EOF, which an inheriting grandchild can hold for
    // as long as it likes — reporting a FINISHED seat as timed out, at which
    // point round 1's kill() was a no-op because the direct child had already
    // exited, so the pipe holder was never signalled at all.
    const pidFile = join(worktreePath, "pipe-holder.pid");
    const script = await writeScript(
      worktreePath,
      "leaky.sh",
      [
        "#!/bin/sh",
        "sleep 30 &",
        `echo $! > ${pidFile}`,
        `echo '${SEAT_RESULT_SENTINEL} {"summary":"finished despite a pipe holder"}'`,
      ].join("\n"),
    );
    await fs.chmod(script, 0o755);

    const port = createClaudeCliAgentPort({
      runner: createNodeProcessRunner(),
      command: script,
      // Well below the pipe holder's 30s lifetime: an implementation that waited
      // for `close` would blow this limit and report a timeout for a seat that
      // finished in milliseconds.
      timeoutMs: 3_000,
      envSource: process.env,
    });

    const startedAt = Date.now();
    const result = await port.dispatch("builder", makeCtx({ enginePath, worktreePath }));
    const elapsed = Date.now() - startedAt;

    expect(result.summary).toBe("finished despite a pipe holder");
    expect(elapsed).toBeLessThan(3_000);

    // Don't leave the pipe holder behind for the rest of the suite.
    try {
      const holder = Number.parseInt(await fs.readFile(pidFile, "utf8"), 10);
      if (holder > 0) process.kill(holder, "SIGKILL");
    } catch {
      /* already gone */
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// The prompt itself — the seat gets the issue's facts plus the output contract
// ---------------------------------------------------------------------------

describe("prompt assembly", () => {
  it("carries the issue's id/title/body and the result-envelope contract", async () => {
    const { enginePath, worktreePath } = await makeTrees();
    const fake = createFakeClaudeCli();
    const port = makePort(fake);
    const issue = {
      ...makeIssue({ id: "ALI-161", title: "Real AgentPort adapter", points: 2, labels: ["critical"] }),
      body: "## Acceptance criteria\n\n1. explicit model argument\n",
    };

    await port.dispatch("builder", makeCtx({ enginePath, worktreePath, issue }));

    const prompt = fake.invocations[0].stdin;
    expect(prompt).toContain("ALI-161");
    expect(prompt).toContain("Real AgentPort adapter");
    expect(prompt).toContain("explicit model argument");
    expect(prompt).toContain(SEAT_RESULT_SENTINEL);
    expect(prompt).toContain(worktreePath);
    // The pinned tree's path is deliberately NOT here (S3), and the seat's
    // instructions are not here either — they govern via --system-prompt (S1).
    expect(prompt).not.toContain(enginePath);
    expect(prompt).not.toContain(ENGINE_MARKER);
    expect(systemPromptArgFrom(fake.invocations[0].args)).toContain(ENGINE_MARKER);
  });

  it("tolerates an issue with no body (the pure `Issue` shape the pipeline is typed against)", async () => {
    const { enginePath, worktreePath } = await makeTrees();
    const fake = createFakeClaudeCli();
    const port = makePort(fake);

    await port.dispatch("builder", makeCtx({ enginePath, worktreePath }));

    expect(fake.invocations[0].stdin).toContain("(no issue body recorded)");
  });
});
