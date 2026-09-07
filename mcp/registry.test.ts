import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeEmptyRegistry,
  describeMissing,
  describeRecord,
  loadLatestRecords,
  reportedVerdict,
} from "./registry";
import type { AssertionResult, RunRecord } from "../suite/types";

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-07T12:00:00.000Z");

let scratch: string | null = null;
afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = null;
});

function assertion(id: string, verdict: AssertionResult["verdict"], passed = 3): AssertionResult {
  return { assertionId: id, verdict, passed, total: 3, attempts: [] };
}

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schemaVersion: "softruth/run/v1",
    specVersion: "transactional-email/v1",
    vendor: "acme",
    seed: "deadbeef",
    startedAt: "2026-09-01T00:00:00.000Z",
    finishedAt: "2026-09-01T00:05:00.000Z",
    runsPerAssertion: 3,
    assertions: [assertion("send.accepts-valid", "PASS")],
    ...overrides,
  };
}

async function withResults(files: Record<string, RunRecord | string>): Promise<string> {
  scratch = await mkdtemp(join(tmpdir(), "softruth-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(scratch, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, typeof content === "string" ? content : JSON.stringify(content));
  }
  return scratch;
}

describe("loadLatestRecords", () => {
  test("an empty registry is a valid state, not an error", async () => {
    expect(await loadLatestRecords({ resultsDir: join(tmpdir(), "softruth-does-not-exist") })).toEqual([]);
  });

  test("picks the newest record per vendor", async () => {
    const dir = await withResults({
      "acme/2026-09-01.json": record({ seed: "older" }),
      "acme/2026-09-05.json": record({ seed: "newer", finishedAt: "2026-09-05T00:00:00.000Z" }),
    });
    const records = await loadLatestRecords({ resultsDir: dir, now: () => NOW });
    expect(records).toHaveLength(1);
    expect(records[0].latest.seed).toBe("newer");
  });

  test("ignores attestation sidecar files", async () => {
    const dir = await withResults({
      "acme/2026-09-01.json": record(),
      "acme/2026-09-01.attestation.json": '{"artifactDigest":"sha256:x"}',
    });
    const records = await loadLatestRecords({ resultsDir: dir, now: () => NOW });
    expect(records).toHaveLength(1);
    expect(records[0].latest.seed).toBe("deadbeef");
  });

  test("skips a malformed record rather than guessing at it", async () => {
    // Reporting a product wrongly is worse than reporting it as untested.
    const dir = await withResults({ "acme/2026-09-01.json": "{ not json" });
    expect(await loadLatestRecords({ resultsDir: dir, now: () => NOW })).toEqual([]);
  });

  test("skips a record with an unparseable timestamp", async () => {
    const dir = await withResults({ "acme/2026-09-01.json": record({ finishedAt: "not-a-date" }) });
    expect(await loadLatestRecords({ resultsDir: dir, now: () => NOW })).toEqual([]);
  });

  test("marks a record older than the window as stale", async () => {
    const dir = await withResults({
      "acme/old.json": record({ finishedAt: new Date(NOW - 60 * DAY).toISOString() }),
    });
    const [r] = await loadLatestRecords({ resultsDir: dir, now: () => NOW, freshnessWindowDays: 45 });
    expect(r.stale).toBe(true);
  });

  test("a record inside the window is not stale", async () => {
    const dir = await withResults({
      "acme/recent.json": record({ finishedAt: new Date(NOW - 10 * DAY).toISOString() }),
    });
    const [r] = await loadLatestRecords({ resultsDir: dir, now: () => NOW, freshnessWindowDays: 45 });
    expect(r.stale).toBe(false);
  });
});

describe("reportedVerdict — staleness decay", () => {
  test("a stale PASS becomes UNKNOWN", () => {
    // The pay-once-pass-forever hole. A vendor must not keep a trophy while
    // their product rots and nothing re-verifies it.
    expect(reportedVerdict(assertion("a", "PASS"), true)).toBe("UNKNOWN");
  });

  test("a fresh PASS stays a PASS", () => {
    expect(reportedVerdict(assertion("a", "PASS"), false)).toBe("PASS");
  });

  test("a stale FAIL stays a FAIL", () => {
    // Softening an observed failure over time would be a favour to the vendor
    // at the reader's expense. Nothing has shown the product got fixed.
    expect(reportedVerdict(assertion("a", "FAIL", 0), true)).toBe("FAIL");
  });

  test("a stale INCONCLUSIVE stays INCONCLUSIVE", () => {
    expect(reportedVerdict(assertion("a", "INCONCLUSIVE", 0), true)).toBe("INCONCLUSIVE");
  });
});

describe("describeRecord", () => {
  test("always publishes the seed so any run can be replayed", () => {
    const text = describeRecord({ vendor: "acme", latest: record(), ageDays: 2, stale: false });
    expect(text).toContain("deadbeef");
  });

  test("shows the ratio, not just the verdict", () => {
    // 2/3 and 3/3 are different products.
    const latest = record({ assertions: [assertion("send.accepts-valid", "PASS", 2)] });
    const text = describeRecord({ vendor: "acme", latest, ageDays: 2, stale: false });
    expect(text).toContain("2/3");
  });

  test("warns loudly when a record has no CI provenance", () => {
    // A locally-produced record is not evidence and must not read like it is.
    const text = describeRecord({ vendor: "acme", latest: record(), ageDays: 1, stale: false });
    expect(text).toContain("NOT INDEPENDENTLY PRODUCED");
  });

  test("links the CI run when provenance exists", () => {
    const latest = record({
      provenance: {
        workflowRunUrl: "https://github.com/x/y/actions/runs/1",
        commit: "abc",
        artifactDigest: "sha256:x",
      },
    });
    const text = describeRecord({ vendor: "acme", latest, ageDays: 1, stale: false });
    expect(text).toContain("https://github.com/x/y/actions/runs/1");
    expect(text).not.toContain("NOT INDEPENDENTLY PRODUCED");
  });

  test("says a stale record is stale, and reports its PASS as UNKNOWN", () => {
    const text = describeRecord({ vendor: "acme", latest: record(), ageDays: 90, stale: true });
    expect(text).toContain("STALE");
    expect(text).toContain("send.accepts-valid: UNKNOWN");
  });
});

describe("absence is reported as absence", () => {
  test("an untested product is explicitly untested, not silently fine", () => {
    const text = describeMissing("acme");
    expect(text).toContain("never tested");
    expect(text).toContain("says nothing about its quality");
  });

  test("an empty registry tells the agent not to infer anything", () => {
    expect(describeEmptyRegistry()).toContain("Do not infer anything");
  });
});
