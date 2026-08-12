# Operating Rules — North Star + The Two Gates

**North star:** an autonomous, self-improving build crew that takes a well-defined product backlog in Linear and ships it — cloned into any product repo, governed by two human gates.

**Principle:** automate the loop; gate the loop that changes the loop. A loop runs autonomously when its output is independently verifiable and a mistake is contained to one unit of work. Two decisions never meet that bar, because they change the machine rather than run it:

1. **Amendment** — changes to the engine itself (agent/skill/prompt files). Every such change ends in a PR only Pedro merges. Enforced by branch protection + CODEOWNERS, not by instruction.
2. **Direction** — admission to a cycle. Nothing executes outside a Pedro-approved cycle. Fail closed.

Everything between — spec, build, review, plan, report — loops without a human.

Lineage: mission command. Pedro reserves intent (end state) and doctrine (this doc + `docs/ENGINE.md` + the agent files) and delegates all execution.
