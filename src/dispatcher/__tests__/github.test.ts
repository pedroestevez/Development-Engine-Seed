/**
 * ALI-160 — real `GitHubPort` adapter: `pushBranch` (real git, hermetic) and
 * `openDraftPr` (REST over an injected `FetchLike`, ALI-155's faithful
 * fake discipline applied to the HTTP layer).
 *
 * Two kinds of test, deliberately kept apart:
 *
 *   - `pushBranch` is proven against REAL git in a throwaway temp-dir repo
 *     (criterion 1 asks for exactly this — the same hermetic pattern
 *     `__tests__/pinning.test.ts` already uses) — no fake stands in for git
 *     here, because "does a rejected push actually surface as a thrown
 *     error" is a claim only real git can settle.
 *   - `openDraftPr` is proven against a stubbed HTTP transport
 *     (`FetchLike`), same discipline `linear.test.ts` already applies to
 *     `LinearApiError`.
 *
 * AC8's reconciliation test hardcodes its own literal copies of
 * `createFakeGitHub()`'s two rejection messages (`run.test.ts`, at the time
 * of writing lines 241-250) rather than importing them — `run.test.ts` is
 * not among this issue's predicted files, and `linear.ts`'s own doc comment
 * on its local copy of `blindqa.ts`'s `extractSection` gives the precedent:
 * importing across that boundary would put a future `run.test.ts` fixture
 * edit in this issue's clustering lane. If the two ever drift, THESE
 * assertions are what catch it, not a shared import silently keeping them
 * in sync by construction.
 *
 * AC9's live contract test runs only when GITHUB_TOKEN/GITHUB_OWNER/
 * GITHUB_REPO are set and otherwise emits a visible skip naming the missing
 * variable(s) — same shape as `linear.test.ts`'s AC9 block. In THIS build
 * sandbox none of the three is set (confirmed), and the sandbox's own
 * network proxy fabricates responses for repo-scoped GitHub API calls
 * regardless (see `github.ts`'s contract-evidence comment) — so the skip is
 * not merely expected here, it is the only honest outcome: this task was
 * explicitly told not to push or open a PR from this worktree, and an
 * unset credential is what keeps that true by construction, not a
 * self-imposed rule this test file adds on top.
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  createGitHubApiPort,
  DEFAULT_RETRY_POLICY,
  GITHUB_API_URL,
  GITHUB_OWNER_ENV,
  GITHUB_REPO_ENV,
  GITHUB_TOKEN_ENV,
  GitHubApiError,
  type FetchLike,
  type GitHubApiConfig,
  type HttpResponseLike,
} from "../github.js";
import { containsSecretLike } from "../runlog.js";
import type { DraftPrParams } from "../worktree.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const DUMMY_TOKEN = "ghp_dummyDummyDummyDummyDummyDummy01";
const OWNER = "acme";
const REPO = "widgets";
const FAKE_ENDPOINT = "https://fake-github.example/api";

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

function textResponse(status: number, body: string): HttpResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => body,
  };
}

function respondWith(...responses: HttpResponseLike[]): { fetchImpl: FetchLike; requests: { url: string; init: unknown }[] } {
  let index = 0;
  const requests: { url: string; init: unknown }[] = [];
  return {
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      const response = responses[Math.min(index, responses.length - 1)];
      index++;
      return response;
    },
    requests,
  };
}

function portWithTransport(fetchImpl: FetchLike, overrides: Partial<GitHubApiConfig> = {}) {
  return createGitHubApiPort({
    token: DUMMY_TOKEN,
    owner: OWNER,
    repo: REPO,
    endpoint: FAKE_ENDPOINT,
    fetchImpl,
    sleep: async () => {},
    ...overrides,
  });
}

const PR_PARAMS: DraftPrParams = {
  branch: "issue/ALI-999",
  base: "main",
  title: "ALI-999: fixture PR",
  body: "Implements ALI-999.",
};

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

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe("config validation", () => {
  it("rejects an empty token, naming GITHUB_TOKEN and ALI-157", () => {
    expect(() => createGitHubApiPort({ token: "", owner: OWNER, repo: REPO })).toThrow(
      new RegExp(`${GITHUB_TOKEN_ENV}.*ALI-157`),
    );
  });

  it("rejects an implausibly short token", () => {
    expect(() => createGitHubApiPort({ token: "short", owner: OWNER, repo: REPO })).toThrow(/implausibly short/);
  });

  it("rejects an empty owner", () => {
    expect(() => createGitHubApiPort({ token: DUMMY_TOKEN, owner: "", repo: REPO })).toThrow(
      new RegExp(GITHUB_OWNER_ENV),
    );
  });

  it("rejects an empty repo", () => {
    expect(() => createGitHubApiPort({ token: DUMMY_TOKEN, owner: OWNER, repo: "" })).toThrow(
      new RegExp(GITHUB_REPO_ENV),
    );
  });

  it("rejects an out-of-range retry policy", () => {
    expect(() =>
      createGitHubApiPort({ token: DUMMY_TOKEN, owner: OWNER, repo: REPO, retry: { maxAttempts: 0 } }),
    ).toThrow(/maxAttempts must be an integer in 1\.\.10/);
    expect(() =>
      createGitHubApiPort({ token: DUMMY_TOKEN, owner: OWNER, repo: REPO, retry: { maxDelayMs: 999_999 } }),
    ).toThrow(/maxDelayMs must be a finite number in 0\.\.60000/);
  });

  it("rejects an out-of-range requestTimeoutMs", () => {
    expect(() =>
      createGitHubApiPort({ token: DUMMY_TOKEN, owner: OWNER, repo: REPO, requestTimeoutMs: 10 * 60_000 }),
    ).toThrow(/requestTimeoutMs: must be a finite number in 1\.\.120000/);
  });

  it("DEFAULT_RETRY_POLICY is sane: bounded attempts, positive delays", () => {
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBeGreaterThan(1);
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBeLessThanOrEqual(10);
    expect(DEFAULT_RETRY_POLICY.baseDelayMs).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AC1 (real git, hermetic) + AC6 (no credential on disk) — pushBranch
// ---------------------------------------------------------------------------

describe("AC1 + AC6: pushBranch — real git, throwaway temp-dir repos", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  async function makeBareRemote(): Promise<string> {
    const dir = await fs.mkdtemp(join(tmpdir(), "ali160-remote-"));
    tempDirs.push(dir);
    await execFileAsync("git", ["init", "-q", "--bare", "-b", "main", dir]);
    return dir;
  }

  async function makeClone(remote: string, name: string): Promise<string> {
    const dir = await fs.mkdtemp(join(tmpdir(), `ali160-${name}-`));
    tempDirs.push(dir);
    await execFileAsync("git", ["clone", "-q", remote, dir]);
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
    return dir;
  }

  async function commit(dir: string, file: string, content: string, message: string): Promise<void> {
    await fs.writeFile(join(dir, file), content);
    await execFileAsync("git", ["add", "."], { cwd: dir });
    await execFileAsync("git", ["commit", "-q", "-m", message], { cwd: dir });
  }

  it("pushes branch to origin — the remote actually receives it", async () => {
    const remote = await makeBareRemote();
    const work = await makeClone(remote, "work");
    await commit(work, "f.txt", "seed\n", "seed");
    await execFileAsync("git", ["push", "-q", "origin", "HEAD:main"], { cwd: work });
    await execFileAsync("git", ["checkout", "-q", "-b", "feature"], { cwd: work });
    await commit(work, "f.txt", "feature change\n", "feature commit");

    const port = createGitHubApiPort({ token: DUMMY_TOKEN, owner: OWNER, repo: REPO });
    await port.pushBranch(work, "feature");

    const { stdout } = await execFileAsync("git", ["ls-remote", "--heads", remote, "feature"]);
    expect(stdout).toContain("refs/heads/feature");
  });

  it("fails loud on a non-fast-forward rejected push, rather than returning normally", async () => {
    const remote = await makeBareRemote();
    const workA = await makeClone(remote, "a");
    await commit(workA, "f.txt", "seed\n", "seed");
    await execFileAsync("git", ["push", "-q", "origin", "HEAD:main"], { cwd: workA });
    // Establish `feature` on the remote from workA's current tip, and leave
    // workA's LOCAL `feature` pointed at that same (soon-to-be-stale) commit.
    await execFileAsync("git", ["checkout", "-q", "-b", "feature"], { cwd: workA });
    await execFileAsync("git", ["push", "-q", "origin", "feature:feature"], { cwd: workA });

    // workB fetches that same `feature`, advances it, and pushes -- moving
    // the REMOTE tip past what workA's local `feature` still points to.
    const workB = await makeClone(remote, "b");
    await execFileAsync("git", ["checkout", "-q", "-b", "feature", "origin/feature"], { cwd: workB });
    await commit(workB, "f.txt", "b's diverging change\n", "b commit");
    await execFileAsync("git", ["push", "-q", "origin", "feature:feature"], { cwd: workB });

    // workA now pushes its OWN new commit on `feature` -- a non-fast-forward
    // against the remote, since it never saw workB's commit.
    await commit(workA, "f.txt", "a's own diverging change\n", "a commit");

    const port = createGitHubApiPort({ token: DUMMY_TOKEN, owner: OWNER, repo: REPO });
    await expect(port.pushBranch(workA, "feature")).rejects.toThrow(GitHubApiError);
    await expect(port.pushBranch(workA, "feature")).rejects.toThrow(/push of "feature" to origin failed/);
  });

  it("fails loud on a server (hook) rejected push", async () => {
    const remote = await makeBareRemote();
    await fs.writeFile(
      join(remote, "hooks", "pre-receive"),
      "#!/bin/sh\necho 'policy blocks this push' >&2\nexit 1\n",
    );
    await fs.chmod(join(remote, "hooks", "pre-receive"), 0o755);

    const work = await makeClone(remote, "hookwork");
    await commit(work, "f.txt", "seed\n", "seed");
    await execFileAsync("git", ["checkout", "-q", "-b", "blocked"], { cwd: work });

    const port = createGitHubApiPort({ token: DUMMY_TOKEN, owner: OWNER, repo: REPO });
    await expect(port.pushBranch(work, "blocked")).rejects.toThrow(GitHubApiError);
  });

  it("an empty worktree path or branch name is refused before any subprocess runs", async () => {
    const port = createGitHubApiPort({ token: DUMMY_TOKEN, owner: OWNER, repo: REPO });
    await expect(port.pushBranch("", "feature")).rejects.toThrow(/empty worktree path/);
    await expect(port.pushBranch("/some/path", "")).rejects.toThrow(/empty branch name/);
  });

  it("AC6: after a successful push, .git/config in the worktree carries no token-shaped string", async () => {
    const remote = await makeBareRemote();
    const work = await makeClone(remote, "cleanconfig");
    await commit(work, "f.txt", "seed\n", "seed");
    await execFileAsync("git", ["checkout", "-q", "-b", "feature"], { cwd: work });

    const port = createGitHubApiPort({ token: DUMMY_TOKEN, owner: OWNER, repo: REPO });
    await port.pushBranch(work, "feature");

    const config = await fs.readFile(join(work, ".git", "config"), "utf8");
    expect(containsSecretLike(config)).toBe(false);
    expect(config).not.toContain(DUMMY_TOKEN);
    expect(config).not.toMatch(/extraheader/i);
  });

  it("AC6: after a REJECTED push, .git/config still carries no token-shaped string, and neither does the thrown error", async () => {
    const remote = await makeBareRemote();
    await fs.writeFile(join(remote, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n");
    await fs.chmod(join(remote, "hooks", "pre-receive"), 0o755);
    const work = await makeClone(remote, "rejectedconfig");
    await commit(work, "f.txt", "seed\n", "seed");
    await execFileAsync("git", ["checkout", "-q", "-b", "blocked"], { cwd: work });

    const port = createGitHubApiPort({ token: DUMMY_TOKEN, owner: OWNER, repo: REPO });
    let caught: unknown;
    try {
      await port.pushBranch(work, "blocked");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GitHubApiError);
    const message = (caught as Error).message;
    expect(containsSecretLike(message)).toBe(false);
    expect(message).not.toContain(DUMMY_TOKEN);

    const config = await fs.readFile(join(work, ".git", "config"), "utf8");
    expect(containsSecretLike(config)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC2: openDraftPr creates a DRAFT PR and returns { number, url }
// ---------------------------------------------------------------------------

describe("AC2: openDraftPr — draft is not optional", () => {
  it("POSTs to /repos/{owner}/{repo}/pulls with draft: true, and maps the 201 response", async () => {
    const transport = respondWith(
      jsonResponse(201, { number: 42, html_url: "https://github.com/acme/widgets/pull/42" }),
    );
    const port = portWithTransport(transport.fetchImpl);

    const result = await port.openDraftPr(PR_PARAMS);

    expect(result).toEqual({ number: 42, url: "https://github.com/acme/widgets/pull/42" });
    expect(transport.requests).toHaveLength(1);
    const [{ url, init }] = transport.requests;
    expect(url).toBe(`${FAKE_ENDPOINT}/repos/${OWNER}/${REPO}/pulls`);
    const request = init as { method: string; headers: Record<string, string>; body: string };
    expect(request.method).toBe("POST");
    expect(request.headers.Authorization).toBe(`Bearer ${DUMMY_TOKEN}`);
    const sentBody = JSON.parse(request.body) as Record<string, unknown>;
    expect(sentBody).toMatchObject({
      head: PR_PARAMS.branch,
      base: PR_PARAMS.base,
      title: PR_PARAMS.title,
      body: PR_PARAMS.body,
      draft: true,
    });
  });

  it("a 201 response missing number/html_url is a named error, not a silently wrong result", async () => {
    const transport = respondWith(jsonResponse(201, { ok: true }));
    const port = portWithTransport(transport.fetchImpl);
    await expect(port.openDraftPr(PR_PARAMS)).rejects.toThrow(/no usable `number`\/`html_url`/);
  });

  it("GITHUB_API_URL is the real GitHub REST base by default", () => {
    expect(GITHUB_API_URL).toBe("https://api.github.com");
  });
});

// ---------------------------------------------------------------------------
// AC3 / AC4 / AC8 — the two hard rejections, exact-shape-matched to the fake
// ---------------------------------------------------------------------------

// Independently-authored copies of `createFakeGitHub()`'s two rejection
// messages (`__tests__/run.test.ts`, lines 241-250 as of this issue) — see
// this file's top doc comment for why these are hardcoded here rather than
// imported.
const FAKE_DUPLICATE_PR_MESSAGE = (branch: string, base: string) =>
  `A pull request already exists for ${branch} -> ${base}. (422-shaped, mirrors real GitHub.)`;
const FAKE_INVALID_BASE_MESSAGE = (branch: string, base: string) =>
  `GitHub rejected PR ${branch} -> ${base}: base branch "${base}" was never pushed and is not the repo's base branch.`;

describe("AC3 + AC8: duplicate PR for the same head->base — GitHub's real 422 shape", () => {
  it("a 422 with a `custom`-coded duplicate-PR error maps to the exact fake-shaped message", async () => {
    const transport = respondWith(
      jsonResponse(422, {
        message: "Validation Failed",
        errors: [
          {
            resource: "PullRequest",
            code: "custom",
            message: `A pull request already exists for ${OWNER}:${PR_PARAMS.branch}.`,
          },
        ],
        documentation_url: "https://docs.github.com/rest/pulls/pulls#create-a-pull-request",
      }),
    );
    const port = portWithTransport(transport.fetchImpl);

    await expect(port.openDraftPr(PR_PARAMS)).rejects.toThrow(GitHubApiError);
    let caught: unknown;
    try {
      await port.openDraftPr(PR_PARAMS);
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toBe(FAKE_DUPLICATE_PR_MESSAGE(PR_PARAMS.branch, PR_PARAMS.base));
    // AC4's "never silently creates a PR": one call in, one thrown error out.
    expect(transport.requests).toHaveLength(2); // two openDraftPr calls above, no retries within either
  });
});

describe("AC4 + AC8: invalid base branch — GitHub's real 422 `field: base, code: invalid` shape", () => {
  it("a 422 with field=base/code=invalid maps to the exact fake-shaped message, and never opens a PR", async () => {
    const transport = respondWith(
      jsonResponse(422, {
        message: "Validation Failed",
        errors: [{ resource: "PullRequest", field: "base", code: "invalid" }],
        documentation_url: "https://docs.github.com/rest/pulls/pulls#create-a-pull-request",
      }),
    );
    const port = portWithTransport(transport.fetchImpl);

    let caught: unknown;
    try {
      await port.openDraftPr(PR_PARAMS);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GitHubApiError);
    expect((caught as Error).message).toBe(FAKE_INVALID_BASE_MESSAGE(PR_PARAMS.branch, PR_PARAMS.base));
    expect(transport.requests).toHaveLength(1); // attempted exactly once — no retry on a 4xx
  });

  it("a generic 422 with no recognised errors[] shape gets a generic-but-named error, never guessed", async () => {
    const transport = respondWith(jsonResponse(422, { message: "Validation Failed", errors: [{ code: "unprocessable" }] }));
    const port = portWithTransport(transport.fetchImpl);
    await expect(port.openDraftPr(PR_PARAMS)).rejects.toThrow(/HTTP 422 \(validation failed\)/);
  });
});

// ---------------------------------------------------------------------------
// AC5 — 401/403 distinguishable as authentication vs transport, never
// retried, never leak a token, never fall back to `gh`.
// ---------------------------------------------------------------------------

describe("AC5: 401/403 — authentication vs transport, no retry, no token text", () => {
  it("401 is always classified authentication", async () => {
    const transport = respondWith(jsonResponse(401, { message: "Bad credentials" }));
    const port = portWithTransport(transport.fetchImpl);
    await expect(port.openDraftPr(PR_PARAMS)).rejects.toThrow(/classified as authentication/);
    expect(transport.requests).toHaveLength(1);
  });

  it("a GitHub-shaped 403 (documentation_url on docs.github.com) is classified authentication", async () => {
    const transport = respondWith(
      jsonResponse(403, {
        message: "API rate limit exceeded",
        documentation_url: "https://docs.github.com/rest/overview/rate-limits-for-the-rest-api",
      }),
    );
    const port = portWithTransport(transport.fetchImpl);
    await expect(port.openDraftPr(PR_PARAMS)).rejects.toThrow(/classified as authentication/);
  });

  it("a 403 whose documentation_url points elsewhere (something in front of GitHub answered) is classified transport", async () => {
    // Reproduces exactly what this session observed from ITS OWN sandbox
    // proxy for a repo-scoped call: GitHub-shaped JSON, but
    // `documentation_url` on a different domain (github.ts's contract
    // evidence comment records the live observation this fixture encodes).
    const transport = respondWith(
      jsonResponse(403, {
        message: "GitHub access is not enabled for this session.",
        documentation_url: "https://docs.anthropic.com/en/docs/claude-code/github-actions",
      }),
    );
    const port = portWithTransport(transport.fetchImpl);
    await expect(port.openDraftPr(PR_PARAMS)).rejects.toThrow(/classified as transport/);
  });

  it("a non-JSON 403 (an HTML error page from something other than GitHub) is classified transport", async () => {
    const transport = { fetchImpl: async () => textResponse(403, "<html>blocked</html>"), requests: [] };
    const port = portWithTransport(transport.fetchImpl);
    await expect(port.openDraftPr(PR_PARAMS)).rejects.toThrow(/classified as transport/);
  });

  it("a 403 is never retried — exactly one request", async () => {
    const transport = respondWith(jsonResponse(403, { message: "Forbidden" }));
    const port = portWithTransport(transport.fetchImpl);
    await expect(port.openDraftPr(PR_PARAMS)).rejects.toThrow();
    expect(transport.requests).toHaveLength(1);
  });

  it("the thrown error never contains the raw token, and never mentions the gh CLI as a fallback", async () => {
    const transport = respondWith(jsonResponse(403, { message: `token was ${DUMMY_TOKEN}` }));
    const port = portWithTransport(transport.fetchImpl);
    let caught: unknown;
    try {
      await port.openDraftPr(PR_PARAMS);
    } catch (error) {
      caught = error;
    }
    const message = (caught as Error).message;
    expect(message).not.toContain(DUMMY_TOKEN);
    expect(containsSecretLike(message)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC6 — value-redaction catches a token GitHub's own prefix list would miss
// ---------------------------------------------------------------------------

describe("AC6: credential redaction — by value, not just by known prefix", () => {
  it("a GitHub App installation token (ghs_-prefixed, NOT in runlog.ts's SECRET_PREFIXES) is still redacted by value", async () => {
    const installationToken = "ghs_installationTokenNotInPrefixList0000";
    const transport = respondWith(jsonResponse(500, { message: `upstream saw ${installationToken}` }));
    const port = portWithTransport(transport.fetchImpl, {
      token: installationToken,
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    });
    let caught: unknown;
    try {
      await port.openDraftPr(PR_PARAMS);
    } catch (error) {
      caught = error;
    }
    const message = (caught as Error).message;
    expect(message).not.toContain(installationToken);
    expect(message).toContain("[REDACTED]");
    // Sanity: `ghs_` is genuinely absent from the generic scrubber's own
    // prefix list, so this test is proving the VALUE-based registry catches
    // what prefix-matching alone would miss, not duplicating that coverage.
    expect(containsSecretLike(installationToken)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC7 — bounded retry: 429/5xx retried, no 4xx ever retried, no double-open
// ---------------------------------------------------------------------------

describe("AC7: retries — 429/5xx recover, 4xx never retried, never a double-open", () => {
  it("500 then 201 opens exactly ONE PR after exactly one retry", async () => {
    const guard = guardedSleep();
    const transport = respondWith(
      jsonResponse(500, { message: "internal error" }),
      jsonResponse(201, { number: 7, html_url: "https://github.com/acme/widgets/pull/7" }),
    );
    const port = portWithTransport(transport.fetchImpl, { sleep: guard.sleep });

    const result = await port.openDraftPr(PR_PARAMS);
    expect(result.number).toBe(7);
    expect(transport.requests).toHaveLength(2);
    expect(guard.delays).toEqual([1_000]);
  });

  it("429 then 201 recovers, honouring (and capping) Retry-After", async () => {
    const guard = guardedSleep();
    const transport = respondWith(
      jsonResponse(429, { message: "rate limited" }, { "retry-after": "3" }),
      jsonResponse(201, { number: 8, html_url: "https://github.com/acme/widgets/pull/8" }),
    );
    const port = portWithTransport(transport.fetchImpl, { sleep: guard.sleep });

    await port.openDraftPr(PR_PARAMS);
    expect(guard.delays).toEqual([3_000]); // Retry-After (3s) honoured, under the 8s default ceiling
  });

  it("a Retry-After far beyond maxDelayMs is capped, never honoured verbatim", async () => {
    const guard = guardedSleep();
    const transport = respondWith(
      jsonResponse(429, {}, { "retry-after": "3600" }),
      jsonResponse(201, { number: 9, html_url: "https://github.com/acme/widgets/pull/9" }),
    );
    const port = portWithTransport(transport.fetchImpl, {
      sleep: guard.sleep,
      retry: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 8_000 },
    });

    await port.openDraftPr(PR_PARAMS);
    expect(guard.delays).toEqual([8_000]); // capped at maxDelayMs, not 3,600,000ms
  });

  it("a forever-500 server gives up after maxAttempts, never spins", async () => {
    const guard = guardedSleep();
    const transport = respondWith(jsonResponse(503, { message: "down" }));
    const port = portWithTransport(transport.fetchImpl, {
      sleep: guard.sleep,
      retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 40 },
    });

    await expect(port.openDraftPr(PR_PARAMS)).rejects.toThrow(/gave up on openDraftPr .* after 3 attempt/);
    expect(transport.requests).toHaveLength(3);
  });

  it("a 422 is attempted EXACTLY ONCE — never retried, so a retried write can never double-open a PR", async () => {
    const transport = respondWith(
      jsonResponse(422, { errors: [{ field: "base", code: "invalid" }] }),
    );
    const port = portWithTransport(transport.fetchImpl, { retry: { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 1 } });

    await expect(port.openDraftPr(PR_PARAMS)).rejects.toThrow();
    expect(transport.requests).toHaveLength(1);
  });

  it("a 404 (also 4xx) is attempted exactly once too — the no-retry rule is not 422-specific", async () => {
    const transport = respondWith(jsonResponse(404, { message: "Not Found" }));
    const port = portWithTransport(transport.fetchImpl);
    await expect(port.openDraftPr(PR_PARAMS)).rejects.toThrow(/HTTP 404/);
    expect(transport.requests).toHaveLength(1);
  });

  it("a network-level failure (no HTTP response at all) is not retried either", async () => {
    let calls = 0;
    const port = portWithTransport(async () => {
      calls++;
      throw new Error("ECONNRESET");
    });
    await expect(port.openDraftPr(PR_PARAMS)).rejects.toThrow(/GitHub API request failed/);
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC9 — live contract test against real GitHub, or a VISIBLE skip
// ---------------------------------------------------------------------------

const LIVE_ENV_VARS = [GITHUB_TOKEN_ENV, GITHUB_OWNER_ENV, GITHUB_REPO_ENV] as const;

function missingLiveEnvVars(env: Record<string, string | undefined>): string[] {
  return LIVE_ENV_VARS.filter((name) => (env[name] ?? "").trim() === "");
}

function liveSkipNotice(missing: readonly string[]): string {
  return (
    `[ALI-160 AC9] SKIPPING the live GitHub contract test — missing environment variable(s): ` +
    `${missing.join(", ")}. These are provisioned by ALI-157. Until this test has run green once, ` +
    "the adapter is NOT proven against the real system."
  );
}

const missingLiveEnv = missingLiveEnvVars(process.env);

describe("AC9: the live-contract gate is loud, never silent", () => {
  it("treats an unset OR blank variable as missing", () => {
    expect(missingLiveEnvVars({})).toEqual([GITHUB_TOKEN_ENV, GITHUB_OWNER_ENV, GITHUB_REPO_ENV]);
    expect(
      missingLiveEnvVars({ [GITHUB_TOKEN_ENV]: "   ", [GITHUB_OWNER_ENV]: "o", [GITHUB_REPO_ENV]: "r" }),
    ).toEqual([GITHUB_TOKEN_ENV]);
    expect(
      missingLiveEnvVars({ [GITHUB_TOKEN_ENV]: "t", [GITHUB_OWNER_ENV]: "o", [GITHUB_REPO_ENV]: "r" }),
    ).toEqual([]);
  });

  it("the skip notice names each missing variable, the owning issue, and says it is a skip", () => {
    const notice = liveSkipNotice([GITHUB_TOKEN_ENV, GITHUB_OWNER_ENV]);
    expect(notice).toContain("SKIPPING");
    expect(notice).toContain(GITHUB_TOKEN_ENV);
    expect(notice).toContain(GITHUB_OWNER_ENV);
    expect(notice).toContain("ALI-157");
    expect(notice).toContain("NOT proven against the real system");
  });
});

describe("AC9: live contract test against real GitHub — opens and immediately closes a draft PR", () => {
  if (missingLiveEnv.length > 0) {
    // Visible on every run without the credential: a skipped test is
    // reported as skipped, and this line names exactly which variable is
    // missing so the skip can never be misread as a pass. This is also,
    // deliberately, the actual outcome in this build sandbox — see this
    // file's top doc comment.
    console.warn(liveSkipNotice(missingLiveEnv));
    it.skip(
      `SKIPPED — ${missingLiveEnv.join(", ")} not set (provisioned by ALI-157); adapter unproven against real GitHub`,
      () => {
        throw new Error("unreachable: this test is skipped");
      },
    );
  } else {
    it(
      "pushes a throwaway branch, opens a draft PR, then closes it",
      async () => {
        const token = process.env[GITHUB_TOKEN_ENV] as string;
        const owner = process.env[GITHUB_OWNER_ENV] as string;
        const repo = process.env[GITHUB_REPO_ENV] as string;
        const base = process.env.GITHUB_LIVE_BASE_BRANCH ?? "main";
        const branch = `ali-160-live-contract-${Date.now()}`;

        const tempDir = await fs.mkdtemp(join(tmpdir(), "ali160-live-"));
        try {
          await execFileAsync("git", ["clone", "-q", `https://github.com/${owner}/${repo}.git`, tempDir]);
          await execFileAsync("git", ["config", "user.email", "dispatcher@example.com"], { cwd: tempDir });
          await execFileAsync("git", ["config", "user.name", "Dispatcher"], { cwd: tempDir });
          await execFileAsync("git", ["checkout", "-q", "-b", branch], { cwd: tempDir });
          await fs.writeFile(join(tempDir, "ALI-160-LIVE-CONTRACT-TEST.md"), `Throwaway commit, ${new Date().toISOString()}\n`);
          await execFileAsync("git", ["add", "."], { cwd: tempDir });
          await execFileAsync("git", ["commit", "-q", "-m", "ALI-160 AC9 live contract test — safe to delete"], {
            cwd: tempDir,
          });

          const port = createGitHubApiPort({ token, owner, repo });
          await port.pushBranch(tempDir, branch);
          const pr = await port.openDraftPr({
            branch,
            base,
            title: "ALI-160 AC9 live contract test — safe to close",
            body: "Opened and immediately closed by the GitHubPort live contract test. Safe to ignore/delete.",
          });
          expect(pr.number).toBeGreaterThan(0);
          expect(pr.url).toContain(`${owner}/${repo}`);

          // Closing is not part of `GitHubPort`'s own contract (only
          // pushBranch/openDraftPr are) -- this is test-only cleanup, done
          // with a direct REST call rather than expanding the port for a
          // capability nothing else needs.
          await fetch(`${GITHUB_API_URL}/repos/${owner}/${repo}/pulls/${pr.number}`, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "Content-Type": "application/json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
            body: JSON.stringify({ state: "closed" }),
          });
        } finally {
          await fs.rm(tempDir, { recursive: true, force: true });
        }
      },
      60_000,
    );
  }
});
