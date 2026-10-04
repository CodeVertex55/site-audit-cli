import { describe, expect, test } from "vitest";
import type { CheckOutcome } from "../src/checks/registry.js";
import { summarise } from "../src/checks/summary.js";
import type { Finding, Group, Severity } from "../src/types.js";

function finding(checkId: string, group: Group, severity: Severity, url: string | null): Finding {
  return { checkId, group, severity, url, detail: "detail" };
}

function outcome(
  id: string,
  group: Group,
  severity: Severity,
  findings: Finding[],
  status?: CheckOutcome["status"],
): CheckOutcome {
  return {
    id,
    group,
    severity,
    title: `Title of ${id}`,
    why: "why",
    fix: `Fix ${id}`,
    status: status ?? (findings.length > 0 ? "fail" : "pass"),
    findings,
  };
}

function failing(id: string, severity: Severity, urls: (string | null)[], group: Group = "seo") {
  return outcome(
    id,
    group,
    severity,
    urls.map((u) => finding(id, group, severity, u)),
  );
}

describe("summarise counts", () => {
  test("an empty list gives zero counts in every group", () => {
    const summary = summarise([]);
    expect(summary.checksRun).toBe(0);
    expect(summary.checksPassed).toBe(0);
    expect(summary.fixFirst).toEqual([]);
    for (const group of ["seo", "health", "performance", "accessibility"] as const) {
      expect(summary.byGroup[group]).toEqual({ error: 0, warning: 0, info: 0 });
    }
  });

  test("findings are counted by group and by their own severity", () => {
    const summary = summarise([
      failing("SEO-A", "error", ["https://x.example/a", "https://x.example/b"]),
      failing("SEO-B", "warning", ["https://x.example/a"]),
      failing("HEALTH-A", "info", [null], "health"),
      failing("PERF-A", "warning", ["https://x.example/a", "https://x.example/b"], "performance"),
    ]);
    expect(summary.byGroup.seo).toEqual({ error: 2, warning: 1, info: 0 });
    expect(summary.byGroup.health).toEqual({ error: 0, warning: 0, info: 1 });
    expect(summary.byGroup.performance).toEqual({ error: 0, warning: 2, info: 0 });
    expect(summary.byGroup.accessibility).toEqual({ error: 0, warning: 0, info: 0 });
  });

  test("an info finding inside a warning check counts as info", () => {
    const check = outcome("HEALTH-EXT-060", "health", "warning", [
      finding("HEALTH-EXT-060", "health", "warning", "https://other.example/dead"),
      finding("HEALTH-EXT-060", "health", "info", "https://other.example/refuses"),
    ]);
    const summary = summarise([check]);
    expect(summary.byGroup.health).toEqual({ error: 0, warning: 1, info: 1 });
  });

  test("checks run excludes not applicable, checks passed counts pass only", () => {
    const summary = summarise([
      outcome("A", "seo", "error", []),
      outcome("B", "seo", "warning", [], "not-applicable"),
      failing("C", "warning", ["https://x.example/"]),
      outcome("D", "health", "info", [], "not-applicable"),
      outcome("E", "health", "warning", []),
    ]);
    expect(summary.checksRun).toBe(3);
    expect(summary.checksPassed).toBe(2);
  });
});

describe("summarise fix first", () => {
  test("errors come before warnings, each ordered by distinct affected URLs", () => {
    const summary = summarise([
      failing("W-MANY", "warning", ["u1", "u2", "u3", "u4"]),
      failing("E-FEW", "error", ["u1"]),
      failing("E-MANY", "error", ["u1", "u2", "u3"]),
      failing("W-FEW", "warning", ["u1", "u2"]),
    ]);
    expect(summary.fixFirst.map((i) => [i.checkId, i.severity, i.affected])).toEqual([
      ["E-MANY", "error", 3],
      ["E-FEW", "error", 1],
      ["W-MANY", "warning", 4],
      ["W-FEW", "warning", 2],
    ]);
  });

  test("an item carries the check title and fix", () => {
    const summary = summarise([failing("E-1", "error", ["u1"])]);
    expect(summary.fixFirst[0]).toEqual({
      checkId: "E-1",
      title: "Title of E-1",
      severity: "error",
      affected: 1,
      fix: "Fix E-1",
    });
  });

  test("affected counts distinct URLs, and a site-level finding counts as one", () => {
    const summary = summarise([
      failing("DUP", "error", ["u1", "u1", "u2"]),
      failing("SITE", "error", [null]),
      failing("BOTH", "error", [null, null, "u1"]),
    ]);
    const affected = Object.fromEntries(summary.fixFirst.map((i) => [i.checkId, i.affected]));
    expect(affected).toEqual({ DUP: 2, SITE: 1, BOTH: 2 });
  });

  test("ties break by check id", () => {
    const summary = summarise([
      failing("E-B", "error", ["u1"]),
      failing("E-A", "error", ["u1"]),
      failing("E-C", "error", ["u1"]),
    ]);
    expect(summary.fixFirst.map((i) => i.checkId)).toEqual(["E-A", "E-B", "E-C"]);
  });

  test("it is capped at five", () => {
    const summary = summarise(
      Array.from({ length: 8 }, (_, i) => failing(`E-${i}`, "error", ["u1"])),
    );
    expect(summary.fixFirst).toHaveLength(5);
    expect(summary.fixFirst.map((i) => i.checkId)).toEqual(["E-0", "E-1", "E-2", "E-3", "E-4"]);
  });

  test("warnings fill the list only after every error", () => {
    const summary = summarise([
      ...Array.from({ length: 4 }, (_, i) => failing(`E-${i}`, "error", ["u1"])),
      failing("W-0", "warning", ["u1", "u2", "u3"]),
      failing("W-1", "warning", ["u1"]),
    ]);
    expect(summary.fixFirst.map((i) => i.checkId)).toEqual(["E-0", "E-1", "E-2", "E-3", "W-0"]);
  });

  test("info checks, passes and not-applicable checks never appear", () => {
    const summary = summarise([
      failing("I-1", "info", ["u1", "u2", "u3"]),
      outcome("E-PASS", "seo", "error", []),
      outcome("E-NA", "seo", "error", [], "not-applicable"),
    ]);
    expect(summary.fixFirst).toEqual([]);
  });

  test("a warning check whose findings are all info is not a fix to make first", () => {
    const check = outcome("HEALTH-EXT-060", "health", "warning", [
      finding("HEALTH-EXT-060", "health", "info", "https://other.example/refuses"),
    ]);
    expect(summarise([check]).fixFirst).toEqual([]);
  });
});
