# Three Rings of CRE Data — and the Pattern That Bridges Them

**Draft v0.2 · 2026-05-16 · Internal · For collaboration**

> Updated from v0.1 with the changes that came out of Rob's pass: (1) the **Fourth Utility** vision is now threaded through — the terminal state of Ring 3 access isn't "operational data," it's owner-controlled infrastructure that becomes part of how the building *is*; (2) **how the Fourth Utility actually gets funded** has its own section, because the framing only works if the commercial mechanic is credible (Optimize funds Operate, Ring 2 evidence underwrites the pitch); (3) a **stakeholder map** because CRE decisions never go through one person and v0.1 was implicitly addressed to a single audience; (4) **mobility analytics use cases by asset class**, because the capability is asset-class-agnostic but the pitch isn't; (5) reviewer fixes — time-in-place hoisted to its own paragraph, substrate-first preamble on the two-products section, IntelliNet moat language in Rob's voice, May 31 lead set to RTO benchmarking, Stiles paragraphs added in both places. `[ROB:` callouts that remain are genuinely open, not unresolved-from-last-round.

---

## The problem CRE data has

Commercial real estate doesn't have a data quality problem. It has a data *epistemology* problem. Every datum in the industry is a byproduct of negotiation — a lease, a sale, a refinancing, a renovation, a permit — and the context that gives the datum meaning is usually not encoded with it. When the industry tries to flatten this into a database, it loses the part that mattered.

This is why CoStar, Reonomy, Attom, and a generation of "CRE data" companies have all converged on the same shape of product (subscription, gated, patchy, eventually-correct-ish) and why none of them has won the category. The fragmentation isn't a tech failure that the next platform will solve. It's structural to how the industry produces information.

The companies that *do* eventually own this category won't be the ones with the cleanest database. They'll be the ones who treat **every record as evidence with a source, a confidence level, and a verification trail**, and who build a system that gets *more* trustworthy as more humans interact with it — not less, the way scraped databases do.

But there's a second insight underneath the data one, and it's the one that turns this from a data-platform story into a structural CRE business: the firms that get to operational truth (Ring 3) don't just have better data — they end up **building infrastructure inside the asset**. Connectivity, access control, building systems integration, monitoring: owner-controlled, persistent, integrated into how the building operates. IB calls this the **Fourth Utility**, alongside power, water, and gas. It's the terminal state of what Ring 3 access becomes when it's done right.

That's the strategic insight behind the work we've been doing in IB Scout. The product surface (find buildings, brief them, route BD) is the visible layer. The substrate underneath — provenance + verification — is what makes the data trustworthy. And the destination, the thing the substrate is the on-ramp to, is the installed base of Fourth Utility deployments that compound the moat over time.

## Three concentric rings

CRE data lives in three rings, with very different cost, coverage, and accuracy profiles. Most platforms in the market pick one and pretend the others don't exist. IB's position is unusual: we already touch all three.

**Each ring is gated by the one above it.** You can't ask the Ring 2 question (who owns this parcel?) until Ring 1 has given you a building to ask about. You can't sell a Ring 3 engagement until Ring 2 has confirmed who actually owns it. This isn't an analytical observation — it's a mechanical constraint on the BD pipeline, and it's why the three-ring stack has to be built in order.

**The cost stack has three dimensions, not two.** Time and money are the dimensions every data provider competes on. The third — **time-in-place** — is where Ring 3 diverges from everything above it. Operational truth isn't a thing you can buy faster by spending more. It compounds with time spent inside the building. A four-year engagement has data depth a six-month engagement doesn't, and no amount of capital closes that gap. This is the load-bearing claim under everything that follows, including the moat story.

| Ring | Time cost | Money cost | Time-in-place |
| --- | --- | --- | --- |
| 1 — Public Surface | Low | Near zero | None |
| 2 — Transactional Record | Medium | Annual license fees | None |
| 3 — Operational Truth | High | License + install + SLA | Years |

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
- **Access cost:** mid — API fees, county portal scrapes. Moving from Attom (annual subscription, gaps in data quality) to Regrid (metered API, GeoJSON-native, parcel-anchored, cancellable) as the primary Ring 2 source, with Attom potentially retained for transaction history.
- **Refresh cost:** mid — these records update at the speed of government, which is to say slowly.
- **Best use:** verifying what Ring 1 told us, identifying recent transactions, anchoring records to a parcel ID instead of an address string — *and* underwriting the commercial pitch for Ring 3 engagements (see "How the Fourth Utility actually gets funded" below).

Ring 2 does more work than v0.1 gave it credit for. It's not just the verification layer for Ring 1 — it's the **evidence layer** for the BD conversation. Public records contain permit history (revealing deferred capex), assessor records (revealing asset age and likely systems vintages), transaction history (revealing when the asset was last underwritten and what the pro-forma assumed), and tax assessments (revealing operating expense baselines visible to buyers and refinance lenders). A BD rep with a Ring 2 brief can credibly underwrite the IntelliNet pitch before ever being inside the building.

### Ring 3 — Operational Truth

What's actually inside the building. Chiller make and vintage, BMS vendor, last commissioning date, deferred maintenance, energy use intensity, tenant comfort, vendor invoices, the lobby coffee machine.

- **Coverage:** structurally invisible from the outside. You only get this by *being inside the building*.
- **Accuracy:** the only data in CRE that's actually ground truth.
- **Access cost:** very high — requires a commercial relationship, a building audit, a BMS integration, ongoing field presence.
- **Refresh cost:** continuous, if you've earned the right to be there.
- **Time-in-place:** compounds. A six-month-old engagement has different operational depth than a four-year-old one. This is the dimension capital can't close.
- **Best use:** the operational decisions that actually move NOI — capital planning, retrofit prioritization, vendor accountability, decarbonization, anything an owner is willing to underwrite.

The important reframing in v0.2: **Ring 3 data isn't extracted from operating relationships — it's the data exhaust of installed infrastructure.** IB doesn't run consulting engagements that happen to generate insight. IB installs the Fourth Utility (connectivity, access control, systems integration, monitoring) and the operational data is what flows through it. That's a stronger structural claim than "we're inside the building" because it makes the asset itself the producer of the data. The building becomes instrumented; the instruments produce the truth.

**IntelliNet** is the commercial mechanism that gets us to Ring 3 and ultimately to the Fourth Utility installed state. It's delivered in two tiers — **IntelliNet Operate** (running the infrastructure once installed) and **IntelliNet Optimize** (identifying operational inefficiencies and savings that fund the rest of the engagement). The Optimize/Operate relationship is what makes the Fourth Utility achievable in real CRE economics, and it gets its own section below.

**The Stiles partnership** is the foundational example. 110 East and the broader Stiles operating footprint give IntelliNet a real operating canvas with a real owner counterparty. The data and operational learnings that come out of that engagement aren't reproducible from the outside — they're the byproduct of years of joint operation. That kind of installed-and-integrated history is what other firms are competing against when they try to enter Ring 3 from a standing start.

### The rings are not equal

The three rings get progressively narrower in coverage and deeper in value. Ring 1 is everyone's data; Ring 3 is yours alone. The data companies that compete on Ring 1 are commodities-in-the-making. The companies that get to Ring 3 are categorical. The companies that turn Ring 3 access into an installed utility are structural.

But Ring 3 is unreachable without Ring 1 and Ring 2, because:

- You can't sell a Ring 3 engagement without first knowing who owns the building (Ring 1) and who actually owns the building (Ring 2).
- You can't underwrite the commercial pitch for Ring 3 without Ring 2 evidence on permit history, asset age, and OpEx baselines.
- You can't *prove the ROI* of a Ring 3 engagement without the comparables that only exist if you have Ring 1 + Ring 2 footprint.

**IB Scout is the discovery and qualification surface that funnels into the Fourth Utility conversation.** Portfolio Scout is the front-door node — it makes the move from "owner exists in the market" to "owner has a parcel-anchored, provenance-tagged record in our system" cheap enough to happen at the pace of BD instead of the pace of manual research.

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

Both products sit on the three-rings architecture and the provenance primitive described above. They diverge only in how deep into the stack they reach and how they monetize what they find there. The separation matters because Scout has SaaS economics and IntelliNet has service-firm economics — and conflating the two flattens the strategy in a way that breaks both the pitch and the pricing logic.

### Scout — software

Scout is software. Marginal cost per user is near zero once built. Two tiers:

- **Free / wide-release tier.** The discovery layer (Ring 1 + Ring 2 essentials). Distributed selectively through channel partners like Stiles, or more broadly as a category-positioning play. The premise: Ring 1 commoditizes regardless of who builds it; better to be the firm that commoditized it on its own terms and made it the front door to the IB conversation. **Stiles is the natural first deployment** of this tier — a partner relationship where Scout can land in the hands of an owner-operator we already work with, prove value, and create the conversation that escalates into the premium tier or into an IntelliNet engagement. The same channel pattern replicates with other strategic operator relationships.
- **Premium tier.** Analytics on geometry — daily visitor counts, trade-zone origin patterns, asset-level intelligence an owner can't easily generate themselves. Enabled by the **Unacast mobility data partnership** and **Regrid's parcel geometry** as the join key (both APIs speak GeoJSON, so the parcel polygon flows from one to the other natively). Sold to owners and operators as a standalone subscription with concrete decisions attached — RTO benchmarking, amenity ROI, lease-marketing targeting, tenant retention diagnostics. *Asset-class-specific use cases are detailed below.*

The premium tier is what turns Scout from an internal tool into a product. It also creates a structural barrier to entry: a competitor needs the geometry partnership *and* the mobility partnership *and* the integration glue, not just one of the three. The Unacast relationship specifically isn't commodity — they don't sell weekend-project access.

### IntelliNet — tech-enabled service, on the path to a utility

IntelliNet is a contracted recurring service that operates and optimizes building infrastructure, with the longer arc of becoming part of the building's permanent operating fabric — the Fourth Utility. The mechanics:

- 3-year auto-renewing subscription
- Physical install and multi-stage onboarding (connect → operate → optimize)
- Delivered in two integrated tiers: **IntelliNet Operate** (running the infrastructure, vendor accountability, day-to-day system management) and **IntelliNet Optimize** (continuous identification of operational inefficiencies, energy waste, deferred-maintenance avoidance, vendor overcharge recovery)
- IB accountable for outcomes against an SLA
- Material marginal cost per customer; the unit economics are service-firm economics, not SaaS economics
- Switching costs created by being inside the building — operationally, contractually, *and increasingly, physically*, as the Fourth Utility install matures into integrated infrastructure

IntelliNet is the only commercial mechanism that gets us to Ring 3 and ultimately to the installed Fourth Utility state. The data layer (operational truth) is a byproduct of the service relationship, not something we sell separately. That's a feature, not a bug — it's what makes the moat structural.

### Why this separation matters

When we talk about "the moat," we should be specific about which moat we mean. There are three, and they have different shapes:

1. **Discovery moat (Scout free tier).** Weak by design. Anyone can build Ring 1 access; the play is to commoditize it on our terms.
2. **Analytics-on-geometry moat (Scout premium tier).** Medium. Requires the combination of parcel geometry + mobility partnership + integration. Replicable with capital and time, but not trivially. The Unacast partnership is the rate-limiter.
3. **Operational + utility moat (IntelliNet, terminal state Fourth Utility).** Structural. Requires being inside the building for years, and increasingly requires displacing physical infrastructure once it's installed. The defensible version isn't the technology — it's *access*, and access in this industry compounds.

## How the Fourth Utility actually gets funded

The Fourth Utility framing is conceptually clean but commercially aspirational on its own. Power, water, and gas are line items every CRE CFO expects to see. The Fourth Utility *isn't* — at least not at the start of the relationship. Pretending otherwise has the doc selling a vision that doesn't survive contact with the operating budget cycle.

The real commercial story is sharper: **IntelliNet doesn't get added to the operating budget. It pays for itself out of it.**

- **IntelliNet Optimize** identifies the savings: operational inefficiencies, vendor overcharges, energy waste, deferred-maintenance avoidance, capex sequencing improvements. These aren't aspirational ROI claims — they're identifiable line items pulled out of the building's existing OpEx.
- **IntelliNet Operate** runs the infrastructure, funded substantially by what Optimize has freed up. The first contract is engineered to be budget-neutral by year one or two, not additive spend on top of the existing budget.
- Once the offset is established, the Fourth Utility framing becomes credible to a CFO. The owner can see the line item paying for itself, and gradually accept it as infrastructure rather than discretionary spend. By year three, the renewal isn't "do we keep paying for this service" — it's "do we rip out infrastructure that's now load-bearing in our operations."

This is what makes the auto-renew structure credible. Without the Optimize-funds-Operate mechanic, a 3-year auto-renewing contract reads to a sophisticated CFO as "you want me to add a recurring expense I don't have today." With it, the contract is reframed: *not new spend, reallocated spend, with infrastructure on top.*

**Ring 2 is the underwriting layer that makes this pitch credible before we're inside the building.** A BD rep with a Ring 2 brief can walk into a meeting and credibly say: *"Based on the public record, your BMS is likely 12 years old, your last major capex was 2019, your reported OpEx is running 8% above the market comp set. We can show you, within 60 days of a no-cost assessment, exactly where the savings are — and structure an engagement that's self-funding by year two."* That's a fundamentally different opening than "we have a service we'd like to sell you," and it requires the Ring 2 evidence stack to be real, not invented in the meeting.

The implication for the doc and for the product roadmap: **the Ring 2 evidence brief is a first-class BD artifact**, not a sidecar to Portfolio Scout. It earns its own design attention as the deliverable a rep walks into a meeting holding.

## Who buys this — and what each stakeholder cares about

CRE decisions never go through one person. The Fourth Utility / Optimize-funds-Operate story has to land differently across at least five roles, each with different objections, time horizons, and incentives. A BD rep who pitches all five the same way will lose four of them.

| Stakeholder | What they care about | What lands for them | What they'll object to |
| --- | --- | --- | --- |
| **Asset manager** | NOI, lease performance, tenant retention, deal at refi/sale | RTO benchmarking, operational savings, evidence for renewal conversations, mobility analytics premium tier | Anything that reads as long-horizon vision instead of "what does this do for my building this year" |
| **Property manager / operator** | Uptime, vendor accountability, defensibility of operating decisions, easier daily workflow | IntelliNet Operate as the daily experience; Ring 3 data as *their* data; vendor accountability as a feature not a threat | Disruption during install; loss of control over vendor relationships they've built |
| **CFO / finance lead** | Operating budget impact, contract structure, credibility of savings claims, exposure on auto-renew | Optimize-funds-Operate with Ring 2 evidence underwriting it; contract structure that's self-funding by year two; specific OpEx line items, not aspirational ROI | Anything that smells like soft savings, vendor-supplied ROI math, or claims that don't tie to GL accounts they can audit |
| **Capital partner / institutional investor** | Portfolio-level value preservation, ESG reporting, refinance/sale defensibility, long-hold operational story | Fourth Utility framing as long-term value driver; portfolio-level operational intelligence; comp-set positioning | Anything that looks like one-off operational tinkering rather than a portfolio-grade thesis |
| **Executive / owner / CEO** | Strategic positioning, peer comparison, asset-level risk, firm narrative | Competitive comp-set evidence ("your peers are doing this"); risk framing ("your assets are exposed without it"); the Fourth Utility framing as differentiation | Anything that feels operational rather than strategic; pitches that don't acknowledge they're already busy |

The CFO row is where most deals are won or lost. The asset manager and PM are the daily relationship; the CFO is the gatekeeper. The Ring 2 evidence brief is built primarily for the CFO conversation, even though the asset manager will read it first.

The executive / owner row is where the Fourth Utility framing does its heaviest lifting. They're the audience that can hear "owner-controlled infrastructure as a long-term value driver" as a strategic claim rather than a sales pitch.

## Mobility analytics use cases by asset class

The premium tier's underlying capability — parcel-anchored mobility data via Unacast on Regrid polygons — is **asset-class-agnostic**. The pitch isn't. A BD rep walking into different asset classes needs different framings of the same data product.

- **Office.** RTO benchmarking is the lead use case. Five years post-COVID, almost every office owner is still recalibrating, and nobody has a confident answer. Supporting cases: amenity ROI (does the lobby renovation justify itself in visit patterns?), tenant marketing intelligence (which submarkets do my building's visitors come from?), lease-renewal evidence (showing a tenant their employees are coming back at higher rates than the market). Visitor counts are moderately useful on their own; *trends and comparisons* are what move decisions. **This is the lead for the May 31 USMNT suite conversations.**
- **Multifamily.** Different game. Owners care less about absolute counts, more about *resident behavior patterns and trade-area dynamics*: where do my residents work and shop, how does that compare to my comp set, what does that tell me about retention risk and pricing power? Strong fit because residential trade areas are diffuse and hard to characterize without observed behavior. The pitch: *"we can tell you why your residents chose this building over the one down the street — and whether that's changing."*
- **Retail / mixed-use.** Mobility data's home turf. Visitor counts, dwell time, trade-zone origins, conversion-adjacent metrics. The owner-side version (vs. the tenant-side version retail brokers already pitch) is **cross-property comparison**: how is your asset performing vs. your other assets, vs. the market? Useful for asset management, capital allocation, and tenant-mix decisions.
- **Medical office (MOB).** Closer to retail than to office. Patient-visit patterns, referral catchment analysis, comparison across a MOB portfolio. Strong fit. *Relevant given Woodside Health is a top SQL and the Bisnow Healthcare Conference pipeline.* The pitch is "we tell you where your patients are actually coming from vs. where you think they are."
- **Industrial / logistics.** Weakest fit for mobility data as currently scoped. Worker counts are operational rather than strategic; trade-zone origins matter less because the workforce is local. There's an adjacent play in truck and freight movement patterns, which Unacast and similar providers handle separately — probably out of scope for v1 premium tier, worth flagging as a vertical extension later.
- **Life sciences / lab.** Mobility data isn't the lead. Building systems intelligence is — specialty utilities, redundancy, real-time monitoring. The Fourth Utility framing actually lands hardest in this asset class because the operational requirements are so specialized. The premium tier's analytics layer isn't the on-ramp here; the IntelliNet capability story is.

The structural point: **mobility data is the on-ramp; the Fourth Utility is the destination.** The premium tier sells visibility — analytics on geometry the owner couldn't easily generate themselves. The IntelliNet engagement sells infrastructure that delivers the visibility *plus* operational control, and ultimately becomes part of how the building runs. An owner who buys the premium tier and finds it useful is an owner who's already experienced what asset-level intelligence feels like, and is ready for the conversation about making it persistent and integrated.

## What this means for the moat

The competitive question to think clearly about: **what would a well-funded competitor have to build to displace IB Scout + IntelliNet?**

- **Ring 1 (Scout discovery):** trivial. A scraper and a Haiku key. We expect this to be commoditized; the strategy is to lead the commoditization rather than defend against it.
- **Ring 2 + premium analytics (Scout premium):** hard but doable on the data side (Regrid sells to anyone with a budget), materially harder on the analytics layer. Mobility data partnerships are not commodity. A competitor needs the relationship, the geometry, and the integration tech in combination — and the relationship is the slowest piece to acquire.
- **Ring 3 + Fourth Utility (IntelliNet):** structural. Operational truth in CRE isn't a content problem; it's an access problem, and access in this industry compounds. IB doesn't extract Ring 3 data from its relationships — we accumulate it as a byproduct of operating them, year after year. The Stiles partnership and the IntelliNet install base at properties like 110 East aren't entries in a CRM; they're the foundation of a multi-decade operator track record that, in this industry, can't be bought, traded, or recreated. The technology version of this moat is weaker because anyone with capital can build similar tech. The access version is harder to dismiss — and once installed infrastructure starts behaving as a utility, displacement requires rip-and-replace, not just a better contract.

The implication: **don't compete on Ring 1**. Lead the commoditization. Compete on the analytics-on-geometry tier (where the moat is partnership-shaped) and on the IntelliNet tier (where the moat is access-shaped and time-shaped, with the Fourth Utility installed state as the long-run lock-in). Both are defensible in ways Ring 1 isn't.

## What we're explicitly not trying to be

- **Not CoStar.** Their moat is data + price + lock-in. Ours is physical presence + multi-year contracts + outcomes accountability + eventually-installed infrastructure — a different shape entirely, and not one CoStar could replicate without becoming a different company.
- **Not a parcel database.** Regrid does this. We pay them when it makes sense; we don't rebuild them.
- **Not a contact platform.** Apollo and HubSpot cover Ring 1 contact discovery. We integrate, we don't rebuild.
- **Not a CRE LLM company.** The LLM is a tool inside the pipeline, not the product. The product is the trust substrate that lets multiple data sources cohabit.
- **Not a SaaS-only company.** Scout has SaaS economics; IntelliNet has service economics with a utility-installation arc. The financial story is the *combination* — software-led discovery into service-led recurring revenue into installed-infrastructure permanence. Treating any single layer as the whole story underrates the model.
- **Not a savings consultancy.** Optimize finds the savings, but the savings are how the Fourth Utility gets funded — not the product itself. A competitor who pitches "we'll find you operational savings" without the installed infrastructure arc is building a different (and weaker) business.

## Open decisions

1. **Regrid trial — moving this week.** Free API trial running before the Attom trial expires. Validation criteria: owner-of-record fidelity vs. Attom on 20-30 known parcels (Mecklenburg + 1-2 other counties), polygon search for area-sweep use cases, GeoJSON-into-Supabase ingest, and building footprint quality on cases where Attom missed SF or stories. If those four check out, we have time to negotiate paid terms before the trial closes.
2. **May 31 tablet-demo decision.** Build a working premium-tier demo (RTO benchmarking lead) over 5-10 Stiles-relevant buildings for the May 31 USMNT suite, using Regrid trial polygons + a placeholder mobility layer? It's a ~2-week scope, separable from full Portfolio Scout v1. Gating criterion: by week 1 end, can we produce a *credible* tablet view for one Stiles building? If yes, scale to 5-10. If no, pull back and run May 31 verbally. `[ROB: decision needed by end of week so engineering can sequence.]`
3. **Ring 2 evidence brief as a first-class artifact.** v0.2 elevated this from sidecar to centerpiece for the CFO conversation. The product implication: it needs its own design pass, separate from Portfolio Scout's verification UX. Template format, data fields, refresh cadence, and how it gets generated (on-demand vs. pre-computed for target accounts) are open.
4. **CoStar one-time pull for dedupe seed.** Brief dismissed CoStar as overkill for ongoing use, but for the dedupe lookup table a one-time pull is "expensive once, free per query." Worth a small budget conversation.
5. **What does "v1" of Portfolio Scout actually deliver to a BD rep?** Building count + name + city + asset class is genuinely actionable. SF + broker + PM is *more* actionable but materially harder to extract. We should pick the floor explicitly so we know when we're done.

## Questions for you (Rob)

Most of what was open in v0.1 has now landed. What's left:

1. **The Optimize-funds-Operate framing.** I've described it as "engineered to be budget-neutral by year one or two" with savings underwriting Operate. Is that the right time horizon to claim in writing, or is it more conservative in practice (year two or three)? The CFO row in the stakeholder map lives or dies on this number being defensible.
2. **The Fourth Utility framing — how aggressively do we lead with it externally?** Internally it's the north star. Externally, for an asset-manager-first conversation (most opening meetings), it might land as too visionary too early. My current placement has it as the strategic frame in the doc but with stakeholder-specific surface pitches that don't lead with it for asset managers and PMs. Confirm that's right, or push back.
3. **The stakeholder map's CFO row.** It's the most consequential row in the table and the one I'm least confident I got right. Specifically the "what they'll object to" column — what are the *actual* CFO objections you've heard in real meetings? The current entries are inferred, not observed.
4. **BD-rep version timing.** Ready to draft once you sign off on v0.2. Recommend doing it before May 31 so a rep walking into the suite has the conversational version in their head. Want me to start that on a fresh branch, or wait until after May 31 conversations to see what actually lands?

---

*Next step: walk through v0.2 together. The substantive framing is now substantially in your voice and addresses the gaps the reviewer surfaced plus the Fourth Utility and funding-model insights. Once the four remaining questions land, this is shareable with Shannon and is the source-of-truth for everything downstream — the BD-rep version, the May 31 demo narrative, and the Ring 2 evidence brief template.*
