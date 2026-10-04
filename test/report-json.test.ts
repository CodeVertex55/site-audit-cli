import { describe, expect, test } from "vitest";
import { renderJson } from "../src/report/json.js";
import { UNSAFE, makeHostileResult, makeResult } from "./helpers/result.js";

describe("renderJson", () => {
  test("parses back to an object equal to the input and ends with a newline", () => {
    const result = makeResult();
    const out = renderJson(result);
    expect(JSON.parse(out)).toEqual(result);
    expect(out.endsWith("}\n")).toBe(true);
    expect(out).toBe(JSON.stringify(result, null, 2) + "\n");
  });

  test("is complete: every finding is present", () => {
    const parsed = JSON.parse(renderJson(makeResult())) as ReturnType<typeof makeResult>;
    expect(parsed.checks[0]?.findings).toHaveLength(12);
    expect(parsed.schemaVersion).toBe(1);
  });

  test("hostile text round-trips unchanged yet prints no raw control or bidi character", () => {
    const result = makeHostileResult();
    const out = renderJson(result);
    expect(JSON.parse(out)).toEqual(result);
    expect(out).not.toMatch(UNSAFE);
    expect(out).not.toContain("\u001b");
  });

  test("writes tag characters, the soft hyphen and the Arabic letter mark as escapes", () => {
    const base = makeResult();
    const note = "x\u{E0041}y\u00adz\u061cw";
    const result = makeResult({ scope: { ...base.scope, originNote: note } });
    const out = renderJson(result);
    expect(out).not.toMatch(/[\u{E0000}-\u{E007F}\u00ad\u061c]/u);
    expect(out).toContain("x\\udb40\\udc41y\\u00adz\\u061cw");
    expect(JSON.parse(out)).toEqual(result);
  });

  test("does not turn escaped backslashes into extra escapes", () => {
    const base = makeResult();
    const result = makeResult({ scope: { ...base.scope, originNote: "a\\u202eb \u202e c" } });
    expect(JSON.parse(renderJson(result))).toEqual(result);
  });
});

test("the scope carries crawlDelayMs", () => {
  const base = makeResult();
  const parsed = JSON.parse(
    renderJson({ ...base, scope: { ...base.scope, crawlDelayMs: 1500 } }),
  ) as { scope: { crawlDelayMs: number | null } };
  expect(parsed.scope.crawlDelayMs).toBe(1500);
});
