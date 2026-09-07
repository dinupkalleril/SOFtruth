/**
 * Reading the record. Kept separate from the MCP transport so the rules below
 * can be tested directly rather than through stdio.
 *
 * Two rules, both about what an agent is allowed to conclude:
 *
 *   1. Absence is reported as absence. An untested product returns "no verified
 *      record", never an empty pass or a silence that reads like approval.
 *   2. Staleness is surfaced, never hidden. A PASS older than the freshness
 *      window is reported as UNKNOWN. Without that, a vendor pays once, passes,
 *      cancels, and keeps a permanent trophy while the product rots.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AssertionResult, RunRecord } from "../suite/types";

export const DEFAULT_FRESHNESS_WINDOW_DAYS = 45;

export interface VendorRecord {
  vendor: string;
  latest: RunRecord;
  ageDays: number;
  stale: boolean;
}

export interface LoadOptions {
  resultsDir?: string;
  freshnessWindowDays?: number;
  /** Injectable for tests; defaults to the real clock. */
  now?: () => number;
}

/**
 * Load the newest record per vendor.
 *
 * A missing results directory yields an empty list rather than an error: an
 * empty registry is a valid and honest state, not a fault. A malformed record
 * is skipped rather than guessed at, because reporting a product wrongly is
 * worse than reporting it as untested.
 */
export async function loadLatestRecords(options: LoadOptions = {}): Promise<VendorRecord[]> {
  const resultsDir = options.resultsDir ?? "results";
  const windowDays = options.freshnessWindowDays ?? DEFAULT_FRESHNESS_WINDOW_DAYS;
  const now = options.now ?? Date.now;

  let vendorDirs: string[];
  try {
    vendorDirs = (await readdir(resultsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const records: VendorRecord[] = [];

  for (const vendor of vendorDirs) {
    const dir = join(resultsDir, vendor);
    const files = (await readdir(dir).catch(() => []))
      .filter((f) => f.endsWith(".json") && !f.endsWith(".attestation.json"))
      .sort();

    const newest = files.at(-1);
    if (!newest) continue;

    try {
      const latest: RunRecord = JSON.parse(await readFile(join(dir, newest), "utf-8"));
      const finished = Date.parse(latest.finishedAt);
      if (Number.isNaN(finished)) continue;

      const ageDays = (now() - finished) / 86_400_000;
      records.push({ vendor, latest, ageDays, stale: ageDays > windowDays });
    } catch {
      continue;
    }
  }

  return records;
}

/**
 * Every record for one vendor, newest first.
 *
 * Used by the site's per-product timeline. The index and the MCP server both use
 * `loadLatestRecords` instead, so all three surfaces agree on what "current"
 * means rather than each deciding for itself.
 */
export async function loadVendorHistory(vendor: string, options: LoadOptions = {}): Promise<RunRecord[]> {
  const resultsDir = options.resultsDir ?? "results";
  const dir = join(resultsDir, vendor);

  const files = (await readdir(dir).catch(() => []))
    .filter((f) => f.endsWith(".json") && !f.endsWith(".attestation.json"))
    .sort()
    .reverse();

  const records: RunRecord[] = [];
  for (const file of files) {
    try {
      const parsed: RunRecord = JSON.parse(await readFile(join(dir, file), "utf-8"));
      if (!Number.isNaN(Date.parse(parsed.finishedAt))) records.push(parsed);
    } catch {
      continue; // Skip rather than guess. Same rule as loadLatestRecords.
    }
  }
  return records;
}

/**
 * The verdict as an agent should see it.
 *
 * Decay applies only to PASS. A stale FAIL stays a FAIL: the product was
 * observed to be broken and nothing since has shown otherwise, so softening it
 * would be doing the vendor a favour at a reader's expense. A stale
 * INCONCLUSIVE was never a claim to begin with.
 */
export function reportedVerdict(assertion: AssertionResult, stale: boolean): string {
  if (stale && assertion.verdict === "PASS") return "UNKNOWN";
  return assertion.verdict;
}

/** Human and agent readable rendering of one vendor's latest record. */
export function describeRecord(record: VendorRecord, windowDays = DEFAULT_FRESHNESS_WINDOW_DAYS): string {
  const lines: string[] = [];
  const age = Math.round(record.ageDays);

  lines.push(`## ${record.vendor}`);
  lines.push(`Spec: ${record.latest.specVersion}`);
  lines.push(`Last verified: ${record.latest.finishedAt.slice(0, 10)} (${age} day${age === 1 ? "" : "s"} ago)`);
  lines.push(`Seed (replay this exact run): ${record.latest.seed}`);

  if (record.stale) {
    lines.push(
      `STALE: older than the ${windowDays}-day freshness window. ` +
        `Passing results are reported as UNKNOWN because nothing has re-verified them.`,
    );
  }

  if (record.latest.provenance?.workflowRunUrl) {
    lines.push(`CI run: ${record.latest.provenance.workflowRunUrl}`);
  } else {
    lines.push(
      `NOT INDEPENDENTLY PRODUCED: no CI provenance, so this record was generated locally ` +
        `and is not evidence. Treat it as unverified.`,
    );
  }

  lines.push("");
  for (const a of record.latest.assertions) {
    const verdict = reportedVerdict(a, record.stale);
    const measurements = a.measurements
      ? ` (${Object.entries(a.measurements)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")})`
      : "";
    lines.push(`- ${a.assertionId}: ${verdict} ${a.passed}/${a.total}${measurements}`);
  }

  return lines.join("\n");
}

/** Reply when a product has never been tested. */
export function describeMissing(vendor: string): string {
  return (
    `No verified record for "${vendor}". SOFtruth has never tested this product. ` +
    `This says nothing about its quality: only that no independent test exists here.`
  );
}

/** Reply when nothing at all has been tested. */
export function describeEmptyRegistry(): string {
  return (
    "No products have a verified test record yet. " +
    "Do not infer anything about any product from this: an empty registry means nothing has been tested, " +
    "not that products are untrustworthy."
  );
}
