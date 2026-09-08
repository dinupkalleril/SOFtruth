#!/usr/bin/env bun
/**
 * Static site generator.
 *
 * Renders agent accounts for humans. The MCP server renders the same records for
 * agents, and both import their reading rules from mcp/registry.ts on purpose: a
 * person and an assistant seeing different answers about the same product would
 * make the register worth nothing.
 *
 * Everything interpolated is escaped. The account is written by an agent that
 * read pages controlled by the product's owner, which makes it untrusted input
 * from the party with the strongest motive to shape what readers see.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_FRESHNESS_WINDOW_DAYS,
  loadLatestRecords,
  loadProductHistory,
  readerGuidance,
  type ProductRecord,
} from "../mcp/registry";
import type { ExplorationRecord } from "../agent/types";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

const OUT_DIR = arg("out", "site/dist");
const EXPLORATIONS_DIR = arg("explorations", "explorations");
const WINDOW_DAYS = Number(arg("window", String(DEFAULT_FRESHNESS_WINDOW_DAYS)));

export function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CSS = `
:root { --fg:#16181d; --muted:#6b7280; --line:#e5e7eb; --bg:#fff; --accent:#0f7b3d; --warn:#8a6d1f; --bad:#b42318; }
@media (prefers-color-scheme: dark) {
  :root { --fg:#e8eaed; --muted:#9aa3af; --line:#2b2f36; --bg:#111317; --accent:#4ade80; --warn:#fbbf24; --bad:#f87171; }
}
* { box-sizing:border-box }
body { margin:0; background:var(--bg); color:var(--fg);
       font:15.5px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
.wrap { max-width:760px; margin:0 auto; padding:44px 20px 90px }
h1 { font-size:23px; margin:0 0 6px; letter-spacing:-0.01em }
h2 { font-size:15px; margin:34px 0 10px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted) }
.sub { color:var(--muted); margin:0 0 30px }
a { color:inherit }
.card { border:1px solid var(--line); border-radius:8px; padding:18px 20px; margin:0 0 14px }
.card h3 { margin:0 0 4px; font-size:17px }
.card .meta { color:var(--muted); font-size:13.5px; margin:0 0 10px }
.bottom { font-size:16px; margin:0 }
.guide { border-left:3px solid var(--line); padding:9px 14px; margin:16px 0; color:var(--muted); font-size:14px }
.guide.warn { border-left-color:var(--warn) }
.guide.bad { border-left-color:var(--bad) }
ul { margin:6px 0 0; padding-left:20px } li { margin:3px 0 }
.evidence { background:color-mix(in srgb, var(--line) 25%, transparent); border-radius:8px; padding:16px 20px; font-size:14px }
.evidence dl { display:grid; grid-template-columns:auto 1fr; gap:5px 16px; margin:0 }
.evidence dt { color:var(--muted) } .evidence dd { margin:0 }
code { font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--muted); word-break:break-all }
.empty { border:1px dashed var(--line); padding:30px; text-align:center; color:var(--muted); border-radius:8px }
footer { margin-top:60px; padding-top:20px; border-top:1px solid var(--line); color:var(--muted); font-size:13px }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style>
</head><body><div class="wrap">${body}
<footer>
An agent signs up for a product, uses it, and writes down what that was like. What it concluded is
published next to the evidence of what it actually did, because a product's own pages can shape a
conclusion but cannot change whether an email arrived.
<br><br>No product has paid for an account here.
</footer>
</div></body></html>`;
}

function guidanceClass(record: ProductRecord): string {
  if (!record.latest.account.couldSignUp) return "guide bad";
  if (!record.latest.account.couldUseCoreFeature || record.stale || record.latest.account.confidence <= 4) {
    return "guide warn";
  }
  return "guide";
}

function renderIndex(records: ProductRecord[]): string {
  if (records.length === 0) {
    return page(
      "SOFtruth",
      `<h1>SOFtruth</h1>
      <p class="sub">An AI agent signs up for a product, uses it, and writes down what happened.</p>
      <div class="empty"><p><strong>No products have been used yet.</strong></p>
      <p>An empty register means nothing has been tried. It does not mean products are untrustworthy,
      and nothing should be inferred from a product's absence.</p></div>`,
    );
  }

  const cards = records
    .map((r) => {
      const a = r.latest.account;
      const age = Math.round(r.ageDays);
      return `<div class="card">
        <h3><a href="./${esc(r.slug)}.html">${esc(r.latest.product.name)}</a></h3>
        <p class="meta">Used by ${esc(r.latest.agent.model)} · ${esc(r.latest.finishedAt.slice(0, 10))}
           · ${age}d ago${r.stale ? " · stale" : ""} · agent's confidence ${esc(a.confidence)}/10</p>
        <p class="bottom">${esc(a.bottomLine)}</p>
        <div class="${guidanceClass(r)}">${esc(readerGuidance(r))}</div>
      </div>`;
    })
    .join("");

  return page(
    "SOFtruth",
    `<h1>SOFtruth</h1>
    <p class="sub">An AI agent signs up for a product, uses it, and writes down what happened.</p>
    ${cards}`,
  );
}

function renderAccount(record: ProductRecord, history: ExplorationRecord[]): string {
  const { latest } = record;
  const { account, evidence, agent } = latest;

  const list = (items: string[]) => (items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : "<p>None recorded.</p>");

  const email = evidence.email.inboxUnavailable
    ? `Could not check — our own mailbox failed (${esc(evidence.email.inboxUnavailable)}). Not the product's fault.`
    : evidence.email.arrived
      ? `Arrived in ${esc(evidence.email.secondsToArrive)}s at an address we control`
      : "Never arrived at the address we control";

  const older = history.slice(1);

  return page(
    `${latest.product.name} — SOFtruth`,
    `<p class="sub"><a href="./index.html">← all products</a></p>
    <h1>${esc(latest.product.name)}</h1>
    <p class="sub"><a href="${esc(latest.product.url)}">${esc(latest.product.url)}</a> · used by
       ${esc(agent.model)} on ${esc(latest.finishedAt.slice(0, 10))}</p>

    <div class="${guidanceClass(record)}">${esc(readerGuidance(record))}</div>

    <h2>What the agent concluded</h2>
    <p class="bottom"><strong>${esc(account.bottomLine)}</strong></p>
    <p>${esc(account.whatItDoes)}</p>
    <h2>Getting started</h2>
    <p>${esc(account.gettingStarted)}</p>
    <h2>Worked</h2>${list(account.worked)}
    <h2>Did not work</h2>${list(account.didNotWork)}
    <h2>Claimed, but not verified by using it</h2>${list(account.unverifiedClaims)}
    <p class="meta">The agent rated its own account ${esc(account.confidence)}/10:
       ${esc(account.confidenceReason)}</p>

    <h2>Evidence</h2>
    <div class="evidence">
      <p style="margin-top:0">What demonstrably happened, independent of anything the agent concluded above.
      A product's pages can shape a conclusion; they cannot change whether an email arrived.</p>
      <dl>
        <dt>Signed up</dt><dd>${account.couldSignUp ? "yes" : "no"}</dd>
        <dt>Used core feature</dt><dd>${account.couldUseCoreFeature ? "yes" : "no"}</dd>
        <dt>Verification email</dt><dd>${email}</dd>
        <dt>Actions taken</dt><dd>${esc(evidence.steps.length)}, each with a screenshot</dd>
        <dt>Session length</dt><dd>${esc(evidence.totalSeconds)}s</dd>
        <dt>Replay</dt><dd><code>${esc(latest.seed)}</code> against <code>${esc(latest.inboxDomain)}</code></dd>
        <dt>Produced by</dt><dd>${
          latest.provenance?.workflowRunUrl
            ? `<a href="${esc(latest.provenance.workflowRunUrl)}">this CI run</a>`
            : "<strong>a local run — no CI provenance, so this is not evidence</strong>"
        }</dd>
      </dl>
    </div>

    <h2>Earlier sessions</h2>
    ${
      older.length === 0
        ? '<p class="sub">This is the first time an agent has used this product.</p>'
        : `<ul>${older
            .map(
              (h) =>
                `<li>${esc(h.finishedAt.slice(0, 10))} — ${esc(h.account.bottomLine)}</li>`,
            )
            .join("")}</ul>
          <p class="meta">Earlier accounts are never removed or edited. A later session appends.</p>`
    }`,
  );
}

async function main(): Promise<void> {
  const records = await loadLatestRecords({
    explorationsDir: EXPLORATIONS_DIR,
    freshnessWindowDays: WINDOW_DAYS,
  });

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, "index.html"), renderIndex(records), "utf-8");

  for (const record of records) {
    const history = await loadProductHistory(record.slug, { explorationsDir: EXPLORATIONS_DIR });
    if (history.length === 0) continue;
    await writeFile(join(OUT_DIR, `${record.slug}.html`), renderAccount(record, history), "utf-8");
  }

  await writeFile(join(OUT_DIR, ".nojekyll"), "", "utf-8");
  console.log(`built ${OUT_DIR}: index + ${records.length} product page(s)`);
}

if (import.meta.main) await main();

export { renderIndex, renderAccount };
