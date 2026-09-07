/**
 * HTTP access to a provider's conformance endpoints.
 *
 * Thin on purpose. Its only real job is to make the difference between
 * "the provider answered and we did not like the answer" and "we never got an
 * answer" impossible to lose, because that distinction is what separates a FAIL
 * from an INCONCLUSIVE downstream.
 */

/** Never blame a provider for our patience running out. */
export const DEFAULT_TIMEOUT_MS = 15_000;

export type HttpOutcome =
  | {
      kind: "response";
      status: number;
      body: string;
      /** Parsed body, or null when it was not valid JSON. */
      json: unknown | null;
      elapsedMs: number;
    }
  | {
      kind: "network";
      reason: "network.timeout" | "network.error" | "network.dns";
      detail: string;
      elapsedMs: number;
    };

export interface RequestOptions {
  method: "GET" | "POST";
  url: string;
  token: string;
  body?: unknown;
  timeoutMs?: number;
}

/**
 * Statuses that mean the provider's infrastructure was having a moment rather
 * than the product being wrong. Treated as harness-level so they resolve to
 * INCONCLUSIVE: a 503 during our test window says nothing about whether the
 * product works, and a rate limit is us hitting them too hard.
 */
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);

export function isTransientStatus(status: number): boolean {
  return TRANSIENT_STATUSES.has(status);
}

/** Stable reason code for the record, e.g. "http.202". */
export function statusReason(status: number): string {
  return `http.${status}`;
}

export async function request(options: RequestOptions): Promise<HttpOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(options.url, {
      method: options.method,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${options.token}`,
        "User-Agent": "SOFtruth/1.0 (+https://softruth.com)",
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    // Cap the body: a provider returning a 50MB error page should not be able to
    // exhaust the runner, and we only ever need the shape of the response.
    const body = (await response.text().catch(() => "")).slice(0, 8192);

    let json: unknown | null = null;
    try {
      json = JSON.parse(body);
    } catch {
      json = null; // Not JSON. That is a finding for the caller, not an error here.
    }

    return { kind: "response", status: response.status, body, json, elapsedMs: Date.now() - started };
  } catch (error) {
    const name = error instanceof Error ? error.name : "UnknownError";
    const message = error instanceof Error ? error.message : String(error);
    const elapsedMs = Date.now() - started;

    if (name === "AbortError" || name === "TimeoutError") {
      return {
        kind: "network",
        reason: "network.timeout",
        detail: `no response within ${timeoutMs}ms`,
        elapsedMs,
      };
    }

    // DNS failures are worth separating: they usually mean the vendor gave us a
    // wrong base URL at onboarding, which is a configuration problem to fix
    // rather than anything about their product.
    const isDns = /getaddrinfo|ENOTFOUND|EAI_AGAIN|dns/i.test(message);
    return {
      kind: "network",
      reason: isDns ? "network.dns" : "network.error",
      detail: `${name}: ${message}`,
      elapsedMs,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Read a string field from a parsed JSON body without trusting its shape. */
export function readString(json: unknown, field: string): string | null {
  if (typeof json !== "object" || json === null) return null;
  const value = (json as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}
