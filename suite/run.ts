#!/usr/bin/env bun
/**
 * Run the canonical suite against one vendor and write a result record.
 *
 *   bun run suite/run.ts --vendor <slug>
 *
 * The vendor's base URL is committed in vendors/<slug>.json. The bearer token
 * never is: it comes from SOFTRUTH_TOKEN_<SLUG> in the environment, so a token
 * cannot end up in git history, which is public and permanent.
 *
 * This writes a file. It does not publish anything. Publishing is a pull request
 * that a human merges, which is where the review gate on FAIL lives.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runAllAssertions } from "./assertions";
import { collapseAttempts, requiresHumanReview, summarize } from "./classify";
import { MemoryInbox, UnconfiguredInbox, type Inbox } from "./inbox";
import { ResendInbox } from "./inbox-resend";
import { generateBounceAddress, generateCase, newSeed, resolveBounceDomain, resolveInboxDomain } from "./seed";
import type { AttemptResult, RunRecord, VendorTarget } from "./types";

const SPEC_VERSION = "transactional-email/v1";
const RUNS_PER_ASSERTION = 3;

interface VendorConfig {
  vendor: string;
  baseUrl: string;
  /** Optional per-vendor overrides of the spec's default windows. */
  deliveryWindowSeconds?: number;
  bounceWindowSeconds?: number;
}

function parseArgs(argv: string[]): { vendor: string; dryRun: boolean } {
  const vendorIndex = argv.indexOf("--vendor");
  if (vendorIndex === -1 || !argv[vendorIndex + 1]) {
    console.error("usage: bun run suite/run.ts --vendor <slug> [--dry-run]");
    process.exit(2);
  }
  return { vendor: argv[vendorIndex + 1], dryRun: argv.includes("--dry-run") };
}

async function loadVendor(slug: string): Promise<VendorTarget & { config: VendorConfig }> {
  const path = join("vendors", `${slug}.json`);
  let config: VendorConfig;
  try {
    config = JSON.parse(await readFile(path, "utf-8"));
  } catch (error) {
    console.error(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }

  const envKey = `SOFTRUTH_TOKEN_${slug.toUpperCase().replace(/-/g, "_")}`;
  const token = process.env[envKey];
  if (!token) {
    console.error(`missing ${envKey}. The token is never committed; set it in the environment.`);
    process.exit(2);
  }

  return { vendor: config.vendor, baseUrl: config.baseUrl, token, config };
}

/**
 * Choose the inbox.
 *
 * Order matters. The explicit memory override comes first so a local smoke run
 * cannot accidentally hit the real API, and the unconfigured fallback comes last
 * so a missing key degrades to INCONCLUSIVE rather than to a failure. An
 * assertion we cannot run must look unrunnable, never failed.
 */
function selectInbox(): Inbox {
  if (process.env.SOFTRUTH_INBOX === "memory") {
    // Local smoke runs only. Never produces a publishable record: nothing
    // actually sends mail, so a PASS here would be meaningless.
    return new MemoryInbox();
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) return new ResendInbox(resendKey);

  return new UnconfiguredInbox();
}

async function main(): Promise<void> {
  const { vendor: slug, dryRun } = parseArgs(process.argv.slice(2));
  const target = await loadVendor(slug);
  const inbox = selectInbox();
  const seed = newSeed();
  const inboxDomain = resolveInboxDomain();
  const bounceDomain = resolveBounceDomain();
  const startedAt = new Date().toISOString();

  console.log(`SOFtruth ${SPEC_VERSION}`);
  console.log(`vendor: ${target.vendor}  seed: ${seed}  inbox: ${inbox.kind}`);
  console.log(`inbox domain: ${inboxDomain}  bounce domain: ${bounceDomain}`);
  console.log(`runs per assertion: ${RUNS_PER_ASSERTION}\n`);

  if (inbox.kind === "unconfigured") {
    console.log("NOTE: no inbox service configured — delivery assertions will be INCONCLUSIVE.\n");
  }

  // Every run uses a different case index, so a provider cannot learn one set of
  // inputs across the three attempts.
  const attemptsByAssertion = new Map<string, AttemptResult[]>();

  for (let run = 0; run < RUNS_PER_ASSERTION; run++) {
    const results = await runAllAssertions({
      target,
      testCase: generateCase(seed, run, inboxDomain),
      inbox,
      bounceAddress: generateBounceAddress(seed, run, bounceDomain),
      deliveryWindowMs: (target.config.deliveryWindowSeconds ?? 300) * 1000,
      bounceWindowMs: (target.config.bounceWindowSeconds ?? 600) * 1000,
    });

    for (const result of results) {
      const existing = attemptsByAssertion.get(result.assertionId) ?? [];
      existing.push(result);
      attemptsByAssertion.set(result.assertionId, existing);
      console.log(`  run ${run + 1}  ${result.verdict.padEnd(12)} ${result.assertionId.padEnd(24)} ${result.detail}`);
    }
  }

  const assertions = [...attemptsByAssertion.entries()].map(([id, attempts]) => collapseAttempts(id, attempts));

  const record: RunRecord = {
    schemaVersion: "softruth/run/v1",
    specVersion: SPEC_VERSION,
    vendor: target.vendor,
    seed,
    inboxDomain,
    bounceDomain,
    startedAt,
    finishedAt: new Date().toISOString(),
    runsPerAssertion: RUNS_PER_ASSERTION,
    assertions,
    // provenance is filled in by CI. Its absence is how a reader knows a record
    // was produced locally and is therefore not evidence of anything.
    ...(process.env.GITHUB_RUN_ID
      ? {
          provenance: {
            workflowRunUrl: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
            commit: process.env.GITHUB_SHA ?? "unknown",
            // Filled by the attest step, which runs after this file exists.
            artifactDigest: "",
          },
        }
      : {}),
  };

  console.log(`\n${summarize(assertions)}`);
  for (const a of assertions) {
    console.log(`  ${a.verdict.padEnd(12)} ${a.assertionId.padEnd(24)} ${a.passed}/${a.total}`);
  }

  if (requiresHumanReview(assertions)) {
    console.log("\nHUMAN REVIEW REQUIRED: this run contains a FAIL and must not publish unreviewed.");
  }

  if (dryRun) {
    console.log("\n--dry-run: no file written");
    return;
  }

  const dir = join("results", slug);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${startedAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
  console.log(`\nwrote ${path}`);

  if (process.env.GITHUB_OUTPUT) {
    await writeFile(
      process.env.GITHUB_OUTPUT,
      [
        `result_path=${path}`,
        `needs_review=${requiresHumanReview(assertions)}`,
        `summary=${summarize(assertions)}`,
        `seed=${seed}`,
      ].join("\n") + "\n",
      { flag: "a" },
    );
  }
}

main();
