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

// ─── Step 1: Geocode ─────────────────────────────────────────────────────────

async function geocodeAddress(address: string) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_KEY}`;
  const data = await httpGet(url);
  if (data.status !== "OK") throw new Error("Address not found. Check input and retry.");

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
}

// ─── Attom helper ─────────────────────────────────────────────────────────────

function attomGet(endpoint: string, geo: ReturnType<typeof geocodeAddress> extends Promise<infer T> ? T : never) {
  const street = [geo.street_number, geo.route].filter(Boolean).join(" ");
  const cityStateZip = `${geo.city},${geo.state} ${geo.zip}`;
  const params = new URLSearchParams({ address1: street, address2: cityStateZip });
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

// ─── Step 7: Report with Sonnet ──────────────────────────────────────────────

async function generateReport(
  formattedAddress: string,
  normalized: Awaited<ReturnType<typeof normalizeWithHaiku>>,
  score: number
): Promise<string> {
  const system = `You are an analyst for Intelligent Buildings (IB), a commercial real estate technology advisory firm. IB positions digital infrastructure as the "Fourth Utility" — a managed service that improves NOI for CRE owners. Write concise, professional property intelligence reports for IB's BD team. Focus on ownership structure, transaction signals, and why this property is or isn't a fit for IB's managed services offering.`;

  const user = `Write a Property Intelligence Report for the IB BD team based on this data:

Property: ${formattedAddress}
Normalized Data: ${JSON.stringify(normalized, null, 2)}
IB Opportunity Score: ${score}/100

Structure the report with these sections:
1. Property Summary (4–5 lines: address, type, SF, stories, year built)
2. Ownership (owner entity, type, mailing address, what this signals)
3. Transaction History (last sale + prior sales — what the timing tells us)
4. IB Fit Assessment (why this property is or isn't a match for Fourth Utility managed services — be specific, not generic)
5. Recommended Next Step (one concrete action for the IB BD team)

Keep the full report under 300 words. Write for a BD team, not a data analyst.`;

  return await callClaude("claude-sonnet-4-6", system, user);
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
  if (!address.trim()) {
    return new Response(JSON.stringify({ error: "address is required" }), {
      status: 400,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
    });
  }

  try {
    // Step 1: Geocode
    const geo = await geocodeAddress(address);

    // Steps 2–4: Attom in parallel
    const [detailData, saleData, historyData] = await Promise.allSettled([
      attomGet("property/detailowner", geo),
      attomGet("sale/detail", geo),
      attomGet("saleshistory/detail", geo),
    ]);

    const detail = detailData.status === "fulfilled" ? detailData.value : null;
    const sale   = saleData.status === "fulfilled"   ? saleData.value   : null;
    const history = historyData.status === "fulfilled" ? historyData.value : null;

    if (!detail) throw new Error("Attom returned no property record for this address.");

    // Step 5: Normalize with Haiku
    const normalized = await normalizeWithHaiku(detail, sale, history);

    // Step 6: Score
    const score = scoreProperty(normalized);
    const priority = priorityLabel(score);

    // Step 7: Report with Sonnet
    const report = await generateReport(geo.formatted_address, normalized, score);

    return new Response(
      JSON.stringify({
        ok: true,
        formatted_address: geo.formatted_address,
        geo: { lat: geo.lat, lng: geo.lng },
        normalized,
        score,
        priority,
        report,
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
