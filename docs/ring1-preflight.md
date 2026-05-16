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
| 1 | — | — | — | — | — | — | — | blocked: egress allowlist (2026-05-16) |
| 2 | — | — | — | — | — | — | — | blocked: egress allowlist (2026-05-16) |
| 3 | — | — | — | — | — | — | — | blocked: egress allowlist (2026-05-16) |
| 4 | — | — | — | — | — | — | — | blocked: egress allowlist (2026-05-16) |
| 5 | — | — | — | — | — | — | — | blocked: egress allowlist (2026-05-16) |
| 6 | — | — | — | — | — | — | — | blocked: egress allowlist (2026-05-16) |
| 7 | — | — | — | — | — | — | — | blocked: egress allowlist (2026-05-16) |
| 8 | — | — | — | — | — | — | — | blocked: egress allowlist (2026-05-16) |
| 9 | — | — | — | — | — | — | — | blocked: egress allowlist (2026-05-16) |
| 10 | — | — | — | — | — | — | — | blocked: egress allowlist (2026-05-16) |

### Run log

**2026-05-16 — attempted static-fetch pass, blocked.** Tried all 10 URLs via both `WebFetch` and `curl` (with a realistic browser User-Agent and the full Sec-Fetch header set) from the Claude Code on-the-web execution environment. Every request returned HTTP 403 with body `Host not in allowlist` (21 bytes). Verified the same response from unrelated control hosts (`google.com`, `anthropic.com`) and one in-list host (`api.github.com` → 200), confirming the block is the environment's egress proxy rather than per-site anti-bot defenses. No target-site HTML reached this session; the findings matrix cannot be honestly populated from here.

This is itself a useful finding for the architecture conversation — even if the network policy is widened, anti-bot defenses on the real target sites (Cloudflare, Akamai, PerimeterX) are likely the next layer to surface once we get past the proxy, so the production extractor should plan for header-realistic fetches with retry-on-403 → headless escalation regardless.

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

- **Egress access to the 10 target hosts.** The default Claude Code on-the-web network policy in use for this session is a strict allowlist that does not include any of the 10 target domains. The static-fetch attempt on 2026-05-16 returned `Host not in allowlist` for all 10. Three options to unblock, in increasing order of friction:
  1. **Run the static-fetch portion locally** — `curl`/`WebFetch` from a developer machine, paste raw HTML snippets into this doc per URL. No environment change needed; loses the ability to re-run the fetch as part of CI later.
  2. **Switch this session's environment to an "open network" policy** (per the Claude Code on the web docs at <https://code.claude.com/docs/en/claude-code-on-the-web>). Lets the static-fetch pass run from here; doesn't help the production edge function, which lives in Supabase and has its own egress.
  3. **Add the 10 domains to the environment's allowlist** instead of opening it fully. More work, but preserves the security posture if Rob wants this environment to stay locked down.
- **Headless browser** with network capture for the XHR portion (the other ~40%). Playwright would do this; need to confirm it's installable in the dev environment or run it on a developer machine. Same egress constraint applies — Playwright in this environment would also hit the allowlist.
- **A 2-3 hour focused pass** to populate the matrix and write the conclusions section, once egress is sorted.

Recommended sequence: unblock egress (option 1 or 2 above), run the static-fetch portion, then queue the headless portion either in this environment or locally.
