/**
 * The property under test everywhere below: this adapter must never turn our own
 * problem into evidence against a provider. "Not received" is a claim that can
 * become a permanent public FAIL; an auth error, a 500, a rate limit or a
 * network blip is not a claim about anyone.
 */

import { describe, expect, test } from "bun:test";
import { ResendInbox } from "./inbox-resend";

const ADDRESS = "probe-abc123@inbox.softruth.com";
const NONCE = "sft-deadbeefcafe";

/** Minimal fetch stub driven by a route table. */
function stubFetch(routes: Record<string, unknown>, options: { status?: number; throws?: Error } = {}) {
  const calls: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    const href = typeof url === "string" ? url : url.toString();
    calls.push(href);
    if (options.throws) throw options.throws;

    const status = options.status ?? 200;
    const match = Object.entries(routes).find(([path]) => href.includes(path));
    const body = match ? match[1] : { data: [] };

    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;

  return { impl, calls };
}

function listOf(...emails: Array<Record<string, unknown>>) {
  return { object: "list", has_more: false, data: emails };
}

describe("finding the message", () => {
  test("matches the nonce in the subject from the cheap list call", async () => {
    const { impl, calls } = stubFetch({
      "/emails/receiving": listOf({
        id: "em_1",
        to: [ADDRESS],
        subject: `Your receipt [${NONCE}]`,
        created_at: "2026-09-07T10:00:00.000Z",
      }),
    });

    const result = await new ResendInbox("key", impl, 1).awaitMessage(ADDRESS, NONCE, 1000);

    expect(result.outcome).toBe("received");
    if (result.outcome === "received") {
      expect(result.matchedIn).toBe("subject");
      expect(result.receivedAt.toISOString()).toBe("2026-09-07T10:00:00.000Z");
    }
    // No per-message fetch needed on the common path.
    expect(calls.filter((c) => /\/emails\/receiving\/em_/.test(c))).toHaveLength(0);
  });

  test("falls back to the body when a provider rewrote the subject", async () => {
    const { impl } = stubFetch({
      "/emails/receiving/em_1": { id: "em_1", subject: "Rewritten", text: `nonce ${NONCE} here` },
      "/emails/receiving": listOf({ id: "em_1", to: [ADDRESS], subject: "Rewritten" }),
    });

    const result = await new ResendInbox("key", impl, 1).awaitMessage(ADDRESS, NONCE, 1000);

    expect(result.outcome).toBe("received");
    if (result.outcome === "received") expect(result.matchedIn).toBe("body");
  });

  test("ignores messages addressed to someone else", async () => {
    // The API has no recipient filter, so this narrowing happens client-side and
    // is the only thing keeping another run's mail out of this one's result.
    const { impl } = stubFetch({
      "/emails/receiving": listOf({
        id: "em_1",
        to: ["probe-somebodyelse@inbox.softruth.com"],
        subject: `Your receipt [${NONCE}]`,
      }),
    });

    expect((await new ResendInbox("key", impl, 1).awaitMessage(ADDRESS, NONCE, 30)).outcome).toBe("not-received");
  });

  test("ignores a message to us carrying a different run's nonce", async () => {
    const { impl } = stubFetch({
      "/emails/receiving": listOf({ id: "em_1", to: [ADDRESS], subject: "Your receipt [sft-someotherrun]" }),
    });

    expect((await new ResendInbox("key", impl, 1).awaitMessage(ADDRESS, NONCE, 30)).outcome).toBe("not-received");
  });

  test("matches the recipient case-insensitively", async () => {
    const { impl } = stubFetch({
      "/emails/receiving": listOf({ id: "em_1", to: [ADDRESS.toUpperCase()], subject: `x [${NONCE}]` }),
    });

    expect((await new ResendInbox("key", impl, 1).awaitMessage(ADDRESS, NONCE, 1000)).outcome).toBe("received");
  });
});

describe("our failures never become evidence against a provider", () => {
  const cases: Array<[string, Parameters<typeof stubFetch>[1]]> = [
    ["auth failure (401)", { status: 401 }],
    ["forbidden (403)", { status: 403 }],
    ["rate limited (429)", { status: 429 }],
    ["server error (500)", { status: 500 }],
    ["network error", { throws: new Error("ECONNREFUSED") }],
  ];

  for (const [label, options] of cases) {
    test(`${label} reports unavailable, not not-received`, async () => {
      const { impl } = stubFetch({}, options);
      const result = await new ResendInbox("key", impl, 1).awaitMessage(ADDRESS, NONCE, 50);

      expect(result.outcome).toBe("unavailable");
      // The distinction that matters: "unavailable" becomes INCONCLUSIVE
      // downstream; "not-received" can become a permanent public FAIL.
      expect(result.outcome).not.toBe("not-received");
    });
  }

  test("a timeout reports unavailable", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const { impl } = stubFetch({}, { throws: abort });

    const result = await new ResendInbox("key", impl, 1).awaitMessage(ADDRESS, NONCE, 50);
    expect(result.outcome).toBe("unavailable");
    if (result.outcome === "unavailable") expect(result.error).toContain("did not respond");
  });

  test("unparseable JSON reports unavailable", async () => {
    const impl = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
      }) as unknown as Response) as unknown as typeof fetch;

    const result = await new ResendInbox("key", impl, 1).awaitMessage(ADDRESS, NONCE, 50);
    expect(result.outcome).toBe("unavailable");
  });
});

describe("waiting", () => {
  test("only reports not-received after the full window has elapsed", async () => {
    // Returning early on an empty poll would be the same bug as misreporting an
    // outage: absence is only evidence once we actually waited for it.
    const { impl, calls } = stubFetch({ "/emails/receiving": listOf() });
    const started = Date.now();

    const result = await new ResendInbox("key", impl, 10).awaitMessage(ADDRESS, NONCE, 120);

    expect(result.outcome).toBe("not-received");
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(calls.length).toBeGreaterThan(1); // polled repeatedly rather than asking once
  });

  test("returns as soon as the message appears, without burning the window", async () => {
    let poll = 0;
    const impl = (async () => {
      poll += 1;
      const data = poll >= 2 ? [{ id: "em_1", to: [ADDRESS], subject: `x [${NONCE}]` }] : [];
      return { ok: true, status: 200, json: async () => ({ data }) } as unknown as Response;
    }) as unknown as typeof fetch;

    const started = Date.now();
    const result = await new ResendInbox("key", impl, 10).awaitMessage(ADDRESS, NONCE, 5000);

    expect(result.outcome).toBe("received");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("an empty inbox is not-received, not unavailable", async () => {
    const { impl } = stubFetch({ "/emails/receiving": listOf() });
    expect((await new ResendInbox("key", impl, 5).awaitMessage(ADDRESS, NONCE, 30)).outcome).toBe("not-received");
  });
});

describe("construction", () => {
  test("refuses an empty API key rather than failing every run later", () => {
    expect(() => new ResendInbox("")).toThrow(/requires an API key/);
  });
});
