/**
 * Dispatcher runtime — the GitHub port.
 *
 * `GitHubPort` needs real network + a real GitHub token — a different
 * concern from `worktree.ts`'s local git plumbing (that file's own doc
 * comment says so; `createGitHubApiPort()` used to live there as a thin
 * throw-only stub and is deleted from it by this change). An HTTP client
 * with credentials and REST error-mapping belongs in its own file so a
 * future GitHub-API change never lands in the same clustering lane as a
 * future worktree/pin change (CLAUDE.md "Concurrency"). `GitHubPort`,
 * `DraftPrParams` and `DraftPrResult` themselves stay in `worktree.ts` —
 * only the adapter moves.
 *
 * Two methods:
 *
 *   - `pushBranch` shells out to real `git push` from the worktree
 *     (`worktree.ts` already owns `execFileAsync`-based git plumbing; this
 *     file uses the same tool for the same reason). No retry: AC1 wants a
 *     rejected or non-fast-forward push to fail LOUD, not to be silently
 *     retried into a different outcome.
 *   - `openDraftPr` is Node 22's built-in `fetch` against GitHub's REST API
 *     — no new npm dependency, same discipline `linear.ts`'s ALI-158 adapter
 *     already established (see that file's doc comment: this repo just
 *     closed two supply-chain issues, ALI-137/ALI-144, and a dependency in
 *     the credential-holding path is not free). No `gh` CLI (ALI-135 cycle-14
 *     retro incident 6: `gh` 403s in the unattended run environment even
 *     though a raw token authenticates fine directly against the REST API —
 *     see the contract-evidence block below for how that was reconfirmed for
 *     this issue, and `classifyForbidden` below for where it lands in the
 *     adapter's own error shape).
 *
 * ALI-133's fix — the fake in `__tests__/run.test.ts`'s `createFakeGitHub()`
 * already models GitHub's two hard 422 rejections (an unknown `base` throws;
 * a duplicate open PR for the same `(branch, base)` throws 422-shaped) —
 * added after the pre-fix fake let a same-head/base double-PR collision
 * through as a flag instead of a red test. This file's error mapping
 * reproduces those two rejections' exact message text (see
 * `duplicatePrMessage`/`invalidBaseMessage` below) so a run-loop test written
 * against the fake and a run-loop test written against this real client see
 * IDENTICAL wording for the same failure class (AC8, ALI-155's "faithful
 * fake" doctrine, teeth: reconciled in `__tests__/github.test.ts`, not by
 * editing `run.test.ts` — that file is not among this issue's predicted
 * files, and `linear.ts`'s own doc comment gives the precedent for keeping a
 * reconciliation fixture local rather than importing across a clustering
 * lane it doesn't belong in).
 *
 * NOT PROVEN AGAINST THE REAL SYSTEM until AC9's live contract test has run
 * green once (needs ALI-157's credential). Everything else here is proven
 * against a faithful fake and against GitHub's published REST contract —
 * see "Contract evidence" below for exactly what was verified live in THIS
 * build sandbox versus taken from documentation.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { scrubSecrets } from "./runlog.js";
import type { DraftPrParams, DraftPrResult, GitHubPort } from "./worktree.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Contract evidence (gate 8 grammar, docs/ENGINE.md §19)
//
//   SOURCE  https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#create-a-pull-request
//   READ AT 2026-08-22
//   LITERAL `POST /repos/{owner}/{repo}/pulls`; documented response codes are
//           201 (Created), 403 (Forbidden), 422 (Validation failed, or the
//           endpoint has been spammed) — 401 is not separately documented on
//           this endpoint's own page, but is GitHub's general "missing or
//           malformed credentials" code (below); the docs state most REST
//           endpoints accept `Authorization: Bearer <token>`.
//
//   SOURCE  https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api?apiVersion=2022-11-28
//   READ AT 2026-08-22
//   LITERAL A 422 response carries an `errors[]` array whose `code` is one
//           of `missing`, `missing_field`, `invalid`, `already_exists`,
//           `unprocessable`, or `custom` (a `custom` code requires reading
//           the sibling `message` field for the reason) — this is the field
//           `buildValidationError` below inspects for the `field: "base",
//           code: "invalid"` shape the issue's AC4 names.
//
//   NOT VERIFIED LIVE IN THIS SESSION, and here is exactly why, since this
//   contradicts what a naive `curl` in this build sandbox suggests: a request
//   to `api.github.com/repos/**` from inside this CODING sandbox (distinct
//   from the target unattended RUN environment ALI-157 provisions) is
//   answered by this sandbox's OWN mediating proxy, not by GitHub —
//   confirmed by observing that BOTH an unauthenticated request AND a
//   request carrying a deliberately garbage bearer token to
//   `https://api.github.com/user` returned HTTP 200 with the SAME fixed
//   account profile. A repo-scoped call
//   (`/repos/pedroestevez/Development-Engine-Seed`) returned HTTP 403 with
//   `{"message":"GitHub access is not enabled for this session...",
//   "documentation_url":"https://docs.anthropic.com/..."}` — a
//   GitHub-shaped envelope whose `documentation_url` points at
//   `docs.anthropic.com`, not `docs.github.com`. That mismatch is exactly
//   the signal `classifyForbidden` below uses to tell a real GitHub 403 from
//   one manufactured by something sitting in front of GitHub — this session
//   handed it the case in point. The two REST error shapes above are
//   therefore `[from docs]`, not `[verified: live 422]`; AC9's live contract
//   test against the real production run environment is what closes that
//   gap for real.
//
//   PROXY REACHABILITY, reconciling ALI-135 incident 6 with this issue's own
//   design note: this session independently confirmed `gh auth status`
//   fails in this sandbox ("Failed to log in to github.com using token
//   (GH_TOKEN)"), while the SAME token as a raw `Authorization: Bearer`
//   header against `api.github.com/user` and `.../rate_limit` returns 200.
//   The accurate statement is not "GitHub is unreachable from this
//   environment" — it is "the `gh` CLI wrapper fails here; a raw REST call
//   with the same token does not." That is corroborating evidence for, not
//   against, the "no `gh` CLI" design decision above.
//
//   PROXYING MECHANISM: Node's global `fetch` does NOT read `HTTP_PROXY`/
//   `HTTPS_PROXY` env vars on its own (no `setGlobalDispatcher` call is made
//   anywhere in this repo, and `node:undici` — the module that would supply
//   `EnvHttpProxyAgent` — is not importable as a bare built-in on this
//   sandbox's Node 22.22.2: `import("node:undici")` throws
//   `ERR_UNKNOWN_BUILTIN_MODULE`). Despite that, a plain `fetch()` with no
//   proxy code at all already reaches `api.github.com` in this sandbox
//   (`/rate_limit`, `/user` both 200) — outbound HTTPS here is intercepted
//   transparently at the network layer (this session's own environment
//   notes: "Outbound HTTPS goes through a pre-configured agent proxy") and
//   trusted via `NODE_EXTRA_CA_CERTS`, so no proxy-agent wiring is needed
//   FROM THIS ADAPTER for that to keep working. This is the same posture
//   `linear.ts`'s adapter already takes (plain global `fetch`, no proxy
//   code) — unchanged here, and consistent with the "zero runtime
//   dependencies" rule, since honoring `HTTPS_PROXY` explicitly would need
//   `undici`'s `EnvHttpProxyAgent`, a dependency this repo does not carry.
// ---------------------------------------------------------------------------

/** GitHub's REST API base. Overridable per-adapter only so tests can point at a fake. */
export const GITHUB_API_URL = "https://api.github.com";

/**
 * Environment variables the live contract test (AC9) reads. Named here so
 * ALI-157 provisions exactly these strings and the loud skip can quote them
 * — same discipline as `linear.ts`'s `LINEAR_API_KEY_ENV`/`LINEAR_TEAM_ID_ENV`.
 * Deliberately NOT `GH_TOKEN` (the `gh` CLI's own variable, already present
 * in some environments including this build sandbox's) — reusing it would
 * silently couple this adapter to whatever the `gh` CLI happens to have,
 * which is exactly the tool this design decision says never to depend on.
 */
export const GITHUB_TOKEN_ENV = "GITHUB_TOKEN";
export const GITHUB_OWNER_ENV = "GITHUB_OWNER";
export const GITHUB_REPO_ENV = "GITHUB_REPO";
/** Base branch the live contract test opens its throwaway draft PR against. Defaults to "main" when unset. */
export const GITHUB_LIVE_BASE_BRANCH_ENV = "GITHUB_LIVE_BASE_BRANCH";

// ---------------------------------------------------------------------------
// Errors — same two-layer redaction discipline as `linear.ts`'s
// `LinearApiError` (that file's doc comment on `REDACTABLE_CREDENTIALS`
// explains why both layers run: `scrubSecrets()` (`runlog.ts`) only catches
// prefix-shaped secrets — `ghp_`/`github_pat_` for GitHub, which covers a
// classic or fine-grained PAT, but NOT a `ghs_`-prefixed GitHub App
// installation token or a `gho_` OAuth token, neither of which is in
// `SECRET_PREFIXES`. Value-redaction against every credential this process
// actually holds closes that gap regardless of prefix.
// ---------------------------------------------------------------------------

const REDACTABLE_CREDENTIALS = new Set<string>();

function rememberCredential(token: string): void {
  REDACTABLE_CREDENTIALS.add(token);
}

function sanitizeMessage(text: string): string {
  let out = text;
  for (const credential of REDACTABLE_CREDENTIALS) {
    out = out.split(credential).join("[REDACTED]");
  }
  return scrubSecrets(out);
}

function sanitizeCause(cause: unknown): unknown {
  if (cause === undefined) return undefined;
  if (cause instanceof Error) {
    const sanitized = new Error(sanitizeMessage(cause.message));
    sanitized.name = cause.name;
    sanitized.stack = `${cause.name}: ${sanitizeMessage(cause.message)}\n    (stack omitted — see the GitHubApiError above)`;
    return sanitized;
  }
  return sanitizeMessage(String(cause));
}

/**
 * Every error this adapter throws — the single choke point for criterion 6
 * (message *and* cause), whether raised by the git subprocess in
 * `pushBranch` or the HTTP transport in `openDraftPr`.
 */
export class GitHubApiError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(sanitizeMessage(message), options?.cause === undefined ? undefined : { cause: sanitizeCause(options.cause) });
    this.name = "GitHubApiError";
  }
}

// ---------------------------------------------------------------------------
// Transport seam — local to this file (not shared with `linear.ts`'s
// identically-shaped one), same reasoning as that file's own local copy of
// `blindqa.ts`'s `extractSection`: this issue's predicted files are
// `github.ts`/`github.test.ts`, and importing a "shared" transport type from
// `linear.ts` would put a future Linear-transport change in this issue's
// clustering lane for no reason — the two adapters have no runtime
// relationship, only a coincidentally similar shape.
// ---------------------------------------------------------------------------

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

/** Defaults to the global `fetch`; tests pass a faithful fake (ALI-155). */
export type FetchLike = (url: string, init: HttpRequestInit) => Promise<HttpResponseLike>;

/** Bounded retry (AC7). `maxAttempts: 1` means "never retry". Mirrors `linear.ts`'s `RetryPolicy` shape. */
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

const MAX_ALLOWED_ATTEMPTS = 10;
const MAX_ALLOWED_DELAY_MS = 60_000;
const MAX_ALLOWED_TIMEOUT_MS = 120_000;

/** Same reasoning as `linear.ts`'s `MIN_API_KEY_CHARS`: guarantees value-redaction is never skipped for an accepted token. */
const MIN_TOKEN_CHARS = 8;

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface GitHubApiConfig {
  token: string;
  owner: string;
  repo: string;
  /** Defaults to `GITHUB_API_URL`. */
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
  token: string;
  owner: string;
  repo: string;
  fetchImpl: FetchLike;
  sleep: (ms: number) => Promise<void>;
  retry: RetryPolicy;
  requestTimeoutMs: number;
}

function resolveGlobalFetch(): FetchLike {
  const candidate = (globalThis as { fetch?: unknown }).fetch;
  if (typeof candidate !== "function") {
    throw new GitHubApiError(
      "No global fetch is available. This adapter requires Node >= 18 (package.json pins >= 22); " +
        "pass `fetchImpl` explicitly if running somewhere else.",
    );
  }
  return candidate as FetchLike;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateConfig(config: GitHubApiConfig): AdapterRuntime {
  if (typeof config.token !== "string" || config.token.trim() === "") {
    throw new GitHubApiError(
      `GitHub token is empty. Set ${GITHUB_TOKEN_ENV} (provisioned by ALI-157) — an adapter constructed ` +
        "without a credential would fail on every call at run time instead of here.",
    );
  }
  if (config.token.length < MIN_TOKEN_CHARS) {
    // Same defense as `linear.ts`'s S7 finding: a very short "token" is not
    // a real GitHub credential, and value-redaction of a tiny string would
    // corrupt unrelated error text. Rejecting it here keeps redaction total
    // for every token actually accepted.
    throw new GitHubApiError(
      `GitHub token is implausibly short (< ${MIN_TOKEN_CHARS} characters). Real GitHub tokens are far longer; ` +
        "a value this short is a misconfiguration, and it would weaken credential redaction.",
    );
  }
  if (typeof config.owner !== "string" || config.owner.trim() === "") {
    throw new GitHubApiError(`GitHub owner is empty. Set ${GITHUB_OWNER_ENV} (provisioned by ALI-157).`);
  }
  if (typeof config.repo !== "string" || config.repo.trim() === "") {
    throw new GitHubApiError(`GitHub repo is empty. Set ${GITHUB_REPO_ENV} (provisioned by ALI-157).`);
  }

  const retry: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...config.retry };
  if (!Number.isInteger(retry.maxAttempts) || retry.maxAttempts < 1 || retry.maxAttempts > MAX_ALLOWED_ATTEMPTS) {
    throw new GitHubApiError(
      `Invalid retry policy: maxAttempts must be an integer in 1..${MAX_ALLOWED_ATTEMPTS}, got ` +
        `${String(retry.maxAttempts)}. An unbounded retry budget is the failure AC7 exists to prevent.`,
    );
  }
  if (!Number.isFinite(retry.baseDelayMs) || retry.baseDelayMs < 0) {
    throw new GitHubApiError(`Invalid retry policy: baseDelayMs must be a finite, non-negative number.`);
  }
  if (!Number.isFinite(retry.maxDelayMs) || retry.maxDelayMs < 0 || retry.maxDelayMs > MAX_ALLOWED_DELAY_MS) {
    throw new GitHubApiError(
      `Invalid retry policy: maxDelayMs must be a finite number in 0..${MAX_ALLOWED_DELAY_MS} ms, got ` +
        `${String(retry.maxDelayMs)}. It is the ceiling a server-supplied Retry-After is clamped to, so it ` +
        "bounds how long an unattended run can be parked.",
    );
  }

  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0 || requestTimeoutMs > MAX_ALLOWED_TIMEOUT_MS) {
    throw new GitHubApiError(`Invalid requestTimeoutMs: must be a finite number in 1..${MAX_ALLOWED_TIMEOUT_MS} ms.`);
  }

  // Registered only after every validation has passed, so a rejected config
  // never adds a value to the redaction set.
  rememberCredential(config.token);
  // N1: the raw token is not the only form that can escape. What git puts on
  // the wire — and therefore what could appear in git's own diagnostics — is
  // base64("x-access-token:" + token), which neither this set nor
  // `scrubSecrets`'s prefix vocabulary would have matched. Redacting only the
  // form we happen to hold leaves a blind spot exactly where the credential
  // is materialized.
  rememberCredential(encodedCredential(config.token));

  return {
    endpoint: config.endpoint ?? GITHUB_API_URL,
    token: config.token,
    owner: config.owner,
    repo: config.repo,
    fetchImpl: config.fetchImpl ?? ((url, init) => resolveGlobalFetch()(url, init)),
    sleep: config.sleep ?? defaultSleep,
    retry,
    requestTimeoutMs,
  };
}

// ---------------------------------------------------------------------------
// pushBranch — real `git push`, no retry (AC1, AC6)
// ---------------------------------------------------------------------------

/** Bytes of process stderr/stdout echoed into a thrown message (after scrubbing). */
const ERROR_OUTPUT_SNIPPET_CHARS = 800;

function snippet(text: string, max = ERROR_OUTPUT_SNIPPET_CHARS): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…[truncated]` : trimmed;
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return String(cause);
}

/** `execFileAsync`'s rejection carries `.stderr`/`.stdout` alongside the usual `Error` fields. */
function describeExecError(cause: unknown): string {
  if (cause && typeof cause === "object") {
    const record = cause as { stderr?: unknown; stdout?: unknown; message?: unknown };
    const stderr = typeof record.stderr === "string" ? record.stderr.trim() : "";
    const stdout = typeof record.stdout === "string" ? record.stdout.trim() : "";
    const parts = [stderr, stdout].filter((s) => s !== "");
    if (parts.length > 0) return snippet(parts.join("\n"));
  }
  return describeCause(cause);
}

/**
 * Injects the push credential via `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/
 * `GIT_CONFIG_VALUE_0` (git >= 2.31) rather than `git -c http.extraheader=…`
 * or an embedded `https://TOKEN@…` remote URL. Both alternatives put the
 * literal token in this process's own argv (visible to anything that can
 * list `ps`/`/proc/<pid>/cmdline` for the lifetime of the child, and an
 * embedded-URL remote risks git itself echoing the URL — token included —
 * into its own error text on failure). The `GIT_CONFIG_*` env-var form is
 * git's own supported mechanism for supplying config without touching argv
 * OR any file: it is scoped to this one child process's environment, never
 * written to `.git/config` (verified: `[hermetic]` in `github.test.ts`), and
 * evaporates when the child exits — nothing to clean up, nothing that
 * survives a crash mid-push.
 *
 * **URL-scoped, and that scoping is load-bearing** (security finding F1).
 * An earlier version used the bare `http.extraheader` key, justified as "this
 * invocation only ever touches one remote (`origin`)". That conflated the
 * remote's *name* with the *URL it resolves to*. This adapter controls the
 * name; it does not control the URL. Git attaches a bare `http.extraheader`
 * to every HTTP(S) request it makes, to any host.
 *
 * Why that was exploitable, concretely: `SEAT_ENV_ALLOWLIST` (`agent.ts`)
 * deliberately withholds this token from build seats — "Never the run's
 * Linear/GitHub tokens" — but seats are real processes whose `cwd` is the
 * worktree, and `pushBranch` runs against that same worktree afterwards
 * (`run.ts`). A seat that writes `remote.origin.pushurl`, or a
 * `url.<x>.insteadOf` rule, into the config it shares with this repo would
 * have redirected the push — and an unscoped header would have handed the
 * attacker `Authorization: Basic base64("x-access-token:" + TOKEN)`. Base64
 * is reversible. The engine's own trust boundary would have been crossed by
 * the very component designed never to hold this credential.
 *
 * With the key scoped to the configured host, a repointed remote simply
 * fails to authenticate instead of exfiltrating. `assertRemoteIsExpected()`
 * below is the second layer: the push is refused before git is ever handed
 * the token.
 */
function pushEnv(token: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: PUSH_CREDENTIAL_CONFIG_KEY,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${encodedCredential(token)}`,
  };
}

/**
 * The only host this adapter will ever hand the push credential to.
 *
 * A constant rather than derived from `endpoint`: `endpoint` is the REST API
 * base (`api.github.com`), the push target is the git host, and letting one
 * imply the other is how a config change in one silently widens the other.
 */
const GITHUB_REMOTE_PREFIX = "https://github.com/";

/**
 * The git config key the push credential is attached to — exported so a test
 * can assert its *scoping*, not merely its absence from disk.
 *
 * Security finding F1 shipped once with the bare `http.extraheader` key and no
 * test caught it, because every existing assertion was about where the
 * credential is STORED. Where it is SENT needs its own assertion.
 */
export const PUSH_CREDENTIAL_CONFIG_KEY = `http.${GITHUB_REMOTE_PREFIX}.extraheader`;

/** The exact bytes git puts on the wire — see `rememberCredential` (N1). */
function encodedCredential(token: string): string {
  return Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
}

/**
 * Refuse to push unless `origin` still points where this adapter expects
 * (security finding F1, second layer).
 *
 * Checked immediately before the push and read from the worktree itself, so
 * it observes whatever a seat may have written rather than what this process
 * configured. `--push` resolves `remote.origin.pushurl` when set and falls
 * back to `remote.origin.url`, which is exactly the precedence git will use.
 */
async function assertRemoteIsExpected(
  runtime: AdapterRuntime,
  worktreePath: string,
): Promise<void> {
  let url: string;
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "--push", "origin"], {
      cwd: worktreePath,
    });
    url = stdout.trim();
  } catch (cause) {
    throw new GitHubApiError(
      `Could not read the push URL of "origin" in ${worktreePath}: ${describeExecError(cause)}. ` +
        "Refusing to push rather than hand a credential to a remote this adapter cannot verify.",
      { cause },
    );
  }

  // Only HTTP(S) remotes can receive the header at all: it is keyed
  // `http.https://github.com/.extraheader`, so git attaches it to matching
  // HTTPS requests and to nothing else. A filesystem or SSH remote is
  // therefore not an exfiltration path for THIS credential, and the hermetic
  // push tests rely on that (they push to a temp-dir repo). Redirecting a
  // push to a local path is a different and much smaller problem — the PR
  // this run is about to open would then fail to find its head — and it is
  // not one this guard is the right place to solve.
  if (!/^https?:\/\//i.test(url)) return;

  const expected = `${GITHUB_REMOTE_PREFIX}${runtime.owner}/${runtime.repo}`;
  const normalized = url.replace(/\.git$/, "");
  if (normalized !== expected) {
    throw new GitHubApiError(
      `Refusing to push: "origin" in ${worktreePath} resolves to ${normalized}, not ${expected}. ` +
        "The push credential is only ever sent to the configured repository — a remote repointed " +
        "after this run started is treated as hostile, not as a reconfiguration to follow.",
    );
  }
}

async function pushBranchImpl(runtime: AdapterRuntime, worktreePath: string, branch: string): Promise<void> {
  if (typeof worktreePath !== "string" || worktreePath.trim() === "") {
    throw new GitHubApiError("pushBranch() was called with an empty worktree path.");
  }
  if (typeof branch !== "string" || branch.trim() === "") {
    throw new GitHubApiError("pushBranch() was called with an empty branch name.");
  }

  try {
    // Explicit `<branch>:<branch>` refspec (never a bare `origin branch`,
    // never `--force`) — pushes exactly the local ref named `branch` to the
    // identically-named remote ref, and lets a divergent remote reject
    // normally rather than this call trying to make it succeed. AC1's whole
    // requirement is that a rejection surfaces as a thrown error, never as
    // a silently-forced overwrite.
    // F1: verified BEFORE the credential is put in the child's environment.
    await assertRemoteIsExpected(runtime, worktreePath);
    await execFileAsync("git", ["push", "origin", `${branch}:${branch}`], {
      cwd: worktreePath,
      env: pushEnv(runtime.token),
    });
  } catch (cause) {
    throw new GitHubApiError(
      `git push of "${branch}" to origin failed from ${worktreePath}: ${describeExecError(cause)}. A rejected ` +
        "or non-fast-forward push must never be treated as success — the PR this run is about to open would " +
        "otherwise point at a head GitHub never actually received.",
      { cause },
    );
  }
}

// ---------------------------------------------------------------------------
// openDraftPr — REST, bounded retry (AC7), rejection mapping (AC3/AC4/AC5)
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJsonSafely(text: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * `Retry-After` honoured but CAPPED at `maxDelayMs` — same reasoning as
 * `linear.ts`'s `backoffDelayMs`: a server (or anything sitting in front of
 * it) asking for an hour-long sleep must not be able to park an unattended
 * run for an hour.
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
 * AC3's exact wording: kept byte-for-byte identical to `createFakeGitHub()`'s
 * duplicate-PR rejection in `__tests__/run.test.ts` (as of this issue,
 * `run.test.ts:248`) so a run-loop assertion written against either sees the
 * same text. `__tests__/github.test.ts` holds an independently-typed copy of
 * that fake literal and asserts this function's output equals it — see this
 * file's top doc comment for why that copy lives there rather than being
 * imported from `run.test.ts`.
 */
function duplicatePrMessage(branch: string, base: string): string {
  return `A pull request already exists for ${branch} -> ${base}. (422-shaped, mirrors real GitHub.)`;
}

/** AC4's exact wording: kept byte-for-byte identical to `createFakeGitHub()`'s unknown-base rejection (`run.test.ts:241-243`). */
function invalidBaseMessage(branch: string, base: string): string {
  return `GitHub rejected PR ${branch} -> ${base}: base branch "${base}" was never pushed and is not the repo's base branch.`;
}

/**
 * AC3/AC4: GitHub's 422 `errors[]` entries (contract evidence above) are
 * inspected for the two specific shapes this issue names — `field: "base",
 * code: "invalid"` for an unreal base branch, and a `code: "custom"` entry
 * whose `message` says a PR already exists for this head/base. Anything else
 * shaped like a 422 is a generic validation failure this adapter has no
 * more specific mapping for, and says so rather than guessing.
 */
function buildValidationError(params: DraftPrParams, envelope: Record<string, unknown> | null, bodyText: string): GitHubApiError {
  const rawErrors = envelope?.errors;
  const errors = Array.isArray(rawErrors) ? rawErrors : [];

  const hasInvalidBase = errors.some((entry) => {
    const record = asRecord(entry);
    return record?.field === "base" && record?.code === "invalid";
  });
  if (hasInvalidBase) {
    return new GitHubApiError(invalidBaseMessage(params.branch, params.base));
  }

  const topLevelMessage = typeof envelope?.message === "string" ? envelope.message : "";
  const hasDuplicateEntry = errors.some((entry) => {
    const record = asRecord(entry);
    const entryMessage = typeof record?.message === "string" ? record.message.toLowerCase() : "";
    return record?.code === "custom" && entryMessage.includes("pull request already exists");
  });
  if (hasDuplicateEntry || /pull request already exists/i.test(topLevelMessage)) {
    return new GitHubApiError(duplicatePrMessage(params.branch, params.base));
  }

  return new GitHubApiError(
    `GitHub rejected openDraftPr ${params.branch} -> ${params.base} with HTTP 422 (validation failed): ` +
      `${snippet(bodyText)}`,
  );
}

/**
 * AC5: 401 is unambiguous — GitHub's own "missing or malformed credentials"
 * code. 403 is genuinely ambiguous by HTTP status alone (GitHub itself uses
 * it for insufficient scope AND for secondary rate limiting; something
 * sitting in front of GitHub — a proxy, a gateway, a WAF — can also answer
 * with its own unrelated 403 before the request ever reaches GitHub, which
 * is exactly the class ALI-135 incident 6 and this session's own contract-
 * evidence block above both hit). The discriminator: GitHub's REST API
 * always returns a JSON body; a real GitHub error additionally carries
 * `documentation_url` pointing at `docs.github.com` when it sets one at all.
 * A 403 that is not JSON, or whose `documentation_url` points somewhere
 * else, was answered by something other than GitHub — `"transport"`.
 * Otherwise it is GitHub's own decision — `"authentication"`.
 */
function classifyForbidden(status: number, envelope: Record<string, unknown> | null): "authentication" | "transport" {
  if (status === 401) return "authentication";
  if (envelope === null) return "transport";
  const docUrl = typeof envelope.documentation_url === "string" ? envelope.documentation_url : "";
  if (docUrl !== "" && !docUrl.startsWith("https://docs.github.com/")) return "transport";
  return "authentication";
}

function buildForbiddenError(
  params: DraftPrParams,
  status: number,
  envelope: Record<string, unknown> | null,
  bodyText: string,
): GitHubApiError {
  const classification = classifyForbidden(status, envelope);
  return new GitHubApiError(
    `GitHub API denied openDraftPr ${params.branch} -> ${params.base} (HTTP ${status}, classified as ` +
      `${classification}): ${snippet(bodyText)}. Never retried (AC7 — a 401/403 is a 4xx) and this adapter ` +
      "never falls back to the `gh` CLI (ALI-135 incident 6: that CLI 403s in the unattended run environment " +
      "even when the same token authenticates fine directly against the REST API).",
  );
}

async function openDraftPrImpl(runtime: AdapterRuntime, params: DraftPrParams): Promise<DraftPrResult> {
  const { retry } = runtime;
  const url = `${runtime.endpoint}/repos/${runtime.owner}/${runtime.repo}/pulls`;
  const requestBody = JSON.stringify({
    title: params.title,
    head: params.branch,
    base: params.base,
    body: params.body,
    // Not optional — `worktree.ts`'s `GitHubPort` doc comment states the
    // rule: every PR this dispatcher opens is a draft (AC2).
    draft: true,
  });

  for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
    let response: HttpResponseLike;
    try {
      response = await runtime.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${runtime.token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: requestBody,
        signal: AbortSignal.timeout(runtime.requestTimeoutMs),
      });
    } catch (cause) {
      // A network failure is never retried here — same posture as
      // `linear.ts`'s `executeGraphQL`. Only a 429/5xx HTTP response is
      // (below); this branch means no HTTP response was ever received.
      throw new GitHubApiError(
        `GitHub API request failed (openDraftPr ${params.branch} -> ${params.base}, attempt ` +
          `${attempt}/${retry.maxAttempts}): ${describeCause(cause)}`,
        { cause },
      );
    }

    let bodyText: string;
    try {
      bodyText = await response.text();
    } catch (cause) {
      throw new GitHubApiError(
        `GitHub API response body could not be read (openDraftPr, HTTP ${response.status}): ${describeCause(cause)}`,
        { cause },
      );
    }

    // AC7's teeth: ONLY 429 and 5xx are retried. Every other status —
    // 401/403/404/422 included — falls straight through to the mapping
    // below and is attempted exactly once. A retried 422 would merely
    // re-fail identically; a retried POST that had actually succeeded
    // server-side (the response merely got lost) would open a SECOND pull
    // request — the exact collision class this port exists to prevent.
    if (response.status === 429 || (response.status >= 500 && response.status <= 599)) {
      if (attempt >= retry.maxAttempts) {
        throw new GitHubApiError(
          `GitHub API did not recover: gave up on openDraftPr ${params.branch} -> ${params.base} after ` +
            `${retry.maxAttempts} attempt(s) (HTTP ${response.status}). Retries are bounded on purpose — an ` +
            `unattended run must never spin. Last response: ${snippet(bodyText)}`,
        );
      }
      await runtime.sleep(backoffDelayMs(attempt, response.headers.get("retry-after"), retry));
      continue;
    }

    const envelope = parseJsonSafely(bodyText);

    if (response.status === 401 || response.status === 403) {
      throw buildForbiddenError(params, response.status, envelope, bodyText);
    }
    if (response.status === 422) {
      throw buildValidationError(params, envelope, bodyText);
    }
    if (response.status !== 201) {
      throw new GitHubApiError(
        `GitHub API returned HTTP ${response.status} for openDraftPr ${params.branch} -> ${params.base}: ` +
          `${snippet(bodyText)}`,
      );
    }

    const number = envelope !== null && typeof envelope.number === "number" ? envelope.number : undefined;
    const htmlUrl = envelope !== null && typeof envelope.html_url === "string" ? envelope.html_url : undefined;
    if (number === undefined || htmlUrl === undefined) {
      throw new GitHubApiError(
        `GitHub API returned HTTP 201 for openDraftPr ${params.branch} -> ${params.base} but the response ` +
          `body had no usable \`number\`/\`html_url\`: ${snippet(bodyText)}`,
      );
    }
    return { number, url: htmlUrl };
  }

  /* c8 ignore next 4 -- unreachable: the loop either returns, throws, or exhausts into the retry-limit branch. */
  throw new GitHubApiError(
    `GitHub API retry loop exited without a result for openDraftPr ${params.branch} -> ${params.base} — this ` +
      "is a bug in the adapter.",
  );
}

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/** Real `GitHubPort` adapter (ALI-160). See this file's top doc comment for scope and contract evidence. */
export function createGitHubApiPort(config: GitHubApiConfig): GitHubPort {
  const runtime = validateConfig(config);
  return {
    pushBranch: (worktreePath, branch) => pushBranchImpl(runtime, worktreePath, branch),
    openDraftPr: (params) => openDraftPrImpl(runtime, params),
  };
}
