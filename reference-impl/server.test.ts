import { describe, expect, test } from "bun:test";
import { createHandler, mapResendEvent } from "./server";

const TOKEN = "test-token";

/** Route-table fetch stub so no test touches the network. */
function stub(routes: Record<string, { status?: number; body?: unknown; throws?: Error }>) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url.toString();
    calls.push({ url: href, body: init?.body ? JSON.parse(String(init.body)) : undefined });

    const match = Object.entries(routes).find(([path]) => href.includes(path));
    const route = match?.[1] ?? { status: 200, body: { id: "resend_default" } };
    if (route.throws) throw route.throws;

    const status = route.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => route.body ?? {},
      text: async () => JSON.stringify(route.body ?? {}),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  return { impl, calls };
}

function handlerWith(routes: Parameters<typeof stub>[0] = {}) {
  const { impl, calls } = stub(routes);
  return {
    handle: createHandler({ token: TOKEN, resendApiKey: "rk", from: "probe@send.softruth.com", fetchImpl: impl }),
    calls,
  };
}

function send(body: unknown, token = TOKEN): Request {
  return new Request("http://localhost/softruth/v1/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID = { to: "probe-x@inbox.softruth.com", subject: "s", text: "t", idempotencyKey: "k1" };

describe("auth", () => {
  test("rejects a missing or wrong token", async () => {
    const { handle } = handlerWith();
    expect((await handle(send(VALID, "wrong"))).status).toBe(401);
  });
});

describe("POST /softruth/v1/send", () => {
  test("accepts a valid send with 202 and a usable messageId", async () => {
    const { handle } = handlerWith({ "/emails": { body: { id: "resend_1" } } });
    const response = await handle(send(VALID));

    expect(response.status).toBe(202);
    expect((await response.json()).messageId).toBe("ref_resend_1");
  });

  test("rejects a send with no recipient rather than silently accepting it", async () => {
    // Accepting this would be data loss wearing a 202.
    const { handle } = handlerWith();
    const response = await handle(send({ subject: "s", text: "t" }));

    expect(response.status).toBe(400);
    expect((await response.json()).message).toContain("'to' is required");
  });

  test("rejects an empty-string recipient", async () => {
    const { handle } = handlerWith();
    expect((await handle(send({ ...VALID, to: "" }))).status).toBe(400);
  });

  test("rejects a non-string recipient", async () => {
    const { handle } = handlerWith();
    expect((await handle(send({ ...VALID, to: 42 }))).status).toBe(400);
  });

  test("rejects a malformed JSON body", async () => {
    const { handle } = handlerWith();
    const response = await handle(
      new Request("http://localhost/softruth/v1/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}` },
        body: "{ not json",
      }),
    );
    expect(response.status).toBe(400);
  });

  test("does not send twice for a repeated idempotency key", async () => {
    // A retried case must not put two messages through a provider's system.
    const { handle, calls } = handlerWith({ "/emails": { body: { id: "resend_1" } } });
    const first = await handle(send(VALID));
    const second = await handle(send(VALID));

    expect((await first.json()).messageId).toBe((await second.json()).messageId);
    expect(calls.filter((c) => c.url.endsWith("/emails"))).toHaveLength(1);
  });

  test("sends from the configured verified identity, not the caller's", async () => {
    const { handle, calls } = handlerWith({ "/emails": { body: { id: "resend_1" } } });
    await handle(send(VALID));
    expect((calls[0].body as { from: string }).from).toBe("probe@send.softruth.com");
  });

  test("an unreachable upstream is 502, not 4xx", async () => {
    // The caller's request was fine; we could not fulfil it. Saying 4xx would
    // blame them for our problem.
    const { handle } = handlerWith({ "/emails": { throws: new Error("ECONNREFUSED") } });
    expect((await handle(send(VALID))).status).toBe(502);
  });

  test("an upstream 4xx passes through as 400", async () => {
    const { handle } = handlerWith({ "/emails": { status: 422, body: { message: "bad" } } });
    expect((await handle(send(VALID))).status).toBe(400);
  });

  test("an upstream 5xx becomes 502", async () => {
    const { handle } = handlerWith({ "/emails": { status: 500, body: {} } });
    expect((await handle(send(VALID))).status).toBe(502);
  });

  test("an accepted send with no upstream id is 502, never a 202 without a messageId", async () => {
    // Returning 202 with no id would fail the spec while looking like success.
    const { handle } = handlerWith({ "/emails": { body: {} } });
    expect((await handle(send(VALID))).status).toBe(502);
  });
});

describe("GET /softruth/v1/messages/{id}", () => {
  async function sendThenStatus(statusRoute: { status?: number; body?: unknown; throws?: Error }) {
    const { handle } = handlerWith({
      "/emails/resend_1": statusRoute,
      "/emails": { body: { id: "resend_1" } },
    });
    const created = await handle(send(VALID));
    const { messageId } = await created.json();

    return handle(
      new Request(`http://localhost/softruth/v1/messages/${messageId}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
  }

  test("reports delivered when the upstream says delivered", async () => {
    const response = await sendThenStatus({ body: { last_event: "delivered" } });
    expect(response.status).toBe(200);
    expect((await response.json()).state).toBe("delivered");
  });

  test("reports bounced when the upstream says bounced", async () => {
    expect((await (await sendThenStatus({ body: { last_event: "bounced" } })).json()).state).toBe("bounced");
  });

  test("an unknown messageId is 404", async () => {
    const { handle } = handlerWith();
    const response = await handle(
      new Request("http://localhost/softruth/v1/messages/nope", { headers: { Authorization: `Bearer ${TOKEN}` } }),
    );
    expect(response.status).toBe(404);
  });

  test("an unreachable upstream is 502, so the suite records INCONCLUSIVE", async () => {
    expect((await sendThenStatus({ throws: new Error("ECONNREFUSED") })).status).toBe(502);
  });
});

describe("mapResendEvent", () => {
  test("maps the states we understand", () => {
    expect(mapResendEvent("delivered")).toBe("delivered");
    expect(mapResendEvent("bounced")).toBe("bounced");
    expect(mapResendEvent("failed")).toBe("failed");
    expect(mapResendEvent("canceled")).toBe("failed");
    expect(mapResendEvent("sent")).toBe("sent");
    expect(mapResendEvent("delivery_delayed")).toBe("sent");
    expect(mapResendEvent("queued")).toBe("queued");
  });

  test("an unknown event becomes queued, never delivered or failed", () => {
    // Resend's event vocabulary is not fully documented and can grow. Asserting
    // delivery or failure from a string we have never seen would be inventing
    // evidence; queued resolves to INCONCLUSIVE downstream, which is honest.
    expect(mapResendEvent("some_future_event")).toBe("queued");
    expect(mapResendEvent(undefined)).toBe("queued");
    expect(mapResendEvent("")).toBe("queued");
  });

  test("engagement events do not count as the provider asserting delivery", () => {
    // opened/clicked imply the mail landed, but the spec's "delivered" means the
    // provider claims delivery. Staying conservative keeps status.matches-reality
    // measuring what it says it measures.
    expect(mapResendEvent("opened")).toBe("sent");
    expect(mapResendEvent("clicked")).toBe("sent");
  });
});
