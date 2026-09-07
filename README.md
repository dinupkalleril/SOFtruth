# SOFtruth

Independent, repeatable, cryptographically attested tests of SaaS products, published
as a public record that AI agents can query at recommendation time.

Today an AI assistant recommending a product has never used it. It assembles an answer
from marketing copy, blog posts and forum threads. SOFtruth runs the same canonical test
suite against every product in a category and publishes what actually happened, so a
recommendation can rest on tested behavior instead of who published the most content.

## How it works

1. A provider implements a small conformance interface for its category (two endpoints
   for transactional email) and submits its product. All testing is consented.
2. A GitHub Actions workflow runs the canonical suite against it three times, with test
   inputs generated from a published random seed.
3. Verdicts are computed by code comparing observed facts. No model reads provider-
   controlled content to decide anything.
4. The result is signed with `actions/attest` (Sigstore keyless; on a public repo the
   signature lands in the Rekor public transparency log) and opened as a pull request.
5. Failures require human review before publishing. Passing results publish with the
   ratio (3/3, 2/3), the suite version, the seed, and a link to the CI run.
6. Agents query the record through an MCP server; humans read the static site.

## Why it is hard to fake

- **The record is git.** Every result is a commit, hash-chained to its parent and
  publicly timestamped. Anyone can clone the repo and verify the whole history.
- **The signature is not ours to forge.** `actions/attest` binds each result to the
  workflow that produced it via GitHub OIDC, and the entry is in a public append-only
  log we do not control.
- **The inputs are random.** Assertions are public so anyone can audit them, but the
  concrete cases are seeded per run, so a provider cannot special-case the exact calls
  and pass without actually implementing the spec.
- **Failures are permanent.** A provider claiming a fix always gets a free re-test, and
  the new result appends. Nothing is deleted.

## Layout

```
spec/<category>/v1.json    the conformance interface providers implement
suite/                     canonical assertions, fixtures, seeded case generation
results/<vendor>/*.json    the record; git history is the append-only log
reference-impl/            a correct stub implementation, so the demo runs with no customer
mcp/                       read-only MCP server agents call at decision time
site/                      static index and per-product timeline
scripts/                   operational probes
.github/workflows/         run, attest, open PR
```

## Status

Pre-validation. Nothing is published yet and no provider has been tested.

The project is gated on a committed kill condition: by **30 September 2026**, after
conversations with at least five people fitting the buyer profile, if fewer than two
will pay $99/month on terms that include permanent publication of their failures, the
project closes.

## Running the egress probe

```bash
bun run scripts/egress-probe.ts
```

Checks whether vendor APIs are reachable from wherever it runs. Compare a local run
against the `Egress probe` workflow on a GitHub-hosted runner: matching verdicts mean
shared runner IPs are fine, differing verdicts mean runner-specific blocking.
