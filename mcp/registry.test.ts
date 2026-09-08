import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeEmptyRegister,
  describeMissing,
  describeRecord,
  loadLatestRecords,
  loadProductHistory,
  readerGuidance,
  type ProductRecord,
} from "./registry";
import type { AgentAccount, ExplorationRecord } from "../agent/types";

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-08T12:00:00.000Z");

let scratch: string | null = null;
afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = null;
});

function account(overrides: Partial<AgentAccount> = {}): AgentAccount {
  return {
    couldSignUp: true,
    couldUseCoreFeature: true,
    whatItDoes: "Sends transactional email over an API.",
    gettingStarted: "Signup took two screens and a verification email.",
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
      email: { address: "agent-x@send.softruth.com", nonce: "sft-x", arrived: true, secondsToArrive: 12 },
      totalSeconds: 360,
    },
    account: account(),
    agent: { model: "claude-sonnet-5", readPageContent: true },
    ...overrides,
  };
}

function productRecord(overrides: Partial<ProductRecord> = {}): ProductRecord {
  return { slug: "acme", latest: record(), ageDays: 1, stale: false, ...overrides };
}

async function withExplorations(files: Record<string, ExplorationRecord | string>): Promise<string> {
  scratch = await mkdtemp(join(tmpdir(), "softruth-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(scratch, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, typeof content === "string" ? content : JSON.stringify(content));
  }
  return scratch;
}

describe("loadLatestRecords", () => {
  test("an empty register is a valid state, not an error", async () => {
    expect(await loadLatestRecords({ explorationsDir: join(tmpdir(), "softruth-nope") })).toEqual([]);
  });

  test("picks the newest account per product", async () => {
    const dir = await withExplorations({
      "acme/2026-09-01.json": record({ seed: "older" }),
      "acme/2026-09-05.json": record({ seed: "newer", finishedAt: "2026-09-05T00:00:00.000Z" }),
    });
    const [r] = await loadLatestRecords({ explorationsDir: dir, now: () => NOW });
    expect(r.latest.seed).toBe("newer");
  });

  test("skips a malformed record rather than guessing at it", async () => {
    // Describing a product wrongly is worse than saying nothing about it.
    const dir = await withExplorations({ "acme/x.json": "{ not json" });
    expect(await loadLatestRecords({ explorationsDir: dir, now: () => NOW })).toEqual([]);
  });

  test("marks an account older than the window as stale", async () => {
    const dir = await withExplorations({
      "acme/old.json": record({ finishedAt: new Date(NOW - 60 * DAY).toISOString() }),
    });
    const [r] = await loadLatestRecords({ explorationsDir: dir, now: () => NOW, freshnessWindowDays: 45 });
    expect(r.stale).toBe(true);
  });
});

describe("loadProductHistory", () => {
  test("returns every account newest first", async () => {
    const dir = await withExplorations({
      "acme/a.json": record({ seed: "first", finishedAt: "2026-09-01T00:00:00.000Z" }),
      "acme/b.json": record({ seed: "second", finishedAt: "2026-09-05T00:00:00.000Z" }),
    });
    const history = await loadProductHistory("acme", { explorationsDir: dir });
    expect(history.map((h) => h.seed)).toEqual(["second", "first"]);
  });
});

describe("readerGuidance — how much weight an account deserves", () => {
  test("an agent that never signed up is describing the door, not the product", () => {
    const r = productRecord({ latest: record({ account: account({ couldSignUp: false }) }) });
    expect(readerGuidance(r)).toContain("could not sign up");
    expect(readerGuidance(r)).toContain("Do not treat it as an evaluation");
  });

  test("signed up but never used the core feature covers onboarding only", () => {
    const r = productRecord({ latest: record({ account: account({ couldUseCoreFeature: false }) }) });
    expect(readerGuidance(r)).toContain("onboarding only");
  });

  test("our own mailbox failing is called out as ours", () => {
    // Otherwise a reader blames the product for our outage.
    const r = productRecord({
      latest: record({
        evidence: {
          steps: [],
          email: { address: "a@b", nonce: "n", arrived: false, inboxUnavailable: "500 from inbox" },
          totalSeconds: 10,
        },
      }),
    });
    expect(readerGuidance(r)).toContain("Our own mailbox failed");
  });

  test("a low-confidence account is flagged as such", () => {
    const r = productRecord({ latest: record({ account: account({ confidence: 3 }) }) });
    expect(readerGuidance(r)).toContain("rated this account low confidence");
  });

  test("a complete, fresh, confident session says so plainly", () => {
    expect(readerGuidance(productRecord())).toContain("signed up and used the product");
  });
});

describe("describeRecord", () => {
  test("separates what the agent concluded from what demonstrably happened", () => {
    // The whole trust model: a product can shape a conclusion, not the evidence.
    const text = describeRecord(productRecord());
    expect(text).toContain("What the agent concluded");
    expect(text).toContain("Evidence (what demonstrably happened");
  });

  test("publishes the replay information", () => {
    const text = describeRecord(productRecord());
    expect(text).toContain("deadbeef");
    expect(text).toContain("send.softruth.com");
  });

  test("names the agent, so an account carries a byline", () => {
    expect(describeRecord(productRecord())).toContain("claude-sonnet-5");
  });

  test("surfaces unverified claims separately from what worked", () => {
    expect(describeRecord(productRecord())).toContain("Claimed but not verified");
  });

  test("warns loudly when a record has no CI provenance", () => {
    expect(describeRecord(productRecord())).toContain("NOT INDEPENDENTLY PRODUCED");
  });

  test("links the CI run when provenance exists", () => {
    const r = productRecord({
      latest: record({
        provenance: { workflowRunUrl: "https://github.com/x/y/actions/runs/1", commit: "a", artifactDigest: "d" },
      }),
    });
    const text = describeRecord(r);
    expect(text).toContain("https://github.com/x/y/actions/runs/1");
    expect(text).not.toContain("NOT INDEPENDENTLY PRODUCED");
  });
});

describe("absence is reported as absence", () => {
  test("an unused product is explicitly unused, not silently fine", () => {
    expect(describeMissing("acme")).toContain("No agent has used this product");
    expect(describeMissing("acme")).toContain("says nothing about its quality");
  });

  test("an empty register tells the reader not to infer anything", () => {
    expect(describeEmptyRegister()).toContain("Do not infer anything");
  });
});
