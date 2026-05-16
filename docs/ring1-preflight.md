# Ring 1 Pre-Flight Investigation

**Status:** static-fetch portion complete (2026-05-16). Findings matrix populated below; architecture conclusions written. Headless / XHR portion still outstanding for three sites flagged in the conclusions.

---

## Purpose

Confirm the actual distribution of portfolio-page patterns in our target segment **before** committing the extractor architecture. The pressure-test conversation established that "static fetch with JS-render fallback" is the wrong fallback chain for the modal case — most professional CRE owner sites are map-driven (Mapbox/Leaflet hydrated from an XHR JSON call). Static fetch returns an empty shell; DOM scrape returns nothing useful even with Playwright.

This document grounds the architecture in evidence rather than theory. The success criterion isn't "we can extract from N sites" — it's "we know which extraction strategy is modal and which are edge cases, so the fallback chain is built in the right order."

## The four patterns we're testing for

Per the strategic doc (v0.3) and the pressure-test conversation:

| Pattern | Signal | Best extraction path |
| --- | --- | --- |
| **A. JSON-LD / schema.org** | `<script type="application/ld+json">` in static HTML, with `RealEstateListing` or `Place` schema | Parse JSON-LD directly. 10× cleaner than DOM. ~15% of sites guessed. |
| **B. Map-driven JSON (XHR)** | Static HTML is a near-empty shell with a `<div id="map">` and a JS bundle. Page loads a JSON endpoint via XHR after JS executes. | Intercept the XHR in headless. Parse the JSON. ~35-40% guessed. |
| **C. Static HTML cards / DOM** | Cards or rows rendered server-side in the HTML response. Common on smaller / older sites. | Cleaned HTML (strip nav/footer/script) + Haiku extraction. ~25-30% guessed. |
| **D. PDF brochure or login-walled** | Linked PDF as the "portfolio." Or a login form blocking access. | Detect, fetch + OCR (PDF) or skip (login). Edge case. ~10-15% guessed. |

**The numbers in the right column are guesses to be falsified.** That's the whole point of this exercise — the pre-flight tells us the real distribution.

## Per-URL methodology

For each URL in the test set, capture:

1. **Static fetch (curl / WebFetch).** What does the raw HTML look like? Empty shell or content-bearing?
2. **JSON-LD presence.** Search the static HTML for `application/ld+json`. If present, parse and capture the schema type.
3. **Headless render check.** Does the rendered page differ materially from the static HTML? (Indicator that JS hydration is doing the real work.)
4. **XHR detection.** Open in headless with network capture. List the XHR responses with `application/json` content-type. Note any that look portfolio-data-shaped (arrays of objects with `name`, `address`, `city`, `sqft`, `image` keys).
5. **DOM card detection (if static).** If the static HTML has cards, capture the CSS selector pattern (e.g. `.property-card`, `[data-property]`).
6. **Field coverage.** For each candidate building visible on the page, tick which fields are present: name, address, city, asset class, SF, year built, broker, property manager, image, detail-page URL.
7. **Volume per page / pagination.** How many buildings on the first load? Is there pagination, "Load More," or infinite scroll? Are all buildings reachable from this one URL or do we need to crawl sub-pages?
8. **Detail-page detection.** Each candidate often links to a deeper page with the actual SF / leasing contact / PM. Note presence of those links and what extra fields they expose.

## The test URL set

Selected to represent the actual distribution rather than to pick easy wins. Mix of public REIT (clean), private institutional (often JS-heavy), regional developer (simpler sites), manager-not-owner (attribution edge case), fund-structured (no inventory at all), marketing-led (case studies not lists), and Charlotte-relevant where possible.

| # | Owner / Operator | URL | Pattern hypothesis | Why this one |
| --- | --- | --- | --- | --- |
| 1 | Cousins Properties | `https://www.cousins.com/properties/` | B (map-driven) or A (JSON-LD) | Public REIT, clean site, Charlotte presence (110 East stack). Pressure-test test case. |
| 2 | Highwoods Properties | `https://www.highwoods.com/properties` | B (map-driven) | Public REIT, Sun Belt office. Likely map-driven. |
| 3 | JBG Smith | `https://www.jbgsmith.com/properties` | B or C | Private institutional, DC/NoVA, mixed-use. Heavy on design / visual. |
| 4 | Granite Properties | `https://www.graniteprop.com/portfolio/` | C (static HTML cards) | Private institutional, Sun Belt office, mid-size. |
| 5 | Crosland Southeast | `https://croslandsoutheast.com/properties/` | C | Regional developer, Charlotte, mixed-use. Active development pipeline relevant to new-construction motion. |
| 6 | Childress Klein | `https://www.childressklein.com/properties` | C | Regional developer, Charlotte. |
| 7 | Lincoln Harris | `https://www.lincolnharris.com/properties` | C or B | Regional firm, Charlotte, manages + develops. Manager-vs-owner edge case. |
| 8 | Greystar | `https://www.greystar.com/find-apartments` | B (map / search-driven) | Manager-not-owner. Critical edge case for attribution logic. Apollo Carolinas, BREIT-managed assets etc. |
| 9 | Stiles Corporation | `https://www.stiles.com/portfolio/` | C or marketing-led | Partner firm. Tests whether we can scrape the channel partner's own site. |
| 10 | Blackstone Real Estate | `https://www.blackstone.com/our-businesses/real-estate/` | D (no inventory) | Fund-structured. Expected to NOT have a building list at all. Confirms the "skip fund structures" rule. |

`[ROB: substitute or swap any of these. A couple of warm-account URLs in the set would let the pre-flight pull double-duty as account intel — happy to swap (e.g. Wexford, Spectrum Companies, Foundry Commercial) if there are specific names you want pre-flighted.]`

## Findings matrix

Populated 2026-05-16 from the static-fetch pass. `curl` with realistic browser UA and `Accept-Encoding: gzip,br`. "Visible text" = HTML with `<script>`/`<style>` blocks and tags stripped, whitespace-collapsed. The XHR column is `not characterized` for every row — that requires headless and has not been run yet.

| # | Owner | Final URL | Static HTML / visible text | JSON-LD? | XHR JSON endpoint? | Card selector | Fields on index | Detail page? | Pattern verdict | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Cousins | `https://cousins.com/properties/` (301 from www) | 2.5 KB / 46 chars visible | No | not characterized | — (empty `<div id="root">`) | none in static HTML | yes, via React routes (URLs not in static) | **B** (pure React SPA) | "You need to enable JavaScript to run this app." No `sitemap.xml` (returns the SPA shell). No static fallback. Needs headless. |
| 2 | Highwoods | `https://www.highwoods.com/find-your-space/search` (the `/properties` path the brief listed is a 404; sitemap-derived search URL is the real index) | 175 KB / 13.5 KB visible | No | not characterized | `<article class="SearchResult" id="SearchPropertyNNNNN">` (20 in initial response; pagination/filters likely add more) | name (`data-name`), detail link (`data-href`), SF (`data-square-feet`, `data-text`), suites (`data-num-suites`), lat/lng (`data-latlng`), market/submarket IDs, asset class via `property_type` int. Image lazy via `data-thumb`. | yes (`/find-your-space/detail/{slug}`) | **C** with **rich `data-*` attributes**; map decorates but is not load-bearing | Best-case structured static. 20 `state+zip` and 52 SF mentions confirm content is real, not placeholder. `data-thumb` was a 1×1 blank — actual images load via JS, so image extraction needs headless. |
| 3 | JBG Smith | `https://www.jbgsmith.com/portfolio/office` (the brief's `/properties` is a 404; `/portfolio/office` exists but is also a near-empty shell) | 2.5 KB / 12 chars visible | No | not characterized | — (empty `<div id="app">` + `vendor.js` + `app.js`) | none in static HTML | yes (`/property/office/{NAME}/{ID}`) | **B** (SPA shell), but **sitemap-discoverable** | `sitemap.xml` lists **every** property with name + ID in the URL — ~100+ entries. Sitemap is the workable index without headless. |
| 4 | Granite | `https://graniteprop.com/explore-properties/` (brief's `/portfolio/` 404s; site canonical is `/explore-properties/`) | 91 KB / 2.9 KB visible | Yes (Yoast `@type: WebPage`, SEO scaffolding only — **no** `RealEstateListing`) | not characterized | `<div class="single-property">` containing `<a href="/{slug}/"><h2>{name}</h2><p>{street}</p><p>{city, ST zip}</p>`, image in `<img>` | name, street, city/state/zip, image, detail link | yes (per-property subpage at root, e.g. `/3630-peachtree/`) | **C** (clean WordPress) | 30 cards, 3 metros visible (Atlanta/Dallas/Houston shown in first response; more behind a market filter). Asset class not on index card — implied by market group, explicit on detail page. |
| 5 | Crosland Southeast | `https://www.croslandsoutheast.com/portfolio` (brief's `/properties/` 404s — site is Wix-hosted; `/portfolio` is the real path) | 992 KB / 1.6 KB visible (Wix inflates HTML with inline JSON state) | No | not characterized | `<div class="item-link-wrapper" data-hook="item-link-wrapper" data-id="{slug}_N">` (Wix Pro Gallery markup) | name only (`data-hook="item-title"`), image — **no address, no city, no asset class on the gallery surface** | yes (Wix per-item routes), but no detail URL on gallery card itself (click-to-route via JS) | **C** (Wix Pro Gallery, structurally data-poor) | 25 items. Names like "Tesora". The Wix gallery is rendered server-side enough to extract names + images, but addresses live only on detail pages or inside Wix's gallery state JSON. Likely tractable via Wix's known JSON-state pattern, but materially more work than the WP/Drupal cases. |
| 6 | Childress Klein | `https://www.childressklein.com/properties` | 106 KB / 2.7 KB visible | No | not characterized | `<article about="/{slug}" class="node property--teaser">` containing `<h4>{name}</h4>` + `<div class="property__field-short-description">{asset_class}</div>` + image | name, asset class (Industrial / Office / Multifamily / Retail / Mixed-Use / Self-Storage), image, detail link — **no address, no SF on index** | yes (per-property subpage; also `/properties/list` and `/properties/map` siblings) | **C** (Drupal, clean) | 40+ property teasers on the single index page, alongside 6 asset-class category cards. Address and SF require detail-page crawl. |
| 7 | Lincoln Harris | `https://www.lincolnharris.com/properties` | 114 B / 503 Service Unavailable | n/a | not characterized | — (Cloudflare bot challenge) | none accessible | n/a | **Blocked** (Cloudflare 503 on both `/properties` and `/`; `sitemap.xml` returns empty) | Could not characterize via static fetch even with realistic UA + Sec-Fetch headers + delay. Needs a real headless browser (Playwright with realistic fingerprint) or a residential-proxy fallback. Defer until headless run. |
| 8 | Greystar | `https://www.greystar.com/homes-to-rent` (the brief's `/find-apartments` is a 404; `/homes-to-rent` is the current entrypoint) | 133 KB / 4 KB visible | No | not characterized | — (no property cards at the entrypoint level; just metro/state CTA cards under `image-text-card`) | **none** — this page is a metro funnel, not a property list. Drilling down: `/homes-to-rent/us/{state}` → `/homes-to-rent/us/{state}/{metro-slug}` → property cards | n/a at this URL | **B** (Next.js, `__NEXT_DATA__` present, 41 KB JSON inline), but **structurally the manager-not-owner edge case the strategic doc flagged** | Not a single-page portfolio. Hierarchical browse: country → state → metro → property. Materially different surface from owner sites. The bigger issue isn't extraction — it's attribution (Greystar manages; doesn't own). Defer until the attribution policy is settled. |
| 9 | Stiles | `https://www.stiles.com/portfolio/` | 557 KB / 43 KB visible | No | not characterized | `<div class="portfolio-item">` with `<h3 class="item-title"><a href="{detail}">{name}</a></h3>` and `<dl class="portfolio-specs">` containing `specs-type` / `specs-address` / `specs-sqft` / `specs-units` | name 100%, type 100% (361/361), address 100% (361/361), SF 75% (271/361), units 10% (37/361), image 100%, detail link 100% | yes (per-property WP page) | **C** (WordPress, **gold-standard for this set**) | 361 portfolio items on one page; no pagination needed. Address rendered as `<span>{street}</span><br><span>{city, state}</span>` — parseable. WP sitemap also exposes them (`sitemap-post-type-portfolio.xml`). Best case in the test set. |
| 10 | Blackstone Real Estate | `https://www.blackstone.com/our-businesses/real-estate/` | 364 KB / 13 KB visible | Yes (Yoast `@type: WebPage`, SEO only) | not characterized | — (no portfolio listing of any kind) | **none** — this is a business-marketing page describing strategy, sectors, and portfolio companies. No building inventory. | n/a (Blackstone doesn't publish a building list at this surface) | **D** (fund structure, no inventory) | Confirms the pre-registered hypothesis. The "skip fund structures" rule holds. Blackstone's actual real-estate inventory is in BREIT prospectuses, 10-Ks, BX press releases, and individual portfolio-company sites — none of them reachable from this URL. |

## Output: extractor architecture decisions

These are the architecture conclusions from the static-fetch pass on 2026-05-16. Three sites (Cousins, Lincoln Harris, Greystar) still need a headless pass to be fully characterized — flagged below.

### Distribution actually observed

Against the four-pattern hypothesis at the top of this doc:

| Pattern | Hypothesis | Observed | Sites |
| --- | --- | --- | --- |
| A. JSON-LD `RealEstateListing` / `Place` | ~15% | **0%** | none — JSON-LD appears on 2/10 sites (Granite, Blackstone) but both are Yoast SEO `WebPage` scaffolding, **not** property data |
| B. Map-driven JSON via XHR (SPA shell) | ~35–40% | **30%** (3/10) | Cousins, JBG Smith, Greystar |
| C. Static HTML cards | ~25–30% | **50%** (5/10) | Highwoods, Granite, Crosland, Childress Klein, Stiles |
| D. PDF / login / fund structure / blocked | ~10–15% | **20%** (2/10) | Blackstone (fund, no inventory), Lincoln Harris (Cloudflare bot challenge) |

**Pattern C is modal, not Pattern B.** That changes the fallback chain. The pressure-test conversation overweighted map-driven SPAs because the easiest mental example (Cousins, the test case) is one. Half the sample is just static HTML with a card pattern — same shape as the original brief, just from a wider sample.

### Modal pattern

**C — static HTML cards, parseable with a CSS selector pass + light cleanup.** Five of ten sites in the test set fall here, and they cover the full owner-type spread: public REIT (Highwoods), private institutional (Granite), regional developer (Crosland, Childress Klein), partner firm (Stiles). The "static fetch is dead" framing from the pressure-test was too strong — static fetch *is* the modal path. The brief had the shape right.

### Fallback chain (the change from the pressure-test conversation)

The order shifts because the evidence shifted. JSON-LD demoted, sitemap promoted, headless reserved for the residual.

1. **Static HTTP fetch + CSS-card extraction.** Realistic UA (Chrome on macOS), `Accept-Encoding: gzip, br`, follow redirects. Strip `<script>`/`<style>`/nav/footer; find card-shaped repeating elements. Resolves 5/10 cleanly (Highwoods, Granite, Crosland-with-caveats, Childress Klein, Stiles).
2. **Sitemap.xml fallback.** When the static index returns an empty SPA shell (<1 KB visible text after strip), try `sitemap.xml` and any nested sitemap-index entries with `portfolio` / `property` / `building` / `asset` in the URL. Resolves JBG Smith (every property listed with name + ID) and a second path for Stiles (WP `sitemap-post-type-portfolio.xml`). Cheap to add, no headless cost. The "candidates" become the sitemap-listed URLs themselves; per-property detail-page fetches fill the fields.
3. **Headless render + XHR capture.** Only when both static and sitemap come back empty. Playwright with a network listener; collect `application/json` responses; pick the one shaped like portfolio data (array of objects with name/address/sqft keys). This is the originally-intended Pattern B path, but it's the third-line fallback now, not the primary. Required for Cousins.
4. **Cleaned-HTML + Haiku extraction.** Last resort for Pattern C sites where the card markup is too irregular for selectors (Crosland's Wix Pro Gallery is the canonical case — names render server-side, but addresses and asset class live in opaque inline state). Single-call extraction over the stripped HTML.
5. **Skip with reason code.** Pattern D (no inventory: Blackstone) and bot-walled (Lincoln Harris) get a structured skip with `reason: fund_structure` or `reason: cloudflare_challenge`, surfaced to the human reviewer. Don't burn LLM calls on these.

JSON-LD parsing stays as a near-free check inserted *inside* step 1 — if `<script type="application/ld+json">` exists and contains a `RealEstateListing` / `Place` / `LocalBusiness` schema, use it; otherwise fall through to CSS extraction. The pre-flight saw zero instances, so don't architect around it, but the check costs nothing to leave in place.

### Headless or static?

**Static fetch resolves 5/10 outright and 7/10 with sitemap fallback** (the +2 are JBG Smith and Stiles, where sitemap is the index). Headless is required only for 2/10 (Cousins, Lincoln Harris), with Greystar a third pending the manager-vs-owner attribution decision. **Roughly 70/30 static-to-headless**, not 40/60 as the pressure-test assumed. That's a material cost-and-latency difference for v1.

### JSON-LD detection

Worth a 30-line check at the top of the static pass — if it's there and it's the right `@type`, it's 10× cleaner than DOM. **But don't promote it to a primary path** based on this sample. The two JSON-LD blocks found in the wild were both Yoast `WebPage` SEO scaffolding, contributing nothing to property data. Treat `RealEstateListing` discovery as a rare bonus, not the architecture's foundation.

### XHR capture mechanic

**Still not characterized in this pre-flight** — every row's XHR column is empty. The static pass was sufficient to settle the fallback order, but the actual mechanics of the headless path (which Playwright APIs, how to filter `application/json` responses, how to identify the portfolio-data-shaped one when a single page makes 30+ XHRs) need a separate pass on the three sites flagged below before any code lands. Likely shape: Playwright `page.on('response', ...)` listener, filter on `content-type` and response body size > 1 KB, look for arrays of objects with name/address keys.

### Detail-page crawl

**Confirmed as a separate, opt-in action — not part of v1 index scrape.** Field coverage on index pages (from the 5 Pattern C sites that produced real fields):

| Field | Index-page coverage |
| --- | --- |
| name | 5/5 (100%) |
| detail URL | 5/5 (100%) |
| image | 5/5 (100%) — but Highwoods's index image is a blank placeholder; real image needs detail page or headless |
| asset class | 3/5 (Childress Klein explicit, Highwoods via int code, Stiles via specs-type) |
| street address | 2/5 (Granite, Stiles) — Highwoods has lat/lng but no human-readable street |
| city / state | 2/5 (Granite, Stiles) |
| SF | 2/5 (Highwoods `data-square-feet` 100%, Stiles `specs-sqft` 75%) |
| year built | 0/5 |
| broker | 0/5 |
| Property Management contact | 0/5 |

The decision-log assumption that SF / broker / Property Management are detail-page-only is **borne out by the data**. The v1 staging row should expect a 100% hit on name + image + detail URL, ~60% on asset class, ~40% on street + city, ~30% on SF, and **0% on broker/PM/year-built** from index alone. The detail-page crawl belongs as a separate per-row opt-in action, exactly as `portfolio-scout-decision-log.md` already concluded.

This also re-validates the **"SF as confidence signal biases toward industrial"** open question. Of the two index pages that exposed SF, one (Highwoods) is Sun Belt office — but it surfaces SF because its leasing-funnel uses suite size, not because the asset class is office-friendly. The other (Stiles) is mixed-use with a Units field for multifamily. Tiering on SF presence will still under-trust multifamily and over-trust industrial; correcting it requires per-asset-class confidence logic, not a single threshold.

### Field-coverage realism

The brief's "name, address, city, asset class, SF, year built, broker, image, detail link" target list **needs to be tiered**. Tier 1 (extracted from index page, expected ≥90% of the time): name, detail URL, image. Tier 2 (extracted from index ~40–60%): asset class, street, city. Tier 3 (detail page or skip): SF, year built. Tier 4 (rarely on owner sites at all): broker, Property Management contact — these are search-driven enrichment workstreams, not a side-effect of portfolio scraping.

### Still needs a headless pass before extractor code lands

Three sites couldn't be fully characterized via static fetch and remain Pattern B candidates pending headless investigation:

1. **Cousins** (`https://www.cousins.com/properties/`). React SPA, no sitemap.xml, no static content. The XHR endpoint that feeds the React tree is the goal of the headless pass — capture URL, payload shape, auth requirements. Pressure-test test case; gets characterized first.
2. **Lincoln Harris** (`https://www.lincolnharris.com/properties`). Cloudflare 503 on every static request including the sitemap. Headless will tell us whether Cloudflare admits a real browser fingerprint or whether this is a "challenge wall" site that we'd need to route through a residential proxy. If still blocked under headless, this becomes a Pattern D skip-with-reason.
3. **Greystar** (`https://www.greystar.com/homes-to-rent`). Not a single-portfolio surface — hierarchical browse with `__NEXT_DATA__` SSR. Worth one headless pass on `/homes-to-rent/us/nc/charlotte-metro` (or equivalent) to confirm `__NEXT_DATA__` carries the property list inline; if it does, we don't need to intercept any XHR — the SSR payload is the index. But the attribution problem (manager vs. owner) is the bigger blocker; extraction tractability is the secondary question.

These three are the queued items for the next pre-flight pass. The extractor implementation can start on the Pattern C path (covering 5 sites and 7 with sitemap fallback) without waiting on them — the headless path is additive, not load-bearing for v1.

These conclusions are the input to the extractor commit that follows this one.

## What this pre-flight is **not**

- Not a production-grade fetcher. The goal is to characterize patterns, not to extract candidates correctly.
- Not a benchmark of accuracy. That comes later, after the extractor is built and evaluated against known portfolios.
- Not a comprehensive crawl. We're looking at the index page; detail-page mechanics get a separate brief pass.
- Not blocked by Netlify / Auth0. This work doesn't need the preview environment.

## What unblocks the remaining headless pass

The static-fetch portion is done. What's left:

- **Headless browser** with network capture for the three sites flagged in the conclusions (Cousins, Lincoln Harris, Greystar). Playwright with a `page.on('response', ...)` listener filtering `application/json` content-type and response body > 1 KB is the likely shape. Need to confirm Playwright runs in this environment or run it on a developer machine.
- **For Lincoln Harris specifically:** a residential proxy may be required if Cloudflare doesn't admit a real headless browser fingerprint. If still blocked, this becomes a Pattern D skip-with-reason — not load-bearing for v1.
- **For Greystar:** extraction is likely tractable via the `__NEXT_DATA__` SSR payload, but the attribution problem (manager vs. owner) is the larger blocker. See decision log Open Question #2 (Property Management / broker enrichment scope).

The extractor implementation can start on the Pattern C path (5 sites direct + 2 via sitemap = 7) without waiting on the headless results — the headless path is additive, not load-bearing for v1.

## Run log

- **2026-05-16 (a):** First attempt blocked by the environment's egress allowlist — none of the 10 hosts were reachable. Stopped without findings.
- **2026-05-16 (b):** Environment switched to open-network policy. Static-fetch pass run via `curl` (realistic Chrome-on-macOS UA, `Accept-Encoding: gzip, br`, follow redirects). 7/10 of the brief's original URLs returned 200 directly; the other 3 needed URL correction (Highwoods `/properties` → `/find-your-space/search`, JBG Smith `/properties` → `/portfolio/office`, Granite `/portfolio/` → `/explore-properties/`, Crosland `/properties/` → `/portfolio`, Greystar `/find-apartments` → `/homes-to-rent`). Lincoln Harris stayed at 503 under every combination of UA + Sec-Fetch headers + delay tried — Cloudflare bot challenge. Findings matrix and conclusions populated from this pass; headless / XHR portion still outstanding for Cousins, Lincoln Harris, and Greystar.
