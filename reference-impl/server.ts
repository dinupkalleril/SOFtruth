#!/usr/bin/env bun
/**
 * Reference implementation of transactional-email/v1.
 *
 * A worked example of the conformance interface a provider implements to be
 * testable by SOFtruth. Two endpoints, proxying to a real email provider
 * (Resend) so it behaves like an actual vendor rather than a stub.
 *
 * It serves two purposes:
 *
 *   1. Documentation a vendor can read and copy. This is the smallest honest
 *      implementation of the spec.
 *   2. Vendor zero, so the demo has a real record before any customer exists.
 *
 * What it does NOT prove: running the suite against this shows the plumbing
 * works, not that the suite can detect a bad provider. This code is correct by
 * construction because we wrote it. Detection is proven by the fixture pairs in
 * suite/fixtures, which run every assertion against a provider broken in exactly
 * the way that assertion targets.
 */

const SPEC_VERSION = "transactional-email/v1";

export interface ServerOptions {
  /** Bearer token SOFtruth must present. In a real vendor, issued to the tester. */
  token: string;
  resendApiKey: string;
  /** Verified sending identity, e.g. probe@softruth.com */
  from: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  port?: number;
}

/** Spec states. Anything we cannot confidently classify becomes "queued". */
type SpecState = "queued" | "sent" | "delivered" | "bounced" | "failed";

/**
 * Map a Resend `last_event` onto a spec state.
 *
 * The default is deliberately "queued", not "sent" or "failed". Resend's event
 * vocabulary is not fully enumerated in their docs and can grow, and an unknown
 * event is a thing we do not understand yet. Downstream, "queued" resolves to
 * INCONCLUSIVE, which is the honest answer: we are not going to assert delivery
 * or failure on a string we have never seen.
 */
export function mapResendEvent(lastEvent: string | undefined): SpecState {
  switch (lastEvent) {
    case "delivered":
      return "delivered";
    case "bounced":
    case "hard_bounced":
      return "bounced";
    case "failed":
    case "canceled":
    case "cancelled":
      return "failed";
    case "sent":
    case "delivery_delayed":
    case "complained":
    case "opened":
    case "clicked":
      // Handed off, outcome not yet final. "complained" and the engagement
      // events all imply the message did land, but the spec's "delivered" should
      // mean the provider asserts delivery, so we stay conservative.
      return "sent";
    case "queued":
    case "scheduled":
      return "queued";
    default:
      return "queued";
  }
}

interface SendBody {
  to?: unknown;
  subject?: unknown;
  text?: unknown;
  idempotencyKey?: unknown;
}

export function createHandler(options: ServerOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;

  /** Our opaque message id → Resend's email id. */
  const messages = new Map<string, string>();
  /** idempotencyKey → our message id, so a retry does not send twice. */
  const byIdempotencyKey = new Map<string, string>();

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get("authorization") !== `Bearer ${options.token}`) {
      return json({ message: "unauthorized" }, 401);
    }

    if (request.method === "POST" && url.pathname === "/softruth/v1/send") {
      return handleSend(request);
    }

    const statusMatch = url.pathname.match(/^\/softruth\/v1\/messages\/(.+)$/);
    if (request.method === "GET" && statusMatch) {
      return handleStatus(decodeURIComponent(statusMatch[1]));
    }

    return json({ message: "not found" }, 404);
  };

  async function handleSend(request: Request): Promise<Response> {
    let body: SendBody | null;
    try {
      body = (await request.json()) as SendBody;
    } catch {
      return json({ message: "body must be valid JSON" }, 400);
    }

    // Reject malformed input rather than silently accepting it. Accepting a send
    // with no recipient would be data loss wearing a 202.
    if (typeof body?.to !== "string" || body.to.length === 0) {
      return json({ message: "field 'to' is required and must be a non-empty string" }, 400);
    }
    if (typeof body.subject !== "string") {
      return json({ message: "field 'subject' is required and must be a string" }, 400);
    }
    if (typeof body.text !== "string") {
      return json({ message: "field 'text' is required and must be a string" }, 400);
    }

    // Idempotency: a retried case must not produce a second message.
    const key = typeof body.idempotencyKey === "string" ? body.idempotencyKey : null;
    if (key && byIdempotencyKey.has(key)) {
      return json({ messageId: byIdempotencyKey.get(key) }, 202);
    }

    let response: Response;
    try {
      response = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${options.resendApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: options.from, to: body.to, subject: body.subject, text: body.text }),
      });
    } catch (error) {
      // Our upstream being unreachable is a 502, not a 4xx: the caller's request
      // was fine, we could not fulfil it.
      return json({ message: `upstream unreachable: ${errorMessage(error)}` }, 502);
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      // Pass the upstream's class through rather than flattening everything to
      // 500: a 4xx from Resend usually means the request really was bad.
      const status = response.status >= 400 && response.status < 500 ? 400 : 502;
      return json({ message: `upstream rejected the send (${response.status}): ${detail}` }, status);
    }

    const parsed = (await response.json().catch(() => null)) as { id?: string } | null;
    if (!parsed?.id) {
      return json({ message: "upstream accepted the send but returned no id" }, 502);
    }

    const messageId = `ref_${parsed.id}`;
    messages.set(messageId, parsed.id);
    if (key) byIdempotencyKey.set(key, messageId);

    return json({ messageId }, 202);
  }

  async function handleStatus(messageId: string): Promise<Response> {
    const resendId = messages.get(messageId);
    if (!resendId) return json({ message: "unknown messageId" }, 404);

    let response: Response;
    try {
      response = await fetchImpl(`https://api.resend.com/emails/${encodeURIComponent(resendId)}`, {
        headers: { Authorization: `Bearer ${options.resendApiKey}` },
      });
    } catch (error) {
      return json({ message: `upstream unreachable: ${errorMessage(error)}` }, 502);
    }

    if (!response.ok) {
      return json({ message: `upstream returned ${response.status}` }, 502);
    }

    const parsed = (await response.json().catch(() => null)) as { last_event?: string } | null;

    return json({ state: mapResendEvent(parsed?.last_event), updatedAt: new Date().toISOString() }, 200);
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  const token = process.env.SOFTRUTH_TOKEN_REFERENCE;
  const resendApiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;

  if (!token || !resendApiKey || !from) {
    console.error("need SOFTRUTH_TOKEN_REFERENCE, RESEND_API_KEY and RESEND_FROM");
    process.exit(2);
  }

  const port = Number(process.env.PORT ?? 8787);
  const handle = createHandler({ token, resendApiKey, from });

  Bun.serve({ port, fetch: handle });
  console.log(`reference implementation of ${SPEC_VERSION} listening on :${port}`);
  console.log(`  sending as ${from}`);
}
