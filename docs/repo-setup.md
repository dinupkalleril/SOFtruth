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

`required_approving_review_count` is 0 for now. GitHub does not let an author
approve their own pull request, so with a single maintainer a non-zero value would
block every merge. The review gate is therefore procedural at this size: the
artifacts get read before a FAIL is merged.

Raise this to 1 as soon as a second maintainer exists, at which point the gate is
enforced by the platform rather than by discipline. Until then the project does not
claim it is enforced, and neither should any description of it.

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
- [ ] `SOFTRUTH_BOUNCE_DOMAIN` resolves to NXDOMAIN (no records, no wildcard on
      the parent), so every provider sees the same hard bounce.
- [ ] An inbox service is chosen and implemented behind the `Inbox` interface.
      Until then `UnconfiguredInbox` reports every delivery assertion as
      INCONCLUSIVE, which is correct: unrunnable must look unrunnable, never failed.
- [ ] Published terms explicitly permit permanent publication of negative results.
- [ ] A written correction policy exists: harness and factual errors are corrected
      by **appending** a correction, never by deleting. Verdicts are never reversed
      on request.

## 4b. DNS layout

Three subdomains of `softruth.com`, three different jobs. They must not collide.

| Subdomain | Job | DNS | Registered with the mail service? |
|---|---|---|---|
| `send.softruth.com` | The reference implementation sends test mail | DKIM TXT + SPF, values from the provider | Yes, as a **sending** domain |
| `inbox.softruth.com` | SOFtruth receives and verifies arrival | MX → the provider's inbound servers | Yes, as an **inbound** domain |
| `bounce.softruth.com` | Must hard-bounce everything | **No records at all** | **Never.** See below |

**`bounce.softruth.com` needs no DNS records at all.** A subdomain with no MX
and no A record produces NXDOMAIN, which every provider treats as a hard bounce.
That is simpler and more robust than a null MX, which some registrars refuse to
accept. Verified 2026-09-07 that `softruth.com` has no wildcard record (a nonsense
subdomain returns NXDOMAIN), so nothing resolves here by accident.

**If a wildcard is ever added to `softruth.com`, this breaks silently.** A
wildcard would give `bounce.softruth.com` an A record, mail servers would fall
back to it as an implicit MX, delivery would succeed, and `bounce.reported` would
stop testing anything while still reporting PASS. Re-probe for a wildcard before
trusting a bounce result after any DNS change.

It is a sibling of the inbox domain, not a child, and `resolveBounceDomain()`
deliberately does not derive it from the inbox domain, so nobody configures the
two together by reflex.

**Sending lives on a subdomain, not the apex.** Sending reputation attaches to
the domain that sends. Keeping it on `send.` isolates the apex for the site and
any future real mail.

**Skip click and open tracking.** Tracking rewrites the message: link tracking
replaces URLs, open tracking injects a pixel. For a harness whose job is
confirming that the message which arrived is the message that was sent, that is a
variable with no upside. Nonces are plain text in subject and body and would
survive either, but there is nothing to gain from open rates on test mail.

**Every record stores the domain it ran against.** `inboxDomain` and
`bounceDomain` are written into each result, because a seed alone does not
determine the addresses: it fixes the local-parts and the domain completes them.
Without that, changing domains later would silently break replay for every
earlier record while the site still promised it.

## 5. What is deliberately not implemented yet

Stated here so nothing claims a guarantee it does not have:

- **No scheduler.** Runs are manual (`workflow_dispatch`). The design calls for a
  cadence a vendor cannot time or skip; until that ships, do not claim it.
- **No freshness indexer.** `reportedVerdict` decays a stale PASS to UNKNOWN at
  read time, which covers the MCP surface. Nothing recomputes and republishes
  status on a schedule.
- **No browser testing.** API surface only.
- **No badge, webhook, or onboarding form.**
