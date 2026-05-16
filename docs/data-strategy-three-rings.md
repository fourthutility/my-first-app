# Three Rings of CRE Data — and the Pattern That Bridges Them

**Draft v0.1 · 2026-05-16 · Internal · For collaboration**

> Updated from v0 with three shifts in the framing, all from Rob's input: (1) ring **gating** is now explicit — Ring 2 is gated by Ring 1, Ring 3 is gated by Ring 2 — and the cost stack has three dimensions, not two; (2) **Scout and IntelliNet are pulled apart** into two products with shared substrate and different commercial mechanics; (3) the **Unacast mobility partnership** opens a paid premium tier for Scout, which changes both the commercial model and the moat picture. Anywhere you see `[ROB:`, that's still an open thread.

---

## The problem CRE data has

Commercial real estate doesn't have a data quality problem. It has a data *epistemology* problem. Every datum in the industry is a byproduct of negotiation — a lease, a sale, a refinancing, a renovation, a permit — and the context that gives the datum meaning is usually not encoded with it. When the industry tries to flatten this into a database, it loses the part that mattered.

This is why CoStar, Reonomy, Attom, and a generation of "CRE data" companies have all converged on the same shape of product (subscription, gated, patchy, eventually-correct-ish) and why none of them has won the category. The fragmentation isn't a tech failure that the next platform will solve. It's structural to how the industry produces information.

The companies that *do* eventually own this category won't be the ones with the cleanest database. They'll be the ones who treat **every record as evidence with a source, a confidence level, and a verification trail**, and who build a system that gets *more* trustworthy as more humans interact with it — not less, the way scraped databases do.

That's the strategic insight behind the work we've been doing in IB Scout. The product surface (find buildings, brief them, route BD) is the visible layer. The substrate underneath — provenance + verification — is what's actually defensible.

## Three concentric rings

CRE data lives in three rings, with very different cost, coverage, and accuracy profiles. Most platforms in the market pick one and pretend the others don't exist. IB's position is unusual: we already touch all three.

**Each ring is gated by the one above it.** You can't ask the Ring 2 question (who owns this parcel?) until Ring 1 has given you a building to ask about. You can't sell a Ring 3 engagement until Ring 2 has confirmed who actually owns the building. This isn't an analytical observation — it's a mechanical constraint on the BD pipeline, and it's why the three-ring stack has to be built in order.

The cost stack has three dimensions, not two:

| Ring | Time cost | Money cost | Time-in-place |
| --- | --- | --- | --- |
| 1 — Public Surface | Low | Near zero | None |
| 2 — Transactional Record | Medium | Annual license fees | None |
| 3 — Operational Truth | High | License + install + SLA | Years |

The third axis is where Ring 3 diverges from everything above it: operational truth isn't a thing you can buy faster by spending more. It compounds with time spent inside the building. A four-year engagement has data depth a six-month engagement doesn't, and no amount of capital closes that gap.

### Ring 1 — Public Surface

What an owner says about themselves in public. Their website, their portfolio page, their press releases, their REIT 10-K, their LinkedIn.

- **Coverage:** broad. Almost every professional CRE owner publishes *something* about their portfolio publicly.
- **Accuracy:** structurally OK on names and locations, structurally weak on numbers (SF), structurally misleading on ownership (manager confused with owner, JVs hidden, recent sales not reflected).
- **Access cost:** near zero — web scraping plus an LLM.
- **Refresh cost:** near zero — re-scrape on demand.
- **Best use:** discovery, BD prospecting, "who owns what in our market," count and footprint.

This is where **Portfolio Scout** lives. The CSV import we have today is *also* Ring 1, just sourced from someone else's manual export (usually a CoStar pull). Portfolio Scout replaces "find the data, get it into a CSV, import the CSV" with "paste a URL, verify, import" — a step change in how much friction sits between a BD rep and a usable building inventory.

### Ring 2 — Transactional Record

What the public record says about a building. Deeds, assessments, permits, MLS history, court filings, environmental disclosures.

- **Coverage:** patchy by jurisdiction (Mecklenburg County's data is excellent; many counties are not), but where it exists it's authoritative.
- **Accuracy:** high for what it covers — the assessor doesn't have an incentive to lie about owner-of-record.
- **Access cost:** mid — API fees, county portal scrapes. We're moving from Attom (annual subscription, gaps in data quality) to Regrid (metered API, GeoJSON-native, parcel-anchored, cancellable) as the primary Ring 2 source, with Attom potentially retained for transaction history.
- **Refresh cost:** mid — these records update at the speed of government, which is to say slowly.
- **Best use:** verifying what Ring 1 told us, identifying recent transactions, anchoring records to a parcel ID instead of an address string.

This is where the existing **IB Scout brief** lives. The Ring 2 data is *what makes Ring 1 trustworthy* — a Portfolio Scout candidate becomes much more confident the moment its address resolves to a parcel that the assessor confirms is owned by the company the website claims it is. Moving to a parcel-anchored architecture (APN + polygon as primary key) is what unlocks the next layer.

### Ring 3 — Operational Truth

What's actually inside the building. Chiller make and vintage, BMS vendor, last commissioning date, deferred maintenance, energy use intensity, tenant comfort, vendor invoices, the lobby coffee machine.

- **Coverage:** structurally invisible from the outside. You only get this by *being inside the building*.
- **Accuracy:** the only data in CRE that's actually ground truth.
- **Access cost:** very high — requires a commercial relationship, a building audit, a BMS integration, ongoing field presence.
- **Refresh cost:** continuous, if you've earned the right to be there.
- **Time-in-place:** compounds. A six-month-old engagement has different operational depth than a four-year-old one. This is the dimension capital can't close.
- **Best use:** the operational decisions that actually move NOI — capital planning, retrofit prioritization, vendor accountability, decarbonization, anything an owner is actually willing to pay for.

Important framing distinction: Ring 3 is the *data layer* (operational truth inside buildings). **IntelliNet** is the *commercial mechanism* that gets us to Ring 3 — a tech-enabled service delivered under a 3-year auto-renewing subscription, with a connect → operate → optimize maturity curve. Keeping these distinct matters because Scout and IntelliNet are separate products even though IntelliNet is what makes our Ring 3 access possible.

### The rings are not equal

The three rings get progressively narrower in coverage and deeper in value. Ring 1 is everyone's data; Ring 3 is yours alone. The data companies that compete on Ring 1 are commodities-in-the-making. The companies that get to Ring 3 are categorical.

But Ring 3 is unreachable without Ring 1 and Ring 2, because:

- You can't sell a Ring 3 engagement without first knowing who owns the building (Ring 1) and who actually owns the building (Ring 2).
- You can't price a Ring 3 engagement without knowing the portfolio context (Ring 1) and the transaction history (Ring 2).
- You can't *prove the ROI* of a Ring 3 engagement without the comparables that only exist if you have Ring 1 + Ring 2 footprint.

**IB Scout is the discovery and qualification surface that funnels into the IntelliNet conversation.** Portfolio Scout is the front-door node — it makes the move from "owner exists in the market" to "owner has a parcel-anchored, provenance-tagged record in our system" cheap enough to happen at the pace of BD instead of the pace of manual research.

## The pattern that bridges them

The hard problem is that data from different rings, captured at different times, with different levels of trust, has to live in the same product without corrupting each other.

If a Portfolio Scout candidate says owner is "Greystar" (Ring 1, marketing surface, often wrong) and the Regrid record says owner is "BREIT - Greystar Carolinas Holdings LLC" (Ring 2, assessor, authoritative), the right behavior is *not* to overwrite Ring 2 with Ring 1 — but it's also not to discard the Ring 1 finding, because "Greystar manages this for BREIT" is itself a useful insight a rep can act on.

What we've landed on is a **provenance primitive** that every record across every ring carries:

| Field | What it captures |
| --- | --- |
| `source_url` | Where this datum came from. Re-fetchable for audit. |
| `raw_snippet` | The literal evidence — text excerpt, image URL, API response. Lets a human verify without re-running the pipeline. |
| `model` / `method` | What extracted this — Haiku, Sonnet, regex, manual entry, field assessment. |
| `confidence` | Tier or score, *derived from explicit signals* (has-address, parseable, corroborated, etc.). |
| `corroborated_by` | What other rings have confirmed this. A Ring 1 claim corroborated by Ring 2 is much more trustworthy than a lonely Ring 1 claim. |
| `reviewed_by` / `reviewed_at` | Who verified it and when. The system gets more trustworthy as the team interacts with it. |

This primitive is currently being built into `portfolio_candidates` (the Portfolio Scout staging table). But the design intent is that **every data record in every Scout feature carries the same provenance shape** — the existing AI Brief, future Ring 2 ownership reconciliation, future Ring 3 field captures. Same fields, different sources.

The reason this matters: it's the only architecture that lets us merge a scraped portfolio page with an assessor record with a field engineer's photo of a chiller nameplate, *without* any of them corrupting the others. Each piece of evidence stands on its own provenance. The product makes the trust delta visible to the human, instead of laundering everything into a single "this is true" claim.

## Two products, shared substrate

Scout and IntelliNet ride on the same data substrate (the three rings + the provenance primitive) but have different commercial mechanics. The framing has to keep them separate, because conflating them flattens the strategy.

### Scout — software

Scout is software. Marginal cost per user is near zero once built. Two tiers:

- **Free / wide-release tier.** The discovery layer (Ring 1 + Ring 2 essentials). Distributed selectively through channel partners like Stiles, or more broadly as a category-positioning play. The premise: Ring 1 commoditizes regardless of who builds it; better to be the firm that commoditized it on its own terms and made it the front door to the IB conversation.
- **Premium tier.** Analytics on geometry — daily visitor counts, trade-zone origin patterns, and the kind of asset-level intelligence an owner can't easily generate themselves. Enabled by the **Unacast mobility data partnership** and **Regrid's parcel geometry** as the join key (both APIs speak GeoJSON, so the parcel polygon flows from one to the other natively). Sold to owners and operators as a standalone subscription with concrete decisions attached: return-to-office benchmarking, amenity investment ROI, lease-marketing targeting, tenant retention diagnostics.

The premium tier is what turns Scout from an internal tool into a product. It also creates a structural barrier to entry the free tier doesn't have: a competitor needs the geometry partnership *and* the mobility partnership *and* the integration glue, not just one of the three. The Unacast relationship specifically isn't commodity — they don't sell weekend-project access.

### IntelliNet — tech-enabled service

IntelliNet is a contracted recurring service. The mechanics:

- 3-year auto-renewing subscription
- Physical install and multi-stage onboarding (connect → operate → optimize)
- IB accountable for outcomes against an SLA
- Material marginal cost per customer; the unit economics are service-firm economics, not SaaS economics
- Switching costs created by being inside the building — operationally *and* contractually

IntelliNet is the only commercial mechanism that gets us to Ring 3. The data layer (operational truth) is a byproduct of the service relationship, not something we sell separately. That's a feature, not a bug — it's what makes the moat structural.

### Why this separation matters

When we talk about "the moat," we should be specific about which moat we mean. There are three, and they have different shapes:

1. **Discovery moat (Scout free tier).** Weak by design. Anyone can build Ring 1 access; the play is to commoditize it on our terms.
2. **Analytics-on-geometry moat (Scout premium tier).** Medium. Requires the combination of parcel geometry + mobility partnership + integration. Replicable with capital and time, but not trivially. The Unacast partnership is the rate-limiter.
3. **Operational moat (IntelliNet).** Structural. Requires being inside the building for years. The defensible version of this isn't the technology — it's relationships, install base, operator track record, and the fact that **time-in-building compounds.** A four-year engagement at 110 East isn't catchable by a competitor who started yesterday, at any price.

## What this means for the moat

The competitive question: **what would a well-funded competitor have to build to displace IB Scout + IntelliNet?**

- **Ring 1 (Scout discovery):** trivial. A scraper and a Haiku key. We expect this to be commoditized; the strategy is to lead the commoditization rather than defend against it.
- **Ring 2 + premium analytics (Scout premium):** hard but doable on the data side (Regrid and Attom sell to anyone with a budget), materially harder on the analytics layer. Mobility data partnerships are not commodity. A competitor needs the relationship, the geometry, and the integration tech in combination — and the relationship is the slowest piece to acquire.
- **Ring 3 (IntelliNet):** structurally impossible without operator presence. [ROB: this is still the part I most want your fingerprints on — what's the version of "why IB owns operational truth in CRE" you'd actually say in a room? My strongest guess is: it's a combination of the Stiles partnership, the decades of operator relationships, the IntelliNet install base at properties like 110 East, and the simple fact that time-in-building compounds. But that needs your language, not mine.]

The implication: **don't compete on Ring 1**. Lead the commoditization. Compete on the analytics-on-geometry tier (where the moat is partnership-shaped) and on the IntelliNet tier (where the moat is time-shaped). Both are defensible in ways Ring 1 isn't.

## What we're explicitly not trying to be

- **Not CoStar.** Their moat is data + price + lock-in. Ours is physical presence + multi-year contracts + outcomes accountability — a different shape entirely, and not one CoStar could replicate without becoming a different company.
- **Not a parcel database.** Regrid does this. We pay them when it makes sense; we don't rebuild them.
- **Not a contact platform.** Apollo and HubSpot cover Ring 1 contact discovery. We integrate, we don't rebuild.
- **Not a CRE LLM company.** The LLM is a tool inside the pipeline, not the product. The product is the trust substrate that lets multiple data sources cohabit.
- **Not a SaaS-only company.** Scout has SaaS economics; IntelliNet has service economics. The financial story is the *combination* — software-led discovery into service-led recurring revenue — and treating either side as the whole story underrates the model.

## Open decisions

1. **Regrid trial — moving this week.** Free API trial running before the Attom trial expires. Validation criteria: owner-of-record fidelity vs. Attom on 20-30 known parcels (Mecklenburg + 1-2 other counties), polygon search for area-sweep use cases, GeoJSON-into-Supabase ingest, and building footprint quality on cases where Attom missed SF or stories. If those four check out, we have time to negotiate paid terms before the trial closes.
2. **Premium tier lead use case.** Which decision does the Unacast-powered premium tier lead with — RTO benchmarking, amenity ROI, lease-marketing support, or tenant retention diagnostics? Each has a different BD opening and a different pricing logic. [ROB: which one do you want to lead with for the May 31 USMNT event conversations? Stiles and Berkeley contacts will give us a live audience to test the pitch against.]
3. **CoStar one-time pull for dedupe seed.** Brief dismissed CoStar as overkill for ongoing use, but for the dedupe lookup table a one-time pull is "expensive once, free per query." Worth a small budget conversation.
4. **What does "v1" of Portfolio Scout actually deliver to a BD rep?** Building count + name + city + asset class is genuinely actionable. SF + broker + PM is *more* actionable but materially harder to extract. We should pick the floor explicitly so we know when we're done.

## Questions for you (Rob)

Before we share this with Shannon and the BD team:

1. **The two-products framing.** Does the Scout vs. IntelliNet separation land cleanly, or does it create a positioning problem — e.g., is it confusing for an owner who hears about Scout's free tier and IntelliNet's 3-year subscription in the same meeting? My current take is the separation actually *helps* the IntelliNet conversation by making Scout the no-pressure on-ramp, but you'd know the room better.
2. **Premium tier positioning.** Locked language from our exchange: *"Most asset teams can't tell you, with any confidence, how many people came to their building yesterday or where those visitors came from. Scout's premium tier can — parcel-by-parcel, daily, with sub-zip-code trade-zone origins — so decisions about return-to-office, amenity investment, and tenant marketing rest on observed behavior instead of speculation."* Does that lead with the right hook, or do you want a different opener?
3. **The Stiles partnership.** Probably belongs in two places in this doc: as a Ring 3 IntelliNet anchor (110 East), and as a potential channel for Scout's free tier reaching more owners. Worth a paragraph somewhere — I left it out because the framing is yours to write.
4. **Audience.** Still reads as Shannon-and-leadership register. The BD-rep version would be shorter and lead with the immediate "what this means for my Tuesday" — most directly, what a rep can offer in a conversation at the May 31 suite. Want me to draft that separately once v0.1 is settled?

---

*Next step: walk through this together, redline the framing, then tighten to a shareable one-pager. The premium tier positioning line is locked. Once the IntelliNet moat language is in your voice and the Stiles framing is in, we have something to share with Shannon.*
