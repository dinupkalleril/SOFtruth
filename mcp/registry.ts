/**
 * Reading the register.
 *
 * What is published is an agent's account of using a product, with the evidence
 * of what it actually did sitting next to it. Kept separate from the MCP
 * transport so the rules below can be tested directly rather than through stdio.
 *
 * Three rules about what a reader is allowed to conclude:
 *
 *   1. Absence is absence. A product nobody has used returns "no account", never
 *      a silence that reads like approval.
 *   2. Staleness is surfaced. Software changes; an account from months ago
 *      describes a product that may no longer exist in that form.
 *   3. Evidence and account never merge. The account is what an agent concluded,
 *      and page content is written by the party with an interest in that
 *      conclusion. The evidence is what demonstrably happened. A reader gets both
 *      and can weigh the second against the first.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentAccount, ExplorationRecord } from "../agent/types";

export const DEFAULT_FRESHNESS_WINDOW_DAYS = 45;

/**
 * How each wall reads to someone deciding whether to trust an account.
 *
 * Written as plain description rather than criticism. A product demanding a card
 * for its trial is making a reasonable business choice; the fact is simply that
 * an agent cannot evaluate it, and a buyer meets the same wall.
 */
const BLOCKER_TEXT: Record<NonNullable<AgentAccount["blockedBy"]>, string> = {
  "payment-required": "The agent stopped at a payment wall: card details were required before the core feature could be reached.",
  "phone-verification": "The agent stopped at phone verification, which it has no way to satisfy.",
  "manual-approval": "The agent stopped at a human gate: approval, a demo call, or a waitlist.",
  "bot-check": "The agent stopped at a bot check it could not pass.",
  "not-web": "The product is not usable in a browser, so an agent cannot reach it at all.",
  other: "The agent was stopped before it could evaluate the product.",
};

export interface ProductRecord {
  slug: string;
  latest: ExplorationRecord;
  ageDays: number;
  stale: boolean;
}

export interface LoadOptions {
  explorationsDir?: string;
  freshnessWindowDays?: number;
  /** Injectable for tests; defaults to the real clock. */
  now?: () => number;
}

/**
 * Load the newest account per product.
 *
 * A missing directory yields an empty list rather than an error: an empty
 * register is a valid state, not a fault. A malformed record is skipped rather
 * than guessed at, because describing a product wrongly is worse than saying
 * nothing about it.
 */
export async function loadLatestRecords(options: LoadOptions = {}): Promise<ProductRecord[]> {
  const dir = options.explorationsDir ?? "explorations";
  const windowDays = options.freshnessWindowDays ?? DEFAULT_FRESHNESS_WINDOW_DAYS;
  const now = options.now ?? Date.now;

  let productDirs: string[];
  try {
    productDirs = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  const records: ProductRecord[] = [];

  for (const slug of productDirs) {
    const files = (await readdir(join(dir, slug)).catch(() => []))
      .filter((f) => f.endsWith(".json") && !f.endsWith(".attestation.json"))
      .sort();

    const newest = files.at(-1);
    if (!newest) continue;

    try {
      const latest: ExplorationRecord = JSON.parse(await readFile(join(dir, slug, newest), "utf-8"));
      const finished = Date.parse(latest.finishedAt);
      if (Number.isNaN(finished)) continue;

      const ageDays = (now() - finished) / 86_400_000;
      records.push({ slug, latest, ageDays, stale: ageDays > windowDays });
    } catch {
      continue;
    }
  }

  return records;
}

/** Every account for one product, newest first. */
export async function loadProductHistory(slug: string, options: LoadOptions = {}): Promise<ExplorationRecord[]> {
  const dir = join(options.explorationsDir ?? "explorations", slug);

  const files = (await readdir(dir).catch(() => []))
    .filter((f) => f.endsWith(".json") && !f.endsWith(".attestation.json"))
    .sort()
    .reverse();

  const records: ExplorationRecord[] = [];
  for (const file of files) {
    try {
      const parsed: ExplorationRecord = JSON.parse(await readFile(join(dir, file), "utf-8"));
      if (!Number.isNaN(Date.parse(parsed.finishedAt))) records.push(parsed);
    } catch {
      continue;
    }
  }
  return records;
}

/**
 * How much weight a reader should give this account.
 *
 * An agent that never got past signup is not describing the product, it is
 * describing a door it could not open. Saying so plainly is more useful than a
 * confident summary assembled from a homepage, and it is the difference between
 * this register and the blog posts it exists to replace.
 */
export function readerGuidance(record: ProductRecord): string {
  const { account, evidence } = record.latest;

  if (account.blockedBy) {
    // A wall is not a verdict. Which wall a product puts up is useful information
    // in itself, and confusing it with "the product is bad" would be the single
    // most damaging misreading this register could invite.
    return `${BLOCKER_TEXT[account.blockedBy]} This is not a judgement of the product: nobody here got far enough to make one.`;
  }
  if (!account.couldSignUp) {
    return "The agent could not sign up, so this describes the way in, not the product. Do not treat it as an evaluation.";
  }
  if (!account.couldUseCoreFeature) {
    return "The agent signed up but never used the product's core feature, so this covers onboarding only.";
  }
  if (evidence.email.inboxUnavailable) {
    return "Our own mailbox failed during this session, so anything about email verification here is unreliable.";
  }
  if (record.stale) {
    return "This account is older than the freshness window. Software changes; treat it as historical.";
  }
  if (account.confidence <= 4) {
    return "The agent itself rated this account low confidence. Weigh it accordingly.";
  }
  return "The agent signed up and used the product. Evidence for each step is published alongside.";
}

/** Full rendering of one product's latest account, for an agent to read. */
export function describeRecord(record: ProductRecord, windowDays = DEFAULT_FRESHNESS_WINDOW_DAYS): string {
  const { latest } = record;
  const { account, evidence, agent } = latest;
  const age = Math.round(record.ageDays);
  const lines: string[] = [];

  lines.push(`## ${latest.product.name} (${latest.product.url})`);
  lines.push(`Used by ${agent.model} on ${latest.finishedAt.slice(0, 10)}, ${age} day${age === 1 ? "" : "s"} ago.`);
  lines.push(`How to read this: ${readerGuidance(record)}`);
  lines.push("");

  if (account.blockedBy) {
    lines.push(`### Blocked: ${account.blockedBy}`);
    lines.push(account.blockedDetail ?? "No further detail given.");
    lines.push("");
  }

  lines.push("### What the agent concluded");
  lines.push(`Bottom line: ${account.bottomLine}`);
  lines.push(`What it does: ${account.whatItDoes}`);
  lines.push(`Getting started: ${account.gettingStarted}`);
  if (account.worked.length) lines.push(`Worked: ${account.worked.join("; ")}`);
  if (account.didNotWork.length) lines.push(`Did not work: ${account.didNotWork.join("; ")}`);
  if (account.unverifiedClaims.length) {
    lines.push(`Claimed but not verified by using it: ${account.unverifiedClaims.join("; ")}`);
  }
  lines.push(`Agent's own confidence: ${account.confidence}/10 — ${account.confidenceReason}`);
  lines.push("");

  lines.push("### Evidence (what demonstrably happened, independent of the account above)");
  lines.push(`Signed up: ${account.couldSignUp ? "yes" : "no"}. Used core feature: ${account.couldUseCoreFeature ? "yes" : "no"}.`);
  lines.push(
    evidence.email.inboxUnavailable
      ? `Verification email: could not check, our mailbox failed (${evidence.email.inboxUnavailable}). Not the product's fault.`
      : evidence.email.arrived
        ? `Verification email arrived in ${evidence.email.secondsToArrive}s at an address we control.`
        : "No verification email arrived at the address we control.",
  );
  lines.push(`${evidence.steps.length} actions taken over ${evidence.totalSeconds}s, each with a screenshot.`);
  lines.push(`Replay: seed ${latest.seed} against ${latest.inboxDomain}`);

  if (record.stale) {
    lines.push(`STALE: older than the ${windowDays}-day window.`);
  }

  lines.push(
    latest.provenance?.workflowRunUrl
      ? `CI run: ${latest.provenance.workflowRunUrl}`
      : "NOT INDEPENDENTLY PRODUCED: no CI provenance, so this was generated locally and is not evidence.",
  );

  return lines.join("\n");
}

/** Reply when a product has never been used. */
export function describeMissing(slug: string): string {
  return (
    `No account for "${slug}". No agent has used this product. ` +
    `That says nothing about its quality: only that nobody here has tried it.`
  );
}

/** Reply when nothing at all has been used. */
export function describeEmptyRegister(): string {
  return (
    "No products have been used by an agent yet. " +
    "Do not infer anything from this: an empty register means nothing has been tried, " +
    "not that products are untrustworthy."
  );
}
