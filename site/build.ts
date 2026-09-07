#!/usr/bin/env bun
/**
 * Static site generator.
 *
 *   bun run site/build.ts [--out site/dist] [--results results]
 *
 * Renders the record for humans. The MCP server renders the same record for
 * agents. Both import their verdict logic from mcp/registry.ts on purpose: if a
 * human and an assistant could see different answers about the same product,
 * the record would be worth nothing.
 *
 * Everything interpolated is HTML-escaped. Assertion detail strings can contain
 * text a provider returned to us, which makes them untrusted input arriving from
 * the party with the strongest motive to manipulate what readers see.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_FRESHNESS_WINDOW_DAYS,
  loadLatestRecords,
  loadVendorHistory,
  reportedVerdict,
  type VendorRecord,
} from "../mcp/registry";
import type { AssertionResult, RunRecord } from "../suite/types";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const OUT_DIR = arg("out", "site/dist");
const RESULTS_DIR = arg("results", "results");
const WINDOW_DAYS = Number(arg("window", String(DEFAULT_FRESHNESS_WINDOW_DAYS)));

/** Escape for HTML text and attribute contexts. */
export function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CSS = `
:root { --fg:#16181d; --muted:#6b7280; --line:#e5e7eb; --bg:#fff;
        --pass:#0f7b3d; --fail:#b42318; --unknown:#8a6d1f; --inconclusive:#4b5563; }
@media (prefers-color-scheme: dark) {
  :root { --fg:#e8eaed; --muted:#9aa3af; --line:#2b2f36; --bg:#111317;
          --pass:#4ade80; --fail:#f87171; --unknown:#fbbf24; --inconclusive:#9aa3af; }
}
* { box-sizing:border-box }
body { margin:0; background:var(--bg); color:var(--fg);
       font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
.wrap { max-width:860px; margin:0 auto; padding:40px 20px 80px }
h1 { font-size:22px; margin:0 0 4px; letter-spacing:-0.01em }
h2 { font-size:16px; margin:36px 0 10px }
.sub { color:var(--muted); margin:0 0 28px }
a { color:inherit }
table { width:100%; border-collapse:collapse; font-size:14px }
th, td { text-align:left; padding:9px 10px; border-bottom:1px solid var(--line); vertical-align:top }
th { font-weight:600; color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em }
.scroll { overflow-x:auto }
.v { font-weight:600; white-space:nowrap }
.PASS { color:var(--pass) } .FAIL { color:var(--fail) }
.UNKNOWN { color:var(--unknown) } .INCONCLUSIVE { color:var(--inconclusive) }
.ratio { color:var(--muted); font-variant-numeric:tabular-nums }
.note { border-left:3px solid var(--line); padding:10px 14px; margin:18px 0; color:var(--muted); font-size:14px }
.warn { border-left-color:var(--unknown) }
.empty { border:1px dashed var(--line); padding:28px; text-align:center; color:var(--muted); border-radius:6px }
code { font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--muted); word-break:break-all }
footer { margin-top:56px; padding-top:18px; border-top:1px solid var(--line); color:var(--muted); font-size:13px }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style>
</head><body><div class="wrap">${body}
<footer>
SOFtruth publishes what was observed, not what was claimed. Every verdict is computed by code from a
run anyone can replay using its published seed. Records are never deleted; corrections are appended.
<br><br>Pre-validation. Nothing here has been sold and no provider has paid for a result.
</footer>
</div></body></html>`;
}

function verdictCell(assertion: AssertionResult, stale: boolean): string {
  const verdict = reportedVerdict(assertion, stale);
  return `<span class="v ${esc(verdict)}">${esc(verdict)}</span> <span class="ratio">${assertion.passed}/${assertion.total}</span>`;
}

function measurementText(assertion: AssertionResult): string {
  if (!assertion.measurements) return "";
  return Object.entries(assertion.measurements)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
}

/** Warning shown when a record has no CI provenance, i.e. it is not evidence. */
function provenanceNote(record: RunRecord): string {
  if (record.provenance?.workflowRunUrl) {
    return `<p class="note">Produced by <a href="${esc(record.provenance.workflowRunUrl)}">this CI run</a>.
      Seed <code>${esc(record.seed)}</code> replays the exact inputs.</p>`;
  }
  return `<p class="note warn"><strong>Not independently produced.</strong> This record has no CI
    provenance, so it was generated locally and is not evidence. Treat it as unverified.</p>`;
}

function renderIndex(records: VendorRecord[]): string {
  if (records.length === 0) {
    return page(
      "SOFtruth",
      `<h1>SOFtruth</h1>
      <p class="sub">Independent, repeatable, attested tests of SaaS products.</p>
      <div class="empty"><p><strong>No products have been tested yet.</strong></p>
      <p>An empty registry means nothing has been tested. It does not mean products are
      untrustworthy, and nothing should be inferred from a product's absence.</p></div>`,
    );
  }

  const assertionIds = [...new Set(records.flatMap((r) => r.latest.assertions.map((a) => a.assertionId)))];

  const header = assertionIds.map((id) => `<th>${esc(id)}</th>`).join("");
  const rows = records
    .map((record) => {
      const cells = assertionIds
        .map((id) => {
          const assertion = record.latest.assertions.find((a) => a.assertionId === id);
          return `<td>${assertion ? verdictCell(assertion, record.stale) : '<span class="ratio">not run</span>'}</td>`;
        })
        .join("");
      const age = Math.round(record.ageDays);
      return `<tr>
        <td><a href="./${esc(record.vendor)}.html"><strong>${esc(record.vendor)}</strong></a><br>
            <span class="ratio">${esc(record.latest.finishedAt.slice(0, 10))} · ${age}d ago${record.stale ? " · stale" : ""}</span></td>
        ${cells}
      </tr>`;
    })
    .join("");

  const anyStale = records.some((r) => r.stale);

  return page(
    "SOFtruth",
    `<h1>SOFtruth</h1>
    <p class="sub">Independent, repeatable, attested tests of SaaS products. Every result is three runs.</p>
    <div class="scroll"><table>
      <thead><tr><th>Product</th>${header}</tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    ${
      anyStale
        ? `<p class="note warn">A record older than ${WINDOW_DAYS} days is marked stale, and its passing
           results are shown as UNKNOWN. Nothing has re-verified them, so they are no longer a claim.</p>`
        : ""
    }
    <p class="note">Ratios show how many of three runs passed. 2/3 and 3/3 are different products, so
    the number is published rather than rounded to a verdict.</p>`,
  );
}

function renderVendor(vendor: string, history: RunRecord[], stale: boolean): string {
  const [latest, ...older] = history;

  const current = latest.assertions
    .map(
      (a) => `<tr>
        <td>${esc(a.assertionId)}</td>
        <td>${verdictCell(a, stale)}</td>
        <td class="ratio">${esc(measurementText(a))}</td>
      </tr>`,
    )
    .join("");

  const timeline = older
    .map((record) => {
      const summary = record.assertions
        .map((a) => `${esc(a.assertionId)} <span class="v ${esc(a.verdict)}">${esc(a.verdict)}</span> ${a.passed}/${a.total}`)
        .join(" · ");
      return `<tr>
        <td>${esc(record.finishedAt.slice(0, 10))}</td>
        <td>${summary}</td>
        <td>${
          record.provenance?.workflowRunUrl
            ? `<a href="${esc(record.provenance.workflowRunUrl)}">run</a>`
            : '<span class="ratio">local</span>'
        }</td>
      </tr>`;
    })
    .join("");

  return page(
    `${vendor} — SOFtruth`,
    `<p class="sub"><a href="./index.html">← all products</a></p>
    <h1>${esc(vendor)}</h1>
    <p class="sub">Spec ${esc(latest.specVersion)} · last verified ${esc(latest.finishedAt.slice(0, 10))}${stale ? " · stale" : ""}</p>
    ${provenanceNote(latest)}
    <div class="scroll"><table>
      <thead><tr><th>Assertion</th><th>Result</th><th>Measured</th></tr></thead>
      <tbody>${current}</tbody>
    </table></div>
    <h2>History</h2>
    ${
      older.length === 0
        ? '<p class="sub">This is the only run so far.</p>'
        : `<div class="scroll"><table>
            <thead><tr><th>Date</th><th>Result</th><th>Evidence</th></tr></thead>
            <tbody>${timeline}</tbody>
          </table></div>
          <p class="note">Earlier results are never removed or amended. A correction appends a new
          record; it does not edit an old one.</p>`
    }`,
  );
}

async function main(): Promise<void> {
  const records = await loadLatestRecords({ resultsDir: RESULTS_DIR, freshnessWindowDays: WINDOW_DAYS });

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, "index.html"), renderIndex(records), "utf-8");

  for (const record of records) {
    const history = await loadVendorHistory(record.vendor, { resultsDir: RESULTS_DIR });
    if (history.length === 0) continue;
    await writeFile(join(OUT_DIR, `${record.vendor}.html`), renderVendor(record.vendor, history, record.stale), "utf-8");
  }

  // GitHub Pages runs Jekyll by default, which ignores files it does not like.
  await writeFile(join(OUT_DIR, ".nojekyll"), "", "utf-8");

  console.log(`built ${OUT_DIR}: index + ${records.length} product page(s)`);
}

if (import.meta.main) await main();

export { renderIndex, renderVendor };
