/**
 * A wall is not a verdict.
 *
 * The most damaging misreading this register could invite is treating "an agent
 * could not evaluate this" as "this product is bad". These pin the separation on
 * every surface a reader touches.
 */

import { describe, expect, test } from "bun:test";
import { readerGuidance, describeRecord, type ProductRecord } from "../mcp/registry";
import { renderAccount, renderIndex } from "../site/build";
import type { AgentAccount, Blocker, ExplorationRecord } from "./types";

function account(overrides: Partial<AgentAccount> = {}): AgentAccount {
  return {
    couldSignUp: false,
    couldUseCoreFeature: false,
    whatItDoes: "Appears to send transactional email.",
    gettingStarted: "Signup asked for a card before showing anything.",
    worked: [],
    didNotWork: [],
    unverifiedClaims: ["free tier"],
    bottomLine: "Could not get in without card details.",
    confidence: 3,
    confidenceReason: "Never reached the product.",
    ...overrides,
  };
}

function blocked(blockedBy: Blocker, detail = "A card was required."): ProductRecord {
  const latest: ExplorationRecord = {
    schemaVersion: "softruth/exploration/v1",
    product: { slug: "acme", name: "Acme", url: "https://acme.example" },
    seed: "s",
    inboxDomain: "send.softruth.com",
    startedAt: "2026-09-08T10:00:00.000Z",
    finishedAt: "2026-09-08T10:03:00.000Z",
    evidence: {
      steps: [],
      email: { address: "a@b", nonce: "n", arrived: false },
      totalSeconds: 180,
    },
    account: account({ blockedBy, blockedDetail: detail }),
    agent: { model: "gpt-5", readPageContent: true },
  };
  return { slug: "acme", latest, ageDays: 1, stale: false };
}

describe("reader guidance separates a wall from a judgement", () => {
  const cases: Array<[Blocker, string]> = [
    ["payment-required", "payment wall"],
    ["phone-verification", "phone verification"],
    ["manual-approval", "human gate"],
    ["bot-check", "bot check"],
    ["not-web", "not usable in a browser"],
    ["other", "stopped before it could evaluate"],
  ];

  for (const [blocker, phrase] of cases) {
    test(`${blocker} is described plainly`, () => {
      expect(readerGuidance(blocked(blocker))).toContain(phrase);
    });
  }

  test("every blocker says explicitly that this is not a judgement of the product", () => {
    for (const [blocker] of cases) {
      expect(readerGuidance(blocked(blocker))).toContain("not a judgement of the product");
    }
  });

  test("the blocker takes precedence over the could-not-sign-up message", () => {
    // Both are true when a card wall stops signup, but only one explains why.
    const guidance = readerGuidance(blocked("payment-required"));
    expect(guidance).not.toContain("Do not treat it as an evaluation");
    expect(guidance).toContain("payment wall");
  });
});

describe("the blocker reaches every surface", () => {
  test("the MCP rendering names it and quotes the detail", () => {
    const text = describeRecord(blocked("payment-required", "Card required at step two."));
    expect(text).toContain("Blocked: payment-required");
    expect(text).toContain("Card required at step two.");
  });

  test("the index card shows it", () => {
    expect(renderIndex([blocked("phone-verification")])).toContain("Blocked: phone-verification");
  });

  test("the product page explains that a buyer meets the same wall", () => {
    const html = renderAccount(blocked("payment-required"), [blocked("payment-required").latest]);
    expect(html).toContain("meets the same wall");
  });

  test("a wall is flagged as a caveat, not condemned as a failure", () => {
    // "guide bad" is reserved for a product that let the agent in and went wrong.
    expect(renderIndex([blocked("payment-required")])).toContain("guide warn");
    expect(renderIndex([blocked("payment-required")])).not.toContain("guide bad");
  });
});
