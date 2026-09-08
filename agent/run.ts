#!/usr/bin/env bun
/**
 * Send an agent to use a product, and record what happened.
 *
 *   bun run agent/run.ts --product <slug>
 *
 * Reads products/<slug>.json for a name and a URL. That is the entire vendor
 * onboarding: a URL and permission. No adapter, no endpoints to implement, no
 * conformance interface. The agent goes to the front door like anyone else.
 *
 * Writes an exploration record containing two clearly separated layers: the
 * evidence of what the agent did and what came back, and the account the agent
 * wrote afterwards for other agents to read.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BrowserSession } from "./browser";
import { explore } from "./explore";
import { selectBrain } from "./llm";
import type { ExplorationRecord } from "./types";
import { MemoryInbox, UnconfiguredInbox, type Inbox } from "../suite/inbox";
import { ResendInbox } from "../suite/inbox-resend";
import { generateIdentity, newSeed, resolveInboxDomain } from "../suite/seed";

interface ProductConfig {
  slug: string;
  name: string;
  url: string;
}

function parseArgs(argv: string[]): { product: string } {
  const i = argv.indexOf("--product");
  if (i === -1 || !argv[i + 1]) {
    console.error("usage: bun run agent/run.ts --product <slug>");
    process.exit(2);
  }
  return { product: argv[i + 1] };
}

async function loadProduct(slug: string): Promise<ProductConfig> {
  try {
    return JSON.parse(await readFile(join("products", `${slug}.json`), "utf-8"));
  } catch (error) {
    console.error(`cannot read products/${slug}.json: ${error instanceof Error ? error.message : error}`);
    process.exit(2);
  }
}

/**
 * The inbox is not optional here the way it was for the old checklist. An agent
 * that cannot receive a verification email usually cannot finish signing up, so
 * running without one produces a session that fails for our reasons and says
 * nothing about the product.
 */
function selectInbox(): Inbox {
  if (process.env.SOFTRUTH_INBOX === "memory") return new MemoryInbox();
  const key = process.env.RESEND_API_KEY;
  return key ? new ResendInbox(key) : new UnconfiguredInbox();
}

async function main(): Promise<void> {
  const { product: slug } = parseArgs(process.argv.slice(2));
  const product = await loadProduct(slug);

  const seed = newSeed();
  const inboxDomain = resolveInboxDomain();
  const identity = generateIdentity(seed, inboxDomain);
  const inbox = selectInbox();
  const brain = selectBrain();
  const startedAt = new Date().toISOString();

  const sessionDir = join("sessions", slug, startedAt.replace(/[:.]/g, "-"));

  console.log(`SOFtruth agent — ${brain.model}`);
  console.log(`  product : ${product.name} (${product.url})`);
  console.log(`  identity: ${identity.email}`);
  console.log(`  seed    : ${seed}`);
  console.log(`  inbox   : ${inbox.kind}\n`);

  if (inbox.kind === "unconfigured") {
    console.log("WARNING: no inbox configured. The agent cannot receive a verification email,");
    console.log("so a failure to sign up will be our fault rather than the product's.\n");
  }

  const browser = new BrowserSession({ sessionDir, headless: process.env.SOFTRUTH_HEADED !== "1" });
  await browser.start();

  const started = Date.now();
  let result;
  try {
    result = await explore({
      productName: product.name,
      productUrl: product.url,
      identity,
      browser,
      inbox,
      brain,
    });
  } finally {
    await browser.stop();
  }

  const record: ExplorationRecord = {
    schemaVersion: "softruth/exploration/v1",
    product: { slug: product.slug, name: product.name, url: product.url },
    seed,
    inboxDomain,
    startedAt,
    finishedAt: new Date().toISOString(),
    evidence: {
      steps: browser.getSteps(),
      email: result.email,
      totalSeconds: Math.round((Date.now() - started) / 10) / 100,
    },
    account: result.account,
    agent: { model: brain.model, readPageContent: true },
    // Absent on a local run, which is how a reader knows it is not evidence.
    ...(process.env.GITHUB_RUN_ID
      ? {
          provenance: {
            workflowRunUrl: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
            commit: process.env.GITHUB_SHA ?? "unknown",
            artifactDigest: "",
          },
        }
      : {}),
  };

  await mkdir(sessionDir, { recursive: true });
  const path = join(sessionDir, "exploration.json");
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf-8");

  console.log(`\n─── what the agent found ${"─".repeat(40)}`);
  console.log(`  signed up          : ${record.account.couldSignUp ? "yes" : "no"}`);
  console.log(`  used core feature  : ${record.account.couldUseCoreFeature ? "yes" : "no"}`);
  console.log(`  verification email : ${record.evidence.email.arrived ? `arrived in ${record.evidence.email.secondsToArrive}s` : "did not arrive"}`);
  console.log(`  steps taken        : ${record.evidence.steps.length}`);
  console.log(`  confidence         : ${record.account.confidence}/10 — ${record.account.confidenceReason}`);
  console.log(`\n  ${record.account.bottomLine}\n`);
  console.log(`wrote ${path}`);

  if (process.env.GITHUB_OUTPUT) {
    await writeFile(
      process.env.GITHUB_OUTPUT,
      [
        `record_path=${path}`,
        `session_dir=${sessionDir}`,
        `signed_up=${record.account.couldSignUp}`,
        `confidence=${record.account.confidence}`,
        `seed=${seed}`,
      ].join("\n") + "\n",
      { flag: "a" },
    );
  }
}

main();
