// IB Scout — Property Intelligence Pipeline (Supabase Edge Function)
//
// Step 1 → Google Geocoding API      (validate + geocode address)
// Step 2 → Attom property/detailowner (owner, building specs)
// Step 3 → Attom sale/detail          (last sale)
// Step 4 → Attom saleshistory/detail  (transaction history)
// Step 5 → Claude HAIKU               (parse + normalize only)
// Step 6 → Scoring logic              (pure code, no LLM)
// Step 7 → Claude SONNET              (intelligence report — only Sonnet call)
//
// Deploy: supabase functions deploy ib-scout
// Secrets needed: ATTOM_API_KEY, ANTHROPIC_API_KEY, GOOGLE_PLACES_API_KEY, APP_SECRET

const ATTOM_KEY   = Deno.env.get("ATTOM_API_KEY")!;
const ANTH_KEY    = Deno.env.get("ANTHROPIC_API_KEY")!;
const GOOGLE_KEY  = Deno.env.get("GOOGLE_PLACES_API_KEY")!;
const APP_SECRET  = Deno.env.get("APP_SECRET")!;
const ALLOWED_ORIGIN = "https://fourthutility.github.io";

function corsHeaders(origin: string | null) {
  const allowed = origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-app-secret",
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function httpGet(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url.split("?")[0]}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function callClaude(model: string, system: string, user: string): Promise<string> {
  const isHaiku = model.includes("haiku");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTH_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: isHaiku ? 1024 : 6000,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic ${res.status}: ${err.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.content as Array<{ text: string }>)[0].text;
}

function parseJsonRobust(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw); } catch { /* fall through */ }
  const stripped = raw.replace(/^```json\s*/i, "").replace(/\s*```$/, "").trim();
  try { return JSON.parse(stripped); } catch { /* fall through */ }
  const match = stripped.match(/\{[\s\S]*\}/);
  if (match) return JSON.parse(match[0]);
  throw new Error("Could not parse JSON from Haiku: " + raw.slice(0, 200));
}

// ─── News: web search for recent property/owner updates ──────────────────────
async function fetchPropertyNews(address: string, ownerEntity: string | null): Promise<Record<string,unknown>> {
  const query = [ownerEntity, address].filter(Boolean).join(" ");
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTH_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
        system: "CRE news researcher. Return ONLY valid JSON. No markdown.",
        messages: [{ role: "user", content: `Find recent news (last 12 months) about this property or owner: "${query}". Look for ownership changes, sales, renovations, financing, tenants, permits, development. Return JSON: {"items":[{"headline":"...","date":"...","summary":"one sentence","relevance":"why this matters to a BD rep"}],"searched_for":"..."}. Max 4 items. If nothing found return {"items":[],"searched_for":"${query}"}` }],
      }),
    });
    if (!res.ok) return { items: [], searched_for: query };
    const data = await res.json();
    const text = (data.content as Array<{type:string;text?:string}>)
      .filter((b: {type:string}) => b.type === "text").map((b: {text?:string}) => b.text || "").join("");
    try {
      const match = text.match(/\{[\s\S]*\}/);
      return match ? JSON.parse(match[0]) : { items: [], searched_for: query };
    } catch { return { items: [], searched_for: query }; }
  } catch { return { items: [], searched_for: query }; }
}

// ─── Step 1: Geocode (with fallback to direct parse) ─────────────────────────

function parseAddressLocally(address: string, city: string, state: string, zip: string) {
  // Try to extract city/state/zip from the address string if not provided separately
  // Handles formats like: "110 East Blvd, Nashville, TN 37203" or "110 East Blvd, Nashville, TN"
  if (!city || !state) {
    const segments = address.split(",").map(s => s.trim());
    if (segments.length >= 3) {
      // Case 1: "401 S 1st St, Austin, TX, 78704" — state and zip in separate segments
      const lastTwo = [segments[segments.length - 2], segments[segments.length - 1]];
      const stateOnly = lastTwo[0].match(/^([A-Za-z]{2})$/);
      const zipOnly   = lastTwo[1].match(/^(\d{5}(-\d{4})?)$/);
      if (stateOnly && zipOnly) {
        state = state || stateOnly[1].toUpperCase();
        zip   = zip   || zipOnly[1];
        city  = city  || segments[segments.length - 3];
      } else {
        // Case 2: "110 East Blvd, Nashville, TN 37203" — state+zip in last segment
        const last = segments[segments.length - 1].trim();
        const stateZip = last.match(/^([A-Za-z]{2})\s*(\d{5}(-\d{4})?)?$/);
        if (stateZip) {
          state = state || stateZip[1].toUpperCase();
          zip   = zip   || (stateZip[2] || "");
          city  = city  || segments[segments.length - 2];
        }
      }
    } else if (segments.length === 2) {
      // Could be "110 East Blvd, Nashville TN 37203"
      const last = segments[1].trim();
      const cityStateZip = last.match(/^(.+?)\s+([A-Za-z]{2})\s*(\d{5})?$/);
      if (cityStateZip) {
        city  = city  || cityStateZip[1];
        state = state || cityStateZip[2].toUpperCase();
        zip   = zip   || (cityStateZip[3] || "");
      }
    }
  }

  // Extract street number + route from the first segment
  const streetPart = address.split(",")[0].trim();
  const streetMatch = streetPart.match(/^(\d+[A-Za-z]?)\s+(.+)$/);

  return {
    formatted_address: address,
    lat: 0, lng: 0,
    street_number: streetMatch ? streetMatch[1] : null,
    route: streetMatch ? streetMatch[2] : streetPart,
    city: city || null,
    state: state || null,
    zip: zip || null,
    county: null,
  };
}

async function geocodeAddress(address: string, city: string, state: string, zip: string) {
  // ALWAYS call Google — we need lat/lng for reliable Attom lookup via coordinates.
  // Local parsing is only a fallback if Google fails.
  const query = [address, city, state, zip]
    .map(s => s?.trim())
    .filter(s => s && s !== "null")
    .join(", ");

  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${GOOGLE_KEY}`;
    const data = await httpGet(url);

    if (data.status !== "OK") throw new Error(`Google status: ${data.status}`);

    const result = data.results[0];
    const ac = result.address_components as Array<{ types: string[]; short_name: string }>;
    const get = (type: string) => (ac.find(c => c.types.includes(type)) || { short_name: null }).short_name;

    return {
      formatted_address: result.formatted_address as string,
      lat: result.geometry.location.lat as number,
      lng: result.geometry.location.lng as number,
      street_number: get("street_number"),
      route: get("route"),
      city: get("locality") || get("sublocality") || get("neighborhood") || city,
      state: get("administrative_area_level_1") || state,
      zip: get("postal_code") || zip,
      county: get("administrative_area_level_2"),
    };
  } catch (e) {
    console.warn("Google geocode failed — falling back to local parse:", e);
    // Local fallback: parse city/state/zip from address string or use provided values
    const parsed = parseAddressLocally(address, city, state, zip);
    if (!parsed.state) throw new Error("Could not determine city/state for this address. Try entering the full address including city and state (e.g. '110 East Blvd, Charlotte, NC 28203').");
    return parsed;
  }
}

// ─── Attom helper ─────────────────────────────────────────────────────────────

function attomGet(endpoint: string, geo: ReturnType<typeof geocodeAddress> extends Promise<infer T> ? T : never) {
  const street = [geo.street_number, geo.route].filter(Boolean).join(" ");
  const zip = geo.zip && geo.zip !== "null" ? ` ${geo.zip}` : "";
  const cityStateZip = `${geo.city},${geo.state}${zip}`;

  // Prefer lat/lng when available — bypasses address abbreviation issues
  // IMPORTANT: Attom requires radius when using lat/lng (per API docs)
  let params: URLSearchParams;
  if (geo.lat && geo.lng && geo.lat !== 0 && geo.lng !== 0) {
    params = new URLSearchParams({
      latitude:  String(geo.lat),
      longitude: String(geo.lng),
      radius:    "0.1",   // ~530 feet — tight enough for single building
    });
    console.log(`Attom ${endpoint}: lat=${geo.lat} lng=${geo.lng} radius=0.1`);
  } else {
    params = new URLSearchParams({ address1: street, address2: cityStateZip });
    console.log(`Attom ${endpoint}: address1="${street}" address2="${cityStateZip}"`);
  }

  const url = `https://api.gateway.attomdata.com/propertyapi/v1.0.0/${endpoint}?${params}`;
  return httpGet(url, { APIKey: ATTOM_KEY, Accept: "application/json" });
}

// ─── Step 5: Normalize with Haiku ────────────────────────────────────────────

async function normalizeWithHaiku(
  detailData: Record<string, unknown>,
  saleData: Record<string, unknown> | null,
  historyData: Record<string, unknown> | null
) {
  const prop = (detailData?.property as Record<string, unknown>[])?.[0] ?? {};
  const sale = (saleData?.sale as Record<string, unknown>[])?.[0] ?? {};
  const history = ((historyData?.sale as Record<string, unknown>[]) ?? []).slice(0, 5);

  const rawBundle = JSON.stringify({ property_detail: prop, last_sale: sale, sales_history: history });

  const system = `You are a commercial real estate data parser. You receive raw property assessor and transaction data and return a clean, normalized JSON object. Return ONLY valid JSON. No preamble. No markdown. No explanation.`;

  const user = `Parse this property data and return this exact JSON schema:

${rawBundle}

Schema to return:
{
  "owner_entity": "string — clean formatted name",
  "owner_type": "individual | LLC | REIT | trust | institution | unknown",
  "owner_mailing_address": "string or null",
  "last_sale_date": "YYYY-MM-DD or null",
  "last_sale_price": number or null,
  "price_per_sf": number or null,
  "sale_disclosure": "arms-length | non-disclosure | unknown",
  "building_sf": number or null,
  "stories": number or null,
  "year_built": number or null,
  "lot_size_sf": number or null,
  "property_type": "office | industrial | retail | multifamily | mixed-use | other",
  "assessed_value": number or null,
  "apn": "string or null",
  "sales_history": [
    { "date": "YYYY-MM-DD", "price": number, "buyer": "string", "seller": "string" }
  ],
  "data_flags": ["list any missing or suspicious fields here"]
}`;

  const raw = await callClaude("claude-haiku-4-5-20251001", system, user);
  return parseJsonRobust(raw) as {
    owner_entity: string;
    owner_type: string;
    owner_mailing_address: string | null;
    last_sale_date: string | null;
    last_sale_price: number | null;
    price_per_sf: number | null;
    sale_disclosure: string;
    building_sf: number | null;
    stories: number | null;
    year_built: number | null;
    lot_size_sf: number | null;
    property_type: string;
    assessed_value: number | null;
    apn: string | null;
    sales_history: Array<{ date: string; price: number; buyer: string; seller: string }>;
    data_flags: string[];
  };
}

// ─── Step 6: Multi-dimensional Pursuit Score (v2) ────────────────────────────

interface ScoreDimension { score: number; max: number; label: "High" | "Medium" | "Low"; rationale: string; }
interface PursuitScore {
  total: number; label: string; action: "Pursue" | "Watch" | "Disqualify" | "Needs Verification";
  breakdown: { strategic_fit: ScoreDimension; timing_trigger: ScoreDimension; access_likelihood: ScoreDimension; technology_need: ScoreDimension; data_confidence: ScoreDimension; };
}

function scoreProperty(p: Awaited<ReturnType<typeof normalizeWithHaiku>>, attomRaw?: Record<string, unknown>): number {
  return scorePropertyV2(p, attomRaw).total;
}

function scorePropertyV2(p: Awaited<ReturnType<typeof normalizeWithHaiku>>, attomRaw?: Record<string, unknown>): PursuitScore {
  const now = new Date();
  const sf = p.building_sf ?? 0;
  const ptype = p.property_type || "";
  const otype = p.owner_type || "";

  // ── 1. Strategic Fit (0–25) ───────────────────────────────────────────────
  let sf_score = 0;
  const sf_notes: string[] = [];
  if (["office", "mixed-use"].includes(ptype)) { sf_score += 10; sf_notes.push("office/mixed-use"); }
  else if (["multifamily", "industrial"].includes(ptype)) { sf_score += 5; sf_notes.push("partial fit asset class"); }
  if (sf >= 100000) { sf_score += 8; sf_notes.push("100K+ SF"); }
  else if (sf >= 50000) { sf_score += 5; sf_notes.push("50K+ SF"); }
  else if (sf >= 25000) { sf_score += 2; sf_notes.push("25K+ SF"); }
  if (["LLC", "REIT", "institution"].includes(otype)) { sf_score += 7; sf_notes.push("institutional owner"); }
  sf_score = Math.min(25, sf_score);

  // ── 2. Timing / Trigger Event (0–25) ─────────────────────────────────────
  let t_score = 0;
  const t_notes: string[] = [];
  if (p.last_sale_date) {
    const yrs = now.getFullYear() - new Date(p.last_sale_date).getFullYear();
    if (yrs <= 2) { t_score = 25; t_notes.push(`sold ${yrs}yr ago — fresh budget cycle`); }
    else if (yrs <= 4) { t_score = 18; t_notes.push(`sold ${yrs}yr ago — ownership cycle active`); }
    else if (yrs <= 7) { t_score = 10; t_notes.push(`sold ${yrs}yr ago — mid-cycle`); }
    else { t_score = 3; t_notes.push(`sold ${yrs}yr ago — late cycle`); }
  } else { t_notes.push("no sale date — timing unknown"); }
  t_score = Math.min(25, t_score);

  // ── 3. Access Likelihood (0–20) ───────────────────────────────────────────
  let a_score = 0;
  const a_notes: string[] = [];
  if (p.owner_entity && !p.owner_entity.toLowerCase().includes("unknown")) { a_score += 6; a_notes.push("named owner entity"); }
  if (p.owner_mailing_address) { a_score += 4; a_notes.push("mailing address known"); }
  if (["LLC", "institution", "REIT"].includes(otype)) { a_score += 5; a_notes.push("institutional contact paths exist"); }
  if (sf >= 50000) { a_score += 5; a_notes.push("building scale = findable contacts"); }
  a_score = Math.min(20, a_score);

  // ── 4. Technology Need (0–20) ─────────────────────────────────────────────
  let tech_score = 0;
  const tech_notes: string[] = [];
  if (p.year_built) {
    if (p.year_built < 1990) { tech_score += 14; tech_notes.push(`built ${p.year_built} — aging BMS, full retrofit`); }
    else if (p.year_built < 2005) { tech_score += 10; tech_notes.push(`built ${p.year_built} — systems reaching EOL`); }
    else if (p.year_built < 2015) { tech_score += 6; tech_notes.push(`built ${p.year_built} — refresh opportunity`); }
    else { tech_score += 2; tech_notes.push(`built ${p.year_built} — newer, greenfield possible`); }
  }
  if (sf >= 100000) { tech_score += 4; tech_notes.push("scale justifies managed services"); }
  else if (sf >= 50000) { tech_score += 2; }
  if (["office", "mixed-use"].includes(ptype)) { tech_score += 2; tech_notes.push("office = BMS + connectivity demand"); }
  tech_score = Math.min(20, tech_score);

  // ── 5. Data Confidence (0–10) ─────────────────────────────────────────────
  let d_score = 0;
  const d_notes: string[] = [];
  const raw = attomRaw || {};
  if (raw.detail_found) { d_score += 4; d_notes.push("Attom detail record found"); }
  if (raw.sale_found) { d_score += 3; d_notes.push("sale record found"); }
  if (raw.history_found && (raw.history_count as number) > 0) { d_score += 2; d_notes.push(`${raw.history_count} transaction records`); }
  if (p.owner_entity && p.apn) { d_score += 1; d_notes.push("owner + APN confirmed"); }
  const flags = p.data_flags?.length ?? 0;
  if (flags > 0) { d_score = Math.max(0, d_score - Math.min(3, flags)); d_notes.push(`${flags} data flag(s)`); }
  d_score = Math.min(10, d_score);

  const total = Math.min(100, sf_score + t_score + a_score + tech_score + d_score);
  const label = total >= 72 ? "High Priority" : total >= 48 ? "Watch" : total >= 28 ? "Low" : "Needs Verification";
  const action: PursuitScore["action"] = total >= 72 ? "Pursue" : total >= 48 ? "Watch" : total >= 28 ? "Disqualify" : "Needs Verification";
  const dim = (s: number, m: number, n: string[]): ScoreDimension => ({
    score: s, max: m,
    label: s >= m * 0.7 ? "High" : s >= m * 0.4 ? "Medium" : "Low",
    rationale: n.join("; ") || "insufficient data",
  });

  return {
    total, label, action,
    breakdown: {
      strategic_fit:    dim(sf_score,   25, sf_notes),
      timing_trigger:   dim(t_score,    25, t_notes),
      access_likelihood:dim(a_score,    20, a_notes),
      technology_need:  dim(tech_score, 20, tech_notes),
      data_confidence:  dim(d_score,    10, d_notes),
    },
  };
}

function priorityLabel(score: number): string {
  if (score >= 72) return "High Priority";
  if (score >= 48) return "Watch";
  if (score >= 28) return "Low";
  return "Needs Verification";
}

// ─── Step 7: Property Intelligence Report — Sonnet (v2) ───────────────────────

async function generateBrief(
  formattedAddress: string,
  normalized: Awaited<ReturnType<typeof normalizeWithHaiku>>,
  scoreResult: PursuitScore | number
): Promise<Record<string, unknown>> {
  // Accept both old number score and new PursuitScore object
  const pursuit = typeof scoreResult === "number"
    ? null
    : scoreResult as PursuitScore;
  const totalScore = typeof scoreResult === "number" ? scoreResult : scoreResult.total;

  const attomAvailable = !normalized.data_flags?.includes("Attom property record not found — report based on AI knowledge only");
  const dataNote = attomAvailable
    ? `Verified Attom Data: ${JSON.stringify(normalized, null, 2)}`
    : `Attom Data: Not available. Use your knowledge of this property to provide specific intelligence — ownership, tenants, age, class, transaction history.`;

  const scoreContext = pursuit ? `
IB Pursuit Score: ${pursuit.total}/100 — ${pursuit.label} → ${pursuit.action}
Score Breakdown:
- Strategic Fit: ${pursuit.breakdown.strategic_fit.score}/25 (${pursuit.breakdown.strategic_fit.label}) — ${pursuit.breakdown.strategic_fit.rationale}
- Timing/Trigger: ${pursuit.breakdown.timing_trigger.score}/25 (${pursuit.breakdown.timing_trigger.label}) — ${pursuit.breakdown.timing_trigger.rationale}
- Access Likelihood: ${pursuit.breakdown.access_likelihood.score}/20 (${pursuit.breakdown.access_likelihood.label}) — ${pursuit.breakdown.access_likelihood.rationale}
- Technology Need: ${pursuit.breakdown.technology_need.score}/20 (${pursuit.breakdown.technology_need.label}) — ${pursuit.breakdown.technology_need.rationale}
- Data Confidence: ${pursuit.breakdown.data_confidence.score}/10 (${pursuit.breakdown.data_confidence.label}) — ${pursuit.breakdown.data_confidence.rationale}` : `IB Opportunity Score: ${totalScore}/100`;

  const system = `You are a senior BD analyst for Intelligent Buildings (IB). IB provides technology managed services for CRE through Intellinet — positioning digital infrastructure (BMS, access control, surveillance, networking, OT cybersecurity, connectivity) as "The Fourth Utility" to improve NOI. Never present inference as fact. Label confidence as High/Medium/Low. Be specific to this building — no generic language.`;

  // IMPORTANT: All string values must be on a single line — use \\n for line breaks, never actual newlines inside strings.
  const user = `Generate a Property Intelligence Report. Return a single JSON object. No preamble. No markdown. Start with {. CRITICAL: every string value must be on ONE line — no literal newlines inside any string value.

Property: ${formattedAddress}
${dataNote}
${scoreContext}

Return this exact JSON (every string on one line, no line breaks inside strings):
{"schema_version":2,"verdict":"one sentence verdict specific to this building","asset_snapshot":"2-3 sentence plain-English interpretation of ownership signals and building condition","asset_anomalies":["anomaly 1","anomaly 2"],"fourth_utility_fit":"why this property does or does not fit the Fourth Utility model","intellinet_fit":"which Intellinet services this building needs and why","technology_opportunity":"BMS/smart building/connectivity opportunity based on age and type","cybersecurity_exposure":"OT/IT risk profile for this asset","new_vs_retrofit":"greenfield or retrofit implications","noi_relevance":"how IB services improve NOI for this owner type","ownership_inferred":"LLC/SPE/REIT structure meaning for capital stack and authority","likely_principals":"who probably controls this asset with confidence label","tech_decision_maker":"who holds technology budget — asset manager, PM, or corporate IT","ownership_confidence":"High|Medium|Low","verification_needed":["item 1","item 2"],"trigger_events":[{"event":"event name","urgency":"Immediate|Near-term|Long-term","significance":"why this creates an IB opportunity"}],"contacts_to_find":[{"title":"exact title","company":"which entity","priority":"Primary|Secondary","why":"decision authority held"}],"primary_path":"best first contact point with rationale","secondary_path":"alternative entry approach","warm_intro_angle":"relationship or market connection to leverage","message_theme":"core message angle for this owner type and asset","outreach_bullets":["talking point 1","talking point 2","talking point 3"],"discovery_questions":["question 1","question 2","question 3","question 4","question 5"],"risk_gaps":[{"issue":"gap or risk","severity":"High|Medium|Low","implication":"pursuit impact"}],"next_best_action":"one specific action with who, what, when, channel","report":"3-4 paragraph executive narrative under 300 words. Cover asset snapshot, ownership signals, timing rationale, IB fit, recommended path. Specific to this building, no generic language.","companies":[{"company":"owner entity","role":"GP/Owner|LP/Co-Owner|Property Manager","contacts_to_find":[{"title":"title","why":"reason"}],"angle":"1-2 sentence pitch"}],"it_contact":{"likely_company":"company","titles_to_find":["title1","title2"],"angle":"pitch"},"next_step":"one-liner action for button display"}`;

  const raw = await callClaude("claude-sonnet-4-6", system, user);
  return parseJsonRobust(raw);
}

// ─── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
    });
  }

  const secret = req.headers.get("x-app-secret");
  if (secret !== APP_SECRET) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
    });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
    });
  }

  const address = (body.address as string) || "";
  const city    = (body.city  as string) || "";
  const state   = (body.state as string) || "";
  const zip     = (body.zip   as string) || "";

  if (!address.trim()) {
    return new Response(JSON.stringify({ error: "address is required" }), {
      status: 400,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
    });
  }

  try {
    // Step 1: Geocode (skips Google if city+state already provided)
    const geo = await geocodeAddress(address, city, state, zip);

    // Steps 2–4: Attom in parallel
    const [detailData, saleData, historyData] = await Promise.allSettled([
      attomGet("property/detailowner", geo),
      attomGet("sale/detail", geo),
      attomGet("saleshistory/detail", geo),
    ]);

    const detail = detailData.status === "fulfilled" ? detailData.value : null;
    const sale   = saleData.status === "fulfilled"   ? saleData.value   : null;
    const history = historyData.status === "fulfilled" ? historyData.value : null;

    if (!detail) {
      // Attom couldn't find it — fall back to Sonnet-only report using known metadata
      // This gives the BD rep something useful rather than a hard failure
      console.log(`Attom returned no record for "${address}" — generating Sonnet-only report`);
      const emptyNormalized = {
        owner_entity: null, owner_type: "unknown", owner_mailing_address: null,
        last_sale_date: null, last_sale_price: null, price_per_sf: null,
        sale_disclosure: "unknown", building_sf: null, stories: null,
        year_built: null, lot_size_sf: null, property_type: "office",
        assessed_value: null, apn: null, sales_history: [],
        data_flags: ["Attom property record not found — report based on AI knowledge only"],
      };
      const fallbackAttom = { detail_found: false, sale_found: false, history_found: false, history_count: 0 };
      const fallbackScore = scorePropertyV2(emptyNormalized, fallbackAttom);
      const brief = await generateBrief(geo.formatted_address, emptyNormalized, fallbackScore);
      return new Response(
        JSON.stringify({
          ok: true,
          schema_version: 2,
          formatted_address: geo.formatted_address,
          geo: { lat: geo.lat, lng: geo.lng },
          normalized: emptyNormalized,
          score: fallbackScore.total,
          pursuit_score: fallbackScore,
          priority: "Unscored — no Attom data",
          brief,
          attom_raw: fallbackAttom,
          attom_missing: true,
        }),
        { headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
      );
    }

    // Step 5: Normalize with Haiku
    const normalized = await normalizeWithHaiku(detail, sale, history);

    // Step 6: Multi-dimensional scoring (v2)
    const attomRawData = {
      detail_found: !!detail,
      sale_found: !!sale,
      history_found: !!history,
      history_count: (history?.sale as unknown[])?.length ?? 0,
    };
    const pursuitScore = scorePropertyV2(normalized, attomRawData);
    const score = pursuitScore.total;
    const priority = pursuitScore.label;

    // Step 7: Full Intelligence Report with Sonnet + parallel news search
    const [brief, news] = await Promise.all([
      generateBrief(geo.formatted_address, normalized, pursuitScore),
      fetchPropertyNews(geo.formatted_address, normalized.owner_entity).catch(() => ({ items: [], searched_for: "" })),
    ]);

    return new Response(
      JSON.stringify({
        ok: true,
        schema_version: 2,
        formatted_address: geo.formatted_address,
        geo: { lat: geo.lat, lng: geo.lng },
        normalized,
        score,
        pursuit_score: pursuitScore,
        priority,
        brief,
        news,
        attom_raw: attomRawData,
      }),
      { headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("IB Scout error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
    );
  }
});
