// IB Scout — Portfolio Scout Edge Function
//
// Pipeline 1 (this commit): synchronous scrape.
//   1. Fetch the source URL with realistic browser headers.
//   2. Strip <script>/<style>/nav/footer/header from the HTML.
//   3. JSON-LD bonus check — if a RealEstateListing/Place block exists,
//      use it. Pre-flight saw zero hits in the wild but the check is cheap.
//   4. If the stripped HTML is content-bearing (visible-text size threshold),
//      hand it to Claude Haiku with a structured-output schema.
//   5. If the page is a shell (sub-threshold visible text), try sitemap.xml
//      and treat property-shaped URLs as candidates.
//   6. If neither path produces candidates, return skip-with-reason
//      (fund_structure / cloudflare / shell_no_sitemap / empty).
//   7. Default property_management_company to the publisher org from the
//      URL with pm_confidence='implied'. The per-row Enrich action
//      (Pipeline 2, separate commit) does the search-driven verification.
//
// Pipeline 2 is the `enrich` action — a separate per-row trigger; it lives
// in this same file but does not run inline with scrape.
//
// Deploy: supabase functions deploy portfolio-scout-scrape --no-verify-jwt
// (--no-verify-jwt because the function verifies the Auth0 access token itself)
//
// Required secrets:
//   ANTHROPIC_API_KEY (Haiku for extraction)
//   AUTH0_DOMAIN, AUTH0_AUDIENCE
//   APP_SECRET (LEGACY — accepted as fallback during Auth0 rollout)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injected by Supabase)

import { createRemoteJWKSet, jwtVerify } from "https://esm.sh/jose@5.9.6";

const ANTHROPIC_KEY    = Deno.env.get("ANTHROPIC_API_KEY")!;
// ScrapingAnt is the headless-browser fallback for JS-rendered SPAs and
// Cloudflare-walled sites. Optional — if absent, the scrape handler falls
// back to the same skip:shell_no_sitemap / skip:cloudflare behavior as
// before. Token gates the whole feature on/off cleanly.
const SCRAPINGANT_KEY  = Deno.env.get("SCRAPINGANT_API_KEY") || "";
const AUTH0_DOMAIN     = Deno.env.get("AUTH0_DOMAIN")!;
const AUTH0_AUDIENCE   = Deno.env.get("AUTH0_AUDIENCE")!;
const APP_SECRET       = Deno.env.get("APP_SECRET") || "";  // legacy fallback
const SB_URL           = Deno.env.get("SUPABASE_URL")!;
const SB_SRK         = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const AUTH0_ISSUER = `https://${AUTH0_DOMAIN}/`;
const JWKS = createRemoteJWKSet(new URL(`${AUTH0_ISSUER}.well-known/jwks.json`));

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

// Anthropic web_search tool spec (used by the enrich action for the PM
// verification call). Mirrors the pattern already in use by ai-brief.
const WEB_SEARCH_BETA = "web-search-2025-03-05";
const WEB_SEARCH_TOOL = { type: "web_search_20250305", name: "web_search", max_uses: 2 };

// Visible-text size below which we treat the page as a shell (SPA awaiting
// hydration). Pre-flight evidence: real content-bearing pages had 1.6 KB+
// of visible text after strip; shells had <100 bytes.
const SHELL_VISIBLE_TEXT_THRESHOLD = 1000;

// Haiku input ceiling — strip output above this gets truncated. Pre-flight
// stripped sizes ranged 2.7-43 KB; 50 KB is a comfortable cap.
const HAIKU_INPUT_CHAR_LIMIT = 50_000;

// Post-load wait for Tier 6 (Pattern B SPA) headless renders. Cousins'
// /market/<city> pages snapshot at 39KB (no property grid) without a wait;
// the grid hydrates from XHR a few seconds after navigation. 5s gives
// most React-driven CRE directories enough time to populate.
const HEADLESS_RENDER_WAIT_MS = 5000;

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-User": "?1",
  "Sec-Fetch-Dest": "document",
  "Upgrade-Insecure-Requests": "1",
};

const ALLOWED_ORIGINS = [
  "https://scout.intelligentbuildings.com",
  "https://ibscout.netlify.app",
  "https://fourthutility.github.io",
  "http://localhost:8080",
];

function corsHeaders(origin: string | null) {
  const isAllowed = !!origin && (
    ALLOWED_ORIGINS.includes(origin) ||
    /^https:\/\/[a-z0-9-]+--ibscout\.netlify\.app$/i.test(origin)
  );
  const allowed = isAllowed ? origin! : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin":  allowed,
    "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-app-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

// Accept Auth0 access token (preferred) or x-app-secret (legacy).
// Returns the verified Auth0 sub when present, "" for legacy.
async function authorize(req: Request): Promise<string> {
  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (token) {
    try {
      const { payload } = await jwtVerify(token, JWKS, {
        issuer: AUTH0_ISSUER, audience: AUTH0_AUDIENCE,
      });
      return String(payload.sub || "");
    } catch { /* fall through */ }
  }
  const secret = req.headers.get("x-app-secret");
  if (secret && APP_SECRET && secret === APP_SECRET) return "";
  throw new Error("Unauthorized");
}

async function sbFetch(path: string, opts: RequestInit = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      "apikey": SB_SRK,
      "Authorization": `Bearer ${SB_SRK}`,
      "Prefer": "return=representation",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

// ─── Fetch + strip ───────────────────────────────────────────────────────────

interface FetchResult {
  status:   number;
  body:     string;
  finalUrl: string;
}

async function fetchHtml(url: string): Promise<FetchResult> {
  const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow" });
  const body = await res.text();
  return { status: res.status, body, finalUrl: res.url };
}

// Headless-rendered fetch via the ScrapingAnt API. Used as a fallback for
// JS-rendered SPAs (no useful HTML in the static body) and Cloudflare-walled
// sites (the residential proxy + browser combo bypasses most challenges).
//
// API contract (verified against the official scrapingant-client-js source
// at https://github.com/ScrapingAnt/scrapingant-client-js):
//
//   POST https://api.scrapingant.com/v1/general
//   headers:  x-api-key: <token>
//             Content-Type: application/json
//             Accept: application/json
//   body:     { url, browser?, proxy_type?, proxy_country?, wait_for_selector?,
//               js_snippet?, cookies?, return_text? }
//   response: { content: string,    // rendered HTML
//               cookies: Cookie[],  // cookies returned by the page
//               text: string,       // text-only version (when return_text:true)
//               status_code: number // upstream site's HTTP status
//             }
//   errors:   { detail: string } in body; HTTP non-2xx indicates ScrapingAnt
//             rejected (bad request, quota, etc.) vs. upstream site error
//             (which surfaces in response.status_code).
//
// 60s timeout — matches the official client's default. Pricing varies and
// is opaque from the docs; check the dashboard for current per-call cost.
//
// waitMs: extra delay (in ms) to give React/Vue SPAs time to hydrate
// their XHR-driven content before we snapshot. Implemented via ScrapingAnt's
// `js_snippet` (base64-encoded JS run in the page context after navigation;
// the headless browser awaits the returned Promise before grabbing HTML).
// Empirical evidence from the Cousins case: their /market/<city> SPA
// shipped a 39KB shell at snapshot time; the property grid hydrated later
// from an XHR call. A ~5s wait bumps that to a content-bearing render.
async function fetchRendered(
  url: string,
  opts: { residential?: boolean; waitForSelector?: string; waitMs?: number } = {},
): Promise<FetchResult> {
  if (!SCRAPINGANT_KEY) throw new Error("SCRAPINGANT_API_KEY not configured");

  const requestBody: Record<string, unknown> = {
    url,
    browser:       true,
    proxy_country: "us",
  };
  if (opts.residential)      requestBody.proxy_type        = "residential";
  if (opts.waitForSelector)  requestBody.wait_for_selector = opts.waitForSelector;
  if (opts.waitMs && opts.waitMs > 0) {
    // The browser evaluates this as an expression; the returned Promise
    // is awaited before the page snapshot. ~5s closes the Pattern B XHR
    // hydration gap (Cousins, JBG Smith, Greystar) at the cost of ~5s
    // added latency on every headless call.
    const snippet = `new Promise(function(r){ setTimeout(r, ${opts.waitMs}); });`;
    requestBody.js_snippet = btoa(snippet);
  }

  // Bump the overall request timeout in proportion to the requested wait
  // so a 5s js_snippet doesn't push the call past the 60s abort ceiling.
  const baseTimeoutMs = 60_000;
  const callTimeoutMs = baseTimeoutMs + Math.max(0, opts.waitMs || 0);
  const abortCtl  = new AbortController();
  const timeoutId = setTimeout(() => abortCtl.abort(), callTimeoutMs);
  try {
    const res = await fetch("https://api.scrapingant.com/v1/general", {
      method: "POST",
      headers: {
        "x-api-key":    SCRAPINGANT_KEY,
        "Content-Type": "application/json",
        "Accept":       "application/json",
      },
      body:   JSON.stringify(requestBody),
      signal: abortCtl.signal,
    });
    if (!res.ok) {
      // Try to extract the structured error detail; fall back to raw text.
      let detail = "";
      try {
        const errJson = await res.json();
        detail = errJson?.detail || JSON.stringify(errJson);
      } catch {
        detail = await res.text().catch(() => "");
      }
      throw new Error(`ScrapingAnt ${res.status}: ${String(detail).slice(0, 200)}`);
    }
    const envelope = await res.json();
    if (typeof envelope?.content !== "string") {
      throw new Error(`ScrapingAnt returned unexpected response shape: ${JSON.stringify(envelope).slice(0, 200)}`);
    }
    return {
      // status_code is the UPSTREAM site's HTTP status (not ScrapingAnt's 200).
      // If upstream returned a non-2xx, surface that so detectSkipReason can
      // handle it the same way it handles direct-fetch failures.
      status:   typeof envelope.status_code === "number" ? envelope.status_code : 200,
      body:     envelope.content,
      finalUrl: url,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function visibleTextSize(stripped: string): number {
  return stripped.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().length;
}

// ─── JSON-LD bonus path ──────────────────────────────────────────────────────

interface JsonLdItem { "@type"?: string | string[]; name?: string; address?: unknown; [k: string]: unknown }

function findJsonLdListings(html: string): JsonLdItem[] {
  const blocks = Array.from(html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi));
  const listings: JsonLdItem[] = [];
  for (const m of blocks) {
    try {
      const data = JSON.parse(m[1]);
      const items: JsonLdItem[] = Array.isArray(data) ? data
        : Array.isArray(data["@graph"]) ? data["@graph"]
        : [data];
      for (const item of items) {
        const type = item["@type"];
        const types = Array.isArray(type) ? type : [type];
        if (types.some(t => t === "RealEstateListing" || t === "Place" || t === "LocalBusiness" || t === "Residence")) {
          listings.push(item);
        }
      }
    } catch { /* malformed JSON-LD — skip */ }
  }
  return listings;
}

// ─── Sitemap fallback ────────────────────────────────────────────────────────

async function fetchSitemapPropertyUrls(sourceUrl: string): Promise<string[]> {
  let origin: string;
  try { origin = new URL(sourceUrl).origin; } catch { return []; }
  const res = await fetch(`${origin}/sitemap.xml`, { headers: BROWSER_HEADERS, redirect: "follow" });
  if (!res.ok) return [];
  const xml = await res.text();
  const urls = Array.from(xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)).map(m => m[1]);
  return urls.filter(u => /\/(propert|portfolio|building|asset)/i.test(u));
}

// ─── Skip-with-reason detection ──────────────────────────────────────────────

function detectSkipReason(fetched: FetchResult): string | null {
  const { status, body } = fetched;
  if (status === 503 && /cloudflare|cf-ray/i.test(body)) return "skip:cloudflare";
  if (status === 403 && /cloudflare|cf-ray/i.test(body)) return "skip:cloudflare";
  if (status >= 400) return `skip:http_${status}`;

  // Fund-structure heuristic: mentions of fund/trust/prospectus without
  // any property-list signals.
  const hasPropertyKeyword = /\b(propert|portfolio|building|asset)\b/i.test(body);
  const fundSignals = (body.match(/\b(fund|trust|prospectus|10-K|investor relations)\b/gi) || []).length;
  if (!hasPropertyKeyword && fundSignals >= 2) return "skip:fund_structure";
  return null;
}

// ─── URL + publisher helpers ─────────────────────────────────────────────────

// Forgiving URL normalizer — mirrors the client-side version in
// portfolio-scout.html. Same input rules: prepend https:// when the
// protocol is missing, reject inputs that can't possibly be a URL.
// Server-side safety net for direct API callers that bypass the client.
function normalizeSourceUrl(raw: string): string {
  let s = String(raw || "").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) {
    if (!s.includes(".")) return "";
    s = "https://" + s;
  }
  try { return new URL(s).toString(); } catch { return ""; }
}

function resolveUrl(maybe: string | null | undefined, base: string): string | null {
  if (!maybe || typeof maybe !== "string") return null;
  try { return new URL(maybe, base).toString(); } catch { return null; }
}

function publisherFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const first = host.split(".")[0];
    return first.charAt(0).toUpperCase() + first.slice(1);
  } catch { return ""; }
}

// ─── "Did you mean?" directory-link suggestions ───────────────────────────────
// When a scrape yields very few candidates from a content-bearing page, the
// operator probably pasted a homepage URL instead of the actual property-
// directory URL. Scan the page's links for paths/text that look like they'd
// lead to the directory (Highwoods' "Find Your Space", Cousins' "Properties",
// Stiles' "Portfolio", etc.) and surface them as clickable hints so the BD
// user doesn't need to know each site's URL conventions.

interface DirectorySuggestion { url: string; label: string; }

interface SuggestionScanStats {
  links_scanned:    number;  // total <a> tags considered (post same-origin filter)
  links_total:      number;  // total <a> tags found in scanned HTML (pre-filter)
  matched_total:    number;  // unique URLs that scored ≥1 — what we returned pre-slice
  truncated_to:     number;  // post-slice count actually returned
  scan_html_bytes:  number;
  html_truncated:   boolean; // true if html.length exceeded the scan cap
}

function findPortfolioDirectorySuggestions(
  html: string,
  sourceUrl: string,
): { suggestions: DirectorySuggestion[]; stats: SuggestionScanStats } {
  // URL path patterns (worth 2 points each)
  const pathPatterns: RegExp[] = [
    /\/propert(?:ies|y)\b/i,
    /\/portfolios?\b/i,
    /\/buildings?\b/i,
    /\/assets?\b/i,
    /\/our[-_/](?:propert|portfolio|asset|building)/i,
    /\/find[-_/]?(?:your[-_/]?)?space/i,
    /\/(?:available[-_/])?spaces?(?:[-_/]for[-_/]lease)?\b/i,
    /\/leasing\b/i,
    /\/listings?\b/i,
    /\/inventory\b/i,
    /\/find[-_/]a[-_/]propert/i,
    /\/explore\b/i,
  ];
  // Link-text patterns (worth 1 point each)
  const textPatterns: RegExp[] = [
    /\bour\s+propert/i,
    /\bview\s+propert/i,
    /\bbrowse\s+propert/i,
    /\bfind\s+(?:your\s+)?space\b/i,
    /\bavailable\s+space/i,
    /\bportfolio\b/i,
    /\bour\s+building/i,
  ];

  const emptyStats: SuggestionScanStats = {
    links_scanned: 0, links_total: 0, matched_total: 0,
    truncated_to: 0, scan_html_bytes: 0, html_truncated: false,
  };

  let sourceUrlObj: URL;
  try { sourceUrlObj = new URL(sourceUrl); }
  catch { return { suggestions: [], stats: emptyStats }; }

  // Normalize hostnames for the "same-site" check: strip www. on both
  // sides so highwoods.com and www.highwoods.com count as the same site.
  // Highwoods (and many CRE sites) absolute-link their nav to the www
  // host even when the page is served from the apex; without this fold
  // the same-origin check would discard every directory link in the nav.
  function hostKey(h: string): string { return h.replace(/^www\./i, "").toLowerCase(); }
  const sourceHostKey = hostKey(sourceUrlObj.hostname);
  const sourceProtocol = sourceUrlObj.protocol;

  // Normalize URLs for dedupe and self-skip comparisons. Strips fragment,
  // collapses trailing slashes so /properties and /properties/ map together.
  function urlKey(u: URL): string {
    let path = u.pathname;
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    return hostKey(u.hostname) + path + u.search;
  }
  const sourceKey = urlKey(sourceUrlObj);

  // Bound the scan — caps the regex cost on truly enormous pages. SPA-
  // rendered HTML can run large (Cousins' headless-rendered homepage is
  // well over 200K with the nav block deep in the body), so we err on the
  // generous side; the regex is linear in scanHtml length.
  const SCAN_CAP = 500_000;
  const scanHtml = html.length > SCAN_CAP ? html.slice(0, SCAN_CAP) : html;
  const htmlTruncated = html.length > SCAN_CAP;

  const seen = new Map<string, { url: string; label: string; score: number }>();
  const linkRe = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  let linksTotal = 0;
  let linksScanned = 0;
  while ((m = linkRe.exec(scanHtml)) !== null) {
    linksTotal++;
    const href = m[1];
    const inner = m[2];
    const linkText = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

    let resolved: URL;
    try { resolved = new URL(href, sourceUrl); } catch { continue; }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
    // Same-site check using www-stripped hostnames + same protocol.
    if (hostKey(resolved.hostname) !== sourceHostKey) continue;
    if (resolved.protocol !== sourceProtocol) continue;

    const key = urlKey(resolved);
    if (key === sourceKey) continue;                          // skip the URL we already scraped
    linksScanned++;

    // Score the link — path-pattern match is stronger than text-pattern
    // match, but both can stack.
    let score = 0;
    const path = resolved.pathname;
    for (const re of pathPatterns) { if (re.test(path)) { score += 2; break; } }
    for (const re of textPatterns) { if (re.test(linkText)) { score += 1; break; } }
    if (score === 0) continue;

    // Prefer the highest-scoring instance of each unique URL.
    const label = (linkText || resolved.pathname).slice(0, 80);
    const existing = seen.get(key);
    if (!existing || existing.score < score) {
      seen.set(key, { url: resolved.toString(), label, score });
    }
  }

  // 8-row cap balances "show every market for a market-filter site like
  // Cousins (Atlanta, Austin, Charlotte, …, Tampa)" against "don't drown
  // the operator in a 30-link footer scan." The list is score-sorted so
  // path-pattern matches (score 2) always win over text-only matches
  // (score 1) within the cap.
  const SUGGESTION_CAP = 8;
  const ranked = Array.from(seen.values()).sort((a, b) => b.score - a.score);
  const suggestions = ranked.slice(0, SUGGESTION_CAP).map(({ url, label }) => ({ url, label }));
  return {
    suggestions,
    stats: {
      links_scanned:   linksScanned,
      links_total:     linksTotal,
      matched_total:   ranked.length,
      truncated_to:    suggestions.length,
      scan_html_bytes: scanHtml.length,
      html_truncated:  htmlTruncated,
    },
  };
}

// ─── Tier 6b: directory-link harvest ─────────────────────────────────────────
// When a Pattern B SPA's headless render returns the React shell — DOM
// scaffolding + nav links, but no hydrated property grid — Haiku can't
// extract from it (visible text < SHELL_VISIBLE_TEXT_THRESHOLD). The nav
// links themselves, though, often contain real `/property/<slug>` URLs
// (Cousins' /market/<city> page: 201 North Tryon, 300 South Tryon, etc.).
//
// This helper splits the suggestion-scan output into:
//   - individuals: per-building URLs (`/property/201-north-tryon`)
//   - directories: roll-up URLs (`/properties`, `/market/atlanta`)
//
// Individuals get promoted to name-only candidates — same shape as the
// sitemap-fallback path — so the user lands in the verification grid
// with cards ready to Enrich one-at-a-time, instead of a skip banner
// with a "click each suggestion to start a new scrape" UX.

const INDIVIDUAL_BUILDING_PREFIXES = new Set([
  "property", "properties", "building", "buildings",
  "asset", "assets", "portfolio",
]);

const INDIVIDUAL_BUILDING_RESERVED_SLUGS = new Set([
  "index", "list", "all", "search", "filter", "map", "view", "browse",
]);

function isIndividualPropertyPath(path: string): boolean {
  const segments = path.split("/").filter(Boolean);
  if (segments.length < 2) return false;
  const first = segments[0].toLowerCase();
  if (!INDIVIDUAL_BUILDING_PREFIXES.has(first)) return false;
  const last = segments[segments.length - 1].toLowerCase();
  if (last.length < 3) return false;
  if (INDIVIDUAL_BUILDING_RESERVED_SLUGS.has(last)) return false;
  return true;
}

function splitSuggestionsByShape(
  suggestions: DirectorySuggestion[],
): { individuals: DirectorySuggestion[]; directories: DirectorySuggestion[] } {
  const individuals: DirectorySuggestion[] = [];
  const directories: DirectorySuggestion[] = [];
  for (const s of suggestions) {
    try {
      const u = new URL(s.url);
      if (isIndividualPropertyPath(u.pathname)) individuals.push(s);
      else directories.push(s);
    } catch { directories.push(s); }
  }
  return { individuals, directories };
}

// Convert a per-building suggestion into a name-only HaikuCandidate.
// Mirrors the sitemap path: name derives from the URL slug (title-cased)
// unless the suggestion's link text is a specific name (not generic
// "View Property" copy). detail_url carries through so Enrich can fetch
// the per-building page and run the full Pipeline 2 pass.
function candidateFromIndividualPropertyUrl(s: DirectorySuggestion): HaikuCandidate {
  let slug = "";
  try { slug = new URL(s.url).pathname.split("/").filter(Boolean).pop() || ""; } catch { /* ignore */ }
  const slugName = slug
    ? slug.replace(/[-_]+/g, " ").replace(/\b\w/g, c => c.toUpperCase())
    : null;
  const label = String(s.label || "").trim();
  const labelIsGeneric =
    label.length < 3 ||
    /^(view|see|browse|learn(?:\s+more)?|details?|read\s+more|find\s+out|explore|click)/i.test(label) ||
    /\bproperties?\b/i.test(label) && label.length < 25;
  const name = !labelIsGeneric ? label.slice(0, 80) : slugName;
  return {
    name,
    address: null, city: null, state: null,
    asset_class: null, sqft: null, year_built: null,
    image_url: null, detail_url: s.url,
    raw_snippet: `headless directory link: ${s.url}`,
  };
}

// ─── Pattern D: map-driven inventory detector ────────────────────────────────
// CRE sites increasingly publish their inventory as interactive map widgets
// (Mapbox / Google Maps / Leaflet / ArcGIS pins) with property data loaded
// via XHR as JSON. Our scrape cascade can't reach this data:
//
//   - Static fetch: returns the map container <div>; no property records
//   - Headless render: visually paints the pins, but the structured data
//     lives in JavaScript state — not in any DOM element Haiku can read
//   - Sitemap: usually doesn't enumerate map-marker building pages
//
// This detector catches the signature: known map-library tokens in the
// static HTML PLUS the page being a content-shell (visible-text under the
// shell threshold). Those two together definitively rule out Tier 4/6 —
// rendering won't add any extractable property data. The structured skip
// reason lets the UI map to actionable guidance ("use a per-site adapter
// or Ring 2 parcel data").
//
// Real-world examples: Northwood Office (Charlotte map with 36 buildings),
// many CBRE/JLL/Cushman & Wakefield broker pages, several REIT sites.

interface MapDetection { matched: boolean; signals: string[]; }

function detectMapDrivenInventory(html: string): MapDetection {
  const signals: string[] = [];
  // Each pattern is intentionally narrow — match identifying tokens, not
  // generic words like "map" that show up in totally unrelated contexts.
  const checks: Array<{ name: string; re: RegExp }> = [
    { name: "mapbox-gl",     re: /\bmapbox-gl\b|api\.mapbox\.com|\bmapboxgl\b|\.mapbox-gl-/i },
    { name: "google-maps",   re: /maps\.googleapis\.com\/maps\/api|google\.maps\.|maps\.google\.com\/maps\/api|new\s+google\.maps\.Map/i },
    { name: "leaflet",       re: /\bleaflet\.(?:js|css)\b|class=["'][^"']*\bleaflet-|L\.map\s*\(|\bunpkg\.com\/leaflet/i },
    { name: "arcgis",        re: /\bjs\.arcgis\.com\b|esri\/[^"']*\.js|esri\.config/i },
    { name: "here-maps",     re: /\bjs\.api\.here\.com\b|H\.map\.Map|HereMaps/i },
    { name: "apple-mapkit",  re: /\bcdn\.apple-mapkit\.com\b|mapkit\.init\(/i },
  ];
  for (const c of checks) {
    if (c.re.test(html)) signals.push(c.name);
  }
  return { matched: signals.length > 0, signals };
}

// ─── Per-site adapters ───────────────────────────────────────────────────────
// Escape hatch for sites whose inventory we can't reach via the generic
// tier cascade. Each adapter targets a specific host (e.g. northwoodoffice.com,
// future Pattern D map sites) and runs a custom extraction — usually fetching
// the site's data API directly. Adapters fire BEFORE the cascade so when they
// produce results the standard tiers don't run.
//
// Returning null falls through to the generic cascade — the adapter "declined"
// (URL doesn't match its supported routes, API call failed, etc.). Throwing
// also falls through with a console warning.
//
// To add a new adapter: implement matches() + extract(), append to the
// SITE_ADAPTERS array. extract() returns HaikuCandidates the same shape Haiku
// produces, so dedupe / cache / write-back work without modification.

interface SiteAdapterResult {
  candidates:     HaikuCandidate[];
  publisher_name: string | null;
  notes?:         string[];   // surfaced into diag for debugging
}

interface SiteAdapter {
  label:   string;
  matches: (url: URL) => boolean;
  extract: (url: URL) => Promise<SiteAdapterResult | null>;
}

const SITE_ADAPTERS: SiteAdapter[] = [
  // ──────────────────────────────────────────────────────────────────────────
  // Northwood Office — Pattern D, map-driven inventory
  //
  // The /portfolio map renders ~11 master portfolio entries as Mapbox pins.
  // Property data comes from a Meilisearch instance hosted at
  // search.goballantyne.com (Goballantyne being Northwood's sister-brand;
  // /multi-search is the standard Meilisearch endpoint).
  //
  // Auth: search-only Bearer key. Meilisearch's search keys are scoped to
  // read-only access on specific indexes and are designed for client-side
  // embedding — the same token is visible to anyone with DevTools open on
  // the public site, so it's safe to reuse here. If Northwood rotates the
  // key, the request will 401 and the adapter falls through to the cascade.
  //
  // Scope: only fires on /portfolio (the master map). Per-property detail
  // pages (/portfolio/<city>/<slug>) extract cleanly via the generic Tier 4
  // Haiku path and don't need the adapter. City-filtered pages
  // (/portfolio/charlotte) would need a filter param in the query — not
  // implemented yet; falls through to the generic cascade.
  // ──────────────────────────────────────────────────────────────────────────
  {
    label:   "northwoodoffice",
    matches: (u) => u.hostname.replace(/^www\./, "") === "northwoodoffice.com",
    extract: async (url) => {
      const path = url.pathname.toLowerCase().replace(/\/+$/, "");
      if (path !== "/portfolio") return null;

      const apiUrl    = "https://search.goballantyne.com/multi-search";
      const searchKey = "LCc-c8xC.kiJK8h6";
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${searchKey}`,
          // Mirror the browser's Origin to match the production CORS path.
          "Origin":        "https://www.northwoodoffice.com",
          "Accept":        "application/json",
        },
        body: JSON.stringify({
          queries: [{ indexUid: "northwood_portfolios", limit: 50 }],
        }),
      });
      if (!res.ok) {
        console.warn(`northwood adapter: ${res.status} ${(await res.text()).slice(0, 120)}`);
        return null;
      }
      const data = await res.json();
      const hits = (data?.results?.[0]?.hits || []) as Array<Record<string, unknown>>;
      const candidates: HaikuCandidate[] = hits.map(h => {
        // API returns "1111 Metropolitan Avenue, Charlotte, North Carolina";
        // dedupe + display code expects just the street, so pre-split.
        const fullAddress = typeof h.address === "string" ? h.address : null;
        const street = fullAddress ? fullAddress.split(",")[0].trim() : null;
        return {
          name:        typeof h.title === "string" ? h.title : null,
          address:     street,  // looksLikeStreetAddress filter handles edge cases
          city:        typeof h.city === "string" ? h.city : null,
          state:       typeof h.state === "string" ? stateAbbrev(h.state) : null,
          asset_class: null,
          sqft:        null,
          year_built:  null,
          image_url:   typeof h.image === "string" ? h.image : null,
          detail_url:  typeof h.url   === "string" ? h.url   : null,
          raw_snippet: `Northwood Meilisearch hit id=${h.id}: ${h.title}`,
        };
      });
      return {
        candidates,
        publisher_name: "Northwood Office",
        notes: [`${candidates.length} buildings via Meilisearch (indexUid=northwood_portfolios)`],
      };
    },
  },
];

async function tryAdapter(sourceUrl: string): Promise<{ adapter: SiteAdapter; result: SiteAdapterResult } | null> {
  let u: URL;
  try { u = new URL(sourceUrl); } catch { return null; }
  for (const adapter of SITE_ADAPTERS) {
    if (!adapter.matches(u)) continue;
    try {
      const result = await adapter.extract(u);
      if (result) return { adapter, result };
    } catch (e) {
      console.warn(`Site adapter ${adapter.label} threw:`, (e as Error).message);
    }
  }
  return null;
}

// ─── Address normalization + dedupe against projects ─────────────────────────

// Conservative normalization: lowercase, strip punctuation, collapse
// whitespace, fold common street/directional suffixes to their abbreviated
// forms, drop unit/suite/apt suffixes. Designed for exact-match equality
// post-normalization. Tradeoff: misses edge cases like "1100 South Blvd
// East" vs "1100 South Blvd. E." with extra qualifiers — those become
// distinct keys. False positives are essentially zero, which is the
// priority here.
//
// Pre-split on the first comma: projects.address in this codebase stores
// the full "<street>, <city>, <state> [zip]" string, while the extractor
// typically returns just the street. Comparing only the street portion
// on both sides is what makes the match work.
//
// SYNC: a JS port of this function lives in portfolio-scout.html as
// dkAddress() (powering the "Show keys" diagnostic). If you change any
// rule here, update there too. The diagnostic exists precisely to expose
// drift between the two, so if you forget, false-negatives will show
// disagreeing keys and the bug will be visible.
function normalizeAddress(addr: string | null | undefined): string {
  if (!addr) return "";
  const street = String(addr).split(",")[0];
  return street
    .toLowerCase()
    .replace(/\s+(suite|ste|unit|apt|apartment|floor|fl|#)\s*[\w\-]+\s*$/i, "")
    .replace(/[.;]/g, "")
    .replace(/\bboulevard\b/g, "blvd")
    .replace(/\bavenue\b/g, "ave")
    .replace(/\bstreet\b/g, "st")
    .replace(/\bdrive\b/g, "dr")
    .replace(/\broad\b/g, "rd")
    .replace(/\bhighway\b/g, "hwy")
    .replace(/\bcourt\b/g, "ct")
    .replace(/\bcircle\b/g, "cir")
    .replace(/\bplace\b/g, "pl")
    .replace(/\blane\b/g, "ln")
    .replace(/\bparkway\b/g, "pkwy")
    .replace(/\bnorth\b/g, "n")
    .replace(/\bsouth\b/g, "s")
    .replace(/\beast\b/g, "e")
    .replace(/\bwest\b/g, "w")
    .replace(/\s+/g, " ")
    .trim();
}

// Property-name normalization for Tier 2 (name+city) dedupe.
// Strips punctuation, leading "the ", collapses whitespace,
// lowercases. Does NOT fold generic words like "tower" / "building"
// because that loses too much signal — "110 East Office Tower"
// becomes "110 east" which collides with neighboring properties.
// Instead we gate Tier 2 with a minimum normalized-name length.
function normalizeName(name: string | null | undefined): string {
  if (!name) return "";
  return String(name)
    .toLowerCase()
    .replace(/[.,;'"]/g, "")
    .replace(/^the\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

// City normalization. The candidate's extracted_city may carry
// "City, ST" (when the extractor pulled a state); the projects.address
// city segment is just "City". Split on the first comma both sides
// to align them.
function normalizeCity(city: string | null | undefined): string {
  if (!city) return "";
  return String(city).split(",")[0].toLowerCase().trim();
}

// State-name → 2-letter abbreviation. Used by site adapters whose source
// API returns full state names ("North Carolina") when Scout's convention
// is the 2-letter code ("NC"). Unrecognized input passes through unchanged.
const STATE_ABBREV: Record<string, string> = {
  "alabama": "AL",        "alaska": "AK",          "arizona": "AZ",         "arkansas": "AR",
  "california": "CA",     "colorado": "CO",        "connecticut": "CT",     "delaware": "DE",
  "florida": "FL",        "georgia": "GA",         "hawaii": "HI",          "idaho": "ID",
  "illinois": "IL",       "indiana": "IN",         "iowa": "IA",            "kansas": "KS",
  "kentucky": "KY",       "louisiana": "LA",       "maine": "ME",           "maryland": "MD",
  "massachusetts": "MA",  "michigan": "MI",        "minnesota": "MN",       "mississippi": "MS",
  "missouri": "MO",       "montana": "MT",         "nebraska": "NE",        "nevada": "NV",
  "new hampshire": "NH",  "new jersey": "NJ",      "new mexico": "NM",      "new york": "NY",
  "north carolina": "NC", "north dakota": "ND",    "ohio": "OH",            "oklahoma": "OK",
  "oregon": "OR",         "pennsylvania": "PA",    "rhode island": "RI",    "south carolina": "SC",
  "south dakota": "SD",   "tennessee": "TN",       "texas": "TX",           "utah": "UT",
  "vermont": "VT",        "virginia": "VA",        "washington": "WA",      "west virginia": "WV",
  "wisconsin": "WI",      "wyoming": "WY",         "district of columbia": "DC",
};

function stateAbbrev(s: string | null | undefined): string | null {
  if (!s) return null;
  const lower = String(s).toLowerCase().trim();
  return STATE_ABBREV[lower] || s;
}

// Tier 2 minimum normalized-name length for the EXACT-match path.
// Calibrated against the real dataset: "Peabody Union" (13) and
// "Sky Building" (12) should pass; "Tower" (5), "The Plaza" →
// "plaza" (5), and "Office" (6) should not — generic short names
// are the false-positive risk on exact-match.
const NAME_MIN_CHARS = 12;

// Tier 2b prefix-match minimum. Looser than NAME_MIN_CHARS because
// we also require city co-occurrence to eliminate cross-city
// collisions. Calibrated to catch the "110 East" (8 chars) ↔
// "110 East Office Tower" case real-world data turned up: the
// project's property_name in inventory is shorter than the
// marketing name on the publisher's portfolio page. 8 chars is
// the floor — "Tower" (5), "Plaza" (5), "Office" (6) stay out.
const NAME_PREFIX_MIN_CHARS = 8;

interface ProjectIndexEntry {
  id:            string;
  address:       string;
  property_name: string | null;
}

interface ProjectIndex {
  byAddress:  Map<string, ProjectIndexEntry>;
  byNameCity: Map<string, ProjectIndexEntry>;
  // For Tier 2b prefix matching: project rows grouped by normalized
  // city, each carrying the precomputed normalized name. Allows a
  // bounded scan of "just this city" rather than the full inventory.
  byCity:     Map<string, Array<{ entry: ProjectIndexEntry; name_key: string }>>;
}

// Single-shot load of (id, address, property_name) for every project.
// Supabase REST default cap is 1000 rows; bump to 10000 — well above
// current (~3800) inventory and gives headroom. If this ever needs to
// scale past that, switch to PostgreSQL-side normalize-and-match via
// an RPC.
//
// Builds two indexes: by normalized street address (Tier 1) and by
// normalized property_name + city (Tier 2). Tier 2 only indexes
// projects whose property_name is specific enough to be safe — the
// length gate eliminates generic-name false positives.
async function loadProjectIndex(): Promise<ProjectIndex> {
  const rows: ProjectIndexEntry[] = await sbFetch("projects?select=id,address,property_name&limit=10000");
  const byAddress  = new Map<string, ProjectIndexEntry>();
  const byNameCity = new Map<string, ProjectIndexEntry>();
  const byCity     = new Map<string, Array<{ entry: ProjectIndexEntry; name_key: string }>>();
  for (const row of rows) {
    const addrKey = normalizeAddress(row.address);
    if (addrKey && !byAddress.has(addrKey)) byAddress.set(addrKey, row);

    // City lives between the first and second commas in our convention.
    const segments = String(row.address || "").split(",");
    const cityKey  = normalizeCity(segments[1]);
    const nameKey  = normalizeName(row.property_name);
    if (nameKey.length >= NAME_MIN_CHARS && cityKey) {
      const composite = `${nameKey}|${cityKey}`;
      if (!byNameCity.has(composite)) byNameCity.set(composite, row);
    }
    // byCity index for Tier 2b prefix matching. Only include rows
    // whose name clears the prefix floor — generic short names
    // ("Tower", "Plaza") never qualify, on either side.
    if (cityKey && nameKey.length >= NAME_PREFIX_MIN_CHARS) {
      const list = byCity.get(cityKey) || [];
      list.push({ entry: row, name_key: nameKey });
      byCity.set(cityKey, list);
    }
  }
  return { byAddress, byNameCity, byCity };
}

interface CandidateForDedupe {
  extracted_address: string | null;
  extracted_name:    string | null;
  extracted_city:    string | null;
}

// Two-tier dedupe lookup. Tier 1 (address match) is always tried
// first — false positives essentially zero. Tier 2 (name + city)
// only fires when Tier 1 misses AND the candidate's name is
// specific enough to clear NAME_MIN_CHARS. The combined precision
// is still high: a 12-char name plus a city match across a
// ~3,800-row inventory is very unlikely to collide by chance.
function findDuplicate(candidate: CandidateForDedupe, idx: ProjectIndex): ProjectIndexEntry | null {
  const addrKey = normalizeAddress(candidate.extracted_address);
  if (addrKey) {
    const hit = idx.byAddress.get(addrKey);
    if (hit) return hit;
  }
  const nameKey = normalizeName(candidate.extracted_name);
  const cityKey = normalizeCity(candidate.extracted_city);

  // Tier 2a: exact name+city match.
  if (nameKey.length >= NAME_MIN_CHARS && cityKey) {
    const hit = idx.byNameCity.get(`${nameKey}|${cityKey}`);
    if (hit) return hit;
  }

  // Tier 2b: prefix name match within the same city. Catches the
  // case where projects.property_name is a shorter form of the
  // candidate's name (or vice-versa) — e.g., "110 East" in inventory
  // vs "110 East Office Tower" on the publisher's portfolio page.
  // Bounded to the same normalized city so a generic prefix can't
  // collide across markets.
  if (nameKey.length >= NAME_PREFIX_MIN_CHARS && cityKey) {
    const cityList = idx.byCity.get(cityKey) || [];
    for (const { entry, name_key: projName } of cityList) {
      // Match if one normalized name is a prefix of the other, with
      // a word boundary at the prefix end (avoids "110 East" matching
      // "110 Eastside Plaza"). Shortest-side must clear the prefix floor.
      const shorter = nameKey.length < projName.length ? nameKey : projName;
      const longer  = nameKey.length < projName.length ? projName : nameKey;
      if (shorter.length < NAME_PREFIX_MIN_CHARS) continue;
      if (!longer.startsWith(shorter)) continue;
      // Word-boundary check: the char after the prefix in `longer`
      // must be a space (or end of string, but then it's an exact
      // match handled by Tier 2a).
      const boundary = longer.charAt(shorter.length);
      if (boundary === " ") return entry;
    }
  }

  return null;
}

// ─── Haiku extraction ────────────────────────────────────────────────────────

interface HaikuCandidate {
  name?:             string | null;
  address?:          string | null;
  city?:             string | null;
  state?:            string | null;
  asset_class?:      string | null;
  sqft?:             number | null;
  year_built?:       number | null;
  image_url?:        string | null;
  detail_url?:       string | null;
  raw_snippet?:      string | null;
  // Tier 2 PM extraction: Haiku-from-page-text. When the page explicitly names
  // a property manager ("Managed by X" / "Operated by X" / a leasing contact
  // on a non-publisher email domain), this carries that value. null when no
  // clear signal — the publisher-as-implied default then applies downstream.
  property_manager?: string | null;
}

// ─── Incremental JSON parser for streaming Haiku output ──────────────────────
// Haiku emits its response as { "publisher_name": "...", "properties": [ {...}, {...} ] }.
// When streamed, we receive that as a continuous text stream and want to detect
// each completed property object the moment its closing brace arrives, so we
// can emit it to the client without waiting for the full response.
//
// Strategy: state machine over the buffered text. On each feed() call we
// re-scan the entire buffer from scratch with FRESH local state — depth,
// currentStart, inString, escape are all loop-local, never persisted.
// Compaction at the end of each call drops emitted objects from the buffer
// so the re-scan stays bounded; an in-progress (incomplete) object stays
// at buffer[0] until its closing brace arrives in a later chunk.
//
// Earlier versions of this class persisted depth/inString between calls
// while still scanning from i=0 — that double-counts every existing brace
// and corrupts state on every chunk after the first. Re-scanning from
// scratch each call is the simplest correct approach.
class IncrementalExtractor {
  private buffer = "";
  private publisherName: string | null = null;
  private publisherDetected = false;
  private arrayStarted = false;

  get publisher(): string | null { return this.publisherName; }
  get publisherKnown(): boolean { return this.publisherDetected; }

  feed(chunk: string): unknown[] {
    this.buffer += chunk;
    const completed: unknown[] = [];

    if (!this.arrayStarted) {
      if (!this.publisherDetected) {
        const pubMatch = this.buffer.match(/"publisher_name"\s*:\s*(null|"((?:[^"\\]|\\.)*)")/);
        if (pubMatch) {
          this.publisherDetected = true;
          if (pubMatch[1] === "null") {
            this.publisherName = null;
          } else {
            try { this.publisherName = JSON.parse(pubMatch[1]); } catch { this.publisherName = null; }
          }
        }
      }
      const arrayMatch = this.buffer.match(/"properties"\s*:\s*\[/);
      if (!arrayMatch) return completed;
      this.arrayStarted = true;
      this.buffer = this.buffer.slice(arrayMatch.index! + arrayMatch[0].length);
    }

    // Fresh local state — re-scan the entire current buffer from scratch.
    let depth = 0;
    let currentStart = -1;
    let inString = false;
    let escape = false;

    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      if (inString) {
        if (escape) escape = false;
        else if (ch === "\\") escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === "{") {
        if (depth === 0) currentStart = i;
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0 && currentStart !== -1) {
          const objStr = this.buffer.slice(currentStart, i + 1);
          try { completed.push(JSON.parse(objStr)); } catch { /* skip malformed object */ }
          currentStart = -1;
        }
      }
    }

    // Compact: drop emitted objects (and any inter-object whitespace) so the
    // re-scan on the next call doesn't re-emit them. If an object is in
    // progress, keep the buffer starting at its opening brace.
    if (depth === 0 && currentStart === -1) {
      this.buffer = "";
    } else if (currentStart > 0) {
      this.buffer = this.buffer.slice(currentStart);
    }

    return completed;
  }

  // Last-chance pass after the stream ends. If the incremental parse missed
  // anything (a prompt deviation, an odd chunk boundary, or a buggy edge
  // case in the state machine), this tries to parse the residual buffer as
  // a sequence of comma-separated objects and recover what it can. Returns
  // any objects not already emitted.
  flushResidual(): unknown[] {
    if (!this.arrayStarted || !this.buffer) return [];
    // Wrap the residual in [] so JSON.parse can read it as an array. Strip
    // a trailing `]}` that closes the original outer object, and any
    // trailing comma.
    let s = this.buffer.replace(/\s*[\]}]+\s*$/, "").replace(/,\s*$/, "").trim();
    if (!s) return [];
    try {
      const arr = JSON.parse("[" + s + "]");
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }
}

// Parse Anthropic's own SSE wrapper. Yields each text-delta chunk as it arrives.
async function* streamAnthropicText(payload: Record<string, unknown>): AsyncGenerator<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ ...payload, stream: true }),
  });
  if (!res.ok) throw new Error(`Haiku API ${res.status}: ${await res.text()}`);
  if (!res.body) throw new Error("Haiku response has no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    for (const part of parts) {
      let evType = "", data = "";
      for (const line of part.split("\n")) {
        if (line.startsWith("event: ")) evType = line.slice(7).trim();
        else if (line.startsWith("data: ")) data = line.slice(6).trim();
      }
      if (evType === "content_block_delta" && data) {
        try {
          const parsed = JSON.parse(data);
          if (parsed?.delta?.type === "text_delta" && typeof parsed.delta.text === "string") {
            yield parsed.delta.text;
          }
        } catch { /* skip malformed delta */ }
      }
    }
  }
}

interface HaikuExtractorResult {
  publisher_name: string | null;
  properties:     HaikuCandidate[];
}

// Shared prompt for the index-page extraction. Both the streaming and the
// (legacy, no longer wired up) buffered code paths use this same text.
//
// Field-to-tier mapping per docs/data-strategy-three-rings.md v0.3.1
// §"What we're actually extracting from Ring 1":
//
//   Tier 1 (high confidence — the Portfolio Scout v1 "done" floor):
//     name           → property name (e.g., "1100 South")
//     address        → numeric street address
//     city + state   → location
//     asset_class    → Office/Industrial/Multifamily/Retail/Mixed-Use/...
//     image_url      → hero image
//     raw_snippet    → marketing blurb / supporting evidence
//
//   Tier 2 (medium confidence — v1.5 territory, "extracted when available"):
//     sqft               → square footage      ← extracted by this prompt
//     year_built         → vintage             ← extracted by this prompt
//     property_manager   → manager firm        ← extracted by this prompt (NEW),
//                                                 then upgraded by Pipeline 2 enrich
//                                                 (detail-page text + web_search)
//     detail_url         → per-property URL    ← enables Pipeline 2 detail-page fetch
//
//   Property Management is treated as Tier 1 PRIORITY (per the patch's BD
//   channel-strategy emphasis) despite its Tier 2 reliability. The
//   multi-strategy stack is:
//     (a) explicit on-page text — this prompt asks Haiku to look for
//         "Managed by", "Operated by", contact-email domain mismatches.
//         pm_confidence='extracted' when caught here.
//     (b) detail-page text via Pipeline 2 enrich — same fields, deeper page.
//     (c) Haiku web_search via Pipeline 2 enrich — third-party citations.
//     (d) publisher-as-implied default — fallback for owner-operator cases.
//   Each step can override the previous when it produces evidence.
//
//   Tier 2 NOT yet extracted (intentional v1.5 deferral):
//     - units / floors count
//     - leasing broker name + firm
//     - submarket / neighborhood
//
//   Tier 3 (low confidence — out of scope for v1):
//     ownership entity LLCs, occupancy, transaction history, tenant list,
//     granular amenities. Most resolve cleanly from Ring 2 (assessor record)
//     once Regrid is plumbed in.
function haikuExtractorPrompt(truncatedHtml: string, sourceUrl: string): string {
  return `Extract publisher information and commercial real estate properties from this HTML.

Source URL: ${sourceUrl}

HTML excerpt (script/style/nav/footer already stripped):

${truncatedHtml}

Return a single JSON object with two keys:

{
  "publisher_name": string | null,
  "properties": [
    {
      "name": string,
      "address": string | null,
      "city": string | null,
      "state": string | null,
      "asset_class": string | null,
      "sqft": number | null,
      "year_built": number | null,
      "image_url": string | null,
      "detail_url": string | null,
      "raw_snippet": string,
      "property_manager": string | null
    }
  ]
}

For "publisher_name": the canonical name of the organization that publishes this page, as displayed on the page itself — in the header logo, the page <title>, the footer, or in the "About" copy. Use the exact branding casing — "JBG Smith", not "Jbgsmith"; "Cousins Properties", not "Cousins". null if you cannot identify a clear publisher organization.

For "properties":
- Only extract actual properties displayed on the page. Skip news posts, blog items, case studies that are not standalone listed properties, and navigation/marketing chrome.
- If the page is a fund overview, news index, or has no actual property listings, return [].
- "name" is the building/property name (e.g., "110 East Office Tower", "The Main Las Olas").
- "address" MUST be a numeric street address (a building number followed by a street name — "225 E Las Olas Blvd", "110 East Blvd", "1100 South Boulevard"). A string without any digit is NOT a valid address. If no numeric street address is visible on the page for this specific property, return null. NEVER substitute the city, neighborhood, building name, property name, or marketing tagline into the address field. Examples of WRONG address values: "Charlotte", "South End", "Downtown", "110 East Office Tower". Examples of CORRECT address values: "1100 South Blvd", "225 E Las Olas Blvd", "200 W 4th St".
- "city" is the city name ONLY (e.g., "Charlotte", not "Charlotte, NC", not "Charlotte, North Carolina"). Always populate the city when it is identifiable anywhere in the property's description, surrounding text, page header, or address copy. Do NOT leave city null if the city appears anywhere associated with this property on the page. State goes in the separate "state" field.
- "state" is the 2-letter state code (e.g., "NC", "FL").
- asset_class should be one of: Office, Industrial, Multifamily, Retail, Mixed-Use, Medical Office, Life Sciences, Self-Storage, Hospitality, Land. Closest match; null if not derivable.
- sqft must be a number (no commas, no units). null if not present.
- image_url and detail_url may be relative — return what the HTML actually contains.
- raw_snippet must be a literal text excerpt from the HTML that supports the extraction (1-2 sentences). The human-auditable evidence.
- "property_manager" is the property management firm if EXPLICITLY named on the page. Look for: phrases like "Managed by X", "Property Management: X", "Operated by X"; contact emails on a domain different from the publisher's domain (e.g., a Stiles-published page with a leasing email "leasing@greystar.com" suggests Greystar manages); a manager logo or attribution in the footer or property card. null when no explicit signal. NEVER guess based on the publisher — the publisher-as-implied default is handled separately downstream; your job here is to capture explicit third-party PM mentions. Examples of VALID values: "Stiles Property Management", "Greystar Real Estate Partners", "Lincoln Harris CSG". Examples of INVALID values: the building name, the building owner if it's not also explicitly stated to be the manager, "Property Management" as a category label.

CRITICAL ordering for streaming: emit "publisher_name" BEFORE "properties" in the output. The publisher key must close before the properties array opens.

YOUR ENTIRE RESPONSE MUST BE A SINGLE JSON OBJECT. No preamble, no explanation, no markdown fences. Start with { and end with }.`;
}

async function callHaikuExtractor(strippedHtml: string, sourceUrl: string): Promise<HaikuExtractorResult> {
  const truncated = strippedHtml.length > HAIKU_INPUT_CHAR_LIMIT
    ? strippedHtml.slice(0, HAIKU_INPUT_CHAR_LIMIT)
    : strippedHtml;

  const prompt = haikuExtractorPrompt(truncated, sourceUrl);

  const payload = {
    model: HAIKU_MODEL,
    max_tokens: 8192,
    messages: [{ role: "user", content: prompt }],
  };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Haiku API ${res.status}: ${await res.text()}`);

  const message = await res.json();
  const text = (message.content as Array<{ type: string; text?: string }>)
    .filter(b => b.type === "text")
    .map(b => b.text || "")
    .join("");

  const start = text.indexOf("{");
  const end   = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`Haiku did not return a JSON object. First 200 chars: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(text.slice(start, end + 1));
  return {
    publisher_name: typeof parsed.publisher_name === "string" && parsed.publisher_name.trim() ? parsed.publisher_name.trim() : null,
    properties:     Array.isArray(parsed.properties) ? parsed.properties : [],
  };
}

// ─── JSON-LD → candidate mapper ──────────────────────────────────────────────

function jsonLdToCandidates(items: JsonLdItem[], sourceUrl: string): HaikuCandidate[] {
  const out: HaikuCandidate[] = [];
  for (const item of items) {
    const name = typeof item.name === "string" ? item.name : null;
    if (!name) continue;
    const addr = item.address as Record<string, unknown> | string | undefined;
    let street: string | null = null, city: string | null = null, state: string | null = null;
    if (typeof addr === "string") {
      street = addr;
    } else if (addr && typeof addr === "object") {
      street = typeof addr.streetAddress === "string" ? addr.streetAddress : null;
      city   = typeof addr.addressLocality === "string" ? addr.addressLocality : null;
      state  = typeof addr.addressRegion === "string" ? addr.addressRegion : null;
    }
    const image = item.image;
    const imageUrl = typeof image === "string" ? image
                   : Array.isArray(image) && typeof image[0] === "string" ? image[0] as string
                   : null;
    out.push({
      name,
      address: street,
      city,
      state,
      asset_class: null,
      sqft: null,
      year_built: null,
      image_url: resolveUrl(imageUrl, sourceUrl),
      detail_url: typeof item.url === "string" ? resolveUrl(item.url, sourceUrl) : null,
      raw_snippet: `JSON-LD ${(Array.isArray(item["@type"]) ? item["@type"].join("/") : item["@type"]) || "item"}: ${name}${street ? ` @ ${street}` : ""}`,
    });
  }
  return out;
}

// ─── Confidence + candidate-row mapping ──────────────────────────────────────

function deriveConfidence(c: HaikuCandidate): "high" | "medium" | "low" {
  const hasAddress = !!c.address;
  if (!hasAddress) return "low";
  const hasAssetClass = !!c.asset_class;
  const hasSqft = typeof c.sqft === "number";
  if (hasAddress && hasAssetClass && hasSqft) return "high";
  if (hasAddress && (hasAssetClass || hasSqft)) return "medium";
  return "medium";
}

interface CandidateRow {
  id?:                         string;  // pre-generated server-side for streaming; DB uses if provided
  owner_name:                  string;
  source_url:                  string;
  raw_snippet:                 string | null;
  extracted_name:              string | null;
  extracted_address:           string | null;
  extracted_city:              string | null;
  extracted_sqft:              number | null;
  extracted_asset_class:       string | null;
  extracted_image_url:         string | null;
  extracted_detail_url:        string | null;
  extracted_year_built:        number | null;
  property_management_company: string | null;
  pm_confidence:               string;
  confidence:                  string;
  extraction_method:           string;
  status:                      string;
  duplicate_of_project_id:     string | null;
  duplicate_match_address:     string | null;
}

// Haiku occasionally ignores the "address must be a street" prompt rule
// and writes the city name, neighborhood, or property name into the
// address field. Server-side enforcement: a real street address has a
// digit somewhere. Strings without one get nulled out at row-build time
// so they never poison the dedupe address-key.
function looksLikeStreetAddress(s: string | null | undefined): boolean {
  if (!s) return false;
  return /\d/.test(String(s));
}

// Builds the per-field provenance object the projects.provenance JSONB
// column expects. Source is always "portfolio_scout" for writes from this
// function; URL is the candidate's scrape source; timestamp is generation
// time of the call. Only fields with a non-blank value get a provenance
// entry — blank writes don't deserve attribution.
interface ProvenanceEntry { source: string; url: string; updated_at: string; }

function buildScoutProvenance(
  sourceUrl: string,
  fields: Record<string, unknown>,
): Record<string, ProvenanceEntry> {
  const now = new Date().toISOString();
  const out: Record<string, ProvenanceEntry> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined || v === "") continue;
    out[k] = { source: "portfolio_scout", url: sourceUrl, updated_at: now };
  }
  return out;
}

function buildCandidateRow(
  c: HaikuCandidate,
  ownerName: string,
  sourceUrl: string,
  method: string,
  publisher: string,
): CandidateRow {
  const cityState = c.city && c.state ? `${c.city}, ${c.state}` : (c.city || null);
  return {
    owner_name:                  ownerName,
    source_url:                  sourceUrl,
    raw_snippet:                 c.raw_snippet || null,
    extracted_name:              c.name || null,
    extracted_address:           looksLikeStreetAddress(c.address) ? c.address! : null,
    extracted_city:              cityState,
    extracted_sqft:              typeof c.sqft === "number" ? c.sqft : null,
    extracted_asset_class:       c.asset_class || null,
    extracted_image_url:         resolveUrl(c.image_url, sourceUrl),
    extracted_detail_url:        resolveUrl(c.detail_url, sourceUrl),
    extracted_year_built:        typeof c.year_built === "number" ? c.year_built : null,
    // PM resolution priority: Haiku-from-page-text (explicit mention) >
    // publisher-as-implied (URL slug). Pipeline 2 Enrich can later upgrade
    // with detail-page text and web-search verification. Defensive: ignore
    // page-text values that look like garbage (too short, equal to the
    // building name or publisher — those mean Haiku reached for nothing).
    property_management_company: (() => {
      const fromPage = typeof c.property_manager === "string" ? c.property_manager.trim() : "";
      if (fromPage && fromPage.length >= 3
          && fromPage.toLowerCase() !== (c.name || "").toLowerCase()
          && fromPage.toLowerCase() !== (publisher || "").toLowerCase()) {
        return fromPage;
      }
      return publisher || null;
    })(),
    pm_confidence: (() => {
      const fromPage = typeof c.property_manager === "string" ? c.property_manager.trim() : "";
      if (fromPage && fromPage.length >= 3
          && fromPage.toLowerCase() !== (c.name || "").toLowerCase()
          && fromPage.toLowerCase() !== (publisher || "").toLowerCase()) {
        return "extracted";  // explicit on-page mention; raw_snippet should reflect
      }
      return publisher ? "implied" : "unknown";
    })(),
    confidence:                  deriveConfidence(c),
    extraction_method:           method,
    status:                      "pending",
    duplicate_of_project_id:     null,
    duplicate_match_address:     null,
  };
}

// ─── Pipeline 1: orchestration ───────────────────────────────────────────────

interface ScrapeResult {
  candidates:     HaikuCandidate[];
  method:         string;
  publisher_name: string | null;
  skip?:          string;
}

async function extractFromIndex(sourceUrl: string): Promise<ScrapeResult> {
  const fetched = await fetchHtml(sourceUrl);

  const skip = detectSkipReason(fetched);
  if (skip) return { candidates: [], method: skip, publisher_name: null, skip };

  // Try JSON-LD first (rare bonus path)
  const jsonLdItems = findJsonLdListings(fetched.body);
  if (jsonLdItems.length > 0) {
    return { candidates: jsonLdToCandidates(jsonLdItems, fetched.finalUrl), method: "jsonld", publisher_name: null };
  }

  // Content-bearing? Use Haiku on the stripped HTML.
  const stripped = stripHtml(fetched.body);
  if (visibleTextSize(stripped) >= SHELL_VISIBLE_TEXT_THRESHOLD) {
    const result = await callHaikuExtractor(stripped, fetched.finalUrl);
    return { candidates: result.properties, method: "haiku_html", publisher_name: result.publisher_name };
  }

  // Shell — try sitemap fallback. Each property URL becomes a name-only candidate.
  const sitemapUrls = await fetchSitemapPropertyUrls(fetched.finalUrl);
  if (sitemapUrls.length > 0) {
    const candidates: HaikuCandidate[] = sitemapUrls.slice(0, 200).map(u => {
      // Derive a tentative name from the slug — last path segment, hyphens → spaces, title case.
      let slug = "";
      try { slug = new URL(u).pathname.split("/").filter(Boolean).pop() || ""; } catch { /* ignore */ }
      const name = slug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()) || null;
      return {
        name,
        address: null, city: null, state: null,
        asset_class: null, sqft: null, year_built: null,
        image_url: null,
        detail_url: u,
        raw_snippet: `sitemap.xml: ${u}`,
      };
    });
    return { candidates, method: "sitemap", publisher_name: null };
  }

  return { candidates: [], method: "skip:shell_no_sitemap", publisher_name: null, skip: "skip:shell_no_sitemap" };
}

// ─── Pipeline 2: per-row enrichment ──────────────────────────────────────────

interface DetailExtractResult {
  address?:          string | null;
  asset_class?:      string | null;
  sqft?:             number | null;
  year_built?:       number | null;
  image_url?:        string | null;
  raw_snippet?:      string | null;
  property_manager?: string | null;
}

async function callHaikuDetailExtractor(strippedHtml: string, detailUrl: string): Promise<DetailExtractResult> {
  const truncated = strippedHtml.length > HAIKU_INPUT_CHAR_LIMIT
    ? strippedHtml.slice(0, HAIKU_INPUT_CHAR_LIMIT)
    : strippedHtml;

  const prompt = `Extract supplemental fields for a single commercial real estate property from its detail page.

Detail page URL: ${detailUrl}

HTML excerpt (script/style/nav/footer stripped):

${truncated}

Return a single JSON object with these keys. Use null where the page does not contain the data — do not invent.

{
  "address": string | null,
  "asset_class": string | null,
  "sqft": number | null,
  "year_built": number | null,
  "image_url": string | null,
  "raw_snippet": string,
  "property_manager": string | null
}

Rules:
- address MUST be a numeric street address (building number + street name — "1100 South Blvd", "225 E Las Olas Blvd"). If no numeric street is visible on the page, return null. NEVER substitute the city, neighborhood, or building name.
- asset_class: one of Office, Industrial, Multifamily, Retail, Mixed-Use, Medical Office, Life Sciences, Self-Storage, Hospitality, Land — closest match, or null.
- sqft: numeric, no commas/units. null if not present.
- raw_snippet: literal text excerpt from the HTML that supports the extractions (1-2 sentences). The human-auditable evidence.
- property_manager: the property management firm if EXPLICITLY named on this detail page. Look for: "Managed by X" / "Property Management: X" / "Operated by X"; leasing contact emails on a non-publisher domain; manager logos or attributions in the footer. null when no explicit signal. NEVER guess based on the publisher.
- YOUR ENTIRE RESPONSE MUST BE A SINGLE JSON OBJECT. No preamble, no markdown fences. Start with { and end with }.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type":     "application/json",
      "x-api-key":        ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Haiku detail API ${res.status}: ${await res.text()}`);

  const message = await res.json();
  const text = (message.content as Array<{ type: string; text?: string }>)
    .filter(b => b.type === "text").map(b => b.text || "").join("");
  const start = text.indexOf("{");
  const end   = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`Haiku detail did not return JSON object: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start, end + 1));
}

interface PmSearchResult {
  property_management_company: string | null;
  pm_confidence:               "extracted" | "implied" | "unknown";
  raw_snippet:                 string | null;
}

async function callHaikuPmSearch(
  buildingName: string,
  address: string | null,
  city: string | null,
  ownerName: string,
): Promise<PmSearchResult> {
  const locationFragment = [address, city].filter(Boolean).join(", ");
  const query = `${buildingName}${locationFragment ? ` ${locationFragment}` : ""} property management company`;

  const prompt = `You are verifying the Property Management firm for a specific commercial real estate property.

Building: ${buildingName}
Address: ${address || "(not provided)"}
City: ${city || "(not provided)"}
Owner (as known to us): ${ownerName}

Use the web_search tool with this exact query first: "${query}"
You may run one additional search if the first does not produce a clear answer.

Return a single JSON object:

{
  "property_management_company": string | null,
  "pm_confidence": "extracted" | "implied" | "unknown",
  "raw_snippet": string | null
}

Rules:
- "extracted" only when a search result explicitly names the management firm for THIS specific building (not just the owner's general management subsidiary). Cite the source in raw_snippet.
- "implied" if the building's manager is reasonably inferred from the owner being a vertically-integrated owner-operator (e.g., Stiles manages Stiles-owned properties).
- "unknown" if you cannot find a credible answer — return null for property_management_company.
- raw_snippet is a literal quote from a search result that supports the answer, plus the source URL in parentheses. null if unknown.
- Do NOT confuse the leasing broker with the property manager. Do NOT confuse the owner with the manager unless the owner is vertically integrated.
- YOUR ENTIRE FINAL RESPONSE MUST BE A SINGLE JSON OBJECT. No preamble, no markdown fences. Start with { and end with }.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta":    WEB_SEARCH_BETA,
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 2048,
      tools: [WEB_SEARCH_TOOL],
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`PM search API ${res.status}: ${await res.text()}`);

  const message = await res.json();
  const text = (message.content as Array<{ type: string; text?: string }>)
    .filter(b => b.type === "text").map(b => b.text || "").join("");
  const start = text.indexOf("{");
  const end   = text.lastIndexOf("}");
  if (start === -1 || end === -1) {
    return { property_management_company: null, pm_confidence: "unknown", raw_snippet: null };
  }
  const parsed = JSON.parse(text.slice(start, end + 1));
  return {
    property_management_company: typeof parsed.property_management_company === "string" ? parsed.property_management_company : null,
    pm_confidence:               (["extracted", "implied", "unknown"].includes(parsed.pm_confidence) ? parsed.pm_confidence : "unknown") as PmSearchResult["pm_confidence"],
    raw_snippet:                 typeof parsed.raw_snippet === "string" ? parsed.raw_snippet : null,
  };
}

// ─── Scrape cache ────────────────────────────────────────────────────────────
// Static building data doesn't change much, so re-running the Haiku
// extraction tier on the same directory burns tokens for no meaningful
// change. The `scrape_cache` table holds the candidate set per normalized
// URL for SCRAPE_CACHE_TTL_DAYS days; clients can bypass it with
// `force_refresh: true` in the request body.
//
// Dedupe always re-runs against the live projects table on cache hit,
// because projects may have been added since the cache row was written.

const SCRAPE_CACHE_TTL_DAYS = 14;

function normalizeUrlForCache(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    let path = u.pathname.replace(/\/+$/, "");
    if (!path) path = "/";
    return `${u.protocol.toLowerCase()}//${host}${path}${u.search}`.toLowerCase();
  } catch {
    return String(url || "").toLowerCase();
  }
}

interface ScrapeCachePayload {
  owner_name:     string;
  publisher_name: string | null;
  method:         string;
  candidates:     Array<Omit<CandidateRow, "id" | "status" | "duplicate_of_project_id" | "duplicate_match_address">>;
}

interface ScrapeCacheRow {
  url_normalized:  string;
  method:          string;
  candidate_count: number;
  payload:         ScrapeCachePayload;
  publisher_name:  string | null;
  scraped_at:      string;
  expires_at:      string;
}

async function lookupScrapeCache(url: string): Promise<ScrapeCacheRow | null> {
  const key = encodeURIComponent(normalizeUrlForCache(url));
  const nowIso = encodeURIComponent(new Date().toISOString());
  try {
    const rows = await sbFetch(
      `scrape_cache?url_normalized=eq.${key}&expires_at=gt.${nowIso}&select=*&limit=1`,
    );
    return Array.isArray(rows) && rows[0] ? (rows[0] as ScrapeCacheRow) : null;
  } catch (e) {
    console.warn("scrape_cache lookup failed:", (e as Error).message);
    return null;
  }
}

async function writeScrapeCache(
  url: string,
  method: string,
  publisherName: string | null,
  ownerName: string,
  candidates: CandidateRow[],
): Promise<void> {
  const key = normalizeUrlForCache(url);
  const now = new Date();
  const expires = new Date(now.getTime() + SCRAPE_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000);
  // Strip transient/dedupe fields — they re-run live on every scrape.
  const cleanCandidates = candidates.map(c => {
    const { id: _id, status: _status, duplicate_of_project_id: _d1, duplicate_match_address: _d2, ...rest } = c;
    return rest;
  });
  const row = {
    url_normalized:  key,
    method,
    candidate_count: candidates.length,
    payload: {
      owner_name:     ownerName,
      publisher_name: publisherName,
      method,
      candidates:     cleanCandidates,
    },
    publisher_name:  publisherName,
    scraped_at:      now.toISOString(),
    expires_at:      expires.toISOString(),
  };
  // Direct fetch (not sbFetch) because we ask PostgREST for return=minimal
  // — empty response body — and sbFetch always calls res.json(), which
  // throws "Unexpected end of JSON input" on an empty body even though
  // the UPSERT itself succeeded.
  try {
    const res = await fetch(`${SB_URL}/rest/v1/scrape_cache`, {
      method: "POST",
      headers: {
        "Content-Type":   "application/json",
        "apikey":         SB_SRK,
        "Authorization":  `Bearer ${SB_SRK}`,
        "Prefer":         "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      throw new Error(`scrape_cache POST ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  } catch (e) {
    console.warn("scrape_cache write failed:", (e as Error).message);
  }
}

// ─── Main handler ────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);

  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  let reviewerSub = "";
  try {
    reviewerSub = await authorize(req);
  } catch (e) {
    return new Response(JSON.stringify({ error: "Unauthorized", detail: (e as Error).message }), {
      status: 401, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const action = String(body.action || "scrape");

  // ── action: scrape — fetch, extract, persist, return ───────────────────────
  if (action === "scrape") {
    const userOwnerOverride = String(body.owner_name || "").trim();
    const sourceUrl         = normalizeSourceUrl(String(body.source_url || ""));
    const forceRefresh      = Boolean(body.force_refresh);
    if (!sourceUrl) {
      return new Response(JSON.stringify({ error: "source_url must be a valid http(s) URL" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // ─── Extraction tiers (graceful degradation) ────────────────────────────
    // Try cheap/fast first; escalate to expensive/slow only when needed; the
    // FIRST tier that produces candidates wins and the rest are skipped.
    // Same pattern as a browser trying cache before network, or a DB trying
    // in-memory indexes before disk scan. The corresponding tier numbers are
    // marked in comments throughout this handler so the architectural model
    // matches what a reader sees in code.
    //
    //   Tier 1 — Static HTTP fetch with realistic browser headers.
    //            Free. ~1-2s. Always tried first.
    //   Tier 2 — Cloudflare bypass via ScrapingAnt residential proxy.
    //            ScrapingAnt credits. ~10-20s. Fires only when Tier 1 hit a
    //            Cloudflare challenge AND SCRAPINGANT_KEY is configured.
    //   Tier 3 — JSON-LD parse for RealEstateListing / Place schema in the
    //            static HTML. Free. Instant. Rare bonus path.
    //   Tier 4 — Haiku-on-stripped-HTML extraction. Haiku tokens. ~5-15s.
    //            The modal success path — fires when the page is content-
    //            bearing (≥SHELL_VISIBLE_TEXT_THRESHOLD chars after strip).
    //   Tier 5 — sitemap.xml fallback. Free. ~1-2s. Fires when Tier 4 saw
    //            a shell. Each property URL becomes a name-only candidate.
    //   Tier 6 — Headless render via ScrapingAnt + Haiku extraction.
    //            ScrapingAnt credit + Haiku tokens. ~15-30s. Fires when Tier
    //            5 had no usable sitemap AND SCRAPINGANT_KEY is configured.
    //            Closes the Pattern B gap (Cousins, JBG Smith, Greystar).
    //   Tier 7 — Skip with reason. Last resort; surfaces a structured
    //            skip:<reason> the client maps to a banner with guidance.
    //
    // Server-Sent Events stream. As the extractor discovers each building it
    // emits a "property" event so the client can render the card immediately —
    // no waiting for the full Haiku response to complete. Stages, dedupe
    // verdicts, the final summary, and any errors are sent as separate event
    // types over the same stream.
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (type: string, payload: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`));
        };

        // ── Diagnostic accumulator ─────────────────────────────────────────
        // Populated as each extraction tier runs. Folded into the final
        // complete/skip event as `diagnostic:` so the UI can render a
        // self-service debug strip without a second round-trip.
        const diag: Record<string, unknown> = {
          source_url:                sourceUrl,
          tiers_attempted:           [] as string[],
          static_html_bytes:         null,
          static_visible_text:       null,
          static_final_url:          null,
          rendered_html_bytes:       null,
          rendered_visible_text:     null,
          rendered_final_url:        null,
          render_wait_ms:            null,
          used_residential_proxy:    false,
          json_ld_items:             0,
          json_ld_candidates:        0,
          sitemap_urls_found:        0,
          haiku_candidate_count:     0,
          suggestions:               null,  // SuggestionScanStats
          map_signals:               [] as string[],
          from_cache:                false,
          force_refresh:             forceRefresh,
        };
        const tiers = diag.tiers_attempted as string[];
        // Suggestion-scan helper: extracts the .suggestions list (for emit)
        // while writing the stats into the diag block as a side effect.
        // The LAST call wins for stats — fine because each scrape only
        // takes one of the skip/complete paths.
        const scanSuggestions = (body: string, finalUrl: string): DirectorySuggestion[] => {
          const result = findPortfolioDirectorySuggestions(body, finalUrl);
          diag.suggestions = result.stats;
          return result.suggestions;
        };
        // Emit + log + close in one shot. Use this on every terminal SSE
        // event so the diagnostic block is always present and the function
        // log always carries the one-line summary.
        const finishWith = (eventType: "complete" | "skip", payload: Record<string, unknown>) => {
          send(eventType, { ...payload, diagnostic: diag });
          // Backend-side log line — one row per scrape, queryable in
          // Supabase function logs.
          const logSummary = {
            url:        sourceUrl,
            event:      eventType,
            method:     payload.method ?? null,
            reason:     payload.reason ?? null,
            count:      payload.count ?? null,
            from_cache: diag.from_cache,
            tiers:      tiers,
            static_bytes:   diag.static_html_bytes,
            rendered_bytes: diag.rendered_html_bytes,
            suggestions:    diag.suggestions,
          };
          console.log(`[portfolio-scout-scrape] ${JSON.stringify(logSummary)}`);
          controller.close();
        };

        try {
          // ── Cache check ────────────────────────────────────────────────────
          // Cache-first by default. `force_refresh: true` bypasses the cache
          // (and overwrites the row when the fresh extraction succeeds).
          // Dedupe runs LIVE against the projects table either way — cached
          // dedupe verdicts go stale as new projects are added.
          if (!forceRefresh) {
            const cached = await lookupScrapeCache(sourceUrl);
            if (cached) {
              tiers.push("cache_hit");
              diag.from_cache = true;
              const ownerName = userOwnerOverride || cached.payload.owner_name;
              const method    = cached.method;
              send("publisher", {
                owner_name:     ownerName,
                publisher_name: cached.publisher_name,
              });
              const cachedCandidateRows: CandidateRow[] = cached.payload.candidates.map(c => ({
                ...c,
                id:                      crypto.randomUUID(),
                owner_name:              ownerName, // honor current override
                status:                  "pending",
                duplicate_of_project_id: null,
                duplicate_match_address: null,
              }));
              for (const row of cachedCandidateRows) {
                send("property", { candidate: row });
              }
              send("progress", { stage: "discovering", count: cachedCandidateRows.length });

              send("progress", { stage: "dedupe", count: cachedCandidateRows.length });
              let cachedDuplicateCount = 0;
              try {
                const projectIndex = await loadProjectIndex();
                for (const row of cachedCandidateRows) {
                  const match = findDuplicate(row, projectIndex);
                  if (match) {
                    row.duplicate_of_project_id = match.id;
                    row.duplicate_match_address = match.address;
                    cachedDuplicateCount++;
                    send("dedupe", {
                      id:                      row.id!,
                      duplicate_of_project_id: match.id,
                      duplicate_match_address: match.address,
                    });
                  }
                }
              } catch (e) {
                console.warn("Dedupe pass failed:", (e as Error).message);
              }

              send("progress", { stage: "saving", count: cachedCandidateRows.length });
              await sbFetch("portfolio_candidates", {
                method: "POST",
                body: JSON.stringify(cachedCandidateRows),
              });

              const ageMs   = Date.now() - new Date(cached.scraped_at).getTime();
              const ageDays = Math.max(0, Math.floor(ageMs / (24 * 60 * 60 * 1000)));
              diag.haiku_candidate_count = cachedCandidateRows.length;
              finishWith("complete", {
                method,
                owner_name:          ownerName,
                duplicates_detected: cachedDuplicateCount,
                count:               cachedCandidateRows.length,
                from_cache:          true,
                scraped_at:          cached.scraped_at,
                cache_age_days:      ageDays,
                suggestions:         [],
              });
              return;
            }
          }

          // ── Site adapter check ─────────────────────────────────────────────
          // Per-site escape hatches for hosts whose inventory we can't reach
          // via the generic cascade — typically Pattern D map-driven sites
          // whose data API has been identified through manual investigation.
          // Adapters run BEFORE the cascade; if one produces candidates, the
          // generic tiers don't fire. Returning null falls through.
          const adapterMatch = await tryAdapter(sourceUrl);
          if (adapterMatch) {
            const { adapter, result } = adapterMatch;
            tiers.push(`adapter:${adapter.label}`);
            const adapterMethod = `site_adapter:${adapter.label}`;
            const publisherFromHost = publisherFromUrl(sourceUrl);
            const resolvedOwner = userOwnerOverride
              || result.publisher_name
              || publisherFromHost;
            send("publisher", {
              owner_name:     resolvedOwner,
              publisher_name: result.publisher_name,
            });
            const adapterRows: CandidateRow[] = result.candidates.map(c => {
              const row = buildCandidateRow(c, resolvedOwner, sourceUrl, adapterMethod, publisherFromHost);
              row.id = crypto.randomUUID();
              return row;
            });
            for (const row of adapterRows) send("property", { candidate: row });
            send("progress", { stage: "discovering", count: adapterRows.length });

            // Same dedupe + save + cache-write path as the cascade success.
            send("progress", { stage: "dedupe", count: adapterRows.length });
            let adapterDupCount = 0;
            try {
              const projectIndex = await loadProjectIndex();
              for (const row of adapterRows) {
                const match = findDuplicate(row, projectIndex);
                if (match) {
                  row.duplicate_of_project_id = match.id;
                  row.duplicate_match_address = match.address;
                  adapterDupCount++;
                  send("dedupe", {
                    id:                      row.id!,
                    duplicate_of_project_id: match.id,
                    duplicate_match_address: match.address,
                  });
                }
              }
            } catch (e) {
              console.warn("Dedupe pass failed:", (e as Error).message);
            }
            send("progress", { stage: "saving", count: adapterRows.length });
            if (adapterRows.length > 0) {
              await sbFetch("portfolio_candidates", {
                method: "POST",
                body: JSON.stringify(adapterRows),
              });
              await writeScrapeCache(
                sourceUrl,
                adapterMethod,
                result.publisher_name,
                resolvedOwner,
                adapterRows,
              );
            }
            diag.haiku_candidate_count = adapterRows.length;
            finishWith("complete", {
              method:              adapterMethod,
              owner_name:          resolvedOwner,
              duplicates_detected: adapterDupCount,
              count:               adapterRows.length,
              from_cache:          false,
              suggestions:         [],
            });
            return;
          }

          // ── Tier 1: static HTTP fetch ──────────────────────────────────────
          tiers.push("static_fetch");
          send("progress", { stage: "fetching" });
          let fetched = await fetchHtml(sourceUrl);
          let usedHeadless = false;
          let initialSkip = detectSkipReason(fetched);
          diag.static_html_bytes    = fetched.body.length;
          diag.static_visible_text  = visibleTextSize(stripHtml(fetched.body));
          diag.static_final_url     = fetched.finalUrl;

          // ── Tier 2: Cloudflare bypass via ScrapingAnt residential proxy ──
          // Only fires when Tier 1 was challenged AND headless is configured.
          // If the bypass also fails, fall through to the original skip
          // (same user-facing behavior as before this feature existed).
          if (initialSkip === "skip:cloudflare" && SCRAPINGANT_KEY) {
            tiers.push("cloudflare_bypass");
            send("progress", { stage: "rendering" });
            try {
              fetched      = await fetchRendered(sourceUrl, { residential: true });
              usedHeadless = true;
              initialSkip  = detectSkipReason(fetched);
              diag.rendered_html_bytes    = fetched.body.length;
              diag.rendered_visible_text  = visibleTextSize(stripHtml(fetched.body));
              diag.rendered_final_url     = fetched.finalUrl;
              diag.used_residential_proxy = true;
            } catch (e) {
              console.warn("Cloudflare bypass failed:", (e as Error).message);
              // Keep the original cloudflare skip.
            }
          }

          if (initialSkip) {
            // Scan the (possibly-shell) body for directory hints anyway —
            // for skip:fund_structure and skip:http_* the page often still
            // contains nav links to the actual property directory.
            finishWith("skip", {
              reason: initialSkip,
              method: initialSkip,
              suggestions: scanSuggestions(fetched.body, fetched.finalUrl),
            });
            return;
          }

          send("progress", { stage: "discovering", count: 0 });

          const publisherFromHost = publisherFromUrl(sourceUrl);
          // Owner can be overridden upfront. Haiku's publisher_name (when
          // streaming) refines this once detected; we re-emit the owner_name
          // via a publisher event so the client can show the canonical
          // brand casing as soon as it's known.
          let resolvedOwner = userOwnerOverride || publisherFromHost;
          // Tracked separately for the scrape_cache write — null until
          // Haiku (or JSON-LD) reports an explicit publisher.
          let detectedPublisher: string | null = null;

          const candidateRows: CandidateRow[] = [];
          let method = usedHeadless ? "haiku_html_cloudflare_bypass" : "haiku_html";
          // When the Tier 6b directory-link harvest fires, residual nav
          // hints (the non-individual /properties roll-up URLs) carry
          // forward as the suggestions on the success-path complete
          // event. Default empty; populated by either Tier 6b path.
          let suggestionsFallback: DirectorySuggestion[] = [];

          // Helper to build, ID, push, and emit a single property.
          const emitProperty = (haikuCand: HaikuCandidate, m: string) => {
            const row = buildCandidateRow(haikuCand, resolvedOwner, sourceUrl, m, publisherFromHost);
            row.id = crypto.randomUUID();
            candidateRows.push(row);
            send("property", { candidate: row });
          };

          // Shared Haiku-on-stripped-HTML extraction loop. Used by the
          // static path AND the headless-render path so the streaming
          // protocol (publisher event + property events + residual flush)
          // is identical regardless of how we got the HTML.
          const runHaikuExtraction = async (strippedHtml: string, finalUrl: string, m: string) => {
            const truncated = strippedHtml.length > HAIKU_INPUT_CHAR_LIMIT
              ? strippedHtml.slice(0, HAIKU_INPUT_CHAR_LIMIT) : strippedHtml;
            const prompt = haikuExtractorPrompt(truncated, finalUrl);
            const extractor = new IncrementalExtractor();
            let publisherSent = false;
            for await (const chunk of streamAnthropicText({
              model: HAIKU_MODEL,
              max_tokens: 8192,
              messages: [{ role: "user", content: prompt }],
            })) {
              const completed = extractor.feed(chunk);
              if (!publisherSent && extractor.publisherKnown) {
                publisherSent = true;
                const pubName = extractor.publisher || "";
                if (pubName) detectedPublisher = pubName;
                if (!userOwnerOverride && pubName) resolvedOwner = pubName;
                send("publisher", { owner_name: resolvedOwner, publisher_name: pubName });
              }
              for (const obj of completed) emitProperty(obj as HaikuCandidate, m);
              if (completed.length > 0) {
                send("progress", { stage: "discovering", count: candidateRows.length });
              }
            }
            // Final flush — recover from state-machine edge cases.
            if (candidateRows.length === 0) {
              const residual = extractor.flushResidual();
              for (const obj of residual) emitProperty(obj as HaikuCandidate, m);
              if (residual.length > 0) {
                send("progress", { stage: "discovering", count: candidateRows.length });
              }
            }
            if (!publisherSent) {
              send("publisher", { owner_name: resolvedOwner, publisher_name: null });
            }
          };

          // Path selection across Tiers 3, 4, 5, 6, 7 (in that priority).
          // The first tier that produces candidates short-circuits the rest.
          const jsonLdItems = findJsonLdListings(fetched.body);
          const stripped    = stripHtml(fetched.body);
          diag.json_ld_items = jsonLdItems.length;

          // ── Pattern D: map-driven inventory ──────────────────────────────
          // When the static body loads a map library AND is a content-shell,
          // the property data lives in JavaScript state — not in any DOM
          // element Haiku could read. Headless render would paint pins on a
          // canvas but still wouldn't surface structured data. Skip directly
          // to a structured map-driven outcome so the UI can guide the user
          // to a per-site adapter or Ring 2 parcel data.
          const mapSignals = detectMapDrivenInventory(fetched.body);
          diag.map_signals = mapSignals.signals;
          if (mapSignals.matched && visibleTextSize(stripped) < SHELL_VISIBLE_TEXT_THRESHOLD) {
            tiers.push("map_driven_detected");
            finishWith("skip", {
              reason:      "skip:map_driven_inventory",
              method:      "skip:map_driven_inventory",
              map_signals: mapSignals.signals,
              suggestions: scanSuggestions(fetched.body, fetched.finalUrl),
            });
            return;
          }

          // ── Tier 3: JSON-LD bonus path ───────────────────────────────────
          // Try first; if it produces zero candidates fall through to the
          // rest of the cascade. The JSON-LD allowlist (Place/LocalBusiness
          // /Residence) matches SEO scaffolding on plenty of sites that
          // don't actually carry building data — those should not short-
          // circuit Tier 4 just because the type-tag was present.
          let jsonLdProduced = false;
          if (jsonLdItems.length > 0) {
            tiers.push("json_ld");
            const jsonLdCands = jsonLdToCandidates(jsonLdItems, fetched.finalUrl);
            diag.json_ld_candidates = jsonLdCands.length;
            if (jsonLdCands.length > 0) {
              method = usedHeadless ? "jsonld_headless" : "jsonld";
              for (const c of jsonLdCands) emitProperty(c, method);
              send("progress", { stage: "discovering", count: candidateRows.length });
              jsonLdProduced = true;
            }
          }

          if (!jsonLdProduced) {
            if (visibleTextSize(stripped) >= SHELL_VISIBLE_TEXT_THRESHOLD) {
              // ── Tier 4: Haiku on stripped static HTML (modal success path) ──
              tiers.push("haiku_static");
              await runHaikuExtraction(stripped, fetched.finalUrl, method);
            } else if (usedHeadless) {
              // Tier 2 already paid for headless on the Cloudflare path and
              // the result is STILL a shell. Try the Tier 6b harvest before
              // giving up — the nav often carries /property/<slug> links
              // even when the React grid hasn't hydrated.
              const cloudflareSuggestions = scanSuggestions(fetched.body, fetched.finalUrl);
              const { individuals, directories } = splitSuggestionsByShape(cloudflareSuggestions);
              if (individuals.length >= 2) {
                tiers.push("directory_link_harvest");
                method = "headless_directory_links";
                for (const s of individuals) emitProperty(candidateFromIndividualPropertyUrl(s), method);
                send("progress", { stage: "discovering", count: candidateRows.length });
                // Fall through to dedupe + complete with `directories`
                // preserved as suggestions (rendered nav/footer hints).
                suggestionsFallback = directories;
              } else {
                finishWith("skip", {
                  reason: "skip:no_content_after_render",
                  method: "skip:no_content_after_render",
                  suggestions: cloudflareSuggestions,
                });
                return;
              }
            } else {
              // SPA-shell path: cascade through Tiers 5 → 6 → 7.
              // ── Tier 5: sitemap.xml fallback (free) ───────────────────────
              tiers.push("sitemap");
              const sitemapUrls = await fetchSitemapPropertyUrls(fetched.finalUrl);
              diag.sitemap_urls_found = sitemapUrls.length;
              if (sitemapUrls.length > 0) {
                method = "sitemap";
                for (const u of sitemapUrls.slice(0, 200)) {
                  let slug = "";
                  try { slug = new URL(u).pathname.split("/").filter(Boolean).pop() || ""; } catch { /* ignore */ }
                  const name = slug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()) || null;
                  emitProperty({
                    name,
                    address: null, city: null, state: null,
                    asset_class: null, sqft: null, year_built: null,
                    image_url: null, detail_url: u,
                    raw_snippet: `sitemap.xml: ${u}`,
                  }, method);
                }
                send("progress", { stage: "discovering", count: candidateRows.length });
              } else if (SCRAPINGANT_KEY) {
                // ── Tier 6: headless render via ScrapingAnt + Haiku ─────────
                // The SPA fallback that closes the Pattern B gap (Cousins,
                // JBG Smith, Greystar). Costs a ScrapingAnt credit per call.
                tiers.push("headless_render");
                send("progress", { stage: "rendering" });
                try {
                  const rendered          = await fetchRendered(sourceUrl, {
                    residential: false,
                    waitMs:      HEADLESS_RENDER_WAIT_MS,
                  });
                  const renderedStripped  = stripHtml(rendered.body);
                  diag.rendered_html_bytes   = rendered.body.length;
                  diag.rendered_visible_text = visibleTextSize(renderedStripped);
                  diag.rendered_final_url    = rendered.finalUrl;
                  diag.render_wait_ms        = HEADLESS_RENDER_WAIT_MS;
                  if (visibleTextSize(renderedStripped) < SHELL_VISIBLE_TEXT_THRESHOLD) {
                    // Scan both the rendered body AND the original static
                    // body — the static one often retains SSR'd nav links
                    // even when the SPA hasn't hydrated the directory grid.
                    // scanSuggestions writes stats for the LAST call, so do
                    // the rendered scan last to capture its stats in diag.
                    const staticSuggestions   = findPortfolioDirectorySuggestions(fetched.body, fetched.finalUrl).suggestions;
                    const renderedSuggestions = scanSuggestions(rendered.body, rendered.finalUrl);
                    const mergedUrls          = new Set<string>();
                    const merged: DirectorySuggestion[] = [];
                    for (const s of [...renderedSuggestions, ...staticSuggestions]) {
                      if (!mergedUrls.has(s.url)) { mergedUrls.add(s.url); merged.push(s); }
                    }

                    // ── Tier 6b: directory-link harvest ──────────────────────
                    // The SPA grid never hydrated, but the shell's nav still
                    // carries real /property/<slug> URLs. Promote those to
                    // name-only candidates (same shape as the sitemap path)
                    // so the operator lands in the verification grid instead
                    // of a skip banner. Each card carries detail_url, so
                    // Enrich (Pipeline 2) can fetch the per-building page
                    // and fill in the rich data the grid would have had.
                    const { individuals, directories } = splitSuggestionsByShape(merged);
                    if (individuals.length >= 2) {
                      tiers.push("directory_link_harvest");
                      method  = "headless_directory_links";
                      fetched = rendered;  // dedupe + write-back use the rendered context
                      for (const s of individuals) {
                        emitProperty(candidateFromIndividualPropertyUrl(s), method);
                      }
                      send("progress", { stage: "discovering", count: candidateRows.length });
                      // Carry the non-individual hints into the success-path
                      // suggestions field. The UI only renders them when
                      // candidates ≤ 2, so on a 5-card harvest they're
                      // present-but-hidden — available for future logic.
                      suggestionsFallback = directories;
                    } else {
                      finishWith("skip", {
                        reason: "skip:no_content_after_render",
                        method: "skip:no_content_after_render",
                        suggestions: merged,
                      });
                      return;
                    }
                  } else {
                    fetched = rendered;  // update so dedupe + suggestion scan use the rendered body
                    method  = "haiku_html_headless";
                    await runHaikuExtraction(renderedStripped, rendered.finalUrl, method);
                  }
                } catch (e) {
                  console.warn("Headless render failed:", (e as Error).message);
                  finishWith("skip", {
                    reason: "skip:render_failed",
                    method: "skip:render_failed",
                    suggestions: scanSuggestions(fetched.body, fetched.finalUrl),
                  });
                  return;
                }
              } else {
                // ── Tier 7: skip with reason ──────────────────────────────
                // No SCRAPINGANT_KEY configured AND no sitemap. Surface a
                // structured skip that the UI maps to actionable guidance.
                tiers.push("skip_no_render");
                finishWith("skip", {
                  reason: "skip:shell_no_sitemap",
                  method: "skip:shell_no_sitemap",
                  suggestions: scanSuggestions(fetched.body, fetched.finalUrl),
                });
                return;
              }
            }
          }

          // Dedupe pass — runs AFTER all properties have been streamed so we
          // can match against the freshest projects index once.
          diag.haiku_candidate_count = candidateRows.length;
          if (candidateRows.length === 0) {
            // Don't cache zero-candidate outcomes — usually a fixable
            // wrong-URL situation; the next try should rescrape.
            finishWith("complete", {
              method, owner_name: resolvedOwner, duplicates_detected: 0,
              count: 0, from_cache: false,
              note: "Extraction returned zero candidates from this URL",
              suggestions: scanSuggestions(fetched.body, fetched.finalUrl),
            });
            return;
          }

          send("progress", { stage: "dedupe", count: candidateRows.length });
          let duplicateCount = 0;
          try {
            const projectIndex = await loadProjectIndex();
            for (const row of candidateRows) {
              const match = findDuplicate(row, projectIndex);
              if (match) {
                row.duplicate_of_project_id = match.id;
                row.duplicate_match_address = match.address;
                duplicateCount++;
                send("dedupe", {
                  id:                       row.id!,
                  duplicate_of_project_id:  match.id,
                  duplicate_match_address:  match.address,
                });
              }
            }
          } catch (e) {
            console.warn("Dedupe pass failed:", (e as Error).message);
          }

          send("progress", { stage: "saving", count: candidateRows.length });
          await sbFetch("portfolio_candidates", {
            method: "POST",
            body: JSON.stringify(candidateRows),
          });

          // Write to the scrape cache so the next request for this URL
          // can skip the extraction tier and just re-run dedupe. Skip
          // outcomes never reach here — they short-circuit above.
          await writeScrapeCache(
            sourceUrl,
            method,
            detectedPublisher,
            resolvedOwner,
            candidateRows,
          );

          finishWith("complete", {
            method,
            owner_name: resolvedOwner,
            duplicates_detected: duplicateCount,
            count: candidateRows.length,
            from_cache: false,
            // Surface directory hints when the operator likely landed on
            // the wrong URL (Highwoods homepage → 1 building, when the
            // real directory is /find-your-space/search). The Tier 6b
            // harvest path pre-populates suggestionsFallback with the
            // residual non-individual nav hints; if it's empty we fall
            // through to a fresh scan of the (possibly-rendered) body.
            suggestions: suggestionsFallback.length > 0
              ? suggestionsFallback
              : (candidateRows.length <= 2
                  ? scanSuggestions(fetched.body, fetched.finalUrl)
                  : []),
          });
        } catch (e) {
          try {
            send("error", { message: (e as Error).message, diagnostic: diag });
            console.log(`[portfolio-scout-scrape] ${JSON.stringify({
              url: sourceUrl, event: "error", message: (e as Error).message, tiers,
            })}`);
          } catch { /* stream closed */ }
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        ...cors,
        "Content-Type":  "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection":    "keep-alive",
      },
    });
  }

  // ── action: approve — promote a staging row into `projects` ────────────────
  if (action === "approve") {
    const candidateId = String(body.candidate_id || "").trim();
    if (!candidateId) {
      return new Response(JSON.stringify({ error: "candidate_id required" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const cands = await sbFetch(`portfolio_candidates?id=eq.${candidateId}&select=*`);
    const candidate = Array.isArray(cands) ? cands[0] : null;
    if (!candidate) {
      return new Response(JSON.stringify({ error: "Candidate not found" }), {
        status: 404, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    if (!candidate.extracted_address) {
      return new Response(JSON.stringify({ error: "Cannot import candidate without an address" }), {
        status: 422, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // Defensive: dedupe-flag check. The UI disables Approve for matched
    // candidates, but if a stale grid or direct API caller slips through,
    // refuse here too. The reviewer can explicitly Reject (or, in a
    // future commit, Merge) a duplicate.
    if (candidate.duplicate_of_project_id) {
      return new Response(JSON.stringify({
        error: "Candidate matches an existing project — re-scrape or Reject.",
        duplicate_of_project_id: candidate.duplicate_of_project_id,
        duplicate_match_address: candidate.duplicate_match_address,
      }), { status: 409, headers: { ...cors, "Content-Type": "application/json" } });
    }

    const projectRows = await sbFetch("projects", {
      method: "POST",
      body: JSON.stringify([{
        address:                     candidate.extracted_address,
        property_name:               candidate.extracted_name,
        owner_developer:             candidate.owner_name,
        property_type:               candidate.extracted_asset_class,
        total_available_sf:          candidate.extracted_sqft,
        year_built:                  candidate.extracted_year_built,
        property_management_company: candidate.property_management_company,
        status:                      "Existing",
        provenance:                  buildScoutProvenance(candidate.source_url, {
          address:                     candidate.extracted_address,
          property_name:               candidate.extracted_name,
          owner_developer:             candidate.owner_name,
          property_type:               candidate.extracted_asset_class,
          total_available_sf:          candidate.extracted_sqft,
          year_built:                  candidate.extracted_year_built,
          property_management_company: candidate.property_management_company,
        }),
      }]),
    });
    const project = Array.isArray(projectRows) ? projectRows[0] : projectRows;

    const updated = await sbFetch(`portfolio_candidates?id=eq.${candidateId}`, {
      method: "PATCH",
      body: JSON.stringify({
        status:               "approved",
        reviewed_at:          new Date().toISOString(),
        reviewed_by:          reviewerSub || null,
        imported_building_id: project?.id || null,
      }),
    });

    return new Response(JSON.stringify({
      candidate: Array.isArray(updated) ? updated[0] : updated,
      project,
    }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  }

  // ── action: enrich — per-row Pipeline 2 (detail page + PM web search) ──────
  if (action === "enrich") {
    const candidateId = String(body.candidate_id || "").trim();
    if (!candidateId) {
      return new Response(JSON.stringify({ error: "candidate_id required" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const cands = await sbFetch(`portfolio_candidates?id=eq.${candidateId}&select=*`);
    const candidate = Array.isArray(cands) ? cands[0] : null;
    if (!candidate) {
      return new Response(JSON.stringify({ error: "Candidate not found" }), {
        status: 404, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const patch: Record<string, unknown> = {
      enriched_at: new Date().toISOString(),
    };
    const enrichmentNotes: string[] = [];

    // Part 1: detail-page fetch (only if we have a URL and at least one
    // detail-fillable field is missing — skip the call otherwise).
    const needsDetail =
      candidate.extracted_detail_url &&
      (!candidate.extracted_sqft || !candidate.extracted_asset_class || !candidate.extracted_year_built || !candidate.extracted_image_url);

    if (needsDetail) {
      try {
        // Detail-page tier cascade — mirrors the scrape action's waterfall
        // so SPA-built per-property pages (Cousins /property/<slug>, etc.)
        // get the same headless-render treatment that closed the gap on
        // their /market/<city> pages. Without this, Enrich on SPA detail
        // URLs left every field blank because the static fetch returned
        // a React shell.
        //
        //   Tier 1 (static fetch) → Tier 2 (Cloudflare bypass, residential)
        //   → Tier 4 (Haiku on stripped HTML) if content-bearing
        //   → Tier 6 (headless render with HEADLESS_RENDER_WAIT_MS) when
        //     the static body is a shell AND ScrapingAnt is configured
        let fetched      = await fetchHtml(candidate.extracted_detail_url);
        let usedHeadless = false;
        let skip         = detectSkipReason(fetched);

        // Tier 2 — Cloudflare bypass via residential proxy.
        if (skip === "skip:cloudflare" && SCRAPINGANT_KEY) {
          try {
            fetched      = await fetchRendered(candidate.extracted_detail_url, { residential: true });
            usedHeadless = true;
            skip         = detectSkipReason(fetched);
            enrichmentNotes.push("detail page: cloudflare bypass fired");
          } catch (e) {
            enrichmentNotes.push(`detail page: cloudflare bypass failed (${(e as Error).message.slice(0, 60)})`);
          }
        }

        if (skip) {
          enrichmentNotes.push(`detail page ${skip}`);
        } else {
          let stripped = stripHtml(fetched.body);

          // Tier 6 — headless render when static fetch returned a shell.
          // SPA detail pages (Cousins/JBG Smith-style) need hydration time
          // for the property data to land in the DOM. Wait baseline matches
          // the scrape action so behavior is consistent across both flows.
          if (visibleTextSize(stripped) < SHELL_VISIBLE_TEXT_THRESHOLD && !usedHeadless && SCRAPINGANT_KEY) {
            try {
              const rendered = await fetchRendered(candidate.extracted_detail_url, {
                residential: false,
                waitMs:      HEADLESS_RENDER_WAIT_MS,
              });
              fetched      = rendered;
              stripped     = stripHtml(rendered.body);
              usedHeadless = true;
              enrichmentNotes.push(`detail page: headless render fired (${rendered.body.length}B, ${visibleTextSize(stripped)} chars visible)`);
            } catch (e) {
              enrichmentNotes.push(`detail page: headless render failed (${(e as Error).message.slice(0, 60)})`);
            }
          }

          if (visibleTextSize(stripped) >= SHELL_VISIBLE_TEXT_THRESHOLD) {
            const detail = await callHaikuDetailExtractor(stripped, fetched.finalUrl);
            // Address: only fill when the candidate was missing one AND the
            // detail-page value passes the same digit-check we apply at
            // scrape time. If it does, also re-run dedupe with the new
            // address since Tier 1 may now find a match.
            if (!candidate.extracted_address && typeof detail.address === "string" && looksLikeStreetAddress(detail.address)) {
              patch.extracted_address = detail.address;
            }
            if (!candidate.extracted_sqft       && typeof detail.sqft       === "number") patch.extracted_sqft       = detail.sqft;
            if (!candidate.extracted_asset_class && typeof detail.asset_class === "string") patch.extracted_asset_class = detail.asset_class;
            if (!candidate.extracted_year_built && typeof detail.year_built === "number") patch.extracted_year_built = detail.year_built;
            if (!candidate.extracted_image_url  && typeof detail.image_url  === "string") patch.extracted_image_url  = resolveUrl(detail.image_url, fetched.finalUrl);
            // Detail-page PM: upgrade publisher-implied to extracted when the
            // detail page explicitly names a manager. Same defensive checks
            // as buildCandidateRow — ignore values that look like the
            // building name or publisher (Haiku reaching for nothing).
            if (candidate.pm_confidence !== "extracted" && typeof detail.property_manager === "string") {
              const fromDetail = detail.property_manager.trim();
              const publisherLower = publisherFromUrl(candidate.source_url as string).toLowerCase();
              const nameLower = (candidate.extracted_name as string || "").toLowerCase();
              if (fromDetail.length >= 3
                  && fromDetail.toLowerCase() !== nameLower
                  && fromDetail.toLowerCase() !== publisherLower) {
                patch.property_management_company = fromDetail;
                patch.pm_confidence               = "extracted";
                enrichmentNotes.push(`pm from detail page: ${fromDetail}`);
              }
            }
            if (detail.raw_snippet && typeof detail.raw_snippet === "string") {
              patch.raw_snippet = `${candidate.raw_snippet || ""}\n[detail] ${detail.raw_snippet}`.trim();
            }
            // Address-changed? Re-run dedupe so the row picks up any Tier 1
            // match against the freshly-extracted street address.
            if (patch.extracted_address) {
              try {
                const projectIndex = await loadProjectIndex();
                const rehydrated = { ...candidate, ...patch };
                const match = findDuplicate(rehydrated, projectIndex);
                if (match) {
                  patch.duplicate_of_project_id = match.id;
                  patch.duplicate_match_address = match.address;
                }
              } catch (e) {
                enrichmentNotes.push(`dedupe recheck failed: ${(e as Error).message}`);
              }
            }
          } else {
            enrichmentNotes.push(`detail page was a shell${usedHeadless ? " even after headless render" : ""} (${visibleTextSize(stripped)} chars visible)`);
          }
        }
      } catch (e) {
        enrichmentNotes.push(`detail extraction failed: ${(e as Error).message}`);
      }
    }

    // Part 2: PM web search verification.
    try {
      const buildingName = patch.extracted_name as string | undefined
                        ?? candidate.extracted_name
                        ?? "(unnamed)";
      const address = (patch.extracted_address as string | undefined) ?? candidate.extracted_address ?? null;
      const city    = (patch.extracted_city    as string | undefined) ?? candidate.extracted_city    ?? null;
      const pm = await callHaikuPmSearch(buildingName, address, city, candidate.owner_name);

      // Promote only when the search produced an extracted answer. An
      // "implied" or "unknown" result does not overwrite the publisher-
      // default that the scrape action already set.
      if (pm.property_management_company && pm.pm_confidence === "extracted") {
        patch.property_management_company = pm.property_management_company;
        patch.pm_confidence               = "extracted";
        if (pm.raw_snippet) {
          patch.raw_snippet = `${patch.raw_snippet ?? candidate.raw_snippet ?? ""}\n[pm] ${pm.raw_snippet}`.trim();
        }
      } else {
        enrichmentNotes.push(`pm search returned ${pm.pm_confidence}`);
      }
    } catch (e) {
      enrichmentNotes.push(`pm search failed: ${(e as Error).message}`);
    }

    const updated = await sbFetch(`portfolio_candidates?id=eq.${candidateId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    return new Response(JSON.stringify({
      candidate: Array.isArray(updated) ? updated[0] : updated,
      notes:     enrichmentNotes,
    }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  }

  // ── action: update_owner — relabel a batch of candidates ──────────────────
  // The simplified form auto-derives the owner from Haiku / the URL. When
  // that derivation is wrong (e.g., a property-manager page or quirky URL
  // casing), the reviewer overrides via the ✏ Edit affordance on the
  // results header. We PATCH all pending rows in one call rather than the
  // client looping per-row.
  if (action === "update_owner") {
    const newOwnerName = String(body.owner_name || "").trim();
    const candidateIds = Array.isArray(body.candidate_ids) ? body.candidate_ids : [];
    if (!newOwnerName || candidateIds.length === 0) {
      return new Response(JSON.stringify({ error: "owner_name and candidate_ids required" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    // Sanitize: each id must be a UUID. Strip anything else defensively
    // before interpolating into the PostgREST in() filter.
    const ids = candidateIds
      .map(id => String(id).trim())
      .filter(id => /^[0-9a-f-]{36}$/i.test(id));
    if (ids.length === 0) {
      return new Response(JSON.stringify({ error: "No valid UUIDs in candidate_ids" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const updated = await sbFetch(`portfolio_candidates?id=in.(${ids.join(",")})`, {
      method: "PATCH",
      body: JSON.stringify({ owner_name: newOwnerName }),
    });
    return new Response(JSON.stringify({
      updated_count: Array.isArray(updated) ? updated.length : 0,
      owner_name:    newOwnerName,
    }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  }

  // ── action: merge_preview — load the matched project's current fields ──────
  // The Merge action targets an existing projects row (the dedupe match).
  // This action returns its current field values so the client can build
  // the side-by-side diff UI where the reviewer picks what to overwrite.
  if (action === "merge_preview") {
    const candidateId = String(body.candidate_id || "").trim();
    if (!candidateId) {
      return new Response(JSON.stringify({ error: "candidate_id required" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const cands = await sbFetch(`portfolio_candidates?id=eq.${candidateId}&select=*`);
    const candidate = Array.isArray(cands) ? cands[0] : null;
    if (!candidate) {
      return new Response(JSON.stringify({ error: "Candidate not found" }), {
        status: 404, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    if (!candidate.duplicate_of_project_id) {
      return new Response(JSON.stringify({ error: "Candidate is not flagged as a duplicate — nothing to merge into." }), {
        status: 422, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const projects = await sbFetch(
      `projects?id=eq.${candidate.duplicate_of_project_id}` +
      `&select=id,address,property_name,owner_developer,property_type,total_available_sf,year_built,property_management_company`,
    );
    const project = Array.isArray(projects) ? projects[0] : null;
    if (!project) {
      return new Response(JSON.stringify({ error: "Matched project row no longer exists (may have been deleted)." }), {
        status: 404, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ project, candidate }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  // ── action: merge — apply selected fields to the matched project ───────────
  // Takes candidate_id + a `fields` object whose keys are projects-table
  // column names and whose values are the candidate values to write. Only
  // an allowlist of columns is accepted. On success, the candidate's
  // status flips to 'merged' (a new status value alongside 'pending' /
  // 'approved' / 'rejected') and imported_building_id points at the
  // matched project so the audit trail is preserved.
  if (action === "merge") {
    const candidateId = String(body.candidate_id || "").trim();
    const fields = (body.fields && typeof body.fields === "object")
      ? body.fields as Record<string, unknown>
      : null;
    if (!candidateId || !fields) {
      return new Response(JSON.stringify({ error: "candidate_id and fields required" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // Allowlist — defense in depth against a malformed request slipping in
    // a write to columns we never opted into.
    const MERGE_ALLOWED_FIELDS = new Set([
      "address", "property_name", "owner_developer", "property_type",
      "total_available_sf", "year_built", "property_management_company",
    ]);
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (MERGE_ALLOWED_FIELDS.has(k)) patch[k] = v;
    }
    if (Object.keys(patch).length === 0) {
      return new Response(JSON.stringify({ error: "No mergeable fields provided." }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const cands = await sbFetch(`portfolio_candidates?id=eq.${candidateId}&select=*`);
    const candidate = Array.isArray(cands) ? cands[0] : null;
    if (!candidate) {
      return new Response(JSON.stringify({ error: "Candidate not found" }), {
        status: 404, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    if (!candidate.duplicate_of_project_id) {
      return new Response(JSON.stringify({ error: "Candidate is not flagged as a duplicate — use Approve instead." }), {
        status: 422, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // Read the project's current provenance so we can overlay only the
    // fields actually being merged. Non-merged fields keep whatever source
    // they had previously — important when ATTOM data is already there
    // and the merge is only touching a few cells.
    const existingProject = await sbFetch(`projects?id=eq.${candidate.duplicate_of_project_id}&select=provenance`);
    const existingProvenance = (existingProject?.[0]?.provenance && typeof existingProject[0].provenance === "object")
      ? existingProject[0].provenance as Record<string, ProvenanceEntry>
      : {};
    const overlay = buildScoutProvenance(candidate.source_url, patch);
    const mergedProvenance = { ...existingProvenance, ...overlay };

    const updatedProject = await sbFetch(`projects?id=eq.${candidate.duplicate_of_project_id}`, {
      method: "PATCH",
      body: JSON.stringify({ ...patch, provenance: mergedProvenance }),
    });
    const project = Array.isArray(updatedProject) ? updatedProject[0] : updatedProject;

    const updatedCandidate = await sbFetch(`portfolio_candidates?id=eq.${candidateId}`, {
      method: "PATCH",
      body: JSON.stringify({
        status:               "merged",
        reviewed_at:          new Date().toISOString(),
        reviewed_by:          reviewerSub || null,
        imported_building_id: candidate.duplicate_of_project_id,
      }),
    });

    return new Response(JSON.stringify({
      candidate:     Array.isArray(updatedCandidate) ? updatedCandidate[0] : updatedCandidate,
      project,
      merged_fields: Object.keys(patch),
    }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  }

  // ── action: approve_bulk — batch-insert eligible candidates into projects ──
  // Bulk equivalent of the approve action. Takes a list of candidate IDs,
  // re-validates eligibility on the server (in case a candidate became a
  // duplicate between selection and submit), pre-generates project UUIDs
  // so we can correlate each INSERT to its source candidate without
  // relying on response ordering, batch-INSERTs all eligible projects in
  // one round-trip, then parallel-PATCHes the staging rows. Returns a
  // report of what landed + what was skipped per reason.
  if (action === "approve_bulk") {
    const candidateIdsRaw = Array.isArray(body.candidate_ids) ? body.candidate_ids : [];
    const candidateIds = candidateIdsRaw
      .map(id => String(id).trim())
      .filter(id => /^[0-9a-f-]{36}$/i.test(id));
    if (candidateIds.length === 0) {
      return new Response(JSON.stringify({ error: "candidate_ids (UUIDs) required" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const candidates = await sbFetch(`portfolio_candidates?id=in.(${candidateIds.join(",")})&select=*`);
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return new Response(JSON.stringify({ error: "No candidates found for the given ids" }), {
        status: 404, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const skipped = { duplicate: 0, no_address: 0, already_processed: 0 };
    const projectsToInsert: Array<Record<string, unknown>> = [];
    const candidateToProject: Array<{ candidate_id: string; project_id: string }> = [];

    for (const c of candidates as Array<Record<string, unknown>>) {
      if (c.status !== "pending")               { skipped.already_processed++; continue; }
      if (!c.extracted_address)                 { skipped.no_address++;        continue; }
      if (c.duplicate_of_project_id)            { skipped.duplicate++;          continue; }

      // Pre-generate project UUID so we can map candidate→project explicitly
      // rather than trusting response array ordering.
      const projectId = crypto.randomUUID();
      candidateToProject.push({ candidate_id: c.id as string, project_id: projectId });
      projectsToInsert.push({
        id:                          projectId,
        address:                     c.extracted_address,
        property_name:               c.extracted_name,
        owner_developer:             c.owner_name,
        property_type:               c.extracted_asset_class,
        total_available_sf:          c.extracted_sqft,
        year_built:                  c.extracted_year_built,
        property_management_company: c.property_management_company,
        status:                      "Existing",
        provenance:                  buildScoutProvenance(c.source_url as string, {
          address:                     c.extracted_address,
          property_name:               c.extracted_name,
          owner_developer:             c.owner_name,
          property_type:               c.extracted_asset_class,
          total_available_sf:          c.extracted_sqft,
          year_built:                  c.extracted_year_built,
          property_management_company: c.property_management_company,
        }),
      });
    }

    if (projectsToInsert.length === 0) {
      return new Response(JSON.stringify({
        approved_count: 0, skipped,
        message: "No eligible candidates in the selection",
      }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
    }

    const insertedProjects = await sbFetch("projects", {
      method: "POST",
      body: JSON.stringify(projectsToInsert),
    });

    // Parallel-PATCH the staging rows. Each candidate gets its specific
    // imported_building_id (the project UUID we pre-generated above).
    const now = new Date().toISOString();
    await Promise.all(candidateToProject.map(pair =>
      sbFetch(`portfolio_candidates?id=eq.${pair.candidate_id}`, {
        method: "PATCH",
        body: JSON.stringify({
          status:               "approved",
          reviewed_at:          now,
          reviewed_by:          reviewerSub || null,
          imported_building_id: pair.project_id,
        }),
      })
    ));

    return new Response(JSON.stringify({
      approved_count: projectsToInsert.length,
      projects:       Array.isArray(insertedProjects) ? insertedProjects : [],
      skipped,
    }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  }

  // ── action: reject_bulk — mark a batch of candidates as rejected ──────────
  // Single PATCH using the in() filter — no per-row decisions, all selected
  // candidates flip to status='rejected' regardless of their current state
  // (already-rejected rows are no-ops; already-approved would also flip
  // back to rejected, but the UI prevents that by only checking pending rows).
  if (action === "reject_bulk") {
    const candidateIdsRaw = Array.isArray(body.candidate_ids) ? body.candidate_ids : [];
    const candidateIds = candidateIdsRaw
      .map(id => String(id).trim())
      .filter(id => /^[0-9a-f-]{36}$/i.test(id));
    if (candidateIds.length === 0) {
      return new Response(JSON.stringify({ error: "candidate_ids (UUIDs) required" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const updated = await sbFetch(`portfolio_candidates?id=in.(${candidateIds.join(",")})`, {
      method: "PATCH",
      body: JSON.stringify({
        status:      "rejected",
        reviewed_at: new Date().toISOString(),
        reviewed_by: reviewerSub || null,
      }),
    });
    return new Response(JSON.stringify({
      rejected_count: Array.isArray(updated) ? updated.length : 0,
    }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  }

  // ── action: update_field — operator edits a candidate field inline ────────
  // BD users get blocked when the extractor misses an address (or fills it
  // with a neighborhood). This action lets them paste/type the value
  // themselves. Allowlisted fields only — extracted_address / _name /
  // _city — and the looksLikeStreetAddress digit-check is INTENTIONALLY
  // skipped for the address field on this path: the user knows what they
  // typed, and they may have a legitimately non-numeric location (a
  // campus name, a development name) that the operator considers
  // acceptable for inventory. Re-runs dedupe afterward since any of the
  // three fields can affect both Tier 1 and Tier 2 matching.
  if (action === "update_field") {
    const candidateId = String(body.candidate_id || "").trim();
    const field       = String(body.field || "").trim();
    const valueRaw    = body.value;
    if (!candidateId || !field) {
      return new Response(JSON.stringify({ error: "candidate_id and field required" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const ALLOWED_EDIT_FIELDS = new Set(["extracted_address", "extracted_name", "extracted_city"]);
    if (!ALLOWED_EDIT_FIELDS.has(field)) {
      return new Response(JSON.stringify({ error: "Field is not editable" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const value: string | null = typeof valueRaw === "string" && valueRaw.trim()
      ? valueRaw.trim()
      : null;

    const patch: Record<string, unknown> = { [field]: value };

    // Re-run dedupe — all three editable fields feed the matcher.
    try {
      const cands = await sbFetch(`portfolio_candidates?id=eq.${candidateId}&select=*`);
      const existing = Array.isArray(cands) ? cands[0] : null;
      if (existing) {
        const rehydrated = { ...existing, [field]: value };
        const projectIndex = await loadProjectIndex();
        const match = findDuplicate(rehydrated, projectIndex);
        patch.duplicate_of_project_id = match ? match.id : null;
        patch.duplicate_match_address = match ? match.address : null;
      }
    } catch (e) {
      console.warn("Dedupe recheck on update_field failed:", (e as Error).message);
    }

    const updated = await sbFetch(`portfolio_candidates?id=eq.${candidateId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    return new Response(JSON.stringify({
      candidate: Array.isArray(updated) ? updated[0] : updated,
    }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  }

  // ── action: reject ─────────────────────────────────────────────────────────
  if (action === "reject") {
    const candidateId = String(body.candidate_id || "").trim();
    if (!candidateId) {
      return new Response(JSON.stringify({ error: "candidate_id required" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const updated = await sbFetch(`portfolio_candidates?id=eq.${candidateId}`, {
      method: "PATCH",
      body: JSON.stringify({
        status:      "rejected",
        reviewed_at: new Date().toISOString(),
        reviewed_by: reviewerSub || null,
      }),
    });
    return new Response(JSON.stringify({ candidate: Array.isArray(updated) ? updated[0] : updated }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
    status: 400, headers: { ...cors, "Content-Type": "application/json" },
  });
});
