/**
 * A signup verification email is written by the product, not by us, so there is
 * no string of ours to match on. The unique per-session address is what makes a
 * message ours. These pin that path, which the agent depends on entirely.
 */

import { describe, expect, test } from "bun:test";
import { MemoryInbox } from "./inbox";
import { ResendInbox } from "./inbox-resend";

const ADDRESS = "probe-abc@send.softruth.com";

describe("MemoryInbox without a nonce", () => {
  test("any message to the address counts as ours", async () => {
    const inbox = new MemoryInbox();
    inbox.deliver(ADDRESS, "Verify your email", "click here");
    const r = await inbox.awaitMessage(ADDRESS, undefined, 100);
    expect(r.outcome).toBe("received");
    if (r.outcome === "received") expect(r.subject).toBe("Verify your email");
  });

  test("a message to a different address is not ours", async () => {
    const inbox = new MemoryInbox();
    inbox.deliver("someone-else@send.softruth.com", "Verify", "x");
    expect((await inbox.awaitMessage(ADDRESS, undefined, 50)).outcome).toBe("not-received");
  });

  test("our inbox being down is still unavailable, not not-received", async () => {
    const inbox = new MemoryInbox();
    inbox.setUnavailable("service returned 500");
    expect((await inbox.awaitMessage(ADDRESS, undefined, 50)).outcome).toBe("unavailable");
  });
});

describe("ResendInbox without a nonce", () => {
  function stub(emails: Array<Record<string, unknown>>) {
    return (async () =>
      ({ ok: true, status: 200, json: async () => ({ data: emails }) }) as unknown as Response) as unknown as typeof fetch;
  }

  test("takes the first message to the address, with no body fetch", async () => {
    const impl = stub([{ id: "em_1", to: [ADDRESS], subject: "Confirm your account" }]);
    const r = await new ResendInbox("k", impl, 1).awaitMessage(ADDRESS, undefined, 500);
    expect(r.outcome).toBe("received");
    if (r.outcome === "received") expect(r.subject).toBe("Confirm your account");
  });

  test("still ignores messages addressed to someone else", async () => {
    const impl = stub([{ id: "em_1", to: ["other@send.softruth.com"], subject: "Confirm" }]);
    expect((await new ResendInbox("k", impl, 1).awaitMessage(ADDRESS, undefined, 30)).outcome).toBe("not-received");
  });
});
