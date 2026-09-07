/**
 * Mailbox access.
 *
 * `delivery.arrives` is the assertion this whole product exists for: we verify
 * against a mailbox WE control, not against the provider's claim that it
 * delivered. That makes the inbox part of the trust chain, so it gets a narrow,
 * explicit interface with one property that matters above all others:
 *
 *   "the message did not arrive" and "our inbox was broken" are different
 *   outcomes and must never collapse into each other.
 *
 * Collapsing them would let our own outage publish as a provider's delivery
 * failure, which is the exact harm the three-state verdict exists to prevent.
 */

/** Outcome of waiting for one message. Discriminated so callers cannot ignore the third case. */
export type InboxResult =
  | { outcome: "received"; receivedAt: Date; subject: string; matchedIn: "subject" | "body" }
  | { outcome: "not-received" }
  | { outcome: "unavailable"; error: string };

export interface Inbox {
  /**
   * Wait until a message containing `nonce` appears at `address`, or the window
   * expires.
   *
   * Implementations MUST return `unavailable` (never `not-received`) when the
   * mailbox itself could not be queried. A provider is not responsible for our
   * inbox being down.
   */
  awaitMessage(address: string, nonce: string, timeoutMs: number): Promise<InboxResult>;

  /** Human-readable name for the record, e.g. "memory" or the service in use. */
  readonly kind: string;
}

/**
 * In-memory inbox for fixtures and tests.
 *
 * This is not a stand-in for the real thing in production; it is how the fixture
 * pairs (suite/fixtures) exercise every assertion path deterministically,
 * including the paths that must produce INCONCLUSIVE. A real inbox cannot be
 * asked to fail on demand, so a fake one is the only way to test that our
 * failure handling is right.
 */
export class MemoryInbox implements Inbox {
  readonly kind = "memory";

  private readonly messages: Array<{ address: string; subject: string; body: string; receivedAt: Date }> = [];
  private unavailableReason: string | null = null;

  /** Simulate a message arriving. */
  deliver(address: string, subject: string, body: string, receivedAt: Date = new Date()): void {
    this.messages.push({ address, subject, body, receivedAt });
  }

  /** Simulate our own inbox being down, so we can assert we report INCONCLUSIVE. */
  setUnavailable(reason: string | null): void {
    this.unavailableReason = reason;
  }

  async awaitMessage(address: string, nonce: string, _timeoutMs: number): Promise<InboxResult> {
    if (this.unavailableReason !== null) {
      return { outcome: "unavailable", error: this.unavailableReason };
    }

    // Match on subject first: providers rewrite bodies (link tracking, pixels)
    // far more often than they rewrite subjects, so a body-only match is the
    // weaker signal and we record which one hit.
    const hit = this.messages.find(
      (m) => m.address === address && (m.subject.includes(nonce) || m.body.includes(nonce)),
    );

    if (!hit) return { outcome: "not-received" };

    return {
      outcome: "received",
      receivedAt: hit.receivedAt,
      subject: hit.subject,
      matchedIn: hit.subject.includes(nonce) ? "subject" : "body",
    };
  }
}

/**
 * Placeholder for the hosted testing-inbox adapter.
 *
 * Deliberately not implemented: the service has not been chosen yet, and a
 * half-guessed adapter would be worse than an honest gap. Whatever service is
 * picked, it implements this same interface and everything above it is unchanged.
 *
 * Implementation notes for whoever writes it:
 *   - Poll rather than assume a push callback; most services expose a search API.
 *   - Any transport error, auth failure or 5xx from the service MUST return
 *     `unavailable`, never `not-received`. Getting this backwards publishes our
 *     outage as a provider's failure.
 *   - Only `not-received` after genuinely waiting the full window. Returning
 *     early because a poll came back empty is the same bug.
 */
export class UnconfiguredInbox implements Inbox {
  readonly kind = "unconfigured";

  async awaitMessage(): Promise<InboxResult> {
    return {
      outcome: "unavailable",
      error: "no inbox service configured; delivery assertions cannot run",
    };
  }
}
