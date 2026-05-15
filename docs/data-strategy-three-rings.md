# Three Rings of CRE Data — and the Pattern That Bridges Them

**Draft v0 · 2026-05-15 · Internal · For collaboration**

> This is a starting point for a conversation, not a finished doc. Anywhere you see `[ROB:`, that's a place I'm guessing about IB-specific context and want your input or correction. I've tried to leave the *structure* in place so you can edit the framing without me — the goal is a one-pager that aligns Shannon, BD, and leadership on why the work behind IB Scout matters at the level it actually does.

---

## The problem CRE data has

Commercial real estate doesn't have a data quality problem. It has a data *epistemology* problem. Every datum in the industry is a byproduct of negotiation — a lease, a sale, a refinancing, a renovation, a permit — and the context that gives the datum meaning is usually not encoded with it. When the industry tries to flatten this into a database, it loses the part that mattered.

This is why CoStar, Reonomy, Attom, and a generation of "CRE data" companies have all converged on the same shape of product (subscription, gated, patchy, eventually-correct-ish) and why none of them has won the category. The fragmentation isn't a tech failure that the next platform will solve. It's structural to how the industry produces information.

The companies that *do* eventually own this category won't be the ones with the cleanest database. They'll be the ones who treat **every record as evidence with a source, a confidence level, and a verification trail**, and who build a system that gets *more* trustworthy as more humans interact with it — not less, the way scraped databases do.

That's the strategic insight behind the work we've been doing in IB Scout. The product surface (find buildings, brief them, route BD) is the visible layer. The substrate underneath — provenance + verification — is what's actually defensible.

## Three concentric rings

CRE data lives in three rings, with very different cost, coverage, and accuracy profiles. Most platforms in the market pick one and pretend the others don't exist. IB's position is unusual: we already touch all three.

### Ring 1 — Public Surface

What an owner says about themselves in public. Their website, their portfolio page, their press releases, their REIT 10-K, their LinkedIn.

- **Coverage:** broad. Almost every professional CRE owner publishes *something* about their portfolio publicly.
- **Accuracy:** structurally OK on names and locations, structurally weak on numbers (SF), structurally misleading on ownership (manager confused with owner, JVs hidden, recent sales not reflected).
- **Access cost:** near zero — web scraping plus an LLM.
- **Refresh cost:** near zero — re-scrape on demand.
- **Best use:** discovery, BD prospecting, "who owns what in our market," count and footprint.

This is where **Portfolio Scout** lives. The CSV import we have today is *also* ring 1, just sourced from someone else's manual export (usually a CoStar pull). Portfolio Scout replaces "find the data, get it into a CSV, import the CSV" with "paste a URL, verify, import" — a step change in how much friction sits between a BD rep and a usable building inventory.

### Ring 2 — Transactional Record

What the public record says about a building. Deeds, assessments, permits, MLS history, court filings, environmental disclosures.

- **Coverage:** patchy by jurisdiction (Mecklenburg County's data is excellent; many counties are not), but where it exists it's authoritative.
- **Accuracy:** high for what it covers — the assessor doesn't have an incentive to lie about owner-of-record.
- **Access cost:** mid — API fees (Attom, Regrid, Accela), county portal scrapes.
- **Refresh cost:** mid — these records update at the speed of government, which is to say slowly.
- **Best use:** verifying what ring 1 told us, identifying recent transactions, anchoring records to a parcel ID instead of an address string.

This is where the existing **IB Scout brief** (Attom + permit history + Sonnet) lives. The ring-2 data is *what makes ring-1 trustworthy* — a Portfolio Scout candidate becomes much more confident the moment its address resolves to a parcel that the assessor confirms is owned by the company the website claims it is.

### Ring 3 — Operational Truth

What's actually inside the building. Chiller make and vintage, BMS vendor, last commissioning date, deferred maintenance, energy use intensity, tenant comfort, vendor invoices, the lobby coffee machine.

- **Coverage:** structurally invisible from the outside. You only get this by *being inside the building*.
- **Accuracy:** the only data in CRE that's actually ground truth.
- **Access cost:** very high — requires a commercial relationship, a building audit, a BMS integration, ongoing field presence.
- **Refresh cost:** continuous, if you've earned the right to be there.
- **Best use:** the operational decisions that actually move NOI — capital planning, retrofit prioritization, vendor accountability, decarbonization, anything an owner is actually willing to pay for.

This is where **IntelliNet** lives. [ROB: confirm framing — the way I think about it is that IntelliNet is the only product in the market that gets to ring 3 at scale, because IB is the only operator that has earned the right to be inside the buildings. If that's not how you'd frame it for Shannon, let's adjust.]

### The rings are not equal

The three rings get progressively narrower in coverage and deeper in value. Ring 1 is everyone's data; ring 3 is yours alone. The data companies that compete on ring 1 are commodities-in-the-making. The companies that get to ring 3 are categorical.

But ring 3 is unreachable without ring 1 and ring 2, because:

- You can't sell a ring-3 engagement without first knowing who owns the building (ring 1) and who actually owns the building (ring 2).
- You can't price a ring-3 engagement without knowing the portfolio context (ring 1) and the transaction history (ring 2).
- You can't *prove the ROI* of a ring-3 engagement without the comparables that only exist if you have ring-1 + ring-2 footprint.

**IB Scout is BD plumbing for IntelliNet.** Its job is to make the path from "owner exists in the market" to "owner is in an IntelliNet engagement" as short as possible. Portfolio Scout is the discovery node at the front of that path.

## The pattern that bridges them

The hard problem is that data from different rings, captured at different times, with different levels of trust, has to live in the same product without corrupting each other.

If a Portfolio Scout candidate says owner is "Greystar" (ring 1, marketing surface, often wrong) and the Attom record says owner is "BREIT - Greystar Carolinas Holdings LLC" (ring 2, assessor, authoritative), the right behavior is *not* to overwrite ring 2 with ring 1 — but it's also not to discard the ring-1 finding, because "Greystar manages this for BREIT" is itself a useful insight a rep can act on.

What we've landed on is a **provenance primitive** that every record across every ring carries:

| Field | What it captures |
| --- | --- |
| `source_url` | Where this datum came from. Re-fetchable for audit. |
| `raw_snippet` | The literal evidence — text excerpt, image URL, API response. Lets a human verify without re-running the pipeline. |
| `model` / `method` | What extracted this — Haiku, Sonnet, regex, manual entry, field assessment. |
| `confidence` | Tier or score, *derived from explicit signals* (has-address, parseable, corroborated, etc.). |
| `corroborated_by` | What other rings have confirmed this. A ring-1 claim corroborated by ring-2 is much more trustworthy than a lonely ring-1 claim. |
| `reviewed_by` / `reviewed_at` | Who verified it and when. The system gets more trustworthy as the team interacts with it. |

This primitive is currently being built into `portfolio_candidates` (the Portfolio Scout staging table). But the design intent is that **every data record in every Scout feature carries the same provenance shape** — the existing AI Brief, future ring-2 ownership reconciliation, future ring-3 field captures. Same fields, different sources.

The reason this matters: it's the only architecture that lets us merge a scraped portfolio page with an assessor record with a field engineer's photo of a chiller nameplate, *without* any of them corrupting the others. Each piece of evidence stands on its own provenance. The product makes the trust delta visible to the human, instead of laundering everything into a single "this is true" claim.

## What this means for Portfolio Scout

- It's deliberately scoped to ring 1.
- It's deliberately not trying to be CoStar 2.0 or Reonomy.
- The "Approve" action doesn't just write a row — it writes a row with full provenance, so the next layer (ring-2 reconciliation) has something to reconcile against.
- The "Duplicate" action is being designed as `merge` instead of `discard`, because the *delta* between what the website says and what Scout already knows is itself a BD signal.
- The mock-first / validation-gate approach we're taking right now is a deliberate forcing function: prove the substrate works end-to-end before investing in the extraction pipeline, because the substrate is the thing that has to be right.

## What this means for the moat

The competitive question to think clearly about: **what would a well-funded competitor have to build to displace IB Scout + IntelliNet?**

- Ring 1: trivial. A scraper and a Haiku key. Anyone can build this.
- Ring 2: hard but doable. Attom and Regrid sell the data to anyone who pays.
- Ring 3: structurally impossible without operator presence. [ROB: this is the part I most want your fingerprints on — what's the *defensible* version of why IB owns ring 3 that doesn't sound like sales-speak? Is it the Stiles partnership? The decades of operator relationships? The IntelliNet install base? Some combination?]

The implication: **don't compete on ring 1**. Build it well enough to be a credible front door, but recognize that ring 1 commoditizes fast and the moat lives below it. Every architecture decision in Portfolio Scout — provenance primitive, verification UX, mock-first validation — should be evaluated against "does this make ring-2 and ring-3 integration easier later?"

## What we're explicitly not trying to be

- **Not CoStar.** CoStar's product is comprehensive, expensive, and used by everyone. We don't want their model. We want a leaner BD surface that points at IntelliNet engagements.
- **Not a parcel database.** Regrid does this. We pay them when it makes sense; we don't rebuild them.
- **Not a contact platform.** Apollo and HubSpot already cover ring-1 contact discovery. We integrate, we don't rebuild.
- **Not a CRE LLM company.** The LLM is a tool inside the pipeline, not the product. The product is the trust substrate that lets multiple data sources cohabit.

## Open decisions

1. **PM and broker enrichment scope.** These aren't on owner portfolio pages and require a separate per-building enrichment pipeline. Decision: is this in scope for Portfolio Scout v1, or a follow-up workstream? See `portfolio-scout-decision-log.md` for the technical detail.
2. **Regrid / Reonomy timing.** Parcel-anchored dedupe is structurally better than address-string dedupe. The Regrid evaluation has been "pending" for a while. If it's a yes in the next 30 days, several v1 architecture choices simplify. [ROB: what's the actual state of that conversation?]
3. **CoStar one-time pull for dedupe seed.** Brief dismissed CoStar as overkill, but for the dedupe lookup table, a one-time pull is "expensive once, free per query." Worth a small budget conversation.
4. **What does "v1" of Portfolio Scout actually deliver to a BD rep?** Building count + name + city + asset class is genuinely actionable. SF + broker + PM is *more* actionable but materially harder to extract. We should pick the floor explicitly so we know when we're done.

## Questions for you (Rob)

Before we tighten this into something Shannon and the BD team see:

1. **Is the three-rings framing the right level of abstraction?** Too academic? Too obvious to the people who already live in this industry? Should it lead with a sharper claim?
2. **The "BD plumbing for IntelliNet" framing.** Is that the right way to position IB Scout internally, or does it underrate it? I wrote it that way deliberately — to make IB Scout's job legible — but you'd know better whether that hits or undersells.
3. **The IntelliNet ring-3 moat.** I want your language here, not mine. What's the version of "why IB owns operational truth in CRE" that you'd actually say in a room?
4. **What's missing?** The Stiles partnership probably deserves a place in the framing. So does the historical reason IB ended up with the position it has. I left those out because I'd rather have you write them than guess.
5. **Audience.** Is this for Shannon? For leadership? For BD reps? Each lands differently — the doc above is closer to "Shannon-and-leadership" register. If the BD reps need a version, it'd be shorter and lead with the immediate "what this means for my Tuesday" use case.

---

*Next step: walk through this together, redline the framing, then tighten to a shareable one-pager. Once the framing is set, every subsequent piece of Scout work (and the data model for what comes after Portfolio Scout) has a north star to point at.*
