# What went wrong, and the rule that prevents it

Written 2026-09-08, after the founder pointed out that the thing being built was
no longer the thing he asked for.

## The idea he brought

> AI agents test the product **directly**... product builders enable **AI signup
> and test usage**, then the agent directly tests the product and tells the user
> about it, or decides based on usage experience. The agent can also **write
> about it for other agents to read**.

Four load-bearing pieces: an **agent**, a **signup**, **real usage**, and an
**agent-readable account** of the experience.

## What got built instead

A deterministic script that calls two endpoints the vendor writes specially for
us, and checks six fixed assertions.

No agent. Nothing signs up. Nothing uses the product. The thing being tested is a
purpose-built shim, not the product a customer would touch.

## How it happened

Three changes, each argued on real engineering grounds, each removing one of the
four load-bearing pieces.

| Change | Stated reason | What it silently removed |
|---|---|---|
| Verdicts computed by deterministic code, never by a model reading vendor content | Closes prompt injection against the tester | **The agent.** No AI in the loop at all. |
| Test the API surface first, browser automation later | Deterministic, fewer inconclusive runs | **The signup and the usage.** No agent experiencing the product as a customer would. |
| One canonical suite authored by us, identical for every vendor | Comparability; vendor-defined tests are gameable | **The agent's own judgment and account.** A fixed checklist replaced first-hand experience. |

Every one of those objections is real. Prompt injection is a genuine attack.
Comparability is a genuine requirement. The failure was not raising them; it was
**resolving them silently against the core idea** instead of putting the cost in
front of the founder and letting him decide.

At no point did the sentence "this removes the agent from your agent product,
do you want to pay that?" get said.

The founder had also said explicitly, during the CEO review: *"keep original
thesis, that we locked in office-hours."* The drift continued after that.

## The rule

**Narrowing an idea is good. Substituting a different idea is not.**

The founder's test, in his words: if someone pitches a restaurant, evaluate the
restaurant. Break it down, argue about scope, and land on the smallest honest
version — *start by selling samosas*. Do not conclude that they should open a
**pet shop**.

Selling samosas is still the restaurant idea, smaller. A pet shop is a different
business wearing the word "start small".

Applied here:

| Change | Verdict |
|---|---|
| Test one product instead of every product | Samosa. Same idea, smaller. |
| Test signup and one core flow instead of the whole product | Samosa. Same idea, smaller. |
| Cover one category before others | Samosa. Same idea, smaller. |
| **Replace the agent with a fixed script** | **Pet shop.** Different mechanism. |
| **Test a vendor-written shim instead of the product** | **Pet shop.** Different subject. |

## How to apply it

Before proposing any change, state it as one sentence and check which shape it takes:

- *"Less of the same thing"* → narrowing. Proceed.
- *"A different thing that solves a similar problem"* → substitution. **Stop and ask.**

When an engineering objection would remove a mechanism the founder named as core,
the objection does not get to win quietly. It gets stated as a trade with the
cost named out loud:

> "Prompt injection means an agent reading vendor pages can be manipulated. The
> fix is to stop using an agent for judgment. That removes the agent from your
> agent product. Options are A, B, C. Which do you want?"

That sentence takes ten seconds. Not saying it cost this project a full rebuild.

## The tell to watch for

Each individual step felt like good engineering. The drift was only visible when
someone compared the end state against the original words.

So: **re-read the founder's original description before every major decision**,
not just at the start. If the thing being built no longer contains the nouns he
used — here, *agent*, *signup*, *usage*, *writes about it* — that is the signal,
regardless of how defensible each step was.

This exact pattern was already documented in the founder's previous design doc,
from a different project, in writing:

> "In four steps the product went from X to Y. Each step was individually
> defensible. The end state was a different product than the founder asked for."

It was known, written down, and repeated anyway.
