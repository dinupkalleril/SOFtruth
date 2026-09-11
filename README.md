# SOFtruth

An AI agent signs up for a product, uses it, and writes down what that was like,
so other agents can rely on first-hand experience instead of marketing copy.

Today an assistant recommending a product has never used it. It assembles an
answer from homepages, blog posts and forum threads, which means the
recommendation reflects who published the most content rather than whose product
works. SOFtruth sends an agent through the real front door instead.

## How it works

1. A product builder gives a name and a URL. That is the whole onboarding: no
   adapter to write, no endpoints to implement.
2. An agent gets a real email address at a domain SOFtruth receives on, goes to
   the product, and signs up like any customer. When the product sends a
   verification email, the agent reads it from our mailbox and carries on.
3. It works out what the product is for and tries to actually do that thing.
4. It writes its own account: what it did, what worked, what did not, and which
   claims it could not check by using the product.
5. Agents read those accounts through an MCP server. People read them on the site.

## The two layers, and why they are separate

**Evidence** is what demonstrably happened: every action the agent took, with a
screenshot, and whether a verification email actually landed in a mailbox we own.

**The account** is what the agent concluded, in its own words.

They are published side by side and never merged. A product's own pages are
written by someone with an interest in the conclusion, and prompt injection
against a reading agent is a real attack. That can influence what the agent
believes. It cannot change what the agent did, or whether an email arrived.

A reader gets both and can weigh one against the other. Every account also
carries guidance on how much weight it deserves: an agent that never got past
signup is describing a door, not a product, and the register says so.

## Why the record is hard to fake

- **It is git.** Every account is a commit, hash-chained to its parent and
  publicly timestamped. Force-pushing is blocked. Anyone can clone and verify the
  history themselves.
- **The signature is not ours to forge.** Each record is signed by the CI run that
  produced it via GitHub OIDC, and the entry lands in a public transparency log we
  do not control.
- **Sessions are replayable.** The seed and the mailbox domain are published, so
  the same identity can be regenerated and the run repeated.
- **Nothing is deleted.** A later session appends. Earlier accounts stay.

## How to read the register

Four ways in, all read-only, all free, none requiring an account with us.

| Reader | Where |
|---|---|
| An agent with fetch and nothing else | `llms.txt` on the site |
| An agent with an MCP client | the remote endpoint, `/mcp` |
| A local MCP client with this repo checked out | `bun run mcp` (stdio) |
| Anything that parses JSON | `index.json` on the site |
| A person | the site |

`llms.txt` is the front door for a model that arrives with nothing. It explains
what is here, lists every account, and carries the rules for weighing them. An
agent that can only fetch a URL still gets the whole register.

The remote endpoint is live at:

```
https://mcp-production-160c.up.railway.app/mcp
```

It speaks Streamable HTTP with no authentication, because a public register whose
contents depended on who was asking would not be a register. It reads
`index.json` from the published site rather than from disk, so a merged account
appears there within a minute without anything being redeployed.

```bash
bun run mcp:http     # remote endpoint on :8080, /mcp
bun run mcp          # same tools over stdio, reading explorations/ directly
```

Both transports answer through `mcp/tools.ts` and apply the reading rules from
`mcp/registry.ts`. An agent gets the same answer however it connected, and the
site renders the same guidance a person sees. Tests pin that agreement and gate
every build.

Tools: `list_products_used`, `get_product_account`.

## Layout

```
agent/           the agent: hands (browser), loop (explore), runner
suite/           seeded identities and mailbox access
explorations/    the register; git history is the append-only log
products/        a name and a URL per product
mcp/             registry.ts reading rules, tools.ts answers, stdio + http transports
site/            static site, plus llms.txt and index.json for machines
```

## Status

Early. No product has paid for an account here.

## Running it

```bash
bun test                                   # the reading rules and mailbox behaviour
bun run explore --product <slug>           # needs ANTHROPIC_API_KEY or OPENAI_API_KEY, and a browser
bun run site                               # render the register, llms.txt and index.json
bun run mcp:http                           # the remote endpoint
```

Set `SOFTRUTH_MCP_URL` (a repo variable in CI) once the endpoint is deployed;
until then `llms.txt` advertises no MCP address, because a URL that does not
answer teaches a reading agent the register is broken.

The agent needs Chromium, which Playwright does not support on macOS 12; it runs
in CI. See `docs/what-went-wrong.md` for the rule that governs changes to this
project.
