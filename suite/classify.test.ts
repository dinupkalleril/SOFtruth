import { describe, expect, test } from "bun:test";
import { collapseAttempts, isHarnessFailure, requiresHumanReview, summarize } from "./classify";
import type { AttemptResult, Verdict } from "./types";

function attempt(verdict: Verdict, reason = "test", measurements?: Record<string, number>): AttemptResult {
  return {
    assertionId: "a1",
    verdict,
    reason,
    detail: `synthetic ${verdict}`,
    measurements,
    startedAt: "2026-09-07T00:00:00.000Z",
    elapsedMs: 10,
  };
}

describe("collapseAttempts", () => {
  test("3 of 3 passing is a PASS with the ratio preserved", () => {
    const r = collapseAttempts("a1", [attempt("PASS"), attempt("PASS"), attempt("PASS")]);
    expect(r.verdict).toBe("PASS");
    expect(r.passed).toBe(3);
    expect(r.total).toBe(3);
  });

  test("2 of 3 passing is a PASS, and the ratio still shows the flakiness", () => {
    // The whole reason we publish the ratio: 2/3 and 3/3 are different products.
    const r = collapseAttempts("a1", [attempt("PASS"), attempt("PASS"), attempt("FAIL")]);
    expect(r.verdict).toBe("PASS");
    expect(r.passed).toBe(2);
    expect(r.total).toBe(3);
  });

  test("2 of 3 failing is a FAIL", () => {
    const r = collapseAttempts("a1", [attempt("FAIL"), attempt("FAIL"), attempt("PASS")]);
    expect(r.verdict).toBe("FAIL");
    expect(r.passed).toBe(1);
  });

  test("all inconclusive stays INCONCLUSIVE — we learned nothing", () => {
    const r = collapseAttempts("a1", [
      attempt("INCONCLUSIVE", "network.timeout"),
      attempt("INCONCLUSIVE", "http.429"),
      attempt("INCONCLUSIVE", "inbox.unreachable"),
    ]);
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.passed).toBe(0);
  });

  test("a 1-1 split with one inconclusive is INCONCLUSIVE, never a FAIL", () => {
    // A permanent public accusation must not rest on a coin flip.
    const r = collapseAttempts("a1", [
      attempt("PASS"),
      attempt("FAIL"),
      attempt("INCONCLUSIVE", "network.timeout"),
    ]);
    expect(r.verdict).toBe("INCONCLUSIVE");
  });

  test("one conclusive PASS among inconclusives is a PASS", () => {
    const r = collapseAttempts("a1", [
      attempt("PASS"),
      attempt("INCONCLUSIVE", "http.503"),
      attempt("INCONCLUSIVE", "http.503"),
    ]);
    expect(r.verdict).toBe("PASS");
    expect(r.passed).toBe(1);
    expect(r.total).toBe(3);
  });

  test("one conclusive FAIL among inconclusives is a FAIL, and review will catch it", () => {
    const r = collapseAttempts("a1", [
      attempt("FAIL"),
      attempt("INCONCLUSIVE", "http.503"),
      attempt("INCONCLUSIVE", "http.503"),
    ]);
    expect(r.verdict).toBe("FAIL");
    expect(requiresHumanReview([r])).toBe(true);
  });

  test("averages measurements across attempts that reported them", () => {
    const r = collapseAttempts("a1", [
      attempt("PASS", "ok", { deliverySeconds: 2 }),
      attempt("PASS", "ok", { deliverySeconds: 4 }),
    ]);
    expect(r.measurements?.deliverySeconds).toBe(3);
  });

  test("a timeout with no latency does not get counted as zero", () => {
    // Counting a missing measurement as 0 would make a broken product look fast.
    const r = collapseAttempts("a1", [
      attempt("PASS", "ok", { deliverySeconds: 10 }),
      attempt("INCONCLUSIVE", "network.timeout"),
    ]);
    expect(r.measurements?.deliverySeconds).toBe(10);
  });

  test("ignores non-finite measurements rather than poisoning the average", () => {
    const r = collapseAttempts("a1", [
      attempt("PASS", "ok", { deliverySeconds: 5 }),
      attempt("PASS", "ok", { deliverySeconds: Number.NaN }),
    ]);
    expect(r.measurements?.deliverySeconds).toBe(5);
  });

  test("omits measurements entirely when nothing reported any", () => {
    const r = collapseAttempts("a1", [attempt("PASS"), attempt("PASS")]);
    expect(r.measurements).toBeUndefined();
  });

  test("throws on zero attempts rather than inventing a verdict", () => {
    expect(() => collapseAttempts("a1", [])).toThrow(/no attempts/);
  });
});

describe("isHarnessFailure", () => {
  test("rate limiting is our fault, not the product's", () => {
    expect(isHarnessFailure("http.429")).toBe(true);
  });

  test("our inbox being down is our fault", () => {
    expect(isHarnessFailure("inbox.unreachable")).toBe(true);
    expect(isHarnessFailure("inbox.timeout")).toBe(true);
  });

  test("gateway errors are treated as transient, not as product failure", () => {
    expect(isHarnessFailure("http.502")).toBe(true);
    expect(isHarnessFailure("http.503")).toBe(true);
    expect(isHarnessFailure("http.504")).toBe(true);
  });

  test("a 400 is the product rejecting our request and is genuinely conclusive", () => {
    expect(isHarnessFailure("http.400")).toBe(false);
    expect(isHarnessFailure("http.401")).toBe(false);
  });
});

describe("requiresHumanReview", () => {
  test("any FAIL blocks publication until a human looks", () => {
    const results = [
      collapseAttempts("a1", [attempt("PASS")]),
      collapseAttempts("a2", [attempt("FAIL")]),
    ];
    expect(requiresHumanReview(results)).toBe(true);
  });

  test("passes and inconclusives publish without review", () => {
    const results = [
      collapseAttempts("a1", [attempt("PASS")]),
      collapseAttempts("a2", [attempt("INCONCLUSIVE", "network.timeout")]),
    ];
    expect(requiresHumanReview(results)).toBe(false);
  });
});

describe("summarize", () => {
  test("counts each verdict for the PR title", () => {
    const results = [
      collapseAttempts("a1", [attempt("PASS")]),
      collapseAttempts("a2", [attempt("FAIL")]),
      collapseAttempts("a3", [attempt("INCONCLUSIVE", "http.429")]),
    ];
    expect(summarize(results)).toBe("1 passed, 1 failed, 1 inconclusive of 3 assertions");
  });
});
