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

const ANTHROPIC_KEY  = Deno.env.get("ANTHROPIC_API_KEY")!;
const AUTH0_DOMAIN   = Deno.env.get("AUTH0_DOMAIN")!;
const AUTH0_AUDIENCE = Deno.env.get("AUTH0_AUDIENCE")!;
const APP_SECRET     = Deno.env.get("APP_SECRET") || "";  // legacy fallback
const SB_URL         = Deno.env.get("SUPABASE_URL")!;
const SB_SRK         = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const AUTH0_ISSUER = `https://${AUTH0_DOMAIN}/`;
const JWKS = createRemoteJWKSet(new URL(`${AUTH0_ISSUER}.well-known/jwks.json`));

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

// Visible-text size below which we treat the page as a shell (SPA awaiting
// hydration). Pre-flight evidence: real content-bearing pages had 1.6 KB+
// of visible text after strip; shells had <100 bytes.
const SHELL_VISIBLE_TEXT_THRESHOLD = 1000;

// Haiku input ceiling — strip output above this gets truncated. Pre-flight
// stripped sizes ranged 2.7-43 KB; 50 KB is a comfortable cap.
const HAIKU_INPUT_CHAR_LIMIT = 50_000;

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

// ─── Haiku extraction ────────────────────────────────────────────────────────

interface HaikuCandidate {
  name?:        string | null;
  address?:     string | null;
  city?:        string | null;
  state?:       string | null;
  asset_class?: string | null;
  sqft?:        number | null;
  year_built?:  number | null;
  image_url?:   string | null;
  detail_url?:  string | null;
  raw_snippet?: string | null;
}

async function callHaikuExtractor(strippedHtml: string, sourceUrl: string): Promise<HaikuCandidate[]> {
  const truncated = strippedHtml.length > HAIKU_INPUT_CHAR_LIMIT
    ? strippedHtml.slice(0, HAIKU_INPUT_CHAR_LIMIT)
    : strippedHtml;

  const prompt = `Extract commercial real estate properties from this HTML.

Source URL: ${sourceUrl}

HTML excerpt (script/style/nav/footer already stripped):

${truncated}

Return a JSON array of properties. Each property is an object with these keys (use null where the source page does not have the data — do not invent):

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
  "raw_snippet": string
}

Rules:
- Only extract actual properties displayed on the page. Skip news posts, blog items, case studies that are not standalone listed properties, and navigation/marketing chrome.
- If the page is a fund overview, news index, or has no actual property listings, return [].
- asset_class should be one of: Office, Industrial, Multifamily, Retail, Mixed-Use, Medical Office, Life Sciences, Self-Storage, Hospitality, Land. Use the closest match; null if not derivable.
- sqft must be a number (no commas, no units). null if not present.
- image_url and detail_url may be relative — return what the HTML actually contains.
- raw_snippet must be a literal text excerpt from the HTML that supports the extraction (1-2 sentences). This is the human-auditable evidence.
- YOUR ENTIRE RESPONSE MUST BE A SINGLE JSON ARRAY. No preamble, no explanation, no markdown fences. Start with [ and end with ].`;

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

  const start = text.indexOf("[");
  const end   = text.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error(`Haiku did not return a JSON array. First 200 chars: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start, end + 1));
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
    extracted_address:           c.address || null,
    extracted_city:              cityState,
    extracted_sqft:              typeof c.sqft === "number" ? c.sqft : null,
    extracted_asset_class:       c.asset_class || null,
    extracted_image_url:         resolveUrl(c.image_url, sourceUrl),
    extracted_detail_url:        resolveUrl(c.detail_url, sourceUrl),
    extracted_year_built:        typeof c.year_built === "number" ? c.year_built : null,
    property_management_company: publisher || null,
    pm_confidence:               publisher ? "implied" : "unknown",
    confidence:                  deriveConfidence(c),
    extraction_method:           method,
    status:                      "pending",
  };
}

// ─── Pipeline 1: orchestration ───────────────────────────────────────────────

interface ScrapeResult {
  candidates: HaikuCandidate[];
  method:     string;
  skip?:      string;
}

async function extractFromIndex(sourceUrl: string): Promise<ScrapeResult> {
  const fetched = await fetchHtml(sourceUrl);

  const skip = detectSkipReason(fetched);
  if (skip) return { candidates: [], method: skip, skip };

  // Try JSON-LD first (rare bonus path)
  const jsonLdItems = findJsonLdListings(fetched.body);
  if (jsonLdItems.length > 0) {
    return { candidates: jsonLdToCandidates(jsonLdItems, fetched.finalUrl), method: "jsonld" };
  }

  // Content-bearing? Use Haiku on the stripped HTML.
  const stripped = stripHtml(fetched.body);
  if (visibleTextSize(stripped) >= SHELL_VISIBLE_TEXT_THRESHOLD) {
    const candidates = await callHaikuExtractor(stripped, fetched.finalUrl);
    return { candidates, method: "haiku_html" };
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
    return { candidates, method: "sitemap" };
  }

  return { candidates: [], method: "skip:shell_no_sitemap", skip: "skip:shell_no_sitemap" };
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
    const ownerName = String(body.owner_name || "").trim();
    const sourceUrl = String(body.source_url || "").trim();
    if (!ownerName || !sourceUrl) {
      return new Response(JSON.stringify({ error: "owner_name and source_url required" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    let result: ScrapeResult;
    try {
      result = await extractFromIndex(sourceUrl);
    } catch (e) {
      return new Response(JSON.stringify({
        error: "Extraction failed",
        detail: (e as Error).message,
      }), { status: 502, headers: { ...cors, "Content-Type": "application/json" } });
    }

    // Skip-with-reason returns no DB writes and surfaces the reason to the UI.
    if (result.skip) {
      return new Response(JSON.stringify({
        candidates: [],
        skip: result.skip,
        method: result.method,
      }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
    }

    const publisher = publisherFromUrl(sourceUrl);
    const rows = result.candidates.map(c => buildCandidateRow(c, ownerName, sourceUrl, result.method, publisher));

    if (rows.length === 0) {
      return new Response(JSON.stringify({
        candidates: [],
        method: result.method,
        note: "Extraction returned zero candidates from this URL",
      }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
    }

    const inserted = await sbFetch("portfolio_candidates", {
      method: "POST",
      body: JSON.stringify(rows),
    });

    return new Response(JSON.stringify({
      candidates: inserted,
      method: result.method,
    }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
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

    const projectRows = await sbFetch("projects", {
      method: "POST",
      body: JSON.stringify([{
        address:                     candidate.extracted_address,
        property_name:               candidate.extracted_name,
        owner_developer:             candidate.owner_name,
        property_type:               candidate.extracted_asset_class,
        total_available_sf:          candidate.extracted_sqft,
        property_management_company: candidate.property_management_company,
        status:                      "Existing",
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
