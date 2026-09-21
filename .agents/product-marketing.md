# Product Marketing Context

**Document version:** v1
**Last updated:** 2026-09-21

Drafted from the codebase (landing copy, goal pages, command modules, `docs/`), as the `product-marketing` skill's
auto-draft path suggests. **Everything here is checkable against the repo or marked as unknown.** Nothing was inferred
about customers, results or demand, because spaca has none yet — see Proof Points, which is deliberately near-empty and
is the single biggest constraint on any marketing copy written from this document.

## Product Overview

**One-liner:** Creator campaigns for web3 launches, on X.

**What it does:** A marketplace where a project posts a campaign brief (or books a fixed-price service) and crypto-
native creators on X apply, get hired, deliver, and are paid when the buyer approves. Money is held rather than sent:
a buyer funds an order, the creator delivers, the buyer approves (or the review window closes), and only then is the
creator paid. Every order includes one revision; a dispute pauses payout for a person to review.

**Product category:** Creator/influencer marketplace, narrowed to web3 and to X.

**Product type:** Two-sided marketplace. Each account is a buyer **or** a creator, never both.

**Business model:** Take rate on orders. **The fee is not decided** — `platform_fee_bps` is 0 everywhere and
`release:check` enforces it, but that is a placeholder, not a pricing decision (LAUNCH_READINESS D8). Copy must not
promise a rate, including "0% fee".

**What it sells today:** four service kinds — CREATE (content delivered to the buyer), PUBLISH (a post on the
creator's own channel), ACCESS (a live call, AMA or Space, 15–480 minutes), DIGITAL (a licensed file) — plus campaigns
across seven goals (Launch, Shiller, Airdrop, AMA & Spaces, Testnet, Education, Memes & art) and item auctions
(whitelist spots, guaranteed mints, pre-market allocations) in Beta.

## Target Audience

**Target companies:** web3 projects at or near launch — token, NFT, chain, protocol, app. AI/SaaS is a stated
secondary audience but nothing in the product is built for it yet.

**Decision-makers:** founder, head of growth or marketing lead at a small crypto team; often the same person who runs
the project's X account.

**Primary use case:** line up several creators around a launch date so the news lands as a coordinated wave rather
than a single post.

**Jobs to be done:**
- Get real voices talking about a launch, on the platform where the audience already is.
- Pay for creator work without trusting a stranger with the money up front.
- Run several creators at once without managing it all in a group chat.

**Use cases:** launch-day threads and videos; disclosed shill posts from many creators; explaining who qualifies for
an airdrop; hosting or joining an AMA or X Space; testnet walkthroughs that bring real testers; tutorials and deep
dives; memes and visual art.

## Personas

| Persona | Cares about | Challenge | Value we promise |
|---|---|---|---|
| Buyer (project) | The launch landing, not being scammed, one place to run it | Finding creators who actually post, paying safely, coordinating many at once | See the price and scope up front; the money waits until you approve |
| Creator (on X) | Being paid, clear scope, not being ghosted | Chasing payment, vague briefs, unpaid revisions | The buyer funds before you start; one revision is agreed up front |

## Problems & Pain Points

**Core challenge:** a project at launch needs several credible voices on X in a short window, and has no safe way to
find them, agree scope, or pay.

**Why current solutions fall short:** deals happen in DMs and group chats — no agreed scope, no escrow, no record.
One side is always taking the risk: the project pays first and hopes, or the creator works first and hopes.

**What it costs them:** a launch that lands as one post; money sent to someone who disappears; hours in group chats.

**Emotional tension:** the buyer's fear of being scammed; the creator's fear of working unpaid. Both are the reason
the product holds the money instead of passing it along.

## Competitive Landscape

*Not researched — this is the biggest gap in this document.* Named here only as categories, not as claims:
- **Direct:** crypto creator/KOL marketplaces and agencies.
- **Secondary:** general influencer platforms that do not know web3 or X's disclosure norms.
- **Indirect:** doing it by hand in DMs and group chats — today's real default, and the thing the landing's closing
  line names ("better than a group chat").

## Differentiation

What spaca does that a DM cannot, all of it built and testable in the repo:
- **The money waits.** A buyer funds an order; the creator is paid on approval, or when the agreed review window
  closes without a revision request or dispute.
- **One revision is included**, agreed before anyone starts.
- **A dispute pauses payout** for a person to review, rather than ending in a public argument.
- **Scope, price and delivery time are fixed up front** on the service, and frozen onto the order when it is placed.
- **Sponsorship is always labelled.** Every post sold through spaca is disclosed; the product refuses briefs that ask
  for undisclosed posts, fake engagement or guaranteed returns.
- **Item auctions** with seller collateral: the seller locks collateral before a listing opens, and a buyer who is not
  delivered to gets their payment back plus that collateral.

## Objections & Anti-Personas

**Top objections** (these are what the pages have to answer, not a list of what customers have said — no customer has
said anything yet):
1. *"How do I know they will actually post?"* → funding is held; payout happens on approval; one revision is included;
   a dispute pauses payout.
2. *"What does it cost me?"* → price and scope are on the service before you book. The platform fee is undecided, so
   the honest answer is that fees are shown before you pay and published before launch — never a number.
3. *"Is anyone even here?"* → the hardest one, and the one with no good answer yet. Every count on the site is real,
   which today means small. Inventing demand is out.

**Anti-persona:** anyone who wants undisclosed posts, bought engagement, or a promised price move. The moderation
policy refuses those briefs outright.

## Switching Dynamics

- **Push:** being scammed or ghosted in DMs; a launch that landed as one post.
- **Pull:** the money waits until the work is approved; scope and price agreed before anyone starts.
- **Habit:** the group chat works well enough, and everyone already lives in DMs.
- **Anxiety:** a new marketplace with few creators; "will there be anyone good here?"; putting money into a site they
  have not used.

## Customer Language

**Use:** launch, thread, Space, AMA, airdrop, testnet, whitelist, mint, disclosed, creator, brief, campaign, escrow,
payout.

**Avoid** — these are rules in the repo, not preferences (`docs/MARKETING_BRIEF.md`, `docs/BRAND_ROLLOUT_PROMPT.md`):
- "0% fee" or any fee number, while the fee is undecided
- "guaranteed", "trustless", "audited", "make a living"
- any promise about returns or price
- "engagement" as something bought
- unlabelled sandbox or testnet money — mock, sandbox, LOCAL devnet, TESTNET and live are always named

## Brand Voice

**Tone:** plain and exact. Short sentences. No hype.

**Style:** direct; says what happens and when; names limits instead of hiding them.

**Personality:** honest, precise, crypto-native, unglamorous, on the creator's side as much as the buyer's.

## Proof Points

**None.** No customers, no completed campaigns, no testimonials, no logos, no metrics. The site is public but
payments are closed (`PAYMENT_MODE=off`), so nothing has been bought.

This is the constraint that decides what can go on a page. Standard CRO advice — "Join 10,000+ teams", customer
logos, review scores, testimonials with photos — is **unavailable**, and inventing any of it is forbidden by the
repo's own rules. The available substitutes, all real:
- the mechanism itself, stated plainly (funding held, approval, revision, dispute, collateral)
- counts that are true even when small, including zero
- the refusal rules (what spaca will not sell)
- work samples a creator actually uploaded, and X profile data actually read from X

## Goals

**Primary business goal:** get the first real campaigns run end to end.

**Key conversion action:** sign up — as a buyer posting a brief, or as a creator applying. Sign-up is open through X
and, since migration 0038, Google.

**Current metrics:** none. Vercel Analytics is wired but has to be switched on for the project before it records
anything.

## Changelog

- **v1 (2026-09-21)** — first draft, auto-drafted from the codebase on the owner's request to optimise the landing
  and product pages using the `marketingskills` library. Competitive landscape is unresearched; Proof Points is empty
  by fact, not by omission.
