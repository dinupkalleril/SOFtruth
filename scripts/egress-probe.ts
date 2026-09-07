/**
 * T1 — Runner egress probe.
 *
 * Question this answers: can a GitHub-hosted runner actually reach vendor APIs,
 * or do shared/rotating runner IPs get blocked by WAFs, bot detection, or
 * IP allowlists? If they get blocked, every test looks like a permanent
 * INCONCLUSIVE and the whole API-first architecture has to change.
 *
 * Method: one unauthenticated request per vendor. We are NOT trying to do
 * anything — we only need to know whether the request reaches their
 * application at all.
 *
 *   REACHABLE  → their API answered us, even with 401/403/422. The request
 *                got through the edge and into the app. This is the good case.
 *   BLOCKED    → a WAF/CDN interstitial, a connection reset, or a timeout.
 *                Nothing reached the app.
 *   AMBIGUOUS  → answered, but we cannot tell app from edge. Needs eyes.
 *
 *          request
 *             │
 *             ├── network error / timeout ─────────────▶ BLOCKED
 *             │
 *             └── HTTP response
 *                    ├── body looks like a WAF interstitial ──▶ BLOCKED
 *                    ├── body looks like an API error ────────▶ REACHABLE
 *                    └── neither ────────────────────────────▶ AMBIGUOUS
 */

const TIMEOUT_MS = 10_000;

interface Target {
  vendor: string;
  url: string;
  method: "GET" | "POST";
}

/**
 * Endpoints chosen so an unauthenticated request produces a normal API error
 * rather than doing anything. No credentials, no side effects, one request each.
 */
const TARGETS: Target[] = [
  { vendor: "postmark", url: "https://api.postmarkapp.com/email", method: "POST" },
  { vendor: "sendgrid", url: "https://api.sendgrid.com/v3/mail/send", method: "POST" },
  { vendor: "resend", url: "https://api.resend.com/emails", method: "POST" },
  { vendor: "mailgun", url: "https://api.mailgun.net/v3/domains", method: "GET" },
  { vendor: "brevo", url: "https://api.brevo.com/v3/smtp/email", method: "POST" },
];

type Verdict = "REACHABLE" | "BLOCKED" | "AMBIGUOUS";

interface ProbeResult {
  vendor: string;
  url: string;
  verdict: Verdict;
  status: number | null;
  server: string | null;
  elapsedMs: number;
  evidence: string;
}

/**
 * Signatures of an edge/WAF rejecting us before the app ever saw the request.
 * Matched against a lowercased body prefix.
 */
const WAF_SIGNATURES = [
  "attention required",
  "cloudflare",
  "access denied",
  "request blocked",
  "you have been blocked",
  "akamai",
  "<!doctype html",
  "<html",
];

/** An API error body means we got through the edge and into the application. */
const API_SIGNATURES = [
  '"message"',
  '"error"',
  '"errors"',
  '"errorcode"',
  '"code"',
  '"statuscode"',
  '"detail"',
];

/**
 * Statuses that only an application produces. These are semantic or
 * content-negotiation answers: an edge proxy blocking an unknown client
 * returns 403 or a challenge page, never "unsupported media type".
 * 403 and 429 are deliberately NOT here — a WAF returns both.
 */
const APP_LEVEL_STATUSES = new Set([400, 401, 405, 406, 415, 422]);

function classify(status: number, bodyPrefix: string): { verdict: Verdict; evidence: string } {
  const body = bodyPrefix.toLowerCase();

  // Order matters: an HTML interstitial can also contain the word "error",
  // so WAF signatures are checked first.
  const waf = WAF_SIGNATURES.find((sig) => body.includes(sig));
  if (waf) {
    return { verdict: "BLOCKED", evidence: `edge/WAF signature in body: ${JSON.stringify(waf)}` };
  }

  const api = API_SIGNATURES.find((sig) => body.includes(sig));
  if (api) {
    return { verdict: "REACHABLE", evidence: `API-shaped error body (matched ${JSON.stringify(api)})` };
  }

  // No API-shaped body, but the status itself is one only an app emits.
  // The WAF check above already ruled out an HTML interstitial.
  if (APP_LEVEL_STATUSES.has(status)) {
    return {
      verdict: "REACHABLE",
      evidence: `status ${status} is app-level (semantic/content-negotiation), non-HTML body`,
    };
  }

  // 403 or 429 with an empty body could be either the app or the edge.
  // We cannot prove it, so we do not claim it.
  return {
    verdict: "AMBIGUOUS",
    evidence: `status ${status}, body matched neither WAF nor API signatures`,
  };
}

async function probe(target: Target): Promise<ProbeResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(target.url, {
      method: target.method,
      signal: controller.signal,
      headers: { "User-Agent": "SOFtruth-egress-probe/1.0 (+https://github.com/softruth)" },
      // Deliberately no auth and no body. We want their "you are not
      // authorized" answer, which proves reachability and nothing else.
    });

    const bodyPrefix = (await response.text().catch(() => "")).slice(0, 600);
    const { verdict, evidence } = classify(response.status, bodyPrefix);

    return {
      vendor: target.vendor,
      url: target.url,
      verdict,
      status: response.status,
      server: response.headers.get("server"),
      elapsedMs: Date.now() - started,
      evidence,
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : "UnknownError";
    const message = error instanceof Error ? error.message : String(error);
    const timedOut = name === "AbortError" || name === "TimeoutError";

    return {
      vendor: target.vendor,
      url: target.url,
      verdict: "BLOCKED",
      status: null,
      server: null,
      elapsedMs: Date.now() - started,
      evidence: timedOut ? `no response within ${TIMEOUT_MS}ms` : `${name}: ${message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const runner = process.env.GITHUB_ACTIONS === "true" ? "github-hosted runner" : "local machine";
  console.log(`SOFtruth egress probe — running on ${runner}\n`);

  // Sequential on purpose: five requests is nothing, and serial output is
  // easier to read when a human is judging AMBIGUOUS rows.
  const results: ProbeResult[] = [];
  for (const target of TARGETS) {
    results.push(await probe(target));
  }

  for (const r of results) {
    const status = r.status === null ? "—" : String(r.status);
    console.log(
      `${r.verdict.padEnd(10)} ${r.vendor.padEnd(10)} ${status.padEnd(4)} ${String(r.elapsedMs).padStart(6)}ms  ${r.evidence}`,
    );
  }

  const blocked = results.filter((r) => r.verdict === "BLOCKED");
  const ambiguous = results.filter((r) => r.verdict === "AMBIGUOUS");

  console.log(
    `\nreachable=${results.length - blocked.length - ambiguous.length} ` +
      `blocked=${blocked.length} ambiguous=${ambiguous.length} of ${results.length}`,
  );

  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = results
      .map((r) => `| ${r.vendor} | ${r.verdict} | ${r.status ?? "—"} | ${r.elapsedMs}ms | ${r.evidence} |`)
      .join("\n");
    await Bun.write(
      process.env.GITHUB_STEP_SUMMARY,
      `## Egress probe (${runner})\n\n` +
        `| Vendor | Verdict | Status | Elapsed | Evidence |\n|---|---|---|---|---|\n${rows}\n`,
    );
  }

  // Never fail the build. This probe reports a fact; it does not gate anything.
  // A BLOCKED result is the finding, not an error.
  if (blocked.length > 0) {
    console.log(
      `\nFINDING: ${blocked.length} vendor(s) unreachable from this runner. ` +
        `API-first testing cannot cover them without a static-IP egress path.`,
    );
  }
}

main();
