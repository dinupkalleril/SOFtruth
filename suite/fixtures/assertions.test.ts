/**
 * Fixture pairs — the tests that guard the product.
 *
 * Each assertion is run against a provider that is correct and one that is
 * broken in exactly the way that assertion targets. An assertion that cannot
 * tell them apart is a bug that would otherwise surface as a permanent, public,
 * wrong verdict about a real company.
 *
 * Note which direction is guarded here: a wrong FAIL gets caught by human review
 * before publishing, but NOTHING reviews a wrong PASS. These tests are the only
 * thing standing between a broken assertion and a corpus full of false passes.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  assertBounceReported,
  assertSendAcceptsValid,
  assertSendRejectsMalformed,
  probeDelivery,
  type AssertionContext,
} from "../assertions";
import { MemoryInbox } from "../inbox";
import { generateBounceAddress, generateCase } from "../seed";
import { startFixtureProvider, type FixtureDefects } from "./provider";

const SEED = "fixture-seed-0001";

let running: { stop(): void } | null = null;
afterEach(() => {
  running?.stop();
  running = null;
});

function setup(defects: FixtureDefects = {}): AssertionContext {
  const inbox = new MemoryInbox();
  const provider = startFixtureProvider(inbox, defects);
  running = provider;

  return {
    target: { vendor: "fixture", baseUrl: provider.baseUrl, token: provider.token },
    testCase: generateCase(SEED, 0),
    inbox,
    bounceAddress: generateBounceAddress(SEED, 0),
    deliveryWindowMs: 1_000,
    bounceWindowMs: 1_000,
  };
}

/** Pull one assertion out of the delivery probe's three results. */
async function delivery(ctx: AssertionContext, id: string) {
  const results = await probeDelivery(ctx);
  const found = results.find((r) => r.assertionId === id);
  if (!found) throw new Error(`probeDelivery did not return ${id}`);
  return found;
}

describe("send.accepts-valid", () => {
  test("PASSES a correct provider", async () => {
    expect((await assertSendAcceptsValid(setup())).verdict).toBe("PASS");
  });

  test("FAILS a provider that returns 202 with no messageId", async () => {
    // Without an id the message cannot be tracked, so the interface is not implemented.
    const r = await assertSendAcceptsValid(setup({ omitsMessageId: true }));
    expect(r.verdict).toBe("FAIL");
    expect(r.reason).toBe("response.no-message-id");
  });

  test("is INCONCLUSIVE when rate limited — that is our fault, not theirs", async () => {
    const r = await assertSendAcceptsValid(setup({ alwaysRateLimited: true }));
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.reason).toBe("http.429");
  });

  test("is INCONCLUSIVE during a provider outage", async () => {
    const r = await assertSendAcceptsValid(setup({ alwaysUnavailable: true }));
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.reason).toBe("http.503");
  });

  test("is INCONCLUSIVE when the host does not resolve", async () => {
    const ctx = setup();
    ctx.target.baseUrl = "http://softruth-nonexistent-host.invalid";
    const r = await assertSendAcceptsValid(ctx);
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(["network.dns", "network.error"]).toContain(r.reason);
  });
});

describe("send.rejects-malformed", () => {
  test("PASSES a provider that returns 4xx for a send with no recipient", async () => {
    expect((await assertSendRejectsMalformed(setup())).verdict).toBe("PASS");
  });

  test("FAILS a provider that accepts a send with no recipient", async () => {
    // Silent data loss for their customers: accepted, never deliverable.
    const r = await assertSendRejectsMalformed(setup({ acceptsMalformed: true }));
    expect(r.verdict).toBe("FAIL");
    expect(r.detail).toContain("silent data loss");
  });

  test("FAILS a provider that crashes on malformed input", async () => {
    const r = await assertSendRejectsMalformed(setup({ crashesOnMalformed: true }));
    expect(r.verdict).toBe("FAIL");
    expect(r.detail).toContain("crashed");
  });
});

describe("delivery.arrives", () => {
  test("PASSES when the message actually lands in our inbox", async () => {
    const r = await delivery(setup(), "delivery.arrives");
    expect(r.verdict).toBe("PASS");
    expect(r.reason).toBe("inbox.received");
  });

  test("FAILS when the provider claims delivered and nothing arrived", async () => {
    const r = await delivery(setup({ claimsDeliveredNeverSends: true }), "delivery.arrives");
    expect(r.verdict).toBe("FAIL");
    expect(r.reason).toBe("inbox.not-received");
  });

  test("is INCONCLUSIVE when the provider is still queued — not a failure yet", async () => {
    const r = await delivery(setup({ staysQueued: true }), "delivery.arrives");
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.reason).toBe("status.still-queued");
  });

  test("is INCONCLUSIVE when OUR inbox is down, never a product failure", async () => {
    // The single most important row in this file. Our outage must not become
    // a permanent public accusation against a provider.
    const ctx = setup({ claimsDeliveredNeverSends: true });
    (ctx.inbox as MemoryInbox).setUnavailable("inbox provider returned 500");
    const r = await delivery(ctx, "delivery.arrives");
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.reason).toBe("inbox.unreachable");
  });
});

describe("delivery.latency", () => {
  test("reports a number when the message arrives", async () => {
    const r = await delivery(setup(), "delivery.latency");
    expect(r.verdict).toBe("PASS");
    expect(r.measurements?.deliverySeconds).toBeGreaterThanOrEqual(0);
  });

  test("is INCONCLUSIVE with no measurement when nothing arrived", async () => {
    // Must not report 0 seconds for a message that never came.
    const r = await delivery(setup({ claimsDeliveredNeverSends: true }), "delivery.latency");
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.measurements).toBeUndefined();
  });
});

describe("status.matches-reality", () => {
  test("PASSES when the provider says delivered and it did arrive", async () => {
    const r = await delivery(setup(), "status.matches-reality");
    expect(r.verdict).toBe("PASS");
  });

  test("FAILS the expensive lie: reported delivered, never arrived", async () => {
    const r = await delivery(setup({ claimsDeliveredNeverSends: true }), "status.matches-reality");
    expect(r.verdict).toBe("FAIL");
    expect(r.reason).toBe("status.false-positive");
  });

  test("FAILS the other direction: reported failed, but it arrived", async () => {
    const r = await delivery(setup({ claimsFailedButDelivers: true }), "status.matches-reality");
    expect(r.verdict).toBe("FAIL");
    expect(r.reason).toBe("status.false-negative");
  });
});

describe("bounce.reported", () => {
  test("PASSES a provider that reports a hard bounce", async () => {
    const r = await assertBounceReported(setup());
    expect(r.verdict).toBe("PASS");
  });

  test("FAILS a provider that claims delivery to a null-MX address", async () => {
    const r = await assertBounceReported(setup({ neverReportsBounce: true }));
    expect(r.verdict).toBe("FAIL");
    expect(r.reason).toBe("bounce.claimed-delivered");
  });

  test("FAILS a provider that never leaves queued", async () => {
    const r = await assertBounceReported(setup({ staysQueued: true }));
    expect(r.verdict).toBe("FAIL");
    expect(r.reason).toBe("bounce.not-reported");
  });
});

describe("no assertion ever blames a provider for our problems", () => {
  test("every assertion returns INCONCLUSIVE under rate limiting", async () => {
    const verdicts = [
      (await assertSendAcceptsValid(setup({ alwaysRateLimited: true }))).verdict,
      (await assertSendRejectsMalformed(setup({ alwaysRateLimited: true }))).verdict,
      (await delivery(setup({ alwaysRateLimited: true }), "delivery.arrives")).verdict,
      (await delivery(setup({ alwaysRateLimited: true }), "status.matches-reality")).verdict,
      (await assertBounceReported(setup({ alwaysRateLimited: true }))).verdict,
    ];
    expect(verdicts.every((v) => v === "INCONCLUSIVE")).toBe(true);
  });

  test("every assertion returns INCONCLUSIVE during a provider outage", async () => {
    const verdicts = [
      (await assertSendAcceptsValid(setup({ alwaysUnavailable: true }))).verdict,
      (await assertSendRejectsMalformed(setup({ alwaysUnavailable: true }))).verdict,
      (await delivery(setup({ alwaysUnavailable: true }), "delivery.arrives")).verdict,
      (await assertBounceReported(setup({ alwaysUnavailable: true }))).verdict,
    ];
    expect(verdicts.every((v) => v === "INCONCLUSIVE")).toBe(true);
  });
});
