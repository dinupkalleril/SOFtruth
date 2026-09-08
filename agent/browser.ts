/**
 * The hands. Everything the agent can physically do to a product.
 *
 * Deliberately small: an agent that can navigate, look, click and type can sign
 * up for almost anything, and a small surface is one an operator can actually
 * reason about. Every action records an EvidenceStep as it happens, so the
 * evidence layer is a by-product of acting rather than something reconstructed
 * afterwards from the agent's memory.
 */

import { chromium, type Browser, type Page } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvidenceStep } from "./types";

/** Values that must never reach a screenshot caption, a log, or the record. */
const REDACT_KEYS = /pass|secret|token|key|card|cvv|ssn/i;

export interface BrowserSessionOptions {
  /** Where screenshots land. One directory per exploration session. */
  sessionDir: string;
  /** Hard cap so a stuck agent cannot run forever. */
  maxSteps?: number;
  headless?: boolean;
}

export class BrowserSession {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private readonly steps: EvidenceStep[] = [];
  private stepIndex = 0;

  constructor(private readonly options: BrowserSessionOptions) {}

  async start(): Promise<void> {
    await mkdir(this.options.sessionDir, { recursive: true });
    this.browser = await chromium.launch({ headless: this.options.headless ?? true });
    const context = await this.browser.newContext({
      viewport: { width: 1280, height: 900 },
      // Honest identification. We are not pretending to be a person: the product
      // being tested is entitled to know an automated agent is using it, and
      // cloaking would make the record evidence of a disguise rather than of the
      // experience a normal user gets.
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 SOFtruth-agent/1.0 (+https://softruth.com)",
    });
    this.page = await context.newPage();
  }

  async stop(): Promise<void> {
    await this.browser?.close().catch(() => {});
    this.browser = null;
    this.page = null;
  }

  /** Evidence gathered so far. */
  getSteps(): EvidenceStep[] {
    return this.steps;
  }

  private requirePage(): Page {
    if (!this.page) throw new Error("browser session not started");
    return this.page;
  }

  /**
   * Run one action and record what happened.
   *
   * The screenshot is taken AFTER the action, because the useful question is
   * what the product did in response, not what it looked like before.
   */
  private async record<T>(
    intent: string,
    input: Record<string, string> | undefined,
    action: () => Promise<T>,
  ): Promise<T> {
    if (this.steps.length >= (this.options.maxSteps ?? 40)) {
      throw new Error(`step budget exhausted after ${this.steps.length} actions`);
    }

    const page = this.requirePage();
    const index = this.stepIndex++;
    const startedAt = new Date().toISOString();
    const started = Date.now();

    let httpStatus: number | undefined;
    let errorText: string | undefined;
    let result: T;

    try {
      result = await action();
    } catch (error) {
      errorText = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      const screenshot = `step-${String(index).padStart(2, "0")}.png`;
      await page
        .screenshot({ path: join(this.options.sessionDir, screenshot), fullPage: false })
        .catch(() => undefined);

      this.steps.push({
        index,
        intent,
        url: page.url(),
        observed: {
          httpStatus,
          pageTitle: await page.title().catch(() => undefined),
          screenshot,
          input: input ? redact(input) : undefined,
          errorText,
        },
        startedAt,
        elapsedMs: Date.now() - started,
      });
    }

    return result!;
  }

  async navigate(url: string): Promise<void> {
    await this.record("navigate", { url }, async () => {
      const page = this.requirePage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(1_000);
    });
  }

  /**
   * What the agent can see.
   *
   * Text rather than raw HTML: an agent reasoning about a page does not need the
   * markup, and trimming it keeps the injected-instruction surface smaller
   * without pretending it is gone.
   */
  async readPage(): Promise<{ title: string; text: string; interactives: string[] }> {
    const page = this.requirePage();

    const title = await page.title().catch(() => "");
    const text = (await page.locator("body").innerText().catch(() => "")).slice(0, 6_000);

    // Everything clickable or fillable, described the way a person would name it.
    const interactives = await page
      .$$eval(
        "a, button, input, textarea, select, [role=button]",
        (nodes) =>
          nodes
            .slice(0, 60)
            .map((n) => {
              const el = n as HTMLElement & { type?: string; name?: string; placeholder?: string; value?: string };
              const label =
                el.getAttribute("aria-label") ||
                el.getAttribute("placeholder") ||
                el.getAttribute("name") ||
                (el.innerText || "").trim().slice(0, 60) ||
                el.getAttribute("value") ||
                "";
              const tag = el.tagName.toLowerCase();
              const type = el.type ? `:${el.type}` : "";
              return label ? `${tag}${type} "${label}"` : "";
            })
            .filter(Boolean),
      )
      .catch(() => [] as string[]);

    return { title, text, interactives };
  }

  /** Click the first thing matching a human description. */
  async click(description: string): Promise<void> {
    await this.record(`click ${description}`, undefined, async () => {
      const page = this.requirePage();
      const target = page
        .getByRole("button", { name: description, exact: false })
        .or(page.getByRole("link", { name: description, exact: false }))
        .or(page.getByText(description, { exact: false }))
        .first();
      await target.click({ timeout: 15_000 });
      await page.waitForTimeout(1_500);
    });
  }

  /** Type into the field a person would identify by this label. */
  async fill(fieldDescription: string, value: string): Promise<void> {
    await this.record(`fill ${fieldDescription}`, { [fieldDescription]: value }, async () => {
      const page = this.requirePage();
      const field = page
        .getByLabel(fieldDescription, { exact: false })
        .or(page.getByPlaceholder(fieldDescription, { exact: false }))
        .or(page.locator(`input[name*="${fieldDescription}" i]`))
        .first();
      await field.fill(value, { timeout: 15_000 });
    });
  }

  /** Current page, for the agent's own orientation. */
  url(): string {
    return this.page?.url() ?? "";
  }
}

/** Never let a password or token reach the published record. */
function redact(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = REDACT_KEYS.test(key) ? "[redacted]" : value;
  }
  return out;
}
