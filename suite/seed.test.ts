import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_BOUNCE_DOMAIN,
  DEFAULT_INBOX_DOMAIN,
  generateBounceAddress,
  generateCase,
  newSeed,
  resolveBounceDomain,
  resolveInboxDomain,
} from "./seed";

describe("generateCase", () => {
  test("is deterministic: same seed and index always give the same case", () => {
    const a = generateCase("abc123", 0);
    const b = generateCase("abc123", 0);
    expect(a).toEqual(b);
  });

  test("determinism is what makes a published seed a real replay", () => {
    // The published record contains only the seed. If this ever stops holding,
    // every claim of reproducibility in the README becomes false.
    const replayed = generateCase("f".repeat(32), 2);
    expect(replayed.nonce).toBe(generateCase("f".repeat(32), 2).nonce);
    expect(replayed.to).toBe(generateCase("f".repeat(32), 2).to);
    expect(replayed.subject).toBe(generateCase("f".repeat(32), 2).subject);
  });

  test("different case indices give different inputs", () => {
    const first = generateCase("abc123", 0);
    const second = generateCase("abc123", 1);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.to).not.toBe(second.to);
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
  });

  test("different seeds give different inputs — this is the anti-doping property", () => {
    // A provider that special-cased run N's values must fail run N+1.
    const run1 = generateCase("seed-one", 0);
    const run2 = generateCase("seed-two", 0);
    expect(run1.nonce).not.toBe(run2.nonce);
    expect(run1.to).not.toBe(run2.to);
  });

  test("the nonce appears in both subject and body", () => {
    // Searched in either, because providers rewrite bodies more often than subjects.
    const c = generateCase("abc123", 0);
    expect(c.subject).toContain(c.nonce);
    expect(c.text).toContain(c.nonce);
  });

  test("produces a well-formed address in the configured inbox domain", () => {
    const c = generateCase("abc123", 0);
    expect(c.to).toMatch(/^probe-[a-z0-9]{16}@/);
    expect(c.to.endsWith(`@${DEFAULT_INBOX_DOMAIN}`)).toBe(true);
  });

  test("honours a custom inbox domain", () => {
    const c = generateCase("abc123", 0, "test.example.com");
    expect(c.to.endsWith("@test.example.com")).toBe(true);
  });

  test("local-part and nonce use only characters that survive an email round trip", () => {
    for (let i = 0; i < 25; i++) {
      const c = generateCase(`seed-${i}`, i);
      expect(c.to.split("@")[0]).toMatch(/^[a-z0-9-]+$/);
      expect(c.nonce).toMatch(/^sft-[a-z0-9]+$/);
    }
  });

  test("nonces do not collide across a realistic number of cases", () => {
    const seed = newSeed();
    const nonces = new Set(Array.from({ length: 500 }, (_, i) => generateCase(seed, i).nonce));
    expect(nonces.size).toBe(500);
  });
});

describe("generateBounceAddress", () => {
  test("is deterministic and varies per case", () => {
    expect(generateBounceAddress("abc123", 0)).toBe(generateBounceAddress("abc123", 0));
    expect(generateBounceAddress("abc123", 0)).not.toBe(generateBounceAddress("abc123", 1));
  });

  test("varies per seed, so a provider cannot allowlist one fixed bounce address", () => {
    expect(generateBounceAddress("seed-one", 0)).not.toBe(generateBounceAddress("seed-two", 0));
  });

  test("lands in the null-MX bounce subdomain", () => {
    expect(generateBounceAddress("abc123", 0)).toMatch(/^nx-[a-z0-9]{16}@bounce\./);
  });
});

describe("newSeed", () => {
  test("returns 32 hex characters", () => {
    expect(newSeed()).toMatch(/^[0-9a-f]{32}$/);
  });

  test("does not repeat", () => {
    const seeds = new Set(Array.from({ length: 200 }, () => newSeed()));
    expect(seeds.size).toBe(200);
  });
});

describe("domain resolution", () => {
  const saved = { inbox: process.env.SOFTRUTH_INBOX_DOMAIN, bounce: process.env.SOFTRUTH_BOUNCE_DOMAIN };
  afterEach(() => {
    process.env.SOFTRUTH_INBOX_DOMAIN = saved.inbox;
    process.env.SOFTRUTH_BOUNCE_DOMAIN = saved.bounce;
    if (saved.inbox === undefined) delete process.env.SOFTRUTH_INBOX_DOMAIN;
    if (saved.bounce === undefined) delete process.env.SOFTRUTH_BOUNCE_DOMAIN;
  });

  test("falls back to the default when nothing is configured", () => {
    delete process.env.SOFTRUTH_INBOX_DOMAIN;
    expect(resolveInboxDomain()).toBe(DEFAULT_INBOX_DOMAIN);
  });

  test("honours an override, so a domain you already own can be used first", () => {
    process.env.SOFTRUTH_INBOX_DOMAIN = "sft-inbox.mayin.me";
    expect(resolveInboxDomain()).toBe("sft-inbox.mayin.me");
  });

  test("bounce domain is independent of the inbox domain", () => {
    // They need opposite DNS: the inbox receives, the bounce domain must reject
    // everything. Deriving one from the other invites configuring them together,
    // which would make mail to the bounce domain succeed and silently disable
    // the assertion that depends on it failing.
    process.env.SOFTRUTH_INBOX_DOMAIN = "inbox.example.com";
    delete process.env.SOFTRUTH_BOUNCE_DOMAIN;
    expect(resolveBounceDomain()).toBe(DEFAULT_BOUNCE_DOMAIN);
    expect(resolveBounceDomain()).not.toContain("inbox.example.com");
  });

  test("bounce domain can be overridden independently", () => {
    process.env.SOFTRUTH_BOUNCE_DOMAIN = "nx.example.invalid";
    expect(resolveBounceDomain()).toBe("nx.example.invalid");
  });

  test("an empty env var falls back rather than producing addresses with no domain", () => {
    process.env.SOFTRUTH_INBOX_DOMAIN = "";
    expect(resolveInboxDomain()).toBe(DEFAULT_INBOX_DOMAIN);
  });

  test("changing the domain changes the addresses for the same seed", () => {
    // Exactly why the domain is recorded in every RunRecord: the seed alone
    // does not determine the address.
    const a = generateCase("same-seed", 0, "one.example.com");
    const b = generateCase("same-seed", 0, "two.example.com");
    expect(a.to).not.toBe(b.to);
    expect(a.nonce).toBe(b.nonce);
  });
});
