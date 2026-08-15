# development-engine-seed

The canonical seed of an autonomous build crew: Claude Code agents that take a well-defined Linear backlog and ship it, governed by two human gates (Amendment + Direction).

- **Spec / source of truth:** [`docs/ENGINE.md`](docs/ENGINE-DOES-NOT-EXIST.md)
- **Short rules the crew loads:** [`CLAUDE.md`](CLAUDE.md)
- **Crew:** [`.claude/agents/`](.claude/agents/) — orchestrator, spec (BA), builder, reviewer, planner, researcher, scribe, security

Product repos template from this seed; broadly-useful improvements PR back here. In this repo, every merge to `main` is the Amendment gate — branch protection requires Pedro's review.
