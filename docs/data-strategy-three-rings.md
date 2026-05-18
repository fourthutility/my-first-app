# Three Rings of CRE Data — and the Pattern That Bridges Them

**Draft v0.3.1 · 2026-05-16 · Internal · For collaboration**

> Updated from v0.2 with six changes from Rob's second pass and the reviewer's CFO-grade feedback: (1) the Optimize-funds-Operate language is **hedged in operator voice**, not vendor-confident; (2) a new **Pitch Sequencing** section maps the stakeholder map onto an actual call plan; (3) the CFO row's objections are now the **five canonical ones** a sophisticated CRE CFO actually raises, not the soft-savings strawman; (4) the funding section is expanded into **"How the Fourth Utility actually pays"** — covering OpEx offset, NOI uplift, asset value creation (leveraged + unleveraged), and the new-construction case where the economics are categorically different; (5) **Property Management** replaces "PM" throughout, because PM gets confused with Project Management in the operator world; (6) BD-rep version drafting moves to this branch, day v0.3 closes. Worked-example numbers in the returns section are illustrative pending the per-asset calculator (post-May 31 deliverable). v0.3.1 patch: Ring 1 extraction scope made explicit — three confidence tiers, Ring 1 → Ring 2 reconciliation pattern, and Portfolio Scout v1 "done" floor.

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

#### What we're actually extracting from Ring 1

The Ring 1 section above describes the *category* of data (what an owner says about themselves in public). This section names the specific fields Portfolio Scout is trying to extract, organized by how reliably each field comes off a typical professional CRE owner portfolio page. The tiering matters because it determines what Portfolio Scout v1 is *done* at, and it determines which fields gracefully degrade when Ring 2 is missing.

**Tier 1 — High confidence. Reliable on most professional CRE owner sites.**

- Building / property name
- Street address (street, city, state)
- Asset class (office, multifamily, retail, industrial, MOB, lab, mixed-use)
- Hero image / property photo
- Short marketing description or positioning blurb

This tier is the **floor for Portfolio Scout v1**. A BD rep handed nothing more than these fields across an owner's full portfolio still has a genuinely actionable artifact: *"Greystar's Charlotte portfolio includes 12 multifamily buildings, ~3,400 units, here are the addresses and asset classes."* That's a real BD output, and it's the version of v1 we can confidently call complete.

**Tier 2 — Medium confidence. Present on roughly 60-70% of professional owner sites, but with quality variance that matters.**

- Building square footage (often present, but rentable vs. gross is frequently ambiguous)
- Year built / year renovated
- Number of units (multifamily) or number of floors (office)
- **Property Management firm** — when shown, often present as a logo, a "managed by" phrase, or a contact reference. *This field is promoted to Tier 1 priority for Scout's extraction logic given IB's channel strategy runs heavily through Property Management relationships (Stiles being the foundational example). The reliability of detection is medium, but the BD value is high — worth investing in extraction quality even when the underlying signal is patchy.*
- Leasing broker name and firm
- Submarket / neighborhood designation

This tier is **Portfolio Scout v1.5 territory** — extracted when available, presented with explicit confidence indicators, and *overwritten by Ring 2 when Ring 2 has a more authoritative version* (the assessor knows year built; the website's claim is decorative).

**Tier 3 — Low confidence. Inconsistent across owners, often missing entirely, sometimes deliberately obscured.**

- Specific ownership entity (the website shows the brand "Greystar"; the actual title-holder LLC "BREIT - Greystar Carolinas Holdings LLC" is a Ring 2 question)
- Current occupancy / lease-up status
- Recent transaction history
- Major tenant list (sometimes shown, often outdated)
- Amenity detail at a level granular enough to compare across buildings

Tier 3 is **not part of Portfolio Scout v1's done criteria**. Where Ring 1 surfaces these fields, capture them with provenance and low confidence, but don't make v1's completeness depend on them. Most of these resolve more cleanly from Ring 2 anyway.

#### The Ring 1 → Ring 2 reconciliation pattern

A field appearing in both Ring 1 (the owner's website) and Ring 2 (the assessor record) doesn't mean we have to choose. The provenance primitive lets both live in the system simultaneously, with the *trust delta visible to the human*. The architectural pattern:

- **Extract from Ring 1 first.** Haiku pass on the portfolio page produces the candidate fields with `source_url`, `raw_snippet`, and a confidence score derived from explicit signals.
- **Query Ring 2 when available.** Regrid parcel lookup returns the authoritative version of fields it covers (owner-of-record, year built, square footage from the assessor's perspective, lot size, building footprint).
- **Store both, mark the delta.** The provenance primitive's `corroborated_by` field captures agreement; disagreements become explicit (e.g., website says 250,000 SF, assessor says 247,300 SF — both stored, the rep sees the delta).
- **Default the displayed value to Ring 2 when present, Ring 1 when Ring 2 is missing.** This makes Portfolio Scout *gracefully degrade* in jurisdictions where Ring 2 is patchy (rural counties, weak assessor data) and *gracefully upgrade* the moment Ring 2 lands. Same provenance shape either way.

The reason this matters for the substrate: it means Portfolio Scout works on its own *and* gets better the moment Ring 2 is plumbed in, without any reconciliation logic having to be reinvented. The provenance primitive is doing the work the rest of the architecture is supposed to lean on.

#### Site patterns A–D (what Ring 1 actually looks like in the wild)

Pre-flight investigation of owner-operator portfolio pages turned up four recurring shapes. Portfolio Scout's tier cascade handles A–C inside Ring 1; **Pattern D is structurally outside Ring 1's reach** and is the cleanest case for "Ring 2 was always the right answer here."

- **Pattern A — Server-rendered HTML cards** (rare, the dream case). Inventory is in plain `<article>`/`<div>` blocks with text content. Static fetch + Haiku extracts perfectly. ~0% of the URLs we tested are pure A.
- **Pattern B — JavaScript SPA, content-bearing post-hydration** (Cousins, JBG Smith, Boston Properties, Greystar). The shell loads, then a React app fetches inventory via XHR and renders the grid into the DOM. Tier 6 (ScrapingAnt headless render + Haiku) closes this gap when hydration completes within snapshot window. **Tier 6b** (directory-link harvest) is the fallback when the grid never hydrates but `/property/<slug>` URLs are still emitted in nav.
- **Pattern C — Static HTML cards on a modern site** (Stiles, Granite, Childress Klein, the modal case). Server-rendered with enough text density that the Haiku-on-static path works. ~50% of the pre-flight sample.
- **Pattern D — Map-driven inventory** (Northwood Office, CBRE Build-to-Suit, many REITs). Inventory is rendered as pins on an embedded map (Mapbox / Google Maps / Leaflet / ArcGIS). Property records are JSON loaded via XHR and held in JavaScript state — *not in any DOM element a scraper can read*. Headless render paints the pins visually but doesn't surface the data. **Generic tiers cannot crack this.**
- **Pattern E — Downloadable formats** (REIT investor decks, PDF fact sheets, XLSX portfolio inventories, PowerPoint pitches). The owner publishes building data as a binary attachment linked from an HTML landing page. The cascade reaches the landing page; the data lives in the linked `.pdf` / `.xlsx` / `.pptx`. **Genuinely outside Ring 1's HTML-extraction reach** — needs a per-format extractor (PDF text → Haiku, XLSX → CSV parser → Haiku, deck → image+OCR → Haiku). Not seen in the v1 pre-flight sample but documented from Tishman Speyer, several REITs, and investor-relations pages broadly.
- **Pattern F — Auth-walled / SSO-gated** (CoStar broker-only views, JLL Spark tenant portals, in-house leasing dashboards). The unauth view is marketing copy; real inventory sits behind a credentialed login. **Not solvable by extraction-tier improvements** — the page literally won't serve the data without auth. The strategic answer is either (a) hold broker credentials we paid for, (b) get partner API access (rare), or (c) lean on IntelliNet broker-affiliation relationships to get authenticated views via the BD rep's own session. Reserved as a real new workstream when a high-value Pattern F source becomes a priority.

**Distinct from the patterns: a data-quality anti-pattern.** Some sites publish a *technically functional* sitemap.xml + detail-page structure, but the linked pages are unpublished CMS template stubs — field labels rendering with no values, slug-derived names like "Property Name 3" / "Building 7" / "Untitled 12". AACUSA exposed this on 2026-05. The cascade does what it should (extracts whatever the page contains); the source just has nothing real to extract. Handled in the UI via a **template-noise detector**: when ≥3 candidates from one scrape have slug-derived placeholder names, a banner warns the operator before they burn Enrich credits on 60 garbage candidates. Not a new pattern in the extraction taxonomy — same cascade behaviour is correct — but worth naming so future debugging sessions don't mistake low-quality data for an unreachable architecture.

For Pattern D the architectural answer is one of two:

- **Per-site adapter** (`SITE_ADAPTERS` registry in the scrape edge function). One-time browser-DevTools investigation per host identifies the XHR endpoint; the adapter then fetches that JSON directly and emits `HaikuCandidate`-shaped records. The cost is roughly half a day per high-value source, and the adapter never breaks until the site changes its API. The detector (`detectMapDrivenInventory`) emits a structured `skip:map_driven_inventory` reason so an operator hitting one of these sites sees clear guidance instead of a silent zero-result.
- **Ring 2 (Regrid)** for parcel-level data. This is the strategically correct answer — Ring 2 doesn't care how Ring 1 publishes inventory; it pulls owner-of-record + parcel polygons directly from the assessor record. Pattern D sites become **the canonical case for the Ring 1 → Ring 2 reconciliation pattern**: when Ring 1 is structurally hostile, Ring 2 is the unlock, and the provenance primitive captures which fields came from which ring.

The practical sequencing: ship the detector + adapter scaffold now (so operators see "this is Pattern D, here's what to do" instead of mystery skips), build per-site adapters opportunistically for the top owners in our pipeline (Northwood, CBRE), and let Ring 2 / Regrid absorb the long tail when that integration lands.

### Ring 2 — Transactional Record

What the public record says about a building. Deeds, assessments, permits, MLS history, court filings, environmental disclosures.

- **Coverage:** patchy by jurisdiction (Mecklenburg County's data is excellent; many counties are not), but where it exists it's authoritative.
- **Accuracy:** high for what it covers — the assessor doesn't have an incentive to lie about owner-of-record.
- **Access cost:** mid — API fees, county portal scrapes. Moving from Attom (annual subscription, gaps in data quality) to Regrid (metered API, GeoJSON-native, parcel-anchored, cancellable) as the primary Ring 2 source, with Attom potentially retained for transaction history.
- **Refresh cost:** mid — these records update at the speed of government, which is to say slowly.
- **Best use:** verifying what Ring 1 told us, identifying recent transactions, anchoring records to a parcel ID instead of an address string — *and* underwriting the commercial pitch for Ring 3 engagements (see "How the Fourth Utility actually pays" below).

Ring 2 does more work than v0.1 gave it credit for. It's not just the verification layer for Ring 1 — it's the **evidence layer** for the BD conversation. Public records contain permit history (revealing deferred capex), assessor records (revealing asset age and likely systems vintages), transaction history (revealing when the asset was last underwritten and what the pro-forma assumed), and tax assessments (revealing operating expense baselines visible to buyers and refinance lenders). A BD rep with a Ring 2 brief can credibly underwrite the IntelliNet pitch before ever being inside the building.

### Ring 3 — Operational Truth

What's actually inside the building. Chiller make and vintage, BMS vendor, last commissioning date, deferred maintenance, energy use intensity, tenant comfort, vendor invoices, the lobby coffee machine.

- **Coverage:** structurally invisible from the outside. You only get this by *being inside the building*.
- **Accuracy:** the only data in CRE that's actually ground truth.
- **Access cost:** very high — requires a commercial relationship, a building audit, a BMS integration, ongoing field presence.
- **Refresh cost:** continuous, if you've earned the right to be there.
- **Time-in-place:** compounds. A six-month-old engagement has different operational depth than a four-year-old one. This is the dimension capital can't close.
- **Best use:** the operational decisions that actually move NOI — capital planning, retrofit prioritization, vendor accountability, decarbonization, anything an owner is willing to underwrite.

The important reframing: **Ring 3 data isn't extracted from operating relationships — it's the data exhaust of installed infrastructure.** IB doesn't run consulting engagements that happen to generate insight. IB installs the Fourth Utility (connectivity, access control, systems integration, monitoring) and the operational data is what flows through it. That's a stronger structural claim than "we're inside the building" because it makes the asset itself the producer of the data. The building becomes instrumented; the instruments produce the truth.

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

## How the Fourth Utility actually pays

The Fourth Utility framing is conceptually clean but commercially aspirational on its own. Power, water, and gas are line items every CRE CFO expects to see. The Fourth Utility *isn't* — at least not at the start of the relationship. Pretending otherwise has the doc selling a vision that doesn't survive contact with the operating budget cycle.

The actual commercial story is more interesting than "we'll save you money." Sophisticated CRE owners don't think about "funding" and "value creation" as separate categories — they think in terms of total return on capital. The Fourth Utility produces returns in three distinct ways, and a credible BD conversation has to address all three.

### Return 1: OpEx offset (Optimize-funds-Operate)

This is the entry-level claim, and the one most directly aimed at the CFO conversation.

- **IntelliNet Optimize** identifies the savings: operational inefficiencies, vendor overcharges, energy waste, deferred-maintenance avoidance, capex sequencing improvements. These aren't aspirational ROI claims — they're identifiable line items pulled out of the building's existing OpEx.
- **IntelliNet Operate** runs the infrastructure, funded substantially by what Optimize has freed up.

For typical asset profiles, the engagement is engineered to be substantially budget-offset by year one and fully self-funding by year two. Buildings with deeper systems modernization needs may extend the offset curve into year three; in those cases the contract structure includes proportional cost-share or deferred-fee mechanics to keep the engagement budget-neutral against the realized savings curve.

The CFO reframe: *not new spend, reallocated spend, with infrastructure on top.* Without Optimize-funds-Operate, a 3-year auto-renew reads as "you want me to add a recurring expense I don't have today." With it, the contract is structurally different — it's reallocation, not addition. By year three, the renewal conversation isn't "do we keep paying for this service" — it's *"do we rip out infrastructure that's now load-bearing in our operations."*

**Ring 2 is the underwriting layer that makes this pitch credible before we're inside the building.** A BD rep with a Ring 2 brief can walk into a meeting and credibly say: *"Based on the public record, your BMS is likely 12 years old, your last major capex was 2019, your reported OpEx is running 8% above the market comp set. We can show you, within 60 days of a no-cost assessment, exactly where the savings are — and structure an engagement that's self-funding by year two."* That's a fundamentally different opening than "we have a service we'd like to sell you."

### Return 2: NOI uplift (revenue, not just savings)

This is the return CFOs and developers actually get most excited about, because it's a top-line claim, not a bottom-line efficiency claim. The Fourth Utility doesn't only lower expenses — in many asset classes, it can be monetized directly as a revenue line.

The clearest example is multifamily, where a tech amenity fee built into rent (covering connectivity, smart-access, building app, package management, sometimes EV charging access) is incremental NOI with no debt service against it. The fee structure is already industry-accepted; competitive new construction increasingly includes it as standard. What changes when IB is the underlying infrastructure provider is that the fee is now backed by infrastructure the owner controls rather than a third-party vendor relationship the owner is dependent on.

**Illustrative example (numbers pending the calculator, but directionally:** a $25/unit/month tech amenity fee on a 300-unit asset is ~$90K of annual incremental NOI. Capitalized at a 5.5% cap rate, that's roughly $1.6M of asset value created — before any OpEx savings are counted.

Office and mixed-use have different but parallel revenue mechanics: tenant tech-amenity packages, premium connectivity offerings, building-as-a-service tiers for flex tenants. The pitch isn't identical across asset classes, but the underlying principle is — *Fourth Utility infrastructure can be monetized as a revenue line, not just expense offset.*

### Return 3: Asset value creation (and the leverage multiplier)

Returns 1 and 2 are already meaningful on their own. The third return is what they produce in combination, capitalized at market cap rates and viewed through the lens of how owners actually finance their assets.

**Unleveraged returns:** NOI lift (Return 2) plus OpEx offset (Return 1) flows directly to NOI. Capitalized at a market cap rate, that's asset value creation visible at refinance or sale. For the multifamily example above, $90K of amenity-fee NOI plus modest OpEx savings, capitalized at 5.5%, becomes $1.8-2M+ of incremental asset value. That number lands differently than "we'll save you money on your chillers."

**Leveraged returns:** When the Fourth Utility installation is financed — whether through a refi, a green-loan structure, vendor-financing from IB, or as part of a broader capex package — the *cash-on-cash return* on the owner's actual equity contribution improves dramatically. A 60-75% LTV financing structure can take an unleveraged 10% project return into 15-25% cash-on-cash territory, depending on cost-of-debt and contribution mix. That's the language sophisticated capital partners and CFOs already use to evaluate every other deployment of capital — and it moves the IntelliNet conversation from "operational vendor pitch" to *"capital deployment decision."*

The strategic implication: **the right audience for the Fourth Utility isn't always the operations team.** For most existing-building retrofits, the asset manager and operations lead are the entry point — but the conversation that closes the deal frequently runs through the CFO and the capital partner, because the returns story they care about is denominated in cap rates and cash-on-cash, not in chillers.

### The new-construction case: where the Fourth Utility lands literally

Every dollar of Fourth Utility infrastructure installed during ground-up construction is dramatically cheaper than retrofitting it later — *and* it can be capitalized into the construction loan or development budget rather than fighting for space in an operating budget.

For a developer, the question isn't "do we add this to OpEx" — it's *"do we include this in the spec at design phase, the way we include power, water, and gas."* That's the Fourth Utility framing landing literally rather than metaphorically. At design phase:

- Infrastructure costs are 30-50% lower than retrofit equivalents (no demolition, no parallel-systems run during install, integrated with the building's structured cabling and base BMS from day one)
- The full installation rolls into the development capital stack at construction-loan rates, not operating-budget rates
- The amenity-fee NOI is baked into the pro-forma from underwriting forward — boosting the project's stabilized cap-rate value at sale or refi
- The asset can be marketed and leased as "Fourth Utility-equipped" from opening, capturing a rent premium during initial lease-up

The audience here is meaningfully different from the existing-asset audience: developers, design teams, GCs, and the development side of capital partners. The pitch is also different — it's not "we'll save you money" or "we'll lift your NOI," it's *"specify us at design phase the way you specify your electrical engineer or your MEP."*

This is a meaningful workstream in its own right, parallel to the existing-asset BD pipeline. It deserves its own go-to-market motion, its own brokerage and design-firm channel partnerships, and its own version of the Ring 2 evidence brief tuned to ground-up project economics. `[ROB: do we have a named BD lead for the new-construction motion, or is that an open seat? Several of the warm Charlotte relationships — Stiles, Crosland Southeast, Wexford — have active development pipelines this conversation should be running through.]`

### Putting all three together

A clean version of the full commercial story, ready for a sophisticated audience:

> *"The Fourth Utility installs are typically engineered to be budget-neutral within the first two years through OpEx offset. In most asset classes, the infrastructure can also be monetized directly as an amenity revenue line, lifting NOI and — at market cap rates — creating substantial asset value visible at refinance or sale. When the installation is financed, leveraged cash-on-cash returns become meaningfully attractive to capital partners. At ground-up construction, all three return drivers operate from day one and the infrastructure is capitalized in the development budget rather than the operating budget — which is the cleanest expression of what 'Fourth Utility' actually means."*

That paragraph is what a fully baked BD conversation eventually walks an owner through. It's not v0.3's job to deliver it perfectly — but it is v0.3's job to make sure the strategy doc captures all three returns, so downstream artifacts (BD-rep version, deck, per-asset calculator) inherit the same scaffolding.

## Who buys this — and what each stakeholder cares about

CRE decisions never go through one person. The Fourth Utility / Optimize-funds-Operate story has to land differently across at least five roles, each with different objections, time horizons, and incentives. A BD rep who pitches all five the same way will lose four of them.

| Stakeholder | What they care about | What lands for them | What they'll object to |
| --- | --- | --- | --- |
| **Asset manager** | NOI, lease performance, tenant retention, deal at refi/sale | RTO benchmarking, operational savings, NOI uplift via amenity-fee structures, evidence for renewal conversations, mobility analytics premium tier | Anything that reads as long-horizon vision instead of "what does this do for my building this year" |
| **Property Management** | Uptime, vendor accountability, defensibility of operating decisions, easier daily workflow | IntelliNet Operate as the daily experience; Ring 3 data as *their* data; vendor accountability as a feature not a threat | Disruption during install; loss of control over vendor relationships they've built |
| **CFO / finance lead** | Operating budget impact, contract structure, savings credibility, balance-sheet treatment, audit defensibility, capital deployment math | Optimize-funds-Operate with Ring 2 evidence underwriting it; contract structure self-funding by year two; leveraged cash-on-cash returns presented in their own language | Audit-defensibility of savings methodology; risk-of-non-realization on savings claims; capital-lease vs. operating-expense treatment of installed infrastructure; exit cost and contractual lock-in mechanics; integration with the existing capex planning cycle |
| **Capital partner / institutional investor** | Portfolio-level value preservation, ESG reporting, refinance/sale defensibility, long-hold operational story, cash-on-cash returns | Fourth Utility as long-term value driver; portfolio-level operational intelligence; comp-set positioning; leveraged returns presented at the portfolio level | Anything that looks like one-off operational tinkering rather than a portfolio-grade thesis |
| **Executive / owner / CEO** | Strategic positioning, peer comparison, asset-level risk, firm narrative | Competitive comp-set evidence ("your peers are doing this"); risk framing ("your assets are exposed without it"); the Fourth Utility framing as differentiation | Anything that feels operational rather than strategic; pitches that don't acknowledge they're already busy |
| **Developer (new construction)** | Project pro-forma, design-phase specification, stabilized cap-rate value, capital stack efficiency | Fourth Utility at design phase; capitalized in construction loan; amenity-fee NOI baked into pro-forma; sale/refi value at stabilization | Anything that arrives after the design freeze; vendors who don't understand construction-loan economics; specs that complicate the GC bid |

The CFO row is where most existing-asset deals are won or lost. The asset manager and Property Management are the daily relationship; the CFO is the gatekeeper. The Ring 2 evidence brief is built primarily for the CFO conversation, even though the asset manager will read it first.

The Developer row is the new addition in v0.3, reflecting that new construction is a parallel motion with materially different economics and a materially different decision-maker. The Fourth Utility framing lands more literally for this audience than for any other.

## Pitch sequencing: what to lead with, in what order

The stakeholder map describes what lands for each role. The pitch sequencing describes what *order* to lead with — meeting 1 vs. meeting 2 — so a BD rep walking into different rooms has a defensible call plan.

| Audience | Meeting 1 opener | Meeting 2 frame |
| --- | --- | --- |
| **Asset manager** | RTO benchmarking / operational savings | Fourth Utility as long-term asset value driver |
| **Property Management** | IntelliNet Operate as their daily experience | Fourth Utility as the professional track record they can point to |
| **CFO** | Optimize-funds-Operate with Ring 2 evidence | Fourth Utility as capitalized infrastructure on the balance sheet |
| **Capital partner** | Portfolio-level operational thesis | Fourth Utility as ESG + refinance defensibility |
| **Executive / Owner** | Fourth Utility as differentiation | Operational specifics — how it actually runs |
| **Developer** | Fourth Utility at design phase | Capital stack + stabilized pro-forma impact |

Two patterns worth noting:

For most stakeholders, Fourth Utility is the *second-meeting frame* — the elevation move once trust is established on tactical value. For executive/owner and developer audiences, it's the *opener* — because those audiences want to know the strategic thesis before they'll engage on tactics.

For Property Management specifically, the two-meeting arc is more lateral than vertical (they're already operating, so the elevation move is about professional defensibility and track record rather than strategic transformation). That's the row to spend the most energy on conversationally, because Property Management is frequently the relationship that lasts longest and gates access to the rest of the org.

## Mobility analytics use cases by asset class

The premium tier's underlying capability — parcel-anchored mobility data via Unacast on Regrid polygons — is **asset-class-agnostic**. The pitch isn't. A BD rep walking into different asset classes needs different framings of the same data product.

- **Office.** RTO benchmarking is the lead use case. Five years post-COVID, almost every office owner is still recalibrating, and nobody has a confident answer. Supporting cases: amenity ROI (does the lobby renovation justify itself in visit patterns?), tenant marketing intelligence (which submarkets do my building's visitors come from?), lease-renewal evidence (showing a tenant their employees are coming back at higher rates than the market). Visitor counts are moderately useful on their own; *trends and comparisons* are what move decisions. **This is the lead for the May 31 USMNT suite conversations.**
- **Multifamily.** Different game. Owners care less about absolute counts, more about *resident behavior patterns and trade-area dynamics*: where do my residents work and shop, how does that compare to my comp set, what does that tell me about retention risk and pricing power? Strong fit because residential trade areas are diffuse and hard to characterize without observed behavior. The pitch: *"we can tell you why your residents chose this building over the one down the street — and whether that's changing."* Pairs naturally with the amenity-fee NOI story.
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
- **Not an ESCO.** Energy services companies sell savings as the product, often with shared-risk financing structures. Our Optimize tier shares mechanical DNA with ESCO contracts, but the strategic identity is different — IB sells operating infrastructure; the savings are how that infrastructure gets funded into existence. Conflating the two costs us pricing power and capital-partner perception.

## Open decisions

1. **Regrid trial — moving this week.** Free API trial running before the Attom trial expires. Validation criteria: owner-of-record fidelity vs. Attom on 20-30 known parcels (Mecklenburg + 1-2 other counties), polygon search for area-sweep use cases, GeoJSON-into-Supabase ingest, and building footprint quality on cases where Attom missed SF or stories. If those four check out, we have time to negotiate paid terms before the trial closes.
2. **May 31 tablet-demo: GO.** Unacast relationship is warm. Plan executes per the engineering sequencing: week 1 is Regrid validation on 110 East + one-building tablet view with synthetic mobility data; week 1 gate is "does this read as executive-grade on a tablet in a suite, or as a tech demo?" Week 2 scales to 5-10 Stiles-relevant buildings only if week 1 passes; otherwise polish 110 East to 95% and run the rest verbally. **One building extremely well > five mediocre.**
3. **Ring 2 evidence brief as a first-class artifact.** Spec exercise post-May 31. Half-day workshop on which Ring 2 fields, which derived signals, generation mechanics, how it renders for different audiences (CFO vs. asset manager vs. rep's own prep), and whether it's part of IB Scout brief tooling or a separate edge function.
4. **Per-asset returns calculator.** Surfaced by v0.3 as a quantitative companion to the new "How the Fourth Utility actually pays" section. Spec exercise post-May 31. Inputs (asset class, unit count, market cap rate, financing structure, baseline OpEx), outputs (year-by-year cash flow, leveraged + unleveraged returns, asset value creation at stabilization). Sales-enablement deliverable, parallel to the BD-rep version.
5. **CFO-objection-handling appendix.** Surfaced by the reviewer's five-objection set. Sales-enablement artifact, post-May 31. One page per objection with the canonical IB response, supporting evidence, and the contract clauses or structures that back it up.
6. **CoStar one-time pull for dedupe seed.** Brief dismissed CoStar as overkill for ongoing use, but for the dedupe lookup table a one-time pull is "expensive once, free per query." Worth a small budget conversation.
7. **Portfolio Scout v1 "done" criteria — defined.** The floor is the Tier 1 field set defined in the Ring 1 extraction scope section: building name, address, asset class, hero image, marketing blurb, extracted reliably across a typical professional owner portfolio page. Tier 2 fields (SF, year built, unit count, Property Management firm, leasing broker) are v1.5 — extracted when available with explicit confidence, overwritten by Ring 2 where Ring 2 speaks to the same field. Tier 3 fields are out of scope for v1. Engineering should treat the Property Management extraction as a Tier 1 priority despite its Tier 2 reliability, given the BD channel value.
8. **New-construction BD lead.** `[ROB: do we have a named BD lead for the new-construction motion, or is that an open seat? Worth deciding before this becomes a parallel pipeline running through brokers and design firms without an owner inside IB.]`

## Questions for you (Rob)

What's still genuinely open:

1. **The illustrative numbers in the returns section.** I used $25/unit/month tech amenity fee, 300-unit asset, 5.5% cap rate, 60-75% LTV, 10% unleveraged → 15-25% leveraged. These are directionally credible but flagged as illustrative pending the calculator. Are the inputs in defensible ranges for the markets and asset profiles you actually target? If multifamily tech amenity fees in your markets are running $35-50 rather than $25, the example should reflect that.
2. **New-construction BD ownership.** Flagged in Open Decision #8 and in the new-construction subsection. This is the question that determines whether new construction is a real workstream or a footnote.
3. **BD-rep version timing — drafting today/tomorrow.** Confirming the recommendation: draft on this branch, the day v0.3 closes, so the rep version is a true compression of the strategy doc and doesn't drift. May 31 is the forcing function.

---

*Next step: walk through v0.3 together. The substantive framing should now be substantially settled. Remaining work is sales-enablement (BD-rep version, calculator, CFO-objection appendix, Ring 2 evidence brief), May 31 execution, and the new-construction BD ownership question. The strategy doc has done its job once it's anchoring those four downstream artifacts.*
