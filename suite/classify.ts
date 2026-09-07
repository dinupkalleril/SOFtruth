/**
 * Verdict classification.
 *
 * Two jobs:
 *   1. Turn one attempt's observed facts into PASS / FAIL / INCONCLUSIVE.
 *   2. Collapse N attempts of the same assertion into one published verdict,
 *      keeping the ratio visible rather than rounding it away.
 *
 * The governing rule everywhere below: when we are not sure, we say we are not
 * sure. A FAIL is a permanent public statement about a named company, so the
 * bar for one is "we observed it fail, repeatedly, and nothing about our own
 * harness explains it". Everything else is INCONCLUSIVE.
 *
 *   3 attempts
 *       │
 *       ├── every attempt INCONCLUSIVE ──────────────▶ INCONCLUSIVE
 *       │
 *       └── at least one conclusive
 *              ├── more PASS than FAIL ───────────────▶ PASS
 *              ├── more FAIL than PASS ───────────────▶ FAIL  (then human review)
 *              └── tied ──────────────────────────────▶ INCONCLUSIVE
 */

import type { AssertionResult, AttemptResult, Verdict } from "./types";

/**
 * Conditions that are always our problem or the network's, never the product's.
 * Anything matching these is INCONCLUSIVE no matter what else was observed.
 */
export const HARNESS_REASONS = new Set([
  "network.timeout",
  "network.error",
  "network.dns",
  "http.429", // rate limited: we hit them too hard, that is on us
  "http.502",
  "http.503",
  "http.504",
  "inbox.unreachable",
  "inbox.timeout",
  "harness.error",
  "spec.unimplemented",
]);

/** True when a reason code means our harness or the network failed, not the product. */
export function isHarnessFailure(reason: string): boolean {
  return HARNESS_REASONS.has(reason);
}

/**
 * Collapse repeated attempts of one assertion into the published result.
 *
 * `passed / total` is published verbatim. A product passing 2 of 3 is a
 * meaningfully different product from one passing 3 of 3, and collapsing both
 * to "PASS" throws away the most useful thing we know: reliability.
 */
export function collapseAttempts(assertionId: string, attempts: AttemptResult[]): AssertionResult {
  if (attempts.length === 0) {
    throw new Error(`collapseAttempts: no attempts for assertion ${assertionId}`);
  }

  const passed = attempts.filter((a) => a.verdict === "PASS").length;
  const failed = attempts.filter((a) => a.verdict === "FAIL").length;

  let verdict: Verdict;
  if (passed === 0 && failed === 0) {
    // Nothing conclusive happened. We learned nothing about the product.
    verdict = "INCONCLUSIVE";
  } else if (passed > failed) {
    verdict = "PASS";
  } else if (failed > passed) {
    verdict = "FAIL";
  } else {
    // A genuine split. We are not going to publish a failure on a coin flip.
    verdict = "INCONCLUSIVE";
  }

  return {
    assertionId,
    verdict,
    passed,
    total: attempts.length,
    attempts,
    measurements: aggregateMeasurements(attempts),
  };
}

/**
 * Average each measurement across attempts that reported it. Latency is the
 * motivating case: one number per assertion, published alongside the verdict.
 * Attempts that reported nothing (a timeout has no latency) are excluded rather
 * than counted as zero, which would silently make a broken product look fast.
 */
function aggregateMeasurements(attempts: AttemptResult[]): Record<string, number> | undefined {
  const sums = new Map<string, { total: number; count: number }>();

  for (const attempt of attempts) {
    for (const [key, value] of Object.entries(attempt.measurements ?? {})) {
      if (!Number.isFinite(value)) continue;
      const entry = sums.get(key) ?? { total: 0, count: 0 };
      entry.total += value;
      entry.count += 1;
      sums.set(key, entry);
    }
  }

  if (sums.size === 0) return undefined;

  const out: Record<string, number> = {};
  for (const [key, { total, count }] of sums) {
    out[key] = Math.round((total / count) * 100) / 100;
  }
  return out;
}

/**
 * Does this run need a human before anything publishes?
 *
 * Only FAIL requires review. That asymmetry is deliberate and it is about
 * consequence, not confidence: a wrong FAIL is a defamatory statement about a
 * named business, while a wrong PASS is an error we correct on the next run.
 * The fixture pairs in suite/fixtures guard the PASS direction instead.
 */
export function requiresHumanReview(results: AssertionResult[]): boolean {
  return results.some((r) => r.verdict === "FAIL");
}

/** One-line summary for a PR title or the site. */
export function summarize(results: AssertionResult[]): string {
  const pass = results.filter((r) => r.verdict === "PASS").length;
  const fail = results.filter((r) => r.verdict === "FAIL").length;
  const inconclusive = results.filter((r) => r.verdict === "INCONCLUSIVE").length;
  return `${pass} passed, ${fail} failed, ${inconclusive} inconclusive of ${results.length} assertions`;
}
