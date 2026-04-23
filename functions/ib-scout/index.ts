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
      max_tokens: isHaiku ? 1024 : 2048,
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

// ─── Step 1: Geocode (with fallback to direct parse) ─────────────────────────

function parseAddressLocally(address: string, city: string, state: string, zip: string) {
  // Try to extract city/state/zip from the address string if not provided separately
  // Handles formats like: "110 East Blvd, Nashville, TN 37203" or "110 East Blvd, Nashville, TN"
  if (!city || !state) {
    const segments = address.split(",").map(s => s.trim());
    if (segments.length >= 3) {
      // Last segment is typically "ST 12345" or "ST"
      const last = segments[segments.length - 1].trim();
      const stateZip = last.match(/^([A-Za-z]{2})\s*(\d{5}(-\d{4})?)?$/);
      if (stateZip) {
        state = state || stateZip[1].toUpperCase();
        zip   = zip   || (stateZip[2] || "");
        city  = city  || segments[segments.length - 2];
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
  // Always run Google geocoding — it gives us lat/lng which Attom uses for reliable lookup
  // Only skip if we somehow already have coordinates (not applicable in current flow)

  // Try to parse city/state from the address string first
  const parsed = parseAddressLocally(address, city, state, zip);
  if (parsed.city && parsed.state) {
    console.log("Parsed city/state from address string");
    return parsed;
  }

  // Fall back to Google geocoding
  try {
    const query = [address, city, state, zip].filter(Boolean).join(", ");
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
      city: get("locality") || get("sublocality") || get("neighborhood"),
      state: get("administrative_area_level_1"),
      zip: get("postal_code"),
      county: get("administrative_area_level_2"),
    };
  } catch (e) {
    console.warn("Google geocode failed:", e);
    // Last resort — use whatever we parsed from the string
    if (!parsed.state) throw new Error("Could not determine city/state for this address. Try entering the full address including city and state (e.g. '110 East Blvd, Charlotte, NC 28203').");
    return parsed;
  }
}

// ─── Attom helper ─────────────────────────────────────────────────────────────

function attomGet(endpoint: string, geo: ReturnType<typeof geocodeAddress> extends Promise<infer T> ? T : never) {
  const street = [geo.street_number, geo.route].filter(Boolean).join(" ");
  const zip = geo.zip && geo.zip !== "null" ? ` ${geo.zip}` : "";
  const cityStateZip = `${geo.city},${geo.state}${zip}`;

  // Prefer lat/lng when available — more reliable than address string parsing
  // Falls back to address1/address2 if coords not available
  let params: URLSearchParams;
  if (geo.lat && geo.lng && geo.lat !== 0 && geo.lng !== 0) {
    params = new URLSearchParams({ latitude: String(geo.lat), longitude: String(geo.lng) });
    console.log(`Attom ${endpoint}: lat=${geo.lat} lng=${geo.lng}`);
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

// ─── Step 6: Score (pure code) ───────────────────────────────────────────────

function scoreProperty(p: Awaited<ReturnType<typeof normalizeWithHaiku>>): number {
  let score = 0;
  const now = new Date();

  if (p.last_sale_date) {
    const yearsAgo = now.getFullYear() - new Date(p.last_sale_date).getFullYear();
    if (yearsAgo <= 3)      score += 30;
    else if (yearsAgo <= 6) score += 15;
  }

  if      ((p.building_sf ?? 0) >= 100000) score += 25;
  else if ((p.building_sf ?? 0) >= 50000)  score += 15;
  else if ((p.building_sf ?? 0) >= 25000)  score += 8;

  if      (["office", "mixed-use"].includes(p.property_type))       score += 20;
  else if (["multifamily", "retail"].includes(p.property_type))     score += 10;

  if (["LLC", "REIT", "institution"].includes(p.owner_type)) score += 15;

  if (p.year_built && p.year_built < 2005) score += 10;

  return Math.min(score, 100);
}

function priorityLabel(score: number): string {
  if (score >= 70) return "High Priority";
  if (score >= 40) return "Watch";
  return "Low";
}

// ─── Step 7: Full Intelligence Brief with Sonnet ─────────────────────────────

async function generateBrief(
  formattedAddress: string,
  normalized: Awaited<ReturnType<typeof normalizeWithHaiku>>,
  score: number
): Promise<Record<string, unknown>> {
  const system = `You are an analyst for Intelligent Buildings (IB), a commercial real estate technology advisory firm. IB positions digital infrastructure as the "Fourth Utility" — a managed service that improves NOI for CRE owners. You produce property intelligence dossiers for IB's BD team that combine verified property data with actionable contact strategy.`;

  const attomAvailable = !normalized.data_flags?.includes("Attom property record not found — report based on AI knowledge only");
  const dataNote = attomAvailable
    ? `Verified Attom Data: ${JSON.stringify(normalized, null, 2)}`
    : `Attom Data: Not available for this address. Use your own knowledge of this property and address to provide the best possible intelligence. Research what you know about this building — ownership, tenants, age, class, transaction history. Be specific, not generic.`;

  const user = `Analyze this property and return a single JSON object. No preamble. No markdown. Start with {.

Property: ${formattedAddress}
${dataNote}
IB Opportunity Score: ${score}/100

Return exactly this schema:
{
  "report": "3–4 paragraph narrative covering: (1) property summary — type, SF, age, condition signals; (2) ownership analysis — who owns it, what the owner type signals about decision-making and budget authority; (3) transaction history — what the sale timing and price tell us about the ownership cycle; (4) IB fit assessment — specific reasons this property is or isn't a match for Fourth Utility managed services. Be specific to this building, not generic. Under 250 words.",
  "companies": [
    {
      "company": "Exact owner entity name from Attom data",
      "role": "GP/Owner | LP/Co-Owner | Property Manager",
      "contacts_to_find": [
        { "title": "Asset Manager", "why": "Controls capital improvement budget" },
        { "title": "Director of Facilities", "why": "Day-to-day building operations" }
      ],
      "angle": "1–2 sentence pitch specific to this company's role and ownership signals"
    }
  ],
  "it_contact": {
    "likely_company": "Which company likely employs the IT/tech decision-maker",
    "titles_to_find": ["Director of IT", "CIO", "VP of Facilities Technology"],
    "angle": "1–2 sentence pitch for the technology contact"
  },
  "discovery_questions": [
    "Specific question about their current BMS or building systems",
    "Specific question about their technology spend or managed service contracts",
    "Specific question tied to the ownership/transaction signals you found"
  ],
  "next_step": "One concrete, specific action the IB BD rep should take this week"
}`;

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
      const score = 0;
      const brief = await generateBrief(geo.formatted_address, emptyNormalized, score);
      return new Response(
        JSON.stringify({
          ok: true,
          formatted_address: geo.formatted_address,
          geo: { lat: geo.lat, lng: geo.lng },
          normalized: emptyNormalized,
          score: 0,
          priority: "Unscored — no Attom data",
          brief,
          attom_raw: { detail_found: false, sale_found: false, history_found: false, history_count: 0 },
          attom_missing: true,
        }),
        { headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
      );
    }

    // Step 5: Normalize with Haiku
    const normalized = await normalizeWithHaiku(detail, sale, history);

    // Step 6: Score
    const score = scoreProperty(normalized);
    const priority = priorityLabel(score);

    // Step 7: Full brief with Sonnet
    const brief = await generateBrief(geo.formatted_address, normalized, score);

    return new Response(
      JSON.stringify({
        ok: true,
        formatted_address: geo.formatted_address,
        geo: { lat: geo.lat, lng: geo.lng },
        normalized,
        score,
        priority,
        brief,
        attom_raw: {
          detail_found: !!detail,
          sale_found: !!sale,
          history_found: !!history,
          history_count: (history?.sale as unknown[])?.length ?? 0,
        },
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
