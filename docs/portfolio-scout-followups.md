# Portfolio Scout — deferred items

Things we've consciously punted on so we can ship. None of these block
v1; each is a future iteration when the underlying need bites hard enough
to justify the work.

## og:image fast preview for sitemap-derived candidates

**Status:** deferred (2026-05-18, AACUSA scrape).

**The gap:** When the scrape resolves via Tier 5 (sitemap.xml fallback —
Cousins / AACUSA / any SPA where the sitemap is the cheapest signal),
each candidate lands with just a URL and a slug-derived name. No image,
no address, no SF — those live on the per-property detail pages, which
we don't fetch until Enrich runs (one HTTP call per candidate, ~5–15s
each via Haiku). On a 63-candidate AACUSA scrape, the verification grid
shows 63 placeholder building icons. Workable but visually inert; the
operator can't pre-scan by "which buildings look interesting."

**Proposed fix:** A "Preview images" affordance on sitemap-derived
scrapes. Parallel HEAD/GET on each candidate's detail URL, extract just
the `og:image` (or `twitter:image`) meta tag, populate
`extracted_image_url`, re-render the card. ~50–200ms per URL,
parallelizable to ~3–5s for 60 candidates. No Haiku tokens, no
ScrapingAnt credits. Same idea social-media link previews use.

**Why not now:**
- Sitemap-derived scrapes are a minority of the traffic (Stiles, Granite,
  Childress Klein etc. all resolve via Pattern C static + Haiku and
  already have rich data including images).
- The AACUSA case that surfaced this is mostly CMS template placeholders,
  not real listings — the image preview wouldn't add much because the
  underlying records aren't quality data.
- Bulk Enrich already covers this need slowly-but-reliably for operators
  who actually need to import a sitemap portfolio.

**Trigger to revisit:** if we hit ≥3 high-value owners whose data lives
behind a sitemap (and where Bulk Enrich's 1–2-minute turnaround is too
slow for the BD workflow), build it.

---

## Northwood Ballantyne per-building index

**Status:** probing (2026-05-18, Northwood adapter).

The `northwood_portfolios` Meilisearch index returns 11 master portfolio
entries. Rob's local knowledge says there are ~36 individual buildings
WITHIN Ballantyne alone — those are almost certainly in a sibling index
on the same `search.goballantyne.com` Meilisearch instance, but the
name is unknown. The Northwood adapter probes 6 candidate names
(`ballantyne_buildings`, `ballantyne_properties`,
`goballantyne_buildings`, `goballantyne_properties`, `buildings`,
`properties`); all probably 404 today.

**Trigger to revisit:** when Rob next opens DevTools on the Ballantyne
map view and shares the actual `multi-search` payload with the correct
indexUid. Six lines of config to wire up.

---

## Update Scout → HubSpot deal property push

**Status:** intentional scope limit (2026-05-17, merge clarification).

Today's behavior: Update Scout writes the merged fields to the Scout
projects row only. HubSpot deal properties aren't auto-synced; they get
populated via Approve (which creates the deal initially) and Enrich
(which pushes leasing contacts). The merge modal's success message says
this explicitly.

**Trigger to revisit:** when a BD rep flags missing PM / asset class /
year built on a HubSpot deal report. The path is a new `update_deal_
properties` action on `hubspot-push` + a call from `applyMerge` after
the Scout patch succeeds.

---

## Owner-operator auto-promote PM to owner

**Status:** intentional caution (2026-05-17, broker-vs-PM split).

When Enrich finds a broker email (CBRE, JLL, Cushman, Thrift CRES) on
an owner-operator's building (Cousins, Northwood), the heuristic
correctly leaves PM as `IMPLIED` rather than stamping the broker as PM.
The operator can confirm via the "Update Scout and set PM = <owner>"
hint in the still-implied suggestion strip.

**Auto-promote path** (not yet built): a known-set
`OWNER_OPERATOR_HOSTS` registry. When Enrich finds ONLY broker-firm
emails on a building whose publisher is in the registry, auto-promote
PM to the publisher with `pm_confidence='extracted'` and a note.

**Trigger to revisit:** if Rob is doing the "Update Scout, set PM = X"
manual step more than ~10 times a week. Until then, the false-positive
risk on co-managed buildings is the bigger concern.

---

## UI re-scaffold

Whole-page redesign deferred. Refresh button placement, bulk-action bar
layout, mobile responsiveness, and the help-panel pattern are all up
for review in that work. Several of the more recent additions — the
diagnostic strip, the merge modal, the HubSpot pills, the PM
suggestion strip — slot in as components that the re-scaffold can move
around or restyle without changing their function.

---

## Ring 2 (Regrid) parcel-data integration

Strategic, not tactical. Documented in `docs/data-strategy-three-rings.md`
section "The Ring 1 → Ring 2 reconciliation pattern" and "Site patterns
A–F". Pattern D map-driven sites are the canonical case where Ring 2
becomes the unlock; the per-site adapter scaffold (Northwood Meilisearch)
is the tactical bridge. Pattern E (downloadable formats) and Pattern F
(auth-walled) are even harder Ring 1 cases — Ring 2 is the only
realistic route for many of those sources too.

---

## Pattern E — downloadable-format extraction (PDF / XLSX / PPTX)

**Status:** documented, not built (2026-05-18).

REIT investor decks, PDF fact sheets, XLSX portfolio inventories, and
PowerPoint pitches are common ways owners publish portfolio data. The
HTML cascade gets to the landing page but the data lives in the linked
binary. Tishman Speyer and several REITs (Boston Properties IR pages,
Highwoods investor reporting) are the canonical examples.

**Proposed pipeline:** a per-format extractor tier in the cascade:
  - `.pdf` → `pdfjs-dist` text extraction → Haiku-on-stripped-text
  - `.xlsx` → SheetJS / `xlsx` library → tabular parse → Haiku for
    column-name inference if needed
  - `.pptx` → unzip → slide-text extraction → Haiku
  - `.docx` → `mammoth` → Haiku

**Trigger to revisit:** when a Tier-1-priority owner publishes their
portfolio only via downloadable format. Won't be the dominant case for
office BD (operator pages tend to have HTML inventory), but is real for
investor-pages-as-portfolio sources.

---

## Pattern F — auth-walled / SSO-gated sources

**Status:** documented, not built (2026-05-18).

CoStar broker-only views, JLL Spark tenant portals, in-house leasing
dashboards. The unauth view is marketing copy; real inventory sits
behind a credentialed login. Not solvable by extraction-tier work —
the page literally won't serve the data without auth.

**Proposed approaches:**
  - **(a) Held broker credentials** — hold our own broker subscription
    accounts that the function can authenticate with. Cost: subscription
    fees + TOS scrutiny on automated access.
  - **(b) Partner API access** — formal agreement with the data provider.
    Rare for the smaller portals; possible for CoStar at scale.
  - **(c) IntelliNet broker-affiliation** — leverage the BD rep's own
    authenticated session via a browser-extension or session-relay
    pattern. Best UX, hardest to build, requires the rep to opt in
    per-source.

**Trigger to revisit:** when a high-value Pattern F source is on the
must-have-for-pipeline list. Until then, Pattern F is structurally
outside Ring 1's reach and that's documented behavior, not a bug.

---

## CMS template-noise detector — promote to scrape-time skip?

**Status:** shipped as UI-side banner (2026-05-18).

The AACUSA case surfaced a data-quality anti-pattern: CMS leaks
unpublished template stubs into its sitemap.xml, the cascade extracts
them as candidates with slug names like "Property Name 3", and the
operator can't tell the source is junk until they Enrich one. Current
v1 behavior: a yellow banner appears above the candidate grid when ≥3
candidates have placeholder slug names.

**Could be promoted to a scrape-time skip:** if the template-noise
heuristic fires server-side AND the candidates have no extracted
addresses / SF / image URLs (i.e. they're definitively template-only,
not just badly-named real buildings), emit a `skip:template_noise`
reason and short-circuit. Same precedent as `skip:fund_structure`.

**Trigger to revisit:** when Rob hits ≥2 more AACUSA-style sources and
the UI banner alone proves insufficient (operators ignoring it and
bulk-enriching anyway). Until then, the warning + manual spot-check
is enough.
