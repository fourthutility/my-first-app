// IB Scout — Property Intelligence Pipeline (Supabase Edge Function)
//
// Step 1   → Google Geocoding API        (validate + geocode address)
// Step 2-4 → Attom property/sale/history (owner, building specs, transactions)
// Step 5   → Claude HAIKU                (parse + normalize only)
// Step 5.5 → Spatialest (NC) + Accela   (county assessment + permit history, parallel)
// Step 6   → Scoring logic              (pure code, no LLM)
// Step 7   → Claude SONNET              (intelligence report — only Sonnet call)
//
// Deploy: supabase functions deploy ib-scout
// Secrets needed: ATTOM_API_KEY, ANTHROPIC_API_KEY, GOOGLE_PLACES_API_KEY, APP_SECRET,
//                 ACCELA_APP_ID, ACCELA_APP_SECRET

const ATTOM_KEY        = Deno.env.get("ATTOM_API_KEY")!;
const ANTH_KEY         = Deno.env.get("ANTHROPIC_API_KEY")!;
const GOOGLE_KEY       = Deno.env.get("GOOGLE_PLACES_API_KEY")!;
const APP_SECRET       = Deno.env.get("APP_SECRET")!;
const ACCELA_APP_ID    = Deno.env.get("ACCELA_APP_ID") || "";
const ACCELA_APP_SECRET= Deno.env.get("ACCELA_APP_SECRET") || "";
const ALLOWED_ORIGIN   = "https://fourthutility.github.io";

// Built-in Supabase env vars — automatically injected into all edge functions
const SB_URL      = Deno.env.get("SUPABASE_URL")!;
const SB_SRK      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Save scout brief server-side (bypasses RLS — service role key)
async function saveScoutBrief(projectId: string, brief: Record<string, unknown>): Promise<void> {
  try {
    const res = await fetch(`${SB_URL}/rest/v1/projects?id=eq.${projectId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "apikey": SB_SRK,
        "Authorization": `Bearer ${SB_SRK}`,
        "Prefer": "return=minimal",
      },
      body: JSON.stringify({ scout_brief: brief, scout_brief_at: new Date().toISOString() }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`saveScoutBrief failed for ${projectId}: ${res.status} ${err.slice(0, 200)}`);
    } else {
      console.log(`Scout brief saved for project ${projectId}`);
    }
  } catch (e) {
    console.error(`saveScoutBrief exception for ${projectId}:`, e);
  }
}

function corsHeaders(origin: string | null) {
  const allowed = origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

async function callClaude(model: string, system: string, user: string, timeoutMs = 90000, maxTokens?: number): Promise<string> {
  const isHaiku = model.includes("haiku");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTH_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens ?? (isHaiku ? 1024 : 6000),
        system,
        messages: [{ role: "user", content: user }],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Anthropic ${res.status}: ${err.slice(0, 300)}`);
    }
    const data = await res.json();
    return (data.content as Array<{ text: string }>)[0].text;
  } finally {
    clearTimeout(timer);
  }
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
  console.log(`News search starting for: ${query}`);
  try {
    const newsCtrl = new AbortController();
    const newsTimer = setTimeout(() => { console.log("News search timed out after 25s"); newsCtrl.abort(); }, 25000);
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
        max_tokens: 512,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
        system: "You are a CRE news researcher. You MUST respond with ONLY a valid JSON object — no prose, no markdown, no explanation. Output format: {\"items\":[],\"searched_for\":\"\"}",
        messages: [{ role: "user", content: `Search for recent news about: "${query}". Return ONLY this JSON (no other text): {"items":[{"headline":"...","date":"YYYY-MM","summary":"one sentence","relevance":"BD impact"}],"searched_for":"${query}"}. Max 3 items. If nothing found: {"items":[],"searched_for":"${query}"}` }],
      }),
      signal: newsCtrl.signal,
    });
    clearTimeout(newsTimer);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.log(`News search HTTP error: ${res.status} — ${errText.slice(0, 300)}`);
      return { items: [], searched_for: query };
    }
    const data = await res.json();
    console.log(`News response stop_reason: ${data.stop_reason}, content blocks: ${data.content?.length}`);
    const allBlocks = (data.content as Array<{type:string;text?:string}>) || [];
    console.log(`News block types: ${allBlocks.map((b:{type:string}) => b.type).join(", ")}`);
    const text = allBlocks
      .filter((b: {type:string}) => b.type === "text")
      .map((b: {text?:string}) => b.text || "").join("");
    console.log(`News text length: ${text.length}, preview: ${text.slice(0, 150)}`);
    try {
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) { console.log("News: no JSON found in text"); return { items: [], searched_for: query }; }
      const parsed = JSON.parse(match[0]);
      console.log(`News: parsed ${(parsed.items as unknown[])?.length ?? 0} items`);
      return parsed;
    } catch (e) { console.log("News JSON parse error:", (e as Error)?.message, "text:", text.slice(0,200)); return { items: [], searched_for: query }; }
  } catch (e) { console.log("News fetch error:", (e as Error)?.message); return { items: [], searched_for: query }; }
}

// ─── Accela: Mecklenburg building permit history ──────────────────────────────
//
// Keywords that indicate IB-relevant building systems work
const IB_PERMIT_KEYWORDS = [
  "automation", "bms", "bas", "building automation", "building management",
  "building control", "hvac", "mechanical", "air handler", "ahu", "vav",
  "chiller", "boiler", "controls", "ddc", "direct digital", "bacnet",
  "modbus", "energy management", "ems", "low voltage", "structured cabling",
  "data cabling", "access control", "security system", "intrusion",
  "cctv", "video surveillance", "fire alarm", "life safety", "electrical",
  "generator", "ups", "power monitoring", "telecommunications",
];

interface AccelaPermit {
  permit_number: string;
  type: string;
  description: string;
  status: string;
  opened_date: string | null;
  closed_date: string | null;
  contractor: string | null;
  keywords_matched: string[];
}

interface AccelaPermitSummary {
  total_permits: number;
  ib_relevant_permits: AccelaPermit[];
  last_mechanical_date: string | null;
  last_controls_date: string | null;
  unique_contractors: string[];
  years_since_controls_work: number | null;
  signal: "overdue" | "recent" | "unknown";
  signal_note: string;
  error?: string;
}

async function fetchAccelaToken(): Promise<string | null> {
  if (!ACCELA_APP_ID || !ACCELA_APP_SECRET) return null;
  try {
    const params = new URLSearchParams({
      grant_type:    "client_credentials",
      client_id:     ACCELA_APP_ID,
      client_secret: ACCELA_APP_SECRET,
      agency_name:   "MECKLENBURG",
      environment:   "PROD",
      scope:         "records",
    });
    const res = await fetch("https://auth.accela.com/oauth2/token", {
      method:  "POST",
      headers: {
        "Content-Type":   "application/x-www-form-urlencoded",
        "x-accela-appid": ACCELA_APP_ID,
      },
      body: params.toString(),
      signal: AbortSignal.timeout(8000), // 8s — fail fast if Accela auth is slow
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      console.warn(`Accela token failed: ${res.status} — ${err.slice(0, 200)}`);
      return null;
    }
    const data = await res.json();
    return (data.access_token as string) || null;
  } catch (e) {
    console.warn("Accela token error:", (e as Error)?.message);
    return null;
  }
}

async function fetchAccelaPermits(
  streetNumber: string | null,
  route: string | null,
  zip: string | null,
  yearBuilt: number | null,
): Promise<AccelaPermitSummary | null> {
  if (!ACCELA_APP_ID || !ACCELA_APP_SECRET) return null;

  const token = await fetchAccelaToken();
  if (!token) return { total_permits: 0, ib_relevant_permits: [], last_mechanical_date: null, last_controls_date: null, unique_contractors: [], years_since_controls_work: null, signal: "unknown", signal_note: "Accela auth failed", error: "token_failed" };

  const headers = {
    "Authorization":      token,
    "x-accela-appid":     ACCELA_APP_ID,
    "x-accela-agency":    "MECKLENBURG",
    "x-accela-environment": "PROD",
    "Content-Type":       "application/json",
    "Accept":             "application/json",
  };

  // Strip directional prefix / street suffix for better Accela matching
  const cleanRoute = (route || "")
    .replace(/^(N|S|E|W|NE|NW|SE|SW)\s+/i, "")
    .replace(/\s+(St\.?|Ave\.?|Blvd\.?|Dr\.?|Rd\.?|Ln\.?|Ct\.?|Way|Pl\.?|Pkwy\.?|Hwy\.?)$/i, "")
    .trim();

  const searchBody = {
    address: {
      streetStart: streetNumber || undefined,
      streetName:  cleanRoute || undefined,
      postalCode:  zip || undefined,
    },
  };

  try {
    const res = await fetch(
      "https://apis.accela.com/v4/search/records?expand=contacts&limit=200",
      { method: "POST", headers, body: JSON.stringify(searchBody), signal: AbortSignal.timeout(15000) } // 15s — fail fast if Accela search hangs
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.warn(`Accela search failed: ${res.status} — ${errText.slice(0, 300)}`);
      return { total_permits: 0, ib_relevant_permits: [], last_mechanical_date: null, last_controls_date: null, unique_contractors: [], years_since_controls_work: null, signal: "unknown", signal_note: `Accela API error ${res.status}`, error: errText.slice(0, 100) };
    }

    const data = await res.json();
    const records = (data.result as Record<string, unknown>[]) || [];
    console.log(`Accela: ${records.length} permits returned`);

    if (!records.length) {
      const now = new Date();
      const signal_note = yearBuilt
        ? `No permits found in Accela. If original controls systems from ${yearBuilt} are still in place, that is ${now.getFullYear() - yearBuilt} years without a documented controls refresh — a strong IB signal.`
        : "No permits found in Accela for this address.";
      return { total_permits: 0, ib_relevant_permits: [], last_mechanical_date: null, last_controls_date: null, unique_contractors: [], years_since_controls_work: yearBuilt ? new Date().getFullYear() - yearBuilt : null, signal: yearBuilt ? "overdue" : "unknown", signal_note };
    }

    // Parse and keyword-match each permit
    const permits: AccelaPermit[] = records.map((r) => {
      const type    = (r.type    as Record<string, string>) || {};
      const status  = (r.status  as Record<string, string>) || {};
      const contacts = (r.contacts as Record<string, unknown>[]) || [];

      const contractorContact = contacts.find(c => {
        const ctype = String(((c.type as Record<string,string>)?.value) || "").toLowerCase();
        return ctype.includes("contractor") || ctype.includes("applicant");
      });
      const contractor = contractorContact
        ? (String(contractorContact.businessName || "").trim() ||
           [contractorContact.firstName, contractorContact.lastName].filter(Boolean).join(" ").trim() ||
           null)
        : null;

      const desc    = String(r.description || "").toLowerCase();
      const typeStr = `${type.group || ""} ${type.type || ""} ${type.subType || ""}`.toLowerCase();
      const combined = `${desc} ${typeStr}`;

      const matchedKeywords = IB_PERMIT_KEYWORDS.filter(kw => combined.includes(kw.toLowerCase()));

      const openedDate = String(r.openedDate || r.createdDate || "").slice(0, 10) || null;
      const closedDate = String(r.closedDate || r.statusDate || "").slice(0, 10) || null;

      return {
        permit_number:    String(r.customId || r.trackingId || r.id || ""),
        type:             [type.group, type.type].filter(Boolean).join(" / ") || "Unknown",
        description:      String(r.description || "").slice(0, 250),
        status:           String(status.value || ""),
        opened_date:      openedDate,
        closed_date:      closedDate,
        contractor,
        keywords_matched: matchedKeywords,
      };
    });

    const ibPermits = permits.filter(p => p.keywords_matched.length > 0);

    // Most-recent date helper across opened/closed
    const bestDate = (p: AccelaPermit) => p.closed_date || p.opened_date;

    const MECH_KW    = ["hvac", "mechanical", "air handler", "ahu", "vav", "chiller", "boiler"];
    const CONTROLS_KW = ["automation", "bms", "bas", "building automation", "building management",
                         "building control", "controls", "ddc", "direct digital", "bacnet",
                         "modbus", "energy management", "ems"];

    const latestMatching = (kws: string[]) =>
      ibPermits
        .filter(p => kws.some(kw => p.keywords_matched.includes(kw)))
        .map(p => bestDate(p))
        .filter(Boolean)
        .sort()
        .reverse()[0] ?? null;

    const lastMechanical = latestMatching(MECH_KW);
    const lastControls   = latestMatching(CONTROLS_KW);
    const referenceDate  = lastControls || lastMechanical;

    const contractors = [...new Set(permits.map(p => p.contractor).filter(Boolean) as string[])];

    const now = new Date();
    let signal: AccelaPermitSummary["signal"] = "unknown";
    let signal_note = "Permit history found but no controls/mechanical permits identified.";
    let yearsSince: number | null = null;

    if (referenceDate) {
      yearsSince = now.getFullYear() - new Date(referenceDate).getFullYear();
      if (yearsSince >= 7) {
        signal = "overdue";
        signal_note = `Last controls/mechanical permit was ${yearsSince} years ago (${referenceDate.slice(0, 7)}). Systems likely at or past end-of-service life — strong refresh signal for IB.`;
      } else if (yearsSince >= 3) {
        signal = "overdue";
        signal_note = `Last controls/mechanical permit was ${yearsSince} years ago (${referenceDate.slice(0, 7)}). Mid-cycle — monitor for upcoming refresh.`;
      } else {
        signal = "recent";
        signal_note = `Recent controls/mechanical work (${referenceDate.slice(0, 7)}, ${yearsSince}yr ago). May be in an active upgrade cycle.`;
      }
    } else if (yearBuilt) {
      yearsSince = now.getFullYear() - yearBuilt;
      signal = "overdue";
      signal_note = `No controls or mechanical permits found in Accela since the building's ${yearBuilt} delivery — ${yearsSince} years with no documented controls refresh. STRONG IB SIGNAL: if original systems are still in place, this building is overdue.`;
    }

    return {
      total_permits:          permits.length,
      ib_relevant_permits:    ibPermits.slice(0, 15),
      last_mechanical_date:   lastMechanical,
      last_controls_date:     lastControls,
      unique_contractors:     contractors.slice(0, 10),
      years_since_controls_work: yearsSince,
      signal,
      signal_note,
    };
  } catch (e) {
    console.warn("Accela fetch error:", (e as Error)?.message);
    return null;
  }
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

  const raw = await callClaude("claude-haiku-4-5-20251001", system, user, 30000);
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
  total: number; label: string; action: "Pursue" | "Watch" | "Verify" | "Disqualify";
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
  } else { t_score = 5; t_notes.push("no sale date on record — timing unconfirmed"); }
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
  const action: PursuitScore["action"] = total >= 72 ? "Pursue" : total >= 48 ? "Watch" : total >= 28 ? "Verify" : "Disqualify";
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

// ─── Energy Cost Estimate (CBECS/ENERGY STAR benchmarks — climate-zone-aware) ──

interface EnergyEstimate {
  annual_cost_low: number;
  annual_cost_high: number;
  savings_low: number;
  savings_high: number;
  kwh_per_sf: number;
  rate_per_kwh: number;
  methodology: string;
}

function estimateEnergyCost(
  buildingSf: number | null,
  propertyType: string | null,
  yearBuilt: number | null,
  state: string | null,
): EnergyEstimate | null {
  if (!buildingSf || buildingSf < 5000) return null;

  // Climate zone lookup by state — drives electricity intensity significantly.
  // "hot"   = ASHRAE CZ1–3 (AC-dominated; SE, TX, FL, AZ)
  // "mixed" = ASHRAE CZ4   (moderate heating + cooling; mid-Atlantic, Mountain West)
  // "cold"  = ASHRAE CZ5–7 (heating-dominated; NE, Midwest, Pacific NW)
  const CLIMATE: Record<string, "hot" | "mixed" | "cold"> = {
    FL: "hot", LA: "hot", MS: "hot", AL: "hot",
    GA: "hot", SC: "hot", NC: "hot", TN: "hot",
    AR: "hot", OK: "hot", TX: "hot", AZ: "hot", NM: "hot", HI: "hot",
    VA: "mixed", MD: "mixed", DE: "mixed", NJ: "mixed",
    KY: "mixed", MO: "mixed", WV: "mixed", DC: "mixed",
    UT: "mixed", CO: "mixed", NV: "mixed", CA: "mixed", OR: "mixed",
    PA: "cold", NY: "cold", CT: "cold", RI: "cold", MA: "cold",
    VT: "cold", NH: "cold", ME: "cold", OH: "cold", IN: "cold",
    IL: "cold", MI: "cold", WI: "cold", MN: "cold", IA: "cold",
    NE: "cold", KS: "cold", SD: "cold", ND: "cold", MT: "cold",
    WY: "cold", ID: "cold", WA: "cold", AK: "cold",
  };
  const zone = CLIMATE[(state || "").toUpperCase()] ?? "mixed";

  // Site electricity intensity (kWh/SF/year) — electricity only, excludes gas/steam.
  // Source: EPA ENERGY STAR Portfolio Manager medians + CBECS 2018, split by climate zone.
  // Hot climates: higher electricity due to cooling load. Cold climates: heating shifts to gas.
  const KWH_SF: Record<string, Record<string, number>> = {
    hot:   { office: 24, retail: 33, healthcare: 48, industrial: 11, multifamily: 15, "mixed-use": 24, other: 22 },
    mixed: { office: 21, retail: 30, healthcare: 44, industrial: 10, multifamily: 13, "mixed-use": 21, other: 19 },
    cold:  { office: 19, retail: 27, healthcare: 41, industrial:  9, multifamily: 11, "mixed-use": 19, other: 17 },
  };
  const pt = (propertyType || "other").toLowerCase();
  const baseKwh = KWH_SF[zone][pt] ?? KWH_SF[zone].other;

  // Age-based efficiency adjustment (older buildings: less efficient HVAC, lighting, controls)
  let ageMult = 1.0;
  if (yearBuilt) {
    if      (yearBuilt < 1980) ageMult = 1.30;
    else if (yearBuilt < 2000) ageMult = 1.15;
    else if (yearBuilt < 2015) ageMult = 1.00;
    else                       ageMult = 0.85;
  }
  const kwhPerSf = baseKwh * ageMult;

  // Commercial electricity rates by state ($/kWh) — blended (energy + demand) per EIA 2024.
  // NC: Duke Energy Carolinas/Progress blended commercial ≈ $0.082 for medium accounts.
  const RATES: Record<string, number> = {
    NC: 0.082, SC: 0.082, GA: 0.089, FL: 0.093, AL: 0.084,
    TN: 0.082, VA: 0.079, TX: 0.070, LA: 0.068, MS: 0.074,
    AR: 0.077, OK: 0.080, AZ: 0.089, NM: 0.087,
    NY: 0.162, MA: 0.158, CT: 0.152, RI: 0.148, VT: 0.141, NH: 0.155, ME: 0.148,
    PA: 0.095, OH: 0.090, MI: 0.093, IN: 0.089, IL: 0.098,
    WI: 0.091, MN: 0.088, IA: 0.081, MO: 0.079, KY: 0.084,
    CA: 0.180, OR: 0.094, WA: 0.079, CO: 0.094, UT: 0.083, NV: 0.091,
    MD: 0.103, NJ: 0.119, DE: 0.098, DC: 0.107,
  };
  const rate = RATES[(state || "").toUpperCase()] ?? 0.100;

  // Annual electricity cost = kWh/SF × rate × SF
  const midCost = kwhPerSf * rate * buildingSf;
  const low  = Math.round(midCost * 0.85 / 1000) * 1000;
  const high = Math.round(midCost * 1.15 / 1000) * 1000;

  // BMS optimization savings: 15–30% is industry-documented for managed BMS vs. unmanaged
  const [sp, ep] = (yearBuilt && yearBuilt < 2000) ? [0.20, 0.30]
                 : (yearBuilt && yearBuilt < 2015) ? [0.15, 0.25]
                 : [0.10, 0.18];

  const rateSource = state?.toUpperCase() === "NC" ? "Duke Energy Carolinas commercial"
                   : state?.toUpperCase() === "SC" ? "Duke Energy Carolinas SC commercial"
                   : `${state || "US avg"} EIA 2024`;
  const yearNote = yearBuilt ? ` · ${yearBuilt} vintage` : "";

  return {
    annual_cost_low: low, annual_cost_high: high,
    savings_low:  Math.round(low  * sp / 1000) * 1000,
    savings_high: Math.round(high * ep / 1000) * 1000,
    kwh_per_sf: Math.round(kwhPerSf * 10) / 10,
    rate_per_kwh: rate,
    methodology: `EPA ENERGY STAR / CBECS 2018 · ${zone}-climate benchmark · ${rateSource} $${rate.toFixed(3)}/kWh${yearNote} · electricity only`,
  };
}

// ─── Spatialest: county assessed value + tax (Mecklenburg NC — expandable) ────

interface SpatialestData {
  spatialest_id: string | null;
  assessed_value: number | null;
  land_value: number | null;
  improvement_value: number | null;
  tax_year: number | null;
  annual_tax: number | null;
  permit_count: number | null;
  property_url: string;
  pictometry_url: string | null;
  county: string;
  // Building details from sections[2] primary building
  year_built: number | null;
  stories: number | null;        // parsed from storyheight field
  building_type: string | null;
  heat: string | null;
  heat_fuel: string | null;
  ext_wall: string | null;
  finished_area: number | null;
  source: "spatialest";
}

async function fetchSpatialest(
  apn: string | null,
  county: string | null,
  state: string | null,
  cachedId?: string | null,
): Promise<SpatialestData | null> {
  if (!apn) return null;

  // Determine which Spatialest endpoint to use based on county + state
  // Currently implemented: Mecklenburg County, NC (Charlotte metro)
  const isMecklenburg = state?.toUpperCase() === "NC" &&
    (county?.toLowerCase().includes("mecklenburg") || county?.toLowerCase().includes("charlotte"));
  if (!isMecklenburg) return null;

  const baseUrl = "https://property.spatialest.com/nc/mecklenburg";
  const cleanApn = apn.replace(/[^0-9-]/g, "");
  const propUrl = `${baseUrl}#/property/`; // completed once ID is known

  // Build APN variants — Attom sometimes returns unit/condo parcels indexed slightly
  // differently. Try digits-only, Mecklenburg dash format, and parent parcel (7 digits).
  const digitsOnly = cleanApn.replace(/-/g, "");
  const withDashes = digitsOnly.length === 8
    ? `${digitsOnly.slice(0,3)}-${digitsOnly.slice(3,6)}-${digitsOnly.slice(6)}`
    : cleanApn;
  const parentApn = digitsOnly.length >= 7 ? digitsOnly.slice(0, 7) : digitsOnly;
  const apnVariants = [...new Set([digitsOnly, withDashes, parentApn])];

  console.log(`Spatialest: searching for APN ${cleanApn} (variants: ${apnVariants.join(", ")})`);

  try {
    // ── Step 1: GET the search page to obtain session cookie + CSRF token ──────
    // Spatialest uses Rails CSRF protection. The token is in <meta name="csrf-token">
    // and must accompany all POST requests. The session cookie ties the token to the session.
    const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    const initCtrl = new AbortController();
    const initTimer = setTimeout(() => initCtrl.abort(), 10000);
    const initRes = await fetch(`${baseUrl}/`, {
      headers: { "Accept": "text/html,application/xhtml+xml,*/*", "User-Agent": UA },
      signal: initCtrl.signal,
    });
    clearTimeout(initTimer);

    // Extract Set-Cookie — forward the raw value so the session cookie is included in POST
    const rawCookie = initRes.headers.get("set-cookie") ?? "";
    // Multiple cookies may be returned comma-separated or as a single header value;
    // extract just the key=value pairs (before first semicolon on each segment).
    const sessionCookie = rawCookie.split(/,(?=[^;]+=[^;]+)/)
      .map(s => s.trim().split(";")[0].trim())
      .filter(Boolean)
      .join("; ");

    const html = await initRes.text();
    const csrfMatch = html.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i)
                  ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']csrf-token["']/i);
    const csrfToken = csrfMatch?.[1] ?? "";
    console.log(`Spatialest: session cookie=${sessionCookie ? "present" : "missing"}, csrf=${csrfToken ? "present" : "missing"}`);

    // ── Step 2: POST /api/v2/search with nested filters body ──────────────────
    // Discovered by intercepting XHR in the live browser:
    //   body: {"filters": {"term": "<APN>", "page": "1"}, "page": "1"}
    //   response: {"id": <spatialest_id>}  — just a single ID, no results array
    // If a cached ID was supplied (from a previous scout), skip the search entirely
    let spatialestId: string | null = cachedId ?? null;
    if (spatialestId) console.log(`Spatialest: using cached ID ${spatialestId}, skipping search`);

    const postHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/plain, */*",
      "Referer": `${baseUrl}/`,
      "Origin": "https://property.spatialest.com",
      "User-Agent": UA,
      "X-Requested-With": "XMLHttpRequest",
    };
    if (csrfToken) postHeaders["X-CSRF-Token"] = csrfToken;
    if (sessionCookie) postHeaders["Cookie"] = sessionCookie;

    if (!spatialestId) {
      for (const variant of apnVariants) {
        const searchCtrl = new AbortController();
        const searchTimer = setTimeout(() => searchCtrl.abort(), 8000);
        try {
          const searchRes = await fetch(`${baseUrl}/api/v2/search`, {
            method: "POST",
            headers: postHeaders,
            body: JSON.stringify({ filters: { term: variant, page: "1" }, page: "1" }),
            signal: searchCtrl.signal,
          });
          clearTimeout(searchTimer);
          const text = await searchRes.text();
          console.log(`Spatialest: POST v2/search apn=${variant} status=${searchRes.status} body=${text.slice(0, 100)}`);
          if (searchRes.ok && text && !text.trim().startsWith("<")) {
            const data = JSON.parse(text) as Record<string, unknown>;
            if (data.id) { spatialestId = String(data.id); break; }
          }
        } catch (e) {
          clearTimeout(searchTimer);
          console.log(`Spatialest: search error for ${variant}: ${(e as Error)?.message}`);
        }
      }
    }

    if (!spatialestId) {
      console.log(`Spatialest: no ID returned for APN ${cleanApn}`);
      return null;
    }
    console.log(`Spatialest: APN ${cleanApn} → ID ${spatialestId}`);

    // ── Step 3: GET /api/v1/recordcard/{id} ───────────────────────────────────
    const cardCtrl = new AbortController();
    const cardTimer = setTimeout(() => cardCtrl.abort(), 8000);
    const cardRes = await fetch(
      `${baseUrl}/api/v1/recordcard/${spatialestId}`,
      { headers: { "Accept": "application/json", "User-Agent": UA, ...(sessionCookie ? { "Cookie": sessionCookie } : {}) }, signal: cardCtrl.signal }
    );
    clearTimeout(cardTimer);

    if (!cardRes.ok) {
      console.warn(`Spatialest record card HTTP ${cardRes.status} for ID ${spatialestId}`);
      // Still return partial data with URL so the BD report can link to it
      return {
        spatialest_id: spatialestId,
        assessed_value: null, land_value: null, improvement_value: null,
        tax_year: null, annual_tax: null, permit_count: null,
        property_url: `${propUrl}${spatialestId}`,
        pictometry_url: null,
        county: "Mecklenburg, NC",
        year_built: null, stories: null, building_type: null,
        heat: null, heat_fuel: null, ext_wall: null, finished_area: null,
        source: "spatialest",
      };
    }
    const card = await cardRes.json() as Record<string, unknown>;
    console.log(`Spatialest record card keys: ${Object.keys(card).join(", ")}`);

    // ── Parse Mecklenburg county record card structure ───────────────────────
    // Structure: card.parcel.header       → summary fields (string dollar amounts)
    //            card.parcel.sections[0]["2"][0] → value breakdown with YearID
    //            card.parcel.sections[2]  → building details array (primary = largest area)
    //            card.parcel.sections[4]  → permits (array of arrays)
    //            card.ctx / card.cty      → longitude / latitude for pictometry
    //
    // Dollar strings like "$75,256,600" need $ and commas stripped before parsing.
    const parseMoney = (v: unknown): number | null => {
      if (v == null) return null;
      const n = Number(String(v).replace(/[$,]/g, "").trim());
      return isNaN(n) || n <= 0 ? null : n;
    };
    const parseNum = (v: unknown): number | null => {
      if (v == null) return null;
      const n = Number(String(v).replace(/,/g, "").trim());
      return isNaN(n) || n <= 0 ? null : n;
    };

    const parcel = card.parcel as Record<string, unknown> | null;
    const header = (parcel?.header ?? {}) as Record<string, unknown>;
    const sections = (parcel?.sections ?? []) as Record<string, unknown>[];

    // Section 0 key "2" → value breakdown row
    const sec0 = sections[0] ?? {};
    const valRows = sec0["2"];
    const valRow = (Array.isArray(valRows) ? valRows[0] : null) as Record<string, unknown> | null ?? {};

    const assessed    = parseMoney(header.PublicTotalMarketValue  ?? valRow.PublicTotalMarketValue);
    const land        = parseMoney(header.PublicTotalLandValue     ?? valRow.PublicTotalLandValue);
    const improvement = parseMoney(header.PublicTotalBuildingValue ?? valRow.PublicTotalBuildingValue);

    // Tax year from section 0 value row (YearID = current assessment year)
    const taxYear = valRow.YearID ? Math.round(Number(valRow.YearID)) : null;

    // Annual tax is not available in Spatialest record card — excluded
    const annualTax: number | null = null;

    // Section 2 → building details; pick primary building (largest finishedarea)
    const sec2 = sections[2];
    const bldgRows: Record<string, unknown>[] = [];
    if (Array.isArray(sec2)) {
      for (const row of sec2) {
        if (Array.isArray(row)) bldgRows.push(...(row as Record<string, unknown>[]));
        else if (row && typeof row === "object") bldgRows.push(row as Record<string, unknown>);
      }
    }
    // Sort by finishedarea descending to get primary/largest building
    bldgRows.sort((a, b) => parseNum(b.finishedarea) ?? 0 - (parseNum(a.finishedarea) ?? 0));
    const primaryBldg = bldgRows[0] ?? {};

    const yearBuilt    = primaryBldg.yearbuilt ? Math.round(Number(primaryBldg.yearbuilt)) : null;
    const buildingType = primaryBldg.buildingtype ? String(primaryBldg.buildingtype) : null;
    const heat         = primaryBldg.heat && String(primaryBldg.heat) !== "NONE" ? String(primaryBldg.heat) : null;
    const heatFuel     = primaryBldg.heatfuel && String(primaryBldg.heatfuel) !== "NONE" ? String(primaryBldg.heatfuel) : null;
    const extWall      = primaryBldg.extwall ? String(primaryBldg.extwall) : null;
    const finishedArea = parseNum(primaryBldg.finishedarea);

    // Parse stories from storyheight field — e.g. ">=4.0 STORY" or "2.5 STORY"
    // Extract the leading number and round up for ">=" prefixes.
    let stories: number | null = null;
    if (primaryBldg.storyheight) {
      const sh = String(primaryBldg.storyheight);
      const isGte = sh.includes(">=");
      const m = sh.match(/(\d+(?:\.\d+)?)/);
      if (m) {
        const raw = parseFloat(m[1]);
        stories = isGte ? Math.ceil(raw) : Math.round(raw);
      }
    }

    // Section 4 → permit count (array of arrays)
    let permitCount: number | null = null;
    const sec4 = sections[4];
    if (Array.isArray(sec4) && Array.isArray(sec4[0])) {
      const count = (sec4[0] as unknown[]).length;
      if (count > 0) permitCount = count;
    }

    // Pictometry viewer URL — built from lat/lng on the record card (ctx=lng, cty=lat)
    const lat = card.cty ? String(card.cty) : null;
    const lng = card.ctx ? String(card.ctx) : null;
    const pictometryUrl = lat && lng
      ? `https://community.spatialest.com/nc/mecklenburg/pictometry.php?y=${lat}&x=${lng}`
      : null;

    console.log(`Spatialest extracted: appraised=${assessed} land=${land} bldg=${improvement} year=${taxYear} permits=${permitCount} yearBuilt=${yearBuilt} extwall=${extWall}`);

    return {
      spatialest_id: spatialestId,
      assessed_value: assessed,
      land_value: land,
      improvement_value: improvement,
      tax_year: taxYear,
      annual_tax: annualTax,
      permit_count: permitCount,
      property_url: `${propUrl}${spatialestId}`,
      pictometry_url: pictometryUrl,
      county: "Mecklenburg, NC",
      year_built: yearBuilt,
      stories: stories,
      building_type: buildingType,
      heat: heat,
      heat_fuel: heatFuel,
      ext_wall: extWall,
      finished_area: finishedArea,
      source: "spatialest",
    };
  } catch (e) {
    console.warn(`Spatialest error for APN ${cleanApn}:`, (e as Error)?.message);
    return null;
  }
}

// ─── NC Secretary of State entity search ─────────────────────────────────────
//
// Searches sosnc.gov for the owner entity name, returns registered agent and
// principal officers/members. Runs only when state=NC. Two HTTP requests:
//   1. POST search → extracts SOS ID from results table
//   2. GET detail page → extracts registered agent + officers

interface NcSosPrincipal {
  name: string;
  title: string;
}

interface NcSosResult {
  entity_name: string | null;
  sos_id: string | null;
  status: string | null;
  date_formed: string | null;
  registered_agent: string | null;
  registered_agent_address: string | null;
  principals: NcSosPrincipal[];
  source_url: string;
}

async function fetchNcSos(
  entityName: string | null,
  state: string | null,
): Promise<NcSosResult | null> {
  if (!entityName || state?.toUpperCase() !== "NC") return null;

  // Strip common suffixes that may not appear in the SOS record name
  const searchTerm = entityName
    .replace(/\s+(LLC|LP|L\.P\.|LLP|LLLP|Inc\.?|Corp\.?|Co\.?|Ltd\.?)\s*$/i, "")
    .replace(/\s+(Properties|Property|Holdings|Holding|Realty|Ventures|Group)\s*$/i, "")
    .trim();
  if (!searchTerm) return null;

  // sosnc.gov blocks all automated access. Use OpenCorporates API instead —
  // mirrors NC SOS data with proper JSON API. Requires a free API token:
  //   1. Register at opencorporates.com (free)
  //   2. supabase secrets set OPENCORPORATES_API_KEY=your_token
  const OC_KEY = Deno.env.get("OPENCORPORATES_API_KEY") ?? "";
  if (!OC_KEY) {
    console.log(`NC SOS: OPENCORPORATES_API_KEY not set — skipping (entity: "${entityName}")`);
    return null;
  }

  const BASE_OC = "https://api.opencorporates.com/v0.4";
  console.log(`NC SOS (via OpenCorporates): searching for "${searchTerm}" (from "${entityName}")`);

  try {
    // ── Step 1: Search for company in NC jurisdiction ─────────────────────────
    const searchUrl = `${BASE_OC}/companies/search?q=${encodeURIComponent(searchTerm)}&jurisdiction_code=us_nc&per_page=5&api_token=${OC_KEY}`;
    const ctrl1 = new AbortController();
    const t1 = setTimeout(() => ctrl1.abort(), 12000);
    const res1 = await fetch(searchUrl, {
      headers: { "Accept": "application/json", "User-Agent": "IB-Scout/1.0" },
      signal: ctrl1.signal,
    });
    clearTimeout(t1);
    if (!res1.ok) { console.warn(`OpenCorporates search HTTP ${res1.status}`); return null; }

    const data1 = await res1.json();
    const companies: Array<{company: Record<string, unknown>}> = data1?.results?.companies ?? [];
    if (!companies.length) {
      console.log(`OpenCorporates: no results for "${searchTerm}"`);
      return null;
    }

    const best = companies[0].company;
    const companyNumber = best.company_number as string;
    const foundName     = (best.name as string) ?? null;
    const status        = (best.current_status as string) ?? null;
    const dateFounded   = (best.incorporation_date as string) ?? null;
    const jurisdiction  = (best.jurisdiction_code as string) ?? "us_nc";

    console.log(`OpenCorporates: found "${foundName}" #${companyNumber} status="${status}"`);

    // ── Step 2: Full company detail — officers, registered agent ──────────────
    const detailUrl = `${BASE_OC}/companies/${jurisdiction}/${companyNumber}?sparse=false&api_token=${OC_KEY}`;
    const ctrl2 = new AbortController();
    const t2 = setTimeout(() => ctrl2.abort(), 12000);
    const res2 = await fetch(detailUrl, {
      headers: { "Accept": "application/json", "User-Agent": "IB-Scout/1.0" },
      signal: ctrl2.signal,
    });
    clearTimeout(t2);

    let registeredAgent: string | null = null;
    let registeredAgentAddress: string | null = null;
    const principals: NcSosPrincipal[] = [];

    if (res2.ok) {
      const data2 = await res2.json();
      const company = data2?.results?.company ?? {};

      registeredAgent = (company.agent_name as string) ?? null;
      if (company.agent_address) {
        const addr = company.agent_address as Record<string, string>;
        const parts = [addr.street_address, addr.locality, addr.region, addr.postal_code].filter(Boolean);
        if (parts.length) registeredAgentAddress = parts.join(", ");
      }

      const officers: Array<{officer: {name: string; position: string; inactive?: boolean}}> =
        (company.officers as Array<{officer: {name: string; position: string; inactive?: boolean}}>) ?? [];
      for (const { officer } of officers) {
        if (!officer.inactive && officer.name) {
          principals.push({ name: officer.name, title: officer.position ?? "Officer" });
        }
      }
    }

    console.log(`OpenCorporates: agent="${registeredAgent}" principals=${principals.length}`);

    return {
      entity_name: foundName,
      sos_id: companyNumber,
      status,
      date_formed: dateFounded,
      registered_agent: registeredAgent,
      registered_agent_address: registeredAgentAddress,
      principals,
      source_url: `https://www.sosnc.gov/online_services/search/CorpDetails?Id=${companyNumber}`,
    };

  } catch (e) {
    console.warn(`NC SOS (OpenCorporates) error for "${entityName}":`, (e as Error)?.message);
    return null;
  }
}

// ─── Vendor Remote Access Estimate (no LLM) ──────────────────────────────────

interface VendorEstimate {
  vendor_count_low: number;
  vendor_count_high: number;
  talking_point: string;
}

function estimateVendorAccess(
  buildingSf: number | null,
  propertyType: string | null,
  yearBuilt: number | null,
): VendorEstimate {
  // Base range by construction era — each era has different system diversity
  let [lo, hi] = [6, 9];
  if (yearBuilt) {
    if      (yearBuilt < 1990) [lo, hi] = [5, 8];   // older: fewer integrated systems
    else if (yearBuilt < 2000) [lo, hi] = [7, 10];  // 90s: mixed-era tech
    else if (yearBuilt < 2010) [lo, hi] = [9, 13];  // 2000s: most siloed, diverse vendors
    else if (yearBuilt < 2018) [lo, hi] = [8, 12];  // 2010s: modern but fragmented
    else                       [lo, hi] = [7, 11];  // newer: connected but still complex
  }
  // Size adjustment
  if (buildingSf) {
    if      (buildingSf > 250000) { lo += 4; hi += 4; }
    else if (buildingSf > 100000) { lo += 2; hi += 2; }
    else if (buildingSf <  50000) { lo -= 1; hi -= 1; }
  }
  // Property type adjustment
  const pt = (propertyType || "").toLowerCase();
  if      (pt === "mixed-use")  { lo += 2; hi += 2; }
  else if (pt === "office")     { lo += 1; hi += 1; }
  else if (pt === "industrial") { lo -= 2; hi -= 2; }
  lo = Math.max(3, lo); hi = Math.max(lo + 2, hi);
  return {
    vendor_count_low: lo, vendor_count_high: hi,
    talking_point: `This building likely has ${lo}–${hi} vendors with independent remote access to building systems — each an unmonitored ingress point with no audit trail, no access revocation, and no visibility into what they're doing when they're connected.`,
  };
}

// ─── Step 7: Property Intelligence Report — Sonnet (v2) ───────────────────────

async function generateBrief(
  formattedAddress: string,
  normalized: Awaited<ReturnType<typeof normalizeWithHaiku>>,
  scoreResult: PursuitScore | number,
  energyEst: EnergyEstimate | null,
  vendorEst: VendorEstimate,
  spatialestData?: SpatialestData | null,
  ncSosData?: NcSosResult | null,
  accelaData?: AccelaPermitSummary | null,
): Promise<Record<string, unknown>> {
  const pursuit = typeof scoreResult === "number" ? null : scoreResult as PursuitScore;
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

  const energyCtx = energyEst ? `
ENERGY SIGNAL (CBECS benchmark estimate — present as estimate, not fact):
- Estimated annual energy cost: $${energyEst.annual_cost_low.toLocaleString()} – $${energyEst.annual_cost_high.toLocaleString()}
- BMS optimization savings potential: $${energyEst.savings_low.toLocaleString()} – $${energyEst.savings_high.toLocaleString()}/year
- Methodology: ${energyEst.methodology}` : "";

  const vendorCtx = `
VENDOR ACCESS SIGNAL (estimated — present as estimate):
- Estimated vendors with remote system access: ${vendorEst.vendor_count_low}–${vendorEst.vendor_count_high}
- Talking point: ${vendorEst.talking_point}`;

  const spatialestCtx = spatialestData ? `
MECKLENBURG COUNTY RECORD (Spatialest — verified county data, present as fact):
- Assessed value: ${spatialestData.assessed_value ? "$" + spatialestData.assessed_value.toLocaleString() : "not retrieved"}${spatialestData.tax_year ? ` (${spatialestData.tax_year} assessment)` : ""}
- Land value: ${spatialestData.land_value ? "$" + spatialestData.land_value.toLocaleString() : "not available"}
- Improvement value: ${spatialestData.improvement_value ? "$" + spatialestData.improvement_value.toLocaleString() : "not available"}
- Annual property tax: ${spatialestData.annual_tax ? "$" + spatialestData.annual_tax.toLocaleString() : "not available"}
- Permit count on record: ${spatialestData.permit_count ?? "not available"}
- County record URL: ${spatialestData.property_url}` : "";

  const ncSosCtx = ncSosData ? `
NC SECRETARY OF STATE RECORD (verified public registry, present as fact):
- Registered entity: ${ncSosData.entity_name || "—"} (SOS ID: ${ncSosData.sos_id || "—"})
- Status: ${ncSosData.status || "—"}
- Date formed: ${ncSosData.date_formed || "—"}
- Registered agent: ${ncSosData.registered_agent || "not found"}${ncSosData.registered_agent_address ? ` — ${ncSosData.registered_agent_address}` : ""}
${ncSosData.principals.length ? `- Officers / Members:\n${ncSosData.principals.map(p => `  • ${p.name} (${p.title})`).join("\n")}` : "- Officers / Members: not listed"}
- SOS record URL: ${ncSosData.source_url}
Use the registered agent and officer names as high-value BD targets. Cross-reference with the owner entity to identify the GP / managing member.` : "";

  const accelaCtx = accelaData ? `
ACCELA PERMIT HISTORY (Mecklenburg County verified records — present as fact):
- Total permits on file: ${accelaData.total_permits}
- Signal: ${accelaData.signal.toUpperCase()} — ${accelaData.signal_note}
- Last controls/BMS permit: ${accelaData.last_controls_date || "none found"}
- Last mechanical permit: ${accelaData.last_mechanical_date || "none found"}
- Years since controls work: ${accelaData.years_since_controls_work !== null ? accelaData.years_since_controls_work : "unknown"}
- IB-relevant permits found: ${accelaData.ib_relevant_permits.length}
${accelaData.unique_contractors.length ? `- Contractors on record: ${accelaData.unique_contractors.join(", ")}` : "- Contractors: none identified"}
${accelaData.ib_relevant_permits.length ? `- Key IB-relevant permits:\n${accelaData.ib_relevant_permits.slice(0, 8).map(p => `  • ${p.closed_date || p.opened_date || "?"} | ${p.type} | ${p.description.slice(0, 80)} | Contractor: ${p.contractor || "unknown"} | Keywords: ${p.keywords_matched.join(", ")}`).join("\n")}` : ""}

INSTRUCTIONS FOR PERMIT DATA:
1. If signal is OVERDUE — lead with the permit gap. Name the specific number of years. This is IB's primary timing argument.
2. If contractors are identified — name them in the report as likely incumbent vendors. This is competitive intel and a potential warm intro path.
3. Surface the permit gap in the trigger_events array with urgency = Immediate if >10yr, Near-term if 5-10yr.
4. Add a "permit_history" object to your JSON with: last_controls_date, years_since_controls_work, signal, signal_note, incumbent_contractors, key_finding.` : "";

  const system = `You are a senior BD analyst for Intelligent Buildings (IB).

WHO IB IS: IB helps CRE developers, owners, and operators manage the increasing complexity of building technology and improve their NOI. The four problems IB hears consistently: (1) Change orders associated with technology — cost overruns that erode budgets. (2) Critical cybersecurity risks hidden in building systems. (3) Decisions made without complete data. (4) Preventable downtime that disrupts operations and occupant experience. IB addresses these through advisory support, assessments, and Intellinet — IB's 24/7 managed service that connects, protects, and optimizes building technology like a utility. IB does not resell products. They sit on the owner's side of the table, focused on owner outcomes: resiliency and NOI improvement. Reference property: 110 East in Charlotte — named the most Intelligent Office Building in North America for 2024, owned by Shorenstein/Stiles, operated by Stiles, powered by IB's Intellinet platform.

WHAT YOU WRITE: Two documents in one JSON call. (1) BD Report — internal intelligence brief. Never present inference as fact. Label confidence High/Medium/Low. Be specific to this building — no generic language. (2) Stakeholder Storyboard — short external document for a property owner, asset manager, or GP principal. Peer-level tone. Direct. No jargon. No buzzwords. Written so the reader picks up the phone. Opens with a specific pain tied to THIS property. Anchors in the energy cost estimate — dollars first, technology second. Names the hidden risk: unmonitored vendor access. Frames IB value across three NOI levers: cost reduction, downtime prevention, tenant retention. Closes with one low-friction ask: a free Intellinet assessment — see what right looks like for your building.`;

  // IMPORTANT: All string values must be on a single line — use \\n for line breaks, never actual newlines inside strings.
  const user = `Generate a Property Intelligence Report AND a Stakeholder Storyboard. Return a single JSON object. No preamble. No markdown. Start with {. CRITICAL: every string value must be on ONE line — no literal newlines inside any string value.

Property: ${formattedAddress}
${dataNote}
${scoreContext}
${energyCtx}
${vendorCtx}
${spatialestCtx}
${ncSosCtx}
${accelaCtx}

Return this exact JSON (every string on one line, no line breaks inside strings):
{"schema_version":2,"verdict":"one sentence verdict specific to this building","asset_snapshot":"2-3 sentence plain-English interpretation of ownership signals and building condition","asset_anomalies":["anomaly 1","anomaly 2"],"fourth_utility_fit":"why this property does or does not fit the Fourth Utility model","intellinet_fit":"which Intellinet services this building needs and why","technology_opportunity":"BMS/smart building/connectivity opportunity based on age and type","cybersecurity_exposure":"OT/IT risk profile for this asset — incorporate vendor access estimate","new_vs_retrofit":"greenfield or retrofit implications","noi_relevance":"how IB services improve NOI for this owner type","ownership_inferred":"LLC/SPE/REIT structure meaning for capital stack and authority","likely_principals":"who probably controls this asset with confidence label","tech_decision_maker":"who holds technology budget — asset manager, PM, or corporate IT","ownership_confidence":"High|Medium|Low","verification_needed":["item 1","item 2"],"trigger_events":[{"event":"event name","urgency":"Immediate|Near-term|Long-term","significance":"why this creates an IB opportunity"}],"contacts_to_find":[{"title":"exact title","company":"which entity","priority":"Primary|Secondary","why":"decision authority held","search_titles":["primary title variant","alternate title 1","alternate title 2"]}],"primary_path":"best first contact point with rationale","secondary_path":"alternative entry approach","warm_intro_angle":"relationship or market connection to leverage","message_theme":"core message angle for this owner type and asset","outreach_bullets":["talking point 1","talking point 2","talking point 3"],"discovery_questions":["question 1","question 2","question 3","question 4","question 5"],"risk_gaps":[{"issue":"gap or risk","severity":"High|Medium|Low","implication":"pursuit impact"}],"next_best_action":"one specific action with who, what, when, channel","report":"3-4 paragraph executive narrative under 300 words. Cover asset snapshot, ownership signals, timing rationale, IB fit, recommended path. Specific to this building, no generic language.","companies":[{"company":"owner entity","role":"GP/Owner|LP/Co-Owner|Property Manager","contacts_to_find":[{"title":"title","why":"reason","search_titles":["title variant 1","title variant 2"]}],"angle":"1-2 sentence pitch"}],"it_contact":{"likely_company":"company","titles_to_find":["title1","title2"],"angle":"pitch"},"next_step":"one-liner action for button display","storyboard":{"opening_hook":"one punchy sentence — specific pain tied to THIS building, not generic","body_p1":"energy paragraph: anchor in the dollar estimate, reference the methodology for credibility, name the savings opportunity from BMS optimization — dollars first, technology second","body_p2":"risk paragraph: name the vendor access estimate, frame it as hidden cybersecurity exposure, connect to the specific asset age and type — no jargon","body_p3":"value paragraph: three specific NOI levers this building would benefit from — cost reduction, downtime prevention, tenant retention. Reference Intellinet and 110 East if relevant. Peer tone.","call_to_action":"one low-friction ask — offer a free Intellinet assessment, specific to this building"}}`;

  const raw = await callClaude("claude-sonnet-4-6", system, user, 110000, 8000);
  return parseJsonRobust(raw);
}

// ─── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(origin) });
  }

  // GET ?project_id=<uuid> — serve saved scout brief using service role key (bypasses RLS)
  if (req.method === "GET") {
    const projectId = new URL(req.url).searchParams.get("project_id") || "";
    if (!projectId) {
      return new Response(JSON.stringify({ error: "project_id required" }), {
        status: 400, headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
      });
    }
    try {
      const sbRes = await fetch(
        `${SB_URL}/rest/v1/projects?id=eq.${projectId}&select=address,property_name,scout_brief,scout_brief_at`,
        { headers: { "apikey": SB_SRK, "Authorization": `Bearer ${SB_SRK}` } }
      );
      const rows = await sbRes.json();
      if (!rows?.length || !rows[0]?.scout_brief) {
        return new Response(JSON.stringify({ error: "not_found" }), {
          status: 404, headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(rows[0]), {
        headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), {
        status: 500, headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
      });
    }
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

  const address    = (body.address    as string) || "";
  const city       = (body.city       as string) || "";
  const state      = (body.state      as string) || "";
  const zip        = (body.zip        as string) || "";
  const project_id = (body.project_id as string) || "";

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
      const fallbackEnergy = estimateEnergyCost(null, "office", null, geo.state);
      const fallbackVendor = estimateVendorAccess(null, "office", null);
      console.log(`Fetching news for fallback report: ${geo.formatted_address}`);
      const [brief, news] = await Promise.all([
        generateBrief(geo.formatted_address, emptyNormalized, fallbackScore, fallbackEnergy, fallbackVendor, null),
        fetchPropertyNews(geo.formatted_address, null).catch((e) => { console.log("News error (fallback):", e?.message); return { items: [], searched_for: "" }; }),
      ]);
      const fallbackResult = {
        ok: true,
        schema_version: 2,
        formatted_address: geo.formatted_address,
        geo: { lat: geo.lat, lng: geo.lng },
        normalized: emptyNormalized,
        score: fallbackScore.total,
        pursuit_score: fallbackScore,
        priority: "Unscored — no Attom data",
        energy_estimate: fallbackEnergy,
        vendor_estimate: fallbackVendor,
        spatialest: null,
        brief,
        news,
        attom_raw: fallbackAttom,
        attom_missing: true,
      };
      if (project_id) await saveScoutBrief(project_id, fallbackResult);
      return new Response(
        JSON.stringify(fallbackResult),
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

    // Supplemental estimates (pure code — no LLM, no extra API calls)
    const energyEst = estimateEnergyCost(normalized.building_sf, normalized.property_type, normalized.year_built, geo.state);
    const vendorEst = estimateVendorAccess(normalized.building_sf, normalized.property_type, normalized.year_built);

    // Step 5.5: Supplemental data — Spatialest (NC-only) + Accela permits (parallel)
    // NC SOS disabled — sosnc.gov blocks automated access. Manual lookup only.
    const [spatialestData, accelaData] = await Promise.all([
      fetchSpatialest(normalized.apn, geo.county, geo.state)
        .catch((e) => { console.log("Spatialest error:", e?.message); return null; }),
      fetchAccelaPermits(geo.street_number, geo.route, geo.zip, normalized.year_built)
        .catch((e) => { console.log("Accela error:", e?.message); return null; }),
    ]);
    const ncSosData = null;
    console.log(`Accela result: signal=${accelaData?.signal} permits=${accelaData?.total_permits} contractors=${accelaData?.unique_contractors?.length}`);

    // Step 7: Full Intelligence Report with Sonnet + parallel news search
    console.log(`Fetching news for: ${geo.formatted_address} / owner: ${normalized.owner_entity}`);
    const [brief, news] = await Promise.all([
      generateBrief(geo.formatted_address, normalized, pursuitScore, energyEst, vendorEst, spatialestData, ncSosData, accelaData),
      fetchPropertyNews(geo.formatted_address, normalized.owner_entity).catch((e) => { console.log("News error:", e?.message); return { items: [], searched_for: "" }; }),
    ]);

    const result = {
      ok: true,
      schema_version: 2,
      formatted_address: geo.formatted_address,
      geo: { lat: geo.lat, lng: geo.lng },
      normalized,
      score,
      pursuit_score: pursuitScore,
      priority,
      energy_estimate: energyEst,
      vendor_estimate: vendorEst,
      spatialest: spatialestData,
      nc_sos: ncSosData,
      accela_permits: accelaData,
      brief,
      news,
      attom_raw: attomRawData,
    };
    if (project_id) await saveScoutBrief(project_id, result);

    return new Response(
      JSON.stringify(result),
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
