# Ring 1 Pre-Flight Investigation

**Status:** structure landed, findings pending. Run the investigation against the URL set below before writing the extractor.

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

## Findings matrix (to be populated)

Per-URL findings will land in this section as the investigation runs. One row per URL; one column per methodology item.

| # | Static HTML size | JSON-LD? | XHR JSON endpoint? | Card selector | Fields on index | Detail page? | Pattern verdict | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | — | — | — | — | — | — | — | — |
| 2 | — | — | — | — | — | — | — | — |
| 3 | — | — | — | — | — | — | — | — |
| 4 | — | — | — | — | — | — | — | — |
| 5 | — | — | — | — | — | — | — | — |
| 6 | — | — | — | — | — | — | — | — |
| 7 | — | — | — | — | — | — | — | — |
| 8 | — | — | — | — | — | — | — | — |
| 9 | — | — | — | — | — | — | — | — |
| 10 | — | — | — | — | — | — | — | — |

## Output: extractor architecture decisions

Once the matrix is populated, this section captures the architecture conclusions:

- **Modal pattern** (what most sites are): _TBD_
- **Fallback order** (which extraction strategy runs first, second, third): _TBD_
- **Headless or static?** (do we need a headless browser at all, and for what fraction): _TBD_
- **JSON-LD detection** (worth a dedicated path, or rare enough to skip): _TBD_
- **XHR capture mechanic** (Playwright network listener, or a different approach): _TBD_
- **Detail-page crawl** (in scope for v1, or follow-up): _TBD_
- **Field-coverage realism** (what fields are actually findable on the index page vs. only on detail pages): _TBD_

These conclusions are the input to the extractor commit that follows this one.

## What this pre-flight is **not**

- Not a production-grade fetcher. The goal is to characterize patterns, not to extract candidates correctly.
- Not a benchmark of accuracy. That comes later, after the extractor is built and evaluated against known portfolios.
- Not a comprehensive crawl. We're looking at the index page; detail-page mechanics get a separate brief pass.
- Not blocked by Netlify / Auth0. This work doesn't need the preview environment.

## What unblocks this from being completed

- **WebFetch on the 10 URLs** for the static-fetch portion (~60% of the signal). Available in this session.
- **Headless browser** with network capture for the XHR portion (the other ~40%). Playwright would do this; need to confirm it's installable in the dev environment or run it on a developer machine.
- **A 2-3 hour focused pass** to populate the matrix and write the conclusions section.

Recommended sequence: run the static-fetch portion first (this branch, next commit), then queue the headless portion either in this environment or locally.
