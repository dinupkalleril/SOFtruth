/**
 * Resend inbound adapter.
 *
 * Implements the Inbox interface against Resend's receiving API:
 *   GET /emails/receiving        list recent received emails (no recipient filter)
 *   GET /emails/receiving/{id}   full message, including the text body
 *
 * The list response carries `subject` but not the body, so matching on the
 * subject is one cheap call. The nonce is written into both subject and body
 * precisely so the common path needs no per-message fetch; the body is only
 * pulled as a fallback for messages addressed to us whose subject was rewritten.
 *
 * The rule that matters more than any of that:
 *
 *   ANY failure to query Resend returns `unavailable`, never `not-received`.
 *
 * `not-received` is evidence against a provider and can become a permanent
 * public FAIL. An auth error, a rate limit, a 500 or a network blip on OUR side
 * is not evidence about anyone. Getting this backwards would publish our outage
 * as their delivery failure, which is the single worst thing this system can do.
 */

import type { Inbox, InboxResult } from "./inbox";

const API_BASE = "https://api.resend.com";
const LIST_LIMIT = 100; // API max; we cannot filter by recipient, so take the widest page.
const POLL_INTERVAL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 15_000;

interface ListedEmail {
  id: string;
  to?: string[];
  from?: string;
  subject?: string;
  created_at?: string;
}

interface ListResponse {
  data?: ListedEmail[];
}

interface RetrievedEmail {
  id: string;
  subject?: string;
  text?: string | null;
  html?: string | null;
  created_at?: string;
}

/** Thrown for anything that means "we could not ask", never "the answer was no". */
class InboxUnavailable extends Error {}

export class ResendInbox implements Inbox {
  readonly kind = "resend";

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly pollIntervalMs: number = POLL_INTERVAL_MS,
  ) {
    if (!apiKey) throw new Error("ResendInbox requires an API key");
  }

  async awaitMessage(address: string, nonce: string, timeoutMs: number): Promise<InboxResult> {
    const deadline = Date.now() + timeoutMs;
    const target = address.toLowerCase();

    while (true) {
      try {
        const hit = await this.findMessage(target, nonce);
        if (hit) return hit;
      } catch (error) {
        if (error instanceof InboxUnavailable) {
          return { outcome: "unavailable", error: error.message };
        }
        // An unexpected error is still our problem, not the provider's.
        return {
          outcome: "unavailable",
          error: `unexpected inbox error: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        // Only here, having genuinely waited the whole window, is absence evidence.
        return { outcome: "not-received" };
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(this.pollIntervalMs, remaining)));
    }
  }

  /** One pass over recent mail. Returns a hit, or null if nothing matched yet. */
  private async findMessage(address: string, nonce: string): Promise<InboxResult | null> {
    const listed = await this.request<ListResponse>(`/emails/receiving?limit=${LIST_LIMIT}`);

    // No recipient filter exists on the API, so narrow client-side first. Only
    // messages addressed to this run's unique address can possibly be ours.
    const ours = (listed.data ?? []).filter((email) =>
      (email.to ?? []).some((recipient) => recipient.toLowerCase().includes(address)),
    );

    // Cheap path: the nonce is in the subject, which the list response already
    // gave us, so no per-message fetch is needed.
    const bySubject = ours.find((email) => email.subject?.includes(nonce));
    if (bySubject) {
      return {
        outcome: "received",
        receivedAt: parseDate(bySubject.created_at),
        subject: bySubject.subject ?? "",
        matchedIn: "subject",
      };
    }

    // Fallback: a provider rewrote the subject. Bounded by construction, since
    // only messages already addressed to this run's unique address get here.
    for (const candidate of ours) {
      const full = await this.request<RetrievedEmail>(`/emails/receiving/${encodeURIComponent(candidate.id)}`);
      const body = `${full.text ?? ""}${full.html ?? ""}`;
      if (body.includes(nonce)) {
        return {
          outcome: "received",
          receivedAt: parseDate(full.created_at ?? candidate.created_at),
          subject: full.subject ?? candidate.subject ?? "",
          matchedIn: "body",
        };
      }
    }

    return null;
  }

  /**
   * Every non-success path throws InboxUnavailable. There is deliberately no
   * branch here that can produce "not received": this method either answers or
   * declares itself unable to.
   */
  private async request<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await this.fetchImpl(`${API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: controller.signal,
      });

      if (!response.ok) {
        // 401/403 included on purpose: a misconfigured key on our side must
        // never be recorded as a provider failing to deliver.
        throw new InboxUnavailable(`Resend returned ${response.status} for ${path}`);
      }

      try {
        return (await response.json()) as T;
      } catch {
        throw new InboxUnavailable(`Resend returned unparseable JSON for ${path}`);
      }
    } catch (error) {
      if (error instanceof InboxUnavailable) throw error;
      const name = error instanceof Error ? error.name : "UnknownError";
      const message = error instanceof Error ? error.message : String(error);
      throw new InboxUnavailable(
        name === "AbortError" || name === "TimeoutError"
          ? `Resend did not respond within ${REQUEST_TIMEOUT_MS}ms`
          : `could not reach Resend: ${message}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/** A missing or unparseable timestamp falls back to now rather than to epoch. */
function parseDate(value: string | undefined): Date {
  if (!value) return new Date();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? new Date() : new Date(parsed);
}
