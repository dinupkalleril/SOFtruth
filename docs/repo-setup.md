# Repository setup

These settings are load-bearing, not hygiene. Two of the claims SOFtruth makes in
public are only true once they are configured, and the code cannot enforce them
from the inside.

## 1. The repository must be public

Not a preference. `actions/attest` picks its Sigstore instance from repository
visibility: a **public** repo uses the public-good instance, which writes the
signature to the **Rekor public transparency log**. A private repo uses GitHub's
private instance and the entry never becomes publicly verifiable.

The public log is what supplies anti-equivocation: we cannot show one version of
history to one person and a different version to another, because the entries are
in an append-only log we do not control. Make the repo private and that property
silently disappears while the README still claims it.

## 2. Branch protection on `main`

The README says the record is append-only because git history is hash-chained.
That is only half true by default: an admin can force-push and rewrite it. Git
gives tamper-**evidence**, and only once rewriting is actually blocked.

Configure a ruleset on `main`:

- **Block force pushes** — without this, history is rewritable and the append-only
  claim is false.
- **Restrict deletions** — the branch itself must not be removable.
- **Require a pull request before merging** — this is where the human review gate
  on a FAIL lives. CI opens PRs; it never commits to `main`.
- **Require status checks to pass** — specifically the test job, so a regression in
  the assertions cannot reach `main` and start producing wrong verdicts.

```bash
gh api -X PUT repos/:owner/:repo/rulesets --input - <<'JSON'
{
  "name": "protect main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/main"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false
    }}
  ]
}
JSON
```

`required_approving_review_count` is 0 because a solo operator cannot approve
their own PR under GitHub's rules. The review gate is therefore procedural rather
than mechanical right now: **you read the artifacts before merging a FAIL.** When
a second person exists, raise this to 1 and the gate becomes enforced rather than
promised. Until then, do not describe it publicly as enforced.

## 3. Secrets

One secret per vendor, named `SOFTRUTH_TOKEN_<SLUG>` in upper snake case:

```bash
gh secret set SOFTRUTH_TOKEN_REFERENCE
```

Tokens are never written to result files, never echoed in logs, and never
committed. This repo is public and permanent: a leaked token cannot be
unpublished, only rotated.

## 4. Before the first vendor record publishes

Ordered, because some of these are one-way doors once a record exists.

- [ ] Repo is public (see 1).
- [ ] Branch ruleset applied (see 2).
- [ ] `SOFTRUTH_INBOX_DOMAIN` is set and its MX records point at the chosen inbox
      service. **Use a subdomain, never the apex** of a domain that already
      receives mail: changing apex MX records breaks existing email.
- [ ] `SOFTRUTH_BOUNCE_DOMAIN` has a **null MX** record (`. 0 MX 0 "."`), so every
      provider sees the same hard bounce.
- [ ] An inbox service is chosen and implemented behind the `Inbox` interface.
      Until then `UnconfiguredInbox` reports every delivery assertion as
      INCONCLUSIVE, which is correct: unrunnable must look unrunnable, never failed.
- [ ] Published terms explicitly permit permanent publication of negative results.
- [ ] A written correction policy exists: harness and factual errors are corrected
      by **appending** a correction, never by deleting. Verdicts are never reversed
      on request.

## 4b. Testing on a domain you already own

You do not need the final domain to start. Point `SOFTRUTH_INBOX_DOMAIN` at a
subdomain of something you already control, for example `sft-inbox.mayin.me`.

Two rules make this safe:

**Use a subdomain, never the apex.** If mail already flows to the parent domain,
adding or changing MX records at the apex breaks it. A subdomain is isolated.

**Every record stores the domain it ran against.** `inboxDomain` and
`bounceDomain` are written into each result, because a seed alone does not
determine the addresses: it fixes the local-parts and the domain completes them.
Without that, moving to the real domain later would silently break replay for
every earlier record while the site still promised it.

The one thing a borrowed domain must not do is reach a **published** record. Test
addresses at a Mayin subdomain appearing in public results would connect SOFtruth
to the GEO tool, which is exactly the entanglement the separate-brand decision
exists to avoid. Fine for pre-launch runs, which stay local and carry no CI
provenance. Move to the real domain before the first vendor record publishes.

## 5. What is deliberately not implemented yet

Stated here so nothing claims a guarantee it does not have:

- **No scheduler.** Runs are manual (`workflow_dispatch`). The design calls for a
  cadence a vendor cannot time or skip; until that ships, do not claim it.
- **No freshness indexer.** `reportedVerdict` decays a stale PASS to UNKNOWN at
  read time, which covers the MCP surface. Nothing recomputes and republishes
  status on a schedule.
- **No browser testing.** API surface only.
- **No badge, webhook, or onboarding form.**
