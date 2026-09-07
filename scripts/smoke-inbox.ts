#!/usr/bin/env bun
/**
 * End-to-end smoke test of the mail chain.
 *
 *   bun run scripts/smoke-inbox.ts
 *
 * Sends one message through Resend to a seeded probe address, then uses the real
 * ResendInbox adapter to wait for it. Exercises the whole path in one go:
 * sending, DKIM/DMARC, MX routing to Resend inbound, the receiving list API, and
 * the adapter's matching logic.
 *
 * Deliberately separate from the suite. This tests OUR infrastructure. The suite
 * tests a provider, and conflating the two would let our own broken setup show up
 * as somebody's product failing.
 */

import { ResendInbox } from "../suite/inbox-resend";
import { generateCase, resolveInboxDomain } from "../suite/seed";

const apiKey = process.env.RESEND_API_KEY;
const from = process.env.RESEND_FROM;

if (!apiKey || !from) {
  console.error("need RESEND_API_KEY and RESEND_FROM (load .env, or run with `bun --env-file=.env`)");
  process.exit(2);
}

const seed = `smoke-${Date.now()}`;
const testCase = generateCase(seed, 0, resolveInboxDomain());
const waitSeconds = Number(process.env.SMOKE_WAIT_SECONDS ?? 180);

console.log("SOFtruth inbox smoke test");
console.log(`  from : ${from}`);
console.log(`  to   : ${testCase.to}`);
console.log(`  nonce: ${testCase.nonce}`);
console.log(`  wait : up to ${waitSeconds}s\n`);

const sendStarted = Date.now();
const response = await fetch("https://api.resend.com/emails", {
  method: "POST",
  headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
  body: JSON.stringify({ from, to: testCase.to, subject: testCase.subject, text: testCase.text }),
});

const body = await response.text();
if (!response.ok) {
  console.error(`SEND FAILED (${response.status}): ${body.slice(0, 400)}`);
  console.error("\nCommon causes: domain not verified in Resend, or `from` is not on a verified domain.");
  process.exit(1);
}

console.log(`sent in ${Date.now() - sendStarted}ms: ${body.slice(0, 120)}\n`);
console.log("waiting for it to come back through inbox.softruth.com ...");

const inbox = new ResendInbox(apiKey);
const result = await inbox.awaitMessage(testCase.to, testCase.nonce, waitSeconds * 1000);

console.log();
switch (result.outcome) {
  case "received":
    console.log(`RECEIVED after ${((result.receivedAt.getTime() - sendStarted) / 1000).toFixed(1)}s`);
    console.log(`  matched in : ${result.matchedIn}`);
    console.log(`  subject    : ${result.subject}`);
    console.log("\nThe whole chain works: send, DNS, inbound routing, list API, adapter matching.");
    break;
  case "not-received":
    console.log(`NOT RECEIVED within ${waitSeconds}s.`);
    console.log("  The send succeeded, so this is a receiving problem: MX routing, Resend inbound");
    console.log("  configuration, or DMARC quarantining the message before it lands.");
    process.exit(1);
  case "unavailable":
    console.log(`INBOX UNAVAILABLE: ${result.error}`);
    console.log("  We could not ask, so this says nothing about whether the message arrived.");
    process.exit(1);
}
