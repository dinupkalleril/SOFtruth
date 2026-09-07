import { describe, expect, test } from "bun:test";
import { esc, renderIndex, renderVendor } from "./build";
import { reportedVerdict } from "../mcp/registry";
import type { AssertionResult, RunRecord } from "../suite/types";
import type { VendorRecord } from "../mcp/registry";

function assertion(
  id: string,
  verdict: AssertionResult["verdict"],
  passed = 3,
  detail?: Record<string, number>,
): AssertionResult {
  return { assertionId: id, verdict, passed, total: 3, attempts: [], measurements: detail };
}

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schemaVersion: "softruth/run/v1",
    specVersion: "transactional-email/v1",
    vendor: "acme",
    seed: "deadbeef",
    inboxDomain: "inbox.example.com",
    bounceDomain: "bounce.inbox.example.com",
    startedAt: "2026-09-01T00:00:00.000Z",
    finishedAt: "2026-09-01T00:05:00.000Z",
    runsPerAssertion: 3,
    assertions: [assertion("send.accepts-valid", "PASS")],
    ...overrides,
  };
}

function vendorRecord(overrides: Partial<VendorRecord> = {}): VendorRecord {
  return { vendor: "acme", latest: record(), ageDays: 3, stale: false, ...overrides };
}

describe("empty registry", () => {
  test("says nothing has been tested, and forbids inferring from absence", () => {
    const html = renderIndex([]);
    expect(html).toContain("No products have been tested yet");
    expect(html).toContain("does not mean products are");
  });
});

describe("escaping — provider-controlled content is untrusted input", () => {
  test("escapes angle brackets, quotes and ampersands", () => {
    expect(esc(`<script>alert("x")&'`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;");
  });

  test("a vendor name containing markup cannot inject into the index", () => {
    const html = renderIndex([vendorRecord({ vendor: '<img src=x onerror="alert(1)">' })]);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  test("an assertion id containing markup cannot inject into a product page", () => {
    // Assertion ids and details can carry text a provider returned to us, which
    // makes them input from the party with the most motive to manipulate readers.
    const latest = record({ assertions: [assertion('<svg onload="alert(1)">', "FAIL", 0)] });
    const html = renderVendor("acme", [latest], false);
    expect(html).not.toContain("<svg onload");
    expect(html).toContain("&lt;svg onload");
  });

  test("a malicious CI url cannot break out of the href attribute", () => {
    const latest = record({
      provenance: { workflowRunUrl: '"><script>alert(1)</script>', commit: "a", artifactDigest: "b" },
    });
    const html = renderVendor("acme", [latest], false);
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});

describe("the site and the MCP server must never disagree", () => {
  // Assert on the rendered verdict span, not the whole document: every page
  // carries a stylesheet naming all four verdicts, so a substring check against
  // the full HTML would pass or fail for the wrong reason.
  const verdictSpan = (v: string) => `<span class="v ${v}">${v}</span>`;

  test("a stale PASS renders as UNKNOWN, matching reportedVerdict", () => {
    const a = assertion("send.accepts-valid", "PASS");
    expect(reportedVerdict(a, true)).toBe("UNKNOWN");

    const html = renderIndex([vendorRecord({ stale: true, ageDays: 90 })]);
    expect(html).toContain(verdictSpan("UNKNOWN"));
    expect(html).not.toContain(verdictSpan("PASS"));
  });

  test("a fresh PASS renders as PASS", () => {
    const html = renderIndex([vendorRecord({ stale: false })]);
    expect(html).toContain(verdictSpan("PASS"));
    expect(html).not.toContain(verdictSpan("UNKNOWN"));
  });

  test("a stale FAIL still renders as FAIL, never softened by age", () => {
    const latest = record({ assertions: [assertion("delivery.arrives", "FAIL", 0)] });
    const html = renderIndex([vendorRecord({ latest, stale: true })]);
    expect(html).toContain(verdictSpan("FAIL"));
    expect(html).not.toContain(verdictSpan("UNKNOWN"));
  });
});

describe("ratios and measurements", () => {
  test("publishes the ratio rather than rounding to a verdict", () => {
    const latest = record({ assertions: [assertion("send.accepts-valid", "PASS", 2)] });
    const html = renderIndex([vendorRecord({ latest })]);
    expect(html).toContain("2/3");
  });

  test("shows measurements on the product page", () => {
    const latest = record({
      assertions: [assertion("delivery.latency", "PASS", 3, { deliverySeconds: 4.2 })],
    });
    const html = renderVendor("acme", [latest], false);
    expect(html).toContain("deliverySeconds 4.2");
  });

  test("marks an assertion that was not run for this vendor", () => {
    const withBoth = vendorRecord({
      vendor: "a",
      latest: record({ assertions: [assertion("send.accepts-valid", "PASS"), assertion("bounce.reported", "PASS")] }),
    });
    const withOne = vendorRecord({ vendor: "b", latest: record({ assertions: [assertion("send.accepts-valid", "PASS")] }) });
    const html = renderIndex([withBoth, withOne]);
    expect(html).toContain("not run");
  });
});

describe("provenance", () => {
  test("warns loudly when a record was produced locally", () => {
    const html = renderVendor("acme", [record()], false);
    expect(html).toContain("Not independently produced");
    expect(html).toContain("is not evidence");
  });

  test("links the CI run and publishes the seed when provenance exists", () => {
    const latest = record({
      provenance: {
        workflowRunUrl: "https://github.com/x/y/actions/runs/1",
        commit: "abc",
        artifactDigest: "sha256:x",
      },
    });
    const html = renderVendor("acme", [latest], false);
    expect(html).toContain("https://github.com/x/y/actions/runs/1");
    expect(html).toContain("deadbeef");
    expect(html).not.toContain("Not independently produced");
  });
});

describe("history", () => {
  test("a single run says so rather than showing an empty table", () => {
    expect(renderVendor("acme", [record()], false)).toContain("only run so far");
  });

  test("older runs appear and the append-only rule is stated", () => {
    const newest = record({ finishedAt: "2026-09-05T00:00:00.000Z" });
    const older = record({ finishedAt: "2026-08-01T00:00:00.000Z" });
    const html = renderVendor("acme", [newest, older], false);
    expect(html).toContain("2026-08-01");
    expect(html).toContain("does not edit an old one");
  });
});
