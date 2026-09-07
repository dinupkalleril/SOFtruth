/**
 * The canonical assertions for transactional-email/v1.
 *
 * Every verdict below is computed by comparing observed facts. No model reads
 * provider-controlled content to decide anything, which is what closes prompt
 * injection against our own tester: a provider can put whatever it likes in a
 * response body and it cannot change a status code comparison.
 *
 * Structural note: `delivery.arrives`, `delivery.latency` and
 * `status.matches-reality` are all observations of ONE send, so they share one
 * probe rather than sending three times. Fewer messages through a provider's
 * system, and more honest: they describe the same event.
 */

import { collapseAttempts } from "./classify";
import { type Inbox } from "./inbox";
import { isTransientStatus, readString, request, statusReason } from "./http";
import type { AttemptResult, SeededCase, VendorTarget } from "./types";

export interface AssertionContext {
  target: VendorTarget;
  testCase: SeededCase;
  inbox: Inbox;
  bounceAddress: string;
  deliveryWindowMs: number;
  bounceWindowMs: number;
}

function sendUrl(target: VendorTarget): string {
  return `${target.baseUrl.replace(/\/$/, "")}/softruth/v1/send`;
}

function statusUrl(target: VendorTarget, messageId: string): string {
  return `${target.baseUrl.replace(/\/$/, "")}/softruth/v1/messages/${encodeURIComponent(messageId)}`;
}

function result(
  assertionId: string,
  verdict: AttemptResult["verdict"],
  reason: string,
  detail: string,
  startedAt: string,
  elapsedMs: number,
  measurements?: Record<string, number>,
): AttemptResult {
  return { assertionId, verdict, reason, detail, measurements, startedAt, elapsedMs };
}

/**
 * send.accepts-valid — a well-formed send is accepted and yields a usable id.
 *
 * A 202 with no resolvable messageId is a FAIL, not a pass: without an id we
 * cannot ask about the message later, so the provider has not actually
 * implemented the interface.
 */
export async function assertSendAcceptsValid(ctx: AssertionContext): Promise<AttemptResult> {
  const id = "send.accepts-valid";
  const startedAt = new Date().toISOString();
  const { testCase, target } = ctx;

  const outcome = await request({
    method: "POST",
    url: sendUrl(target),
    token: target.token,
    body: {
      to: testCase.to,
      subject: testCase.subject,
      text: testCase.text,
      idempotencyKey: testCase.idempotencyKey,
    },
  });

  if (outcome.kind === "network") {
    return result(id, "INCONCLUSIVE", outcome.reason, outcome.detail, startedAt, outcome.elapsedMs);
  }

  if (isTransientStatus(outcome.status)) {
    return result(
      id,
      "INCONCLUSIVE",
      statusReason(outcome.status),
      `transient ${outcome.status}; says nothing about the product`,
      startedAt,
      outcome.elapsedMs,
    );
  }

  if (outcome.status !== 202) {
    return result(
      id,
      "FAIL",
      statusReason(outcome.status),
      `expected 202, got ${outcome.status}`,
      startedAt,
      outcome.elapsedMs,
    );
  }

  const messageId = readString(outcome.json, "messageId");
  if (messageId === null) {
    return result(
      id,
      "FAIL",
      "response.no-message-id",
      "202 returned without a usable messageId, so the message cannot be tracked",
      startedAt,
      outcome.elapsedMs,
    );
  }

  return result(
    id,
    "PASS",
    statusReason(202),
    `accepted, messageId issued`,
    startedAt,
    outcome.elapsedMs,
    { acceptMs: outcome.elapsedMs },
  );
}

/**
 * send.rejects-malformed — invalid input is refused rather than swallowed.
 *
 * Both failure directions matter. A 2xx means the provider accepted a request
 * missing a required field, which is silent data loss for their customers. A
 * 5xx means it crashed on input it should have rejected.
 */
export async function assertSendRejectsMalformed(ctx: AssertionContext): Promise<AttemptResult> {
  const id = "send.rejects-malformed";
  const startedAt = new Date().toISOString();
  const { target, testCase } = ctx;

  const outcome = await request({
    method: "POST",
    url: sendUrl(target),
    token: target.token,
    // `to` omitted deliberately. Everything else is well-formed, so a provider
    // cannot claim we sent garbage: exactly one required field is missing.
    body: { subject: testCase.subject, text: testCase.text, idempotencyKey: `${testCase.idempotencyKey}-malformed` },
  });

  if (outcome.kind === "network") {
    return result(id, "INCONCLUSIVE", outcome.reason, outcome.detail, startedAt, outcome.elapsedMs);
  }

  if (isTransientStatus(outcome.status)) {
    return result(
      id,
      "INCONCLUSIVE",
      statusReason(outcome.status),
      `transient ${outcome.status}`,
      startedAt,
      outcome.elapsedMs,
    );
  }

  if (outcome.status >= 400 && outcome.status < 500) {
    return result(
      id,
      "PASS",
      statusReason(outcome.status),
      `correctly rejected a send with no recipient`,
      startedAt,
      outcome.elapsedMs,
    );
  }

  if (outcome.status >= 200 && outcome.status < 300) {
    return result(
      id,
      "FAIL",
      statusReason(outcome.status),
      `accepted a send with no recipient (${outcome.status}); silent data loss for their customers`,
      startedAt,
      outcome.elapsedMs,
    );
  }

  return result(
    id,
    "FAIL",
    statusReason(outcome.status),
    `crashed on malformed input instead of rejecting it (${outcome.status})`,
    startedAt,
    outcome.elapsedMs,
  );
}

/**
 * One send, three observations.
 *
 * Returns delivery.arrives, delivery.latency and status.matches-reality, because
 * all three describe the same message. `status.matches-reality` is the one that
 * catches the common and expensive case: a provider optimistically reporting
 * "delivered" for mail that never landed.
 */
export async function probeDelivery(ctx: AssertionContext): Promise<AttemptResult[]> {
  const startedAt = new Date().toISOString();
  const { target, testCase, inbox, deliveryWindowMs } = ctx;

  const inconclusiveAll = (reason: string, detail: string, elapsedMs: number): AttemptResult[] =>
    ["delivery.arrives", "delivery.latency", "status.matches-reality"].map((id) =>
      result(id, "INCONCLUSIVE", reason, detail, startedAt, elapsedMs),
    );

  const send = await request({
    method: "POST",
    url: sendUrl(target),
    token: target.token,
    body: {
      to: testCase.to,
      subject: testCase.subject,
      text: testCase.text,
      idempotencyKey: `${testCase.idempotencyKey}-delivery`,
    },
  });

  if (send.kind === "network") {
    return inconclusiveAll(send.reason, send.detail, send.elapsedMs);
  }
  if (isTransientStatus(send.status) || send.status >= 500) {
    return inconclusiveAll(statusReason(send.status), `send returned ${send.status}`, send.elapsedMs);
  }
  if (send.status !== 202) {
    // The send was refused outright. That is send.accepts-valid's finding to
    // report, not ours; we simply never observed a delivery to judge.
    return inconclusiveAll(
      statusReason(send.status),
      `send refused with ${send.status}; delivery never attempted`,
      send.elapsedMs,
    );
  }

  const messageId = readString(send.json, "messageId");
  if (messageId === null) {
    return inconclusiveAll("response.no-message-id", "no messageId to track", send.elapsedMs);
  }

  const sentAt = Date.now();
  const arrival = await inbox.awaitMessage(testCase.to, testCase.nonce, deliveryWindowMs);

  // Our inbox being down is never the provider's fault.
  if (arrival.outcome === "unavailable") {
    return inconclusiveAll("inbox.unreachable", `our inbox failed: ${arrival.error}`, Date.now() - sentAt);
  }

  const providerState = await readProviderState(ctx, messageId);
  const arrived = arrival.outcome === "received";
  const deliverySeconds = arrived ? (arrival.receivedAt.getTime() - sentAt) / 1000 : undefined;

  const arrives: AttemptResult = arrived
    ? result(
        "delivery.arrives",
        "PASS",
        "inbox.received",
        `nonce found in ${arrival.matchedIn} after ${deliverySeconds?.toFixed(1)}s`,
        startedAt,
        Date.now() - sentAt,
      )
    : providerState === "queued" || providerState === null
      ? result(
          "delivery.arrives",
          "INCONCLUSIVE",
          providerState === null ? "status.unavailable" : "status.still-queued",
          providerState === null
            ? "message never arrived and the status endpoint did not answer, so we cannot attribute it"
            : `message never arrived but the provider still reports queued after ${deliveryWindowMs / 1000}s`,
          startedAt,
          Date.now() - sentAt,
        )
      : result(
          "delivery.arrives",
          "FAIL",
          "inbox.not-received",
          `no message within ${deliveryWindowMs / 1000}s while the provider reported "${providerState}"`,
          startedAt,
          Date.now() - sentAt,
        );

  const latency: AttemptResult =
    deliverySeconds === undefined
      ? result("delivery.latency", "INCONCLUSIVE", "no-delivery", "nothing arrived to time", startedAt, 0)
      : result(
          "delivery.latency",
          "PASS",
          "measured",
          `${deliverySeconds.toFixed(1)}s from accept to arrival`,
          startedAt,
          Date.now() - sentAt,
          { deliverySeconds: Math.round(deliverySeconds * 100) / 100 },
        );

  const matches = classifyStatusAgainstReality(providerState, arrived, startedAt, Date.now() - sentAt);

  return [arrives, latency, matches];
}

/** Read the provider's own state for a message. null when we could not read it. */
async function readProviderState(ctx: AssertionContext, messageId: string): Promise<string | null> {
  const outcome = await request({
    method: "GET",
    url: statusUrl(ctx.target, messageId),
    token: ctx.target.token,
  });

  if (outcome.kind === "network" || outcome.status !== 200) return null;
  return readString(outcome.json, "state");
}

/**
 * status.matches-reality — does the provider's own story match what we saw?
 *
 * The asymmetry is deliberate. Claiming delivery for mail that never arrived is
 * the expensive lie: their customer believes a password reset went out and it
 * did not. Claiming failure for mail that did arrive is wrong too, but it fails
 * safe for their customer, who retries.
 */
function classifyStatusAgainstReality(
  providerState: string | null,
  arrived: boolean,
  startedAt: string,
  elapsedMs: number,
): AttemptResult {
  const id = "status.matches-reality";

  if (providerState === null) {
    return result(id, "INCONCLUSIVE", "status.unavailable", "status endpoint did not answer", startedAt, elapsedMs);
  }
  if (providerState === "queued") {
    return result(id, "INCONCLUSIVE", "status.still-queued", "still queued at the end of the window", startedAt, elapsedMs);
  }

  const claimsDelivered = providerState === "delivered";
  const claimsNotDelivered = providerState === "bounced" || providerState === "failed";

  if (claimsDelivered && arrived) {
    return result(id, "PASS", "status.accurate", "reported delivered and it arrived", startedAt, elapsedMs);
  }
  if (claimsNotDelivered && !arrived) {
    return result(id, "PASS", "status.accurate", `reported ${providerState} and nothing arrived`, startedAt, elapsedMs);
  }
  if (claimsDelivered && !arrived) {
    return result(
      id,
      "FAIL",
      "status.false-positive",
      "reported delivered for a message that never arrived",
      startedAt,
      elapsedMs,
    );
  }
  if (claimsNotDelivered && arrived) {
    return result(
      id,
      "FAIL",
      "status.false-negative",
      `reported ${providerState} for a message that did arrive`,
      startedAt,
      elapsedMs,
    );
  }

  // "sent" and anything unrecognised: the provider handed off but will not say
  // what happened next. Not a lie, not a confirmation.
  return result(
    id,
    "INCONCLUSIVE",
    "status.indeterminate",
    `state "${providerState}" neither confirms nor denies delivery`,
    startedAt,
    elapsedMs,
  );
}

/**
 * bounce.reported — a hard bounce is reported as a bounce.
 *
 * The address is a seeded local-part at a null-MX subdomain we control, so every
 * provider must see the same hard failure, and no provider can allowlist one
 * fixed address into a canned "bounced" answer.
 */
export async function assertBounceReported(ctx: AssertionContext): Promise<AttemptResult> {
  const id = "bounce.reported";
  const startedAt = new Date().toISOString();
  const { target, testCase, bounceAddress, bounceWindowMs } = ctx;

  const send = await request({
    method: "POST",
    url: sendUrl(target),
    token: target.token,
    body: {
      to: bounceAddress,
      subject: testCase.subject,
      text: testCase.text,
      idempotencyKey: `${testCase.idempotencyKey}-bounce`,
    },
  });

  if (send.kind === "network") {
    return result(id, "INCONCLUSIVE", send.reason, send.detail, startedAt, send.elapsedMs);
  }
  if (isTransientStatus(send.status) || send.status >= 500) {
    return result(id, "INCONCLUSIVE", statusReason(send.status), `send returned ${send.status}`, startedAt, send.elapsedMs);
  }
  if (send.status !== 202) {
    // Refusing to send to an undeliverable address up front is defensible
    // behaviour, not a bounce-reporting failure. We cannot judge the assertion.
    return result(
      id,
      "INCONCLUSIVE",
      statusReason(send.status),
      `refused the send with ${send.status}, so no bounce could be observed`,
      startedAt,
      send.elapsedMs,
    );
  }

  const messageId = readString(send.json, "messageId");
  if (messageId === null) {
    return result(id, "INCONCLUSIVE", "response.no-message-id", "no messageId to track", startedAt, send.elapsedMs);
  }

  const state = await pollUntilTerminal(ctx, messageId, bounceWindowMs);
  const elapsedMs = Date.now() - Date.parse(startedAt);

  if (state === null) {
    return result(id, "INCONCLUSIVE", "status.unavailable", "status endpoint did not answer", startedAt, elapsedMs);
  }
  if (state === "bounced") {
    return result(id, "PASS", "bounce.detected", "hard bounce correctly reported", startedAt, elapsedMs);
  }
  if (state === "delivered") {
    return result(
      id,
      "FAIL",
      "bounce.claimed-delivered",
      "reported delivered for an address with no MX record",
      startedAt,
      elapsedMs,
    );
  }
  return result(
    id,
    "FAIL",
    "bounce.not-reported",
    `still "${state}" after ${bounceWindowMs / 1000}s instead of reporting a bounce`,
    startedAt,
    elapsedMs,
  );
}

/**
 * Poll status until it stops being queued/sent, or the window expires.
 *
 * The sleep is clamped to the time actually remaining. Sleeping a full interval
 * regardless would overshoot every deadline by up to one interval, which is
 * invisible with a 600s window and a 5s interval, and turns a 1s window into a
 * 5s one.
 */
async function pollUntilTerminal(
  ctx: AssertionContext,
  messageId: string,
  windowMs: number,
  intervalMs = 5_000,
): Promise<string | null> {
  const deadline = Date.now() + windowMs;
  let last: string | null = null;

  while (true) {
    last = await readProviderState(ctx, messageId);
    if (last !== null && last !== "queued" && last !== "sent") return last;

    const remaining = deadline - Date.now();
    if (remaining <= 0) return last;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }
}

/** Every assertion in the category, in the order they run. */
export async function runAllAssertions(ctx: AssertionContext): Promise<AttemptResult[]> {
  return [
    await assertSendAcceptsValid(ctx),
    await assertSendRejectsMalformed(ctx),
    ...(await probeDelivery(ctx)),
    await assertBounceReported(ctx),
  ];
}

export { collapseAttempts };
