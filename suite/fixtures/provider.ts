/**
 * Fixture providers: fake transactional-email services with known behaviour.
 *
 * These exist because the suite IS the product. A wrong assertion publishes a
 * wrong verdict about a named company, permanently, and no human ever reviews a
 * wrong PASS. So every assertion is exercised against a provider we KNOW is
 * correct and one we KNOW is broken in exactly the way that assertion targets.
 * If an assertion cannot tell those apart, our own CI goes red before anything
 * touches a real vendor.
 */

import type { MemoryInbox } from "../inbox";

export interface FixtureDefects {
  /** Return 2xx for a send missing a required field. */
  acceptsMalformed?: boolean;
  /** Return 5xx instead of 4xx for malformed input. */
  crashesOnMalformed?: boolean;
  /** Return 202 with no messageId. */
  omitsMessageId?: boolean;
  /** Accept the send, report "delivered", never actually deliver. */
  claimsDeliveredNeverSends?: boolean;
  /** Deliver the message but report "failed". */
  claimsFailedButDelivers?: boolean;
  /** Report "delivered" for the null-MX bounce address. */
  neverReportsBounce?: boolean;
  /** Always 429, to prove rate limiting resolves to INCONCLUSIVE. */
  alwaysRateLimited?: boolean;
  /** Always 503, to prove a provider outage resolves to INCONCLUSIVE. */
  alwaysUnavailable?: boolean;
  /** Never leave "queued", to prove an indefinite queue is INCONCLUSIVE not FAIL. */
  staysQueued?: boolean;
}

export interface FixtureProvider {
  baseUrl: string;
  token: string;
  stop(): void;
}

interface StoredMessage {
  to: string;
  state: string;
  updatedAt: string;
}

/**
 * Start a fixture provider on an ephemeral port.
 *
 * `inbox` is the same MemoryInbox the assertions read, so a "correct" fixture
 * genuinely delivers and a `claimsDeliveredNeverSends` one genuinely does not.
 * The delivery path is real, only the provider is fake.
 */
export function startFixtureProvider(inbox: MemoryInbox, defects: FixtureDefects = {}): FixtureProvider {
  const token = "fixture-token";
  const messages = new Map<string, StoredMessage>();
  let counter = 0;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);

      if (defects.alwaysRateLimited) {
        return Response.json({ message: "rate limited" }, { status: 429 });
      }
      if (defects.alwaysUnavailable) {
        return Response.json({ message: "service unavailable" }, { status: 503 });
      }
      if (req.headers.get("authorization") !== `Bearer ${token}`) {
        return Response.json({ message: "unauthorized" }, { status: 401 });
      }

      if (req.method === "POST" && url.pathname === "/softruth/v1/send") {
        return handleSend(req);
      }

      const statusMatch = url.pathname.match(/^\/softruth\/v1\/messages\/(.+)$/);
      if (req.method === "GET" && statusMatch) {
        const stored = messages.get(decodeURIComponent(statusMatch[1]));
        if (!stored) return Response.json({ message: "not found" }, { status: 404 });
        return Response.json({ state: stored.state, updatedAt: stored.updatedAt });
      }

      return Response.json({ message: "not found" }, { status: 404 });
    },
  });

  async function handleSend(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const to = typeof body?.to === "string" ? body.to : null;
    const subject = typeof body?.subject === "string" ? body.subject : "";
    const text = typeof body?.text === "string" ? body.text : "";

    // Malformed: a required field is missing.
    if (to === null) {
      if (defects.acceptsMalformed) {
        return Response.json({ messageId: `msg-${++counter}` }, { status: 202 });
      }
      if (defects.crashesOnMalformed) {
        return Response.json({ message: "internal error" }, { status: 500 });
      }
      return Response.json({ message: "field 'to' is required" }, { status: 400 });
    }

    const messageId = `msg-${++counter}`;
    if (defects.omitsMessageId) {
      return Response.json({}, { status: 202 });
    }

    // Checked before the bounce branch on purpose: a provider that never
    // resolves anything never resolves bounces either, and an earlier version
    // of this fixture let the bounce path short-circuit the defect, which made
    // a broken provider look correct.
    if (defects.staysQueued) {
      messages.set(messageId, { to, state: "queued", updatedAt: new Date().toISOString() });
      return Response.json({ messageId }, { status: 202 });
    }

    // A null-MX address is a hard bounce for everyone.
    const isBounceAddress = to.includes("@bounce.");

    if (isBounceAddress) {
      messages.set(messageId, {
        to,
        state: defects.neverReportsBounce ? "delivered" : "bounced",
        updatedAt: new Date().toISOString(),
      });
      return Response.json({ messageId }, { status: 202 });
    }

    if (defects.claimsDeliveredNeverSends) {
      // The expensive lie: their customer believes the mail went out.
      messages.set(messageId, { to, state: "delivered", updatedAt: new Date().toISOString() });
      return Response.json({ messageId }, { status: 202 });
    }

    // Actually deliver.
    inbox.deliver(to, subject, text);
    messages.set(messageId, {
      to,
      state: defects.claimsFailedButDelivers ? "failed" : "delivered",
      updatedAt: new Date().toISOString(),
    });
    return Response.json({ messageId }, { status: 202 });
  }

  return {
    baseUrl: `http://localhost:${server.port}`,
    token,
    stop: () => server.stop(true),
  };
}
