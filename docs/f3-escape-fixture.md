# F3 escape fixture — TRANSIENT, removed before this PR is merge-ready

This file exists only to prove security finding **F3** (ALI-100 security pass,
comment `0d889e41`) is real rather than hypothetical: `scripts/check-md-links.js`
resolves link targets with `path.resolve(...)` and no confinement, so a markdown
link that leaves the repository root is validated against the **CI runner's**
filesystem instead of the repository.

Both links below escape the repository root. On the commit that adds this file
and nothing else, the `Markdown cross-reference check` job is expected to pass —
that green run *is* the evidence of the false pass. The very next commit adds
the confinement and both links must then fail.

This file and `docs/escape-fixture` are deleted in the third commit of this PR.

## The two escape classes

1. **Lexical escape** — a `../` chain that walks out of the root before any
   filesystem call happens: [x](../../../../../../../../../../../../etc/hostname)
2. **Symlink escape** — a path that is *inside* the root lexically, but whose
   `realpath` is not, because it is a committed in-repo symlink: [y](escape-fixture)

The chain in (1) is deliberately long enough to clamp at `/` on POSIX. The
spec's illustrative `../../../../etc/hostname` is checkout-depth-specific: on a
GitHub runner the repository sits at `/home/runner/work/<repo>/<repo>`, so four
levels up from `docs/` resolves to `/home/runner/etc/hostname`, which does not
exist — the link would fail as an ordinary broken link and prove nothing about
confinement. Clamping makes the fixture depth-independent, so it resolves to
`/etc/hostname` both locally and on the runner.
