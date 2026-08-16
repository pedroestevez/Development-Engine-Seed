import { describe, expect, it } from "vitest";
import { extractBlindView, type BlindDispatchContext } from "../blindqa.js";

/**
 * A full issue body in the real template's shape (`.claude/templates/issue-body.md`):
 * Why -> What -> Acceptance criteria -> Invariant -> Definition of done ->
 * Files touched -> Reversibility class. `## Why` and `## What` each carry a
 * marker string this suite asserts never survives into the extracted view.
 */
const WHY_MARKER = "SECRET-IMPLEMENTATION-SKETCH-42";
const WHAT_MARKER = "ALTER TABLE bookings ADD CONSTRAINT no_leak";

const FULL_TEMPLATE_BODY = [
  "## Why",
  "",
  `The problem, with evidence. ${WHY_MARKER}`,
  "",
  "## What",
  "",
  `${WHAT_MARKER} -- the concrete fix.`,
  "",
  "## Acceptance criteria",
  "",
  "1. First criterion.",
  "2. Second criterion, with detail.",
  "",
  "## Invariant",
  "",
  "The invariant statement.",
  "",
  "## Definition of done",
  "",
  "The done-state.",
  "",
  "## Files touched (predicted)",
  "",
  "`src/foo.ts`",
  "",
  "## Reversibility class",
  "",
  "`none`",
  "",
].join("\n");

describe("extractBlindView: happy path -- all three sections extracted, everything else withheld", () => {
  it("extracts issueId/title verbatim and each section's body, trimmed", () => {
    const result = extractBlindView({ id: "ALI-999", title: "Fixture issue", body: FULL_TEMPLATE_BODY });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");

    expect(result.context.issueId).toBe("ALI-999");
    expect(result.context.title).toBe("Fixture issue");
    expect(result.context.acceptanceCriteria).toBe("1. First criterion.\n2. Second criterion, with detail.");
    expect(result.context.invariant).toBe("The invariant statement.");
    expect(result.context.definitionOfDone).toBe("The done-state.");
  });

  it("never leaks '## Why' or '## What' content into any field of the blind context", () => {
    const result = extractBlindView({ id: "ALI-999", title: "t", body: FULL_TEMPLATE_BODY });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");

    const serialized = JSON.stringify(result.context);
    expect(serialized).not.toContain(WHY_MARKER);
    expect(serialized).not.toContain(WHAT_MARKER);
  });

  it("the returned context's own keys are exactly the five allowed fields -- nothing extra", () => {
    const result = extractBlindView({ id: "ALI-1", title: "t", body: FULL_TEMPLATE_BODY });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    const keys = Object.keys(result.context as BlindDispatchContext).sort();
    expect(keys).toEqual(["acceptanceCriteria", "definitionOfDone", "invariant", "issueId", "title"].sort());
  });

  it("is insensitive to sections appearing after Definition of done (Files touched, Reversibility class)", () => {
    // FULL_TEMPLATE_BODY already has both trailing sections -- this test
    // exists to name that property explicitly rather than leave it implicit
    // in the happy-path fixture.
    const result = extractBlindView({ id: "ALI-1", title: "t", body: FULL_TEMPLATE_BODY });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.context.definitionOfDone).toBe("The done-state.");
    expect(result.context.definitionOfDone).not.toContain("Files touched");
    expect(result.context.definitionOfDone).not.toContain("Reversibility");
  });

  it("handles CRLF line endings the same as LF", () => {
    const crlfBody = FULL_TEMPLATE_BODY.replace(/\n/g, "\r\n");
    const result = extractBlindView({ id: "ALI-2", title: "t", body: crlfBody });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.context.acceptanceCriteria).toContain("First criterion.");
    expect(result.context.invariant).toBe("The invariant statement.");
  });
});

describe("extractBlindView: AC7 negative case -- no '## Acceptance criteria' heading at all", () => {
  it("returns ok:false, reason names the issue id and the missing heading", () => {
    const body = ["## Why", "", "stuff", "", "## What", "", "more stuff", ""].join("\n");
    const result = extractBlindView({ id: "ALI-42", title: "t", body });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.reason).toContain("ALI-42");
    expect(result.reason).toMatch(/heading/i);
    expect(result.reason).toMatch(/Acceptance criteria/i);
  });

  it("an entirely empty body is also unparseable, for the same reason", () => {
    const result = extractBlindView({ id: "ALI-43", title: "t", body: "" });
    expect(result.ok).toBe(false);
  });
});

describe("extractBlindView: AC7 negative case -- '## Acceptance criteria' heading present but empty", () => {
  it("returns ok:false, reason distinguishes 'empty' from 'missing'", () => {
    const body = ["## Acceptance criteria", "", "## Invariant", "", "holds", ""].join("\n");
    const result = extractBlindView({ id: "ALI-44", title: "t", body });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.reason).toContain("ALI-44");
    expect(result.reason).toMatch(/empty/i);
  });

  it("whitespace-only content under the heading counts as empty", () => {
    const body = ["## Acceptance criteria", "", "   ", "\t", "", "## Invariant", "", "holds", ""].join("\n");
    const result = extractBlindView({ id: "ALI-45", title: "t", body });
    expect(result.ok).toBe(false);
  });

  it("'## Acceptance criteria' as the very last section (nothing follows) is also empty, not a match past end-of-string", () => {
    const body = ["## Why", "", "x", "", "## Acceptance criteria", ""].join("\n");
    const result = extractBlindView({ id: "ALI-46", title: "t", body });
    expect(result.ok).toBe(false);
  });
});

describe("extractBlindView: missing Invariant / Definition of done sections do not block dispatch", () => {
  it("a body with Acceptance criteria but no Invariant or Definition of done heading still parses -- those fields come back empty", () => {
    const body = ["## Acceptance criteria", "", "1. Only this exists.", ""].join("\n");
    const result = extractBlindView({ id: "ALI-47", title: "t", body });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.context.acceptanceCriteria).toBe("1. Only this exists.");
    expect(result.context.invariant).toBe("");
    expect(result.context.definitionOfDone).toBe("");
  });
});

describe("extractBlindView: last section in the body is captured to end-of-string, not truncated", () => {
  it("Definition of done as the final section (no Files touched/Reversibility after it) captures everything to EOF", () => {
    const body = [
      "## Acceptance criteria",
      "",
      "1. x.",
      "",
      "## Invariant",
      "",
      "y.",
      "",
      "## Definition of done",
      "",
      "z, multi-line,",
      "still part of the same section.",
      "",
    ].join("\n");
    const result = extractBlindView({ id: "ALI-48", title: "t", body });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.context.definitionOfDone).toBe("z, multi-line,\nstill part of the same section.");
  });
});
