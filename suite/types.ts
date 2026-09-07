/** Core types shared by the runner, the classifier and the assertions. */

/**
 * The three-state verdict. The existence of INCONCLUSIVE is the point: a
 * failure of our own harness (rate limit, timeout, our inbox being down,
 * a provider outage) must never be recorded as the provider's product failing.
 * Publishing a permanent public accusation caused by our own broken code is
 * the single most damaging thing this system could do.
 */
export type Verdict = "PASS" | "FAIL" | "INCONCLUSIVE";

/** One assertion, executed once. */
export interface AttemptResult {
  assertionId: string;
  verdict: Verdict;
  /** Machine-readable reason code, e.g. "http.202", "inbox.timeout". */
  reason: string;
  /** Human-readable one-liner for the published record. */
  detail: string;
  /** Numbers worth publishing even when the verdict is not a number, e.g. latency. */
  measurements?: Record<string, number>;
  startedAt: string;
  elapsedMs: number;
}

/** The same assertion across all runs, collapsed into one published verdict. */
export interface AssertionResult {
  assertionId: string;
  verdict: Verdict;
  /** e.g. 2 of 3 runs passed. Published rather than collapsed to a bare verdict. */
  passed: number;
  total: number;
  attempts: AttemptResult[];
  measurements?: Record<string, number>;
}

/** One complete evaluation of one vendor, the thing that gets signed and committed. */
export interface RunRecord {
  schemaVersion: "softruth/run/v1";
  specVersion: string;
  vendor: string;
  /** Published so anyone can reproduce the exact inputs this run used. */
  seed: string;
  startedAt: string;
  finishedAt: string;
  runsPerAssertion: number;
  assertions: AssertionResult[];
  /** Populated by CI. Absent on local runs, which is why local runs never publish. */
  provenance?: {
    workflowRunUrl: string;
    commit: string;
    artifactDigest: string;
    rekorEntry?: string;
  };
}

/**
 * A single concrete test case, generated from the seed. Nothing here is fixed:
 * a provider that special-cases these exact values still fails the next run,
 * which is the entire anti-doping mechanism.
 */
export interface SeededCase {
  seed: string;
  caseIndex: number;
  /** Full destination address in a domain SOFtruth controls. */
  to: string;
  subject: string;
  /** Body text containing the nonce. */
  text: string;
  /** The string we search the inbox for. Unique per case. */
  nonce: string;
  idempotencyKey: string;
}

/** What a provider must expose. Supplied at onboarding, never guessed. */
export interface VendorTarget {
  /** Slug used in results/<vendor>/. */
  vendor: string;
  /** Base URL implementing the category spec, e.g. https://api.example.com */
  baseUrl: string;
  /** Bearer token the provider issued to SOFtruth. Never logged, never committed. */
  token: string;
}
