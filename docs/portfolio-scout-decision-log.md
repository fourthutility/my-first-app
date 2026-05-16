# Portfolio Scout — Decision Log

**Status as of 2026-05-16:** Skeleton pushed to `claude/portfolio-scout-skeleton-mT3Ah` (draft PR #17). Paused on Netlify preview URL being added to Auth0 allowed origins (Shannon). Strategic framing at v0.1 after Rob's first redline pass.

This log captures decisions, deliberate non-decisions, and pressure-test outcomes so we don't re-litigate them in three weeks. Update as we go.

---

## Where we are

- Branch `claude/portfolio-scout-skeleton-mT3Ah` is live on origin.
- Five files shipped: `portfolio-scout.html`, `supabase-functions/portfolio-scout-scrape/index.ts`, `migrations/portfolio-scout-candidates-migration.sql`, `_redirects`, and a FAB addition in `index.html`.
- No scraping logic yet. The edge function returns three hard-coded mock candidates (mixed confidence) so the end-to-end round-trip (form → grid → approve → main inventory) can be validated on the preview before any extraction logic lands.
- The validation gate (submit → review → approve → confirm `projects` row written) is the next checkpoint, blocked on Auth0 origins.

## Decisions made (settled)

1. **Sibling to CSV import, not a replacement.** Separate route, edge function, staging table, UI surface. CSV flow is untouched.
2. **Edge function name:** `portfolio-scout-scrape` — matches existing verb-noun convention (`auth-callback`, `contact-enrich`, `apollo-phone-webhook`).
3. **Staging table name:** `portfolio_candidates`.
4. **UI entry point:** FAB at `right: 164px`, next to the existing CSV import FAB. (User-confirmed over "header button next to BD Feed" or "both.")
5. **Auth0 wiring mirrors the existing pattern.** New page loads `js/auth.js`, gates rendering on `window.IBAuth.ready`, and calls the edge function with `Authorization: Bearer <Auth0 access token>`. No new Auth0 application or audience.
6. **Confidence is free text** (`high` / `medium` / `low`), not an enum. Lets v1 re-tier signals without a migration.
7. **RLS mirrors the `contacts` table:** open `for all using (true)` with service-role bypass via edge function. Lock-down with an Auth0-sub policy is a follow-up.
8. **API contract is async-shaped today, even though v1 returns synchronously.** Implementation can be single-shot for v1; the contract leaves room for `scrape_id` + polling without breaking the client when background jobs land.
9. **Mock returns three candidates with mixed confidence** (2 high, 1 low with no extracted address) so both the bulk-approve and individual-review UX paths are exercised during validation.
10. **No edge-function CI/CD.** Confirmed in this codebase — only `playwright.yml` exists, and it's `workflow_dispatch` only. Edge functions deploy manually via `supabase functions deploy <name> --no-verify-jwt`.
11. **Two manual steps required before the validation gate works:**
    - Run `migrations/portfolio-scout-candidates-migration.sql` in Supabase SQL editor.
    - `supabase functions deploy portfolio-scout-scrape --no-verify-jwt` once Netlify preview is reachable.

## Architectural shifts from the original brief

These came out of the pressure-test pass. The brief got the *shape* right; these adjustments matter for v1 working in the wild rather than just on five hand-picked easy pages.

| Brief said | We're shifting to | Why |
| --- | --- | --- |
| "Static fetch with JS-render fallback" | **JSON-LD → XHR capture in headless → cleaned HTML + Haiku** (in that order of preference) | Most professional CRE portfolios are map-driven (Mapbox/Leaflet hydrated from an XHR JSON call). DOM scraping returns nothing useful even with Playwright. The JSON endpoint, when present, is structurally cleaner than the DOM and 10× more accurate. We need to look for it before falling back to LLM extraction. |
| "Single confidence value per row" | **Confidence signal panel** (has-address, address-parseable, asset-class-extracted, SF-is-numeric, corroborated-by-detail-page) — tier *derived* from signals | A single value hides why the row is trusted or not. Surfacing the signals lets the human reviewer make a fast judgment without re-reading the snippet. |
| "Sonnet for the dedupe/merge step" | **Sonnet only on the residual ambiguous set.** Block by metro/zip → exact normalized-address match → fuzzy within block → *then* Sonnet on what's left | A 200-building submission against ~94 existing rows is 18,800 pairwise comparisons. Sonnet-on-everything explodes daily spend. Block-first keeps it sane. |
| "5 known portfolio pages, 80% extraction" | **10 URLs representing the actual pattern distribution; report extraction rate per pattern, not aggregate** | 5 hand-picked pages will all be the easy pattern. The hard cases are the modal cases. One Hines + one Cousins tells us more than 5 easy wins. |
| `owner_developer` single field | **Two fields: `owner_as_stated` (scrape) + `owner_of_record` (assessor, future)**. The *delta* is BD intelligence | Owner-on-website is often wrong — manager confused with owner (Greystar), recent sale (stale site), JV / SPV legal name vs. brand. The delta between stated and recorded is itself a meeting opener. |
| `status: duplicate` is terminal | **Add a `merged` action** that keeps the existing `projects` row, overwrites `owner_developer`, and appends provenance | Most duplicates *should* update owner attribution — that's the whole point of the feature. "Duplicate, do nothing" loses the signal. |
| "Synchronous is fine for v1" | **Implementation is synchronous; API contract is async-shaped** (`scrape_id` + status, even if it resolves immediately) | iPhone Safari timeouts and Netlify's 26s function ceiling will kill any real REIT scrape. Designing the contract async-first means v1.1 background-job migration doesn't break the UI. |

## Explicitly deferred

The temptation to design "the platform" right now is real. We're holding off on the following until we have either a forcing function or a second concrete consumer.

1. **Generalized evidence-store schema.** Wait until we have a second consumer (ring-2 ownership reconciliation, or ring-3 field-data capture). Designing a shared schema with one real use case is how you build something the second use case won't fit into.
2. **Background job queue / async processor.** v1.1+, tied to the broader iPhone-Safari timeout architectural work.
3. **Auto-discovery of company website from name.** v2+. Manual URL is fine for the crawl phase.
4. **APN / parcel enrichment.** Pending Regrid/Reonomy evaluation.
5. **Re-verification of ownership across existing inventory.** Separate workstream.
6. **Detail-page crawling** for SF / broker / property manager enrichment. Probably belongs as a *separate* opt-in action per row, not part of the index scrape. Decide after pre-flight.

## In progress

- **Regrid free-API trial.** Moving this week, ahead of Attom trial expiry. Validation: owner-of-record fidelity vs. Attom on 20-30 known parcels (Mecklenburg + 1-2 other counties), polygon search, GeoJSON-into-Supabase ingest, building footprint quality on Attom misses. Outcome of this trial determines whether parcel-anchored architecture is the v1.x state (probably yes).

## Open questions

1. **Pre-flight investigation on 10 real portfolio URLs.** Mix of public REIT (Cousins, Highwoods), private institutional (JBG Smith, Granite), regional developer (×2), manager-not-owner (Greystar), fund structure (Blackstone), marketing-led (Stiles), PDF-only (×1). Goal: confirm which of the four patterns (JSON-LD, XHR, DOM, PDF) is modal — and how often SF / broker / PM are actually findable. **Recommended next action regardless of architecture path.** Pair with Regrid trial parcel lookups on the same URLs where possible.
2. **PM / broker enrichment scope.** Pressure-test concluded these are mostly *not* on owner portfolio pages — they require a per-building search workstream (Sonnet + web-search). If they're a v1 must-have, it's a second pipeline, not one extractor. Decision needed before extractor architecture is final.
3. **Premium-tier demo prep for May 31 USMNT event.** Stiles + Berkeley contacts in the room. The Unacast + Regrid parcel-polygon analytics is the headline. Open question: do we want a working tablet-demo for 5-10 Stiles-relevant buildings by then, or do we keep Portfolio Scout v1 as the priority and let the May 31 conversation be verbal? See "May 31 implications" below.
4. **CoStar one-time ingestion for dedupe?** Brief dismissed CoStar as overkill, but a one-time pull for the dedupe lookup table is "expensive once, free per query." Worth a budget conversation.
5. **SF as confidence signal biases toward industrial.** Office and multifamily owners publish vanity metrics, not precise SF. If we tier on SF presence, we systematically over-trust industrial extractions. Accept or correct?

## Blockers

1. **Shannon:** add Netlify preview URL to Auth0 allowed callback URLs, allowed logout URLs, and allowed web origins. Preview URL pattern: `https://claude-portfolio-scout-skeleton-mt3ah--ibscout.netlify.app` (confirm against Netlify dashboard once deploy goes green).
2. **Edge function deploy:** `supabase functions deploy portfolio-scout-scrape --no-verify-jwt` after Netlify is reachable.
3. **Migration:** run `migrations/portfolio-scout-candidates-migration.sql` in Supabase SQL editor.

## Next session (after blockers clear)

1. End-to-end round-trip validation on preview: login → /portfolio-scout → submit → grid → approve → confirm row in `projects` and `imported_building_id` set on staging row.
2. Run the pre-flight investigation on 10 real owner URLs.
3. Decide the PM / broker scope question based on pre-flight findings.
4. Draft the extractor architecture spec — JSON-LD detection, XHR capture strategy, fallback chain, blocking/dedupe approach.
5. Build the extractor as the next commit on this branch (or as a series of commits — fetch path, Haiku integration, dedupe).

## Implications from strategic doc v0.1

The strategic doc redline introduced three things that flow back into the engineering plan:

1. **Regrid is the primary Ring 2 source, not a future possibility.** Trial is this week; Attom is being deprecated to "transaction history only" if at all. The `portfolio_candidates` schema should accommodate `parcel_id` (FK to a parcels table holding APN + GeoJSON polygon) as a near-term addition — design now even if v1 doesn't populate it yet. Address-string dedupe is a bridge, not the destination.
2. **Scout has a premium tier built on parcel-polygon × Unacast mobility data.** The provenance primitive scales (it was designed to), but every record that eventually feeds the premium tier should be parcel-anchored. The fastest way to make the premium tier demoable is to wire `parcel_polygon` through the substrate from day one.
3. **May 31 USMNT event is a soft pacing deadline.** If we want a tablet-demo of the premium-tier hook ("here's your building, parcel-anchored, with yesterday's visitor count and trade-zone origins"), that's a 2-week scope. It's separable from full Portfolio Scout v1 — a focused mock over 5-10 Stiles-relevant buildings using Regrid trial polygons + a placeholder mobility layer would carry the conversation. Decision pending in Open Questions §3.

## Related artifacts

- Strategic framing: `docs/data-strategy-three-rings.md` (draft v0.1 — collaboration target on PR #17)
- Branch: `claude/portfolio-scout-skeleton-mT3Ah`
- Draft PR: https://github.com/fourthutility/my-first-app/pull/17
- Skeleton commit: `7034d2f` · Docs commit: `bbbefff` · Strategic v0.1: this commit
