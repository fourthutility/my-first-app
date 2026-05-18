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
A–D". Pattern D map-driven sites are the canonical case where Ring 2
becomes the unlock; the per-site adapter scaffold (Northwood Meilisearch)
is the tactical bridge.
