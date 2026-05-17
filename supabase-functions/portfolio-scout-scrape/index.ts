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
      "raw_snippet": string
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
    property_management_company: publisher || null,
    pm_confidence:               publisher ? "implied" : "unknown",
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
  asset_class?: string | null;
  sqft?:        number | null;
  year_built?:  number | null;
  image_url?:   string | null;
  raw_snippet?: string | null;
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
  "asset_class": string | null,
  "sqft": number | null,
  "year_built": number | null,
  "image_url": string | null,
  "raw_snippet": string
}

Rules:
- asset_class: one of Office, Industrial, Multifamily, Retail, Mixed-Use, Medical Office, Life Sciences, Self-Storage, Hospitality, Land — closest match, or null.
- sqft: numeric, no commas/units. null if not present.
- raw_snippet: literal text excerpt from the HTML that supports the extractions (1-2 sentences). The human-auditable evidence.
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
    if (!sourceUrl) {
      return new Response(JSON.stringify({ error: "source_url must be a valid http(s) URL" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

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
        try {
          send("progress", { stage: "fetching" });
          const fetched = await fetchHtml(sourceUrl);
          const skip = detectSkipReason(fetched);
          if (skip) {
            send("skip", { reason: skip, method: skip });
            controller.close();
            return;
          }

          send("progress", { stage: "discovering", count: 0 });

          const publisherFromHost = publisherFromUrl(sourceUrl);
          // Owner can be overridden upfront. Haiku's publisher_name (when
          // streaming) refines this once detected; we re-emit the owner_name
          // via a publisher event so the client can show the canonical
          // brand casing as soon as it's known.
          let resolvedOwner = userOwnerOverride || publisherFromHost;

          // Path selection: JSON-LD (rare bonus), Haiku-on-stripped-HTML
          // (modal), or sitemap fallback for SPA shells.
          const jsonLdItems = findJsonLdListings(fetched.body);
          const stripped    = stripHtml(fetched.body);

          const candidateRows: CandidateRow[] = [];
          let method = "haiku_html";

          // Helper to build, ID, push, and emit a single property.
          const emitProperty = (haikuCand: HaikuCandidate, m: string) => {
            const row = buildCandidateRow(haikuCand, resolvedOwner, sourceUrl, m, publisherFromHost);
            row.id = crypto.randomUUID();
            candidateRows.push(row);
            send("property", { candidate: row });
          };

          if (jsonLdItems.length > 0) {
            method = "jsonld";
            const jsonLdCands = jsonLdToCandidates(jsonLdItems, fetched.finalUrl);
            for (const c of jsonLdCands) emitProperty(c, method);
            send("progress", { stage: "discovering", count: candidateRows.length });
          } else if (visibleTextSize(stripped) >= SHELL_VISIBLE_TEXT_THRESHOLD) {
            method = "haiku_html";
            const truncated = stripped.length > HAIKU_INPUT_CHAR_LIMIT
              ? stripped.slice(0, HAIKU_INPUT_CHAR_LIMIT) : stripped;
            const prompt = haikuExtractorPrompt(truncated, fetched.finalUrl);
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
                if (!userOwnerOverride && pubName) resolvedOwner = pubName;
                send("publisher", { owner_name: resolvedOwner, publisher_name: pubName });
              }
              for (const obj of completed) emitProperty(obj as HaikuCandidate, method);
              if (completed.length > 0) {
                send("progress", { stage: "discovering", count: candidateRows.length });
              }
            }
            // Final flush: if the incremental parse caught nothing, try to
            // recover any objects still sitting in the residual buffer.
            // This is the belt-and-suspenders against state-machine
            // edge cases that would otherwise silently lose the run.
            if (candidateRows.length === 0) {
              const residual = extractor.flushResidual();
              for (const obj of residual) emitProperty(obj as HaikuCandidate, method);
              if (residual.length > 0) {
                send("progress", { stage: "discovering", count: candidateRows.length });
              }
            }
            // Edge case: publisher_name arrives late or never. Make sure the
            // resolved owner reflects whatever we know by the end.
            if (!publisherSent) {
              send("publisher", { owner_name: resolvedOwner, publisher_name: null });
            }
          } else {
            // Sitemap fallback for SPA shells.
            const sitemapUrls = await fetchSitemapPropertyUrls(fetched.finalUrl);
            if (sitemapUrls.length === 0) {
              send("skip", { reason: "skip:shell_no_sitemap", method: "skip:shell_no_sitemap" });
              controller.close();
              return;
            }
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
          }

          // Dedupe pass — runs AFTER all properties have been streamed so we
          // can match against the freshest projects index once.
          if (candidateRows.length === 0) {
            send("complete", {
              method, owner_name: resolvedOwner, duplicates_detected: 0,
              count: 0, note: "Extraction returned zero candidates from this URL",
            });
            controller.close();
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

          send("complete", {
            method,
            owner_name: resolvedOwner,
            duplicates_detected: duplicateCount,
            count: candidateRows.length,
          });
          controller.close();
        } catch (e) {
          try { send("error", { message: (e as Error).message }); } catch { /* stream closed */ }
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
        const fetched = await fetchHtml(candidate.extracted_detail_url);
        const skip = detectSkipReason(fetched);
        if (skip) {
          enrichmentNotes.push(`detail page ${skip}`);
        } else {
          const stripped = stripHtml(fetched.body);
          if (visibleTextSize(stripped) >= SHELL_VISIBLE_TEXT_THRESHOLD) {
            const detail = await callHaikuDetailExtractor(stripped, fetched.finalUrl);
            if (!candidate.extracted_sqft       && typeof detail.sqft       === "number") patch.extracted_sqft       = detail.sqft;
            if (!candidate.extracted_asset_class && typeof detail.asset_class === "string") patch.extracted_asset_class = detail.asset_class;
            if (!candidate.extracted_year_built && typeof detail.year_built === "number") patch.extracted_year_built = detail.year_built;
            if (!candidate.extracted_image_url  && typeof detail.image_url  === "string") patch.extracted_image_url  = resolveUrl(detail.image_url, fetched.finalUrl);
            if (detail.raw_snippet && typeof detail.raw_snippet === "string") {
              patch.raw_snippet = `${candidate.raw_snippet || ""}\n[detail] ${detail.raw_snippet}`.trim();
            }
          } else {
            enrichmentNotes.push("detail page was a shell");
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
