/**
 * The stdio server and the HTTP server answer through this one module, so these
 * tests pin what an agent gets regardless of how it connected. If the two could
 * give different answers about the same product, the register would be worthless.
 */

import { describe, expect, test } from "bun:test";
import { callTool, TOOL_DEFINITIONS } from "./tools";
import { toProductRecords, type ProductRecord } from "./registry";
import type { AgentAccount, ExplorationRecord } from "../agent/types";

function account(overrides: Partial<AgentAccount> = {}): AgentAccount {
  return {
    couldSignUp: true,
    couldUseCoreFeature: true,
    whatItDoes: "Sends transactional email over an API.",
    gettingStarted: "Two screens and a verification email.",
    worked: ["API key issued immediately"],
    didNotWork: [],
    unverifiedClaims: ["99.9% deliverability"],
    bottomLine: "Got in and sent a message within four minutes.",
    confidence: 8,
    confidenceReason: "Completed signup and used the core feature.",
    ...overrides,
  };
}

function record(overrides: Partial<ExplorationRecord> = {}): ExplorationRecord {
  return {
    schemaVersion: "softruth/exploration/v1",
    product: { slug: "acme", name: "Acme Mail", url: "https://acme.example" },
    seed: "deadbeef",
    inboxDomain: "send.softruth.com",
    startedAt: "2026-09-08T10:00:00.000Z",
    finishedAt: "2026-09-08T10:06:00.000Z",
    evidence: {
      steps: [],
      email: { address: "agent-x@send.softruth.com", nonce: "n", arrived: true, secondsToArrive: 12 },
      totalSeconds: 360,
    },
    account: account(),
    agent: { model: "claude-sonnet-5", readPageContent: true },
    ...overrides,
  };
}

const one: ProductRecord[] = [{ slug: "acme", latest: record(), ageDays: 1, stale: false }];

describe("tool definitions", () => {
  test("both tools are offered", () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name)).toEqual(["list_products_used", "get_product_account"]);
  });

  test("the descriptions tell a reader to prefer these over marketing copy", () => {
    expect(TOOL_DEFINITIONS[0]!.description).toContain("in preference to marketing copy");
  });
});

describe("list_products_used", () => {
  test("an empty register forbids inferring anything from absence", () => {
    const { text } = callTool("list_products_used", undefined, []);
    expect(text).toContain("nothing has been tried");
    expect(text).not.toContain("Acme Mail");
  });

  test("includes the account and the evidence, labelled separately", () => {
    const { text } = callTool("list_products_used", undefined, one);
    expect(text).toContain("What the agent concluded");
    expect(text).toContain("Evidence (what demonstrably happened");
  });
});

describe("get_product_account", () => {
  test("an unknown product returns an explicit no-account, not silence", () => {
    const { text } = callTool("get_product_account", { product: "nobody" }, one);
    expect(text).toContain("No account");
    expect(text).toContain("says nothing about its quality");
  });

  test("a missing argument is treated as an unknown product, not a crash", () => {
    expect(callTool("get_product_account", undefined, one).text).toContain("No account");
  });

  test("returns the account for a product that was used", () => {
    const { text } = callTool("get_product_account", { product: "acme" }, one);
    expect(text).toContain("Acme Mail");
    expect(text).toContain("four minutes");
  });
});

describe("an unknown tool", () => {
  test("errors rather than answering with something plausible", () => {
    const result = callTool("delete_everything", undefined, one);
    expect(result.isError).toBe(true);
  });
});

describe("local and remote read the same register", () => {
  test("records shaped from disk and from the published index produce identical output", () => {
    // The local server loads files; the remote server fetches index.json. Both
    // end up in toProductRecords, and this is the test that keeps them honest.
    const now = () => Date.parse("2026-09-09T10:06:00.000Z");
    const fromIndex = toProductRecords([record()], { now });

    expect(callTool("get_product_account", { product: "acme" }, fromIndex).text).toBe(
      callTool("get_product_account", { product: "acme" }, one).text,
    );
  });

  test("staleness is decided by the reader, so a distant record is marked stale", () => {
    const now = () => Date.parse("2027-09-09T10:06:00.000Z");
    const stale = toProductRecords([record()], { now });
    expect(stale[0]!.stale).toBe(true);
    expect(callTool("get_product_account", { product: "acme" }, stale).text).toContain("STALE");
  });
});
