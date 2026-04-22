// IB-Scout — AI Brief Edge Function (Haiku + Web Search)
// Calls Claude Sonnet with live web search to generate property intelligence
// Deploy via: supabase functions deploy ai-brief
//
// Required secrets:
//   ANTHROPIC_API_KEY — from console.anthropic.com (key: scout-tests)
//   APP_SECRET        — shared secret (ib-scout-2026)
//   SB_URL            — https://lnldwxttyfjmaobluciy.supabase.co
//   SB_SERVICE_KEY    — service_role key

// No SDK needed — using direct fetch for Anthropic API (required for web-search beta)

const ANTHROPIC_KEY  = Deno.env.get("ANTHROPIC_API_KEY")!;
const APP_SECRET     = Deno.env.get("APP_SECRET")!;
const SUPABASE_URL   = Deno.env.get("SB_URL")!;
const SERVICE_KEY    = Deno.env.get("SB_SERVICE_KEY")!;
const ALLOWED_ORIGIN = "https://fourthutility.github.io";
const DAILY_LIMIT    = 50;

function corsHeaders(origin: string | null) {
  const allowed = origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-app-secret",
  };
}

async function sbFetch(path: string, opts: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Prefer": "return=representation",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function checkDailyLimit(): Promise<{ allowed: boolean; count: number }> {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const rows = await sbFetch(
      `ai_brief_calls?select=id&created_at=gte.${todayStart.toISOString()}`
    );
    const count = Array.isArray(rows) ? rows.length : 0;
    return { allowed: count < DAILY_LIMIT, count };
  } catch {
    return { allowed: true, count: 0 };
  }
}

async function logCall(address: string, tokensIn: number, tokensOut: number) {
  try {
    await sbFetch("ai_brief_calls", {
      method: "POST",
      body: JSON.stringify({ address, tokens_in: tokensIn, tokens_out: tokensOut }),
    });
  } catch { /* non-fatal */ }
}

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

  const { allowed, count } = await checkDailyLimit();
  if (!allowed) {
    return new Response(
      JSON.stringify({ error: `Daily limit of ${DAILY_LIMIT} AI briefs reached (${count} used). Try again tomorrow.` }),
      { status: 429, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
    );
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

  const {
    address = "",
    building_name = "",
    year_built = "",
    building_class = "",
    leed_certified = "",
    sf = "",
    status = "",
    owner_name = "",
    limited_partners = [],
    property_manager = "",
    leasing_company = "",
    city = "",
    state = "",
    ib_stage = "",
  } = body as Record<string, unknown>;

  // Build ownership lines for prompt
  const ownershipLines: string[] = [];
  if (owner_name) ownershipLines.push(`- GP/Owner: ${owner_name}`);
  const lps = Array.isArray(limited_partners) ? limited_partners : [];
  lps.forEach((lp: unknown) => ownershipLines.push(`- LP/Co-Owner: ${lp}`));
  if (property_manager) ownershipLines.push(`- Property Manager: ${property_manager}`);
  if (leasing_company)  ownershipLines.push(`- Leasing Company: ${leasing_company}`);

  const prompt = `CRE intelligence analyst for Intellinet BD outreach (tech managed services: BMS, access, surveillance, networking, cybersecurity).

PROPERTY: ${address}${building_name ? ` (${building_name})` : ""} | ${city || ""}${state ? ", "+state : ""} | Built ${year_built||"?"} | Class ${building_class||"?"} | ${sf ? sf+" SF" : "?"} | ${status||""} | LEED: ${leed_certified||"None"} | Stage: ${ib_stage||"Prospect"}

KNOWN PARTIES:
${ownershipLines.length ? ownershipLines.join("\n") : "None — search required"}

USE WEB SEARCH TO FIND: property manager (if unknown), recent sale/transaction (date, buyer, seller, price), key decision-maker at each ownership entity, recent news or renovations, major tenants.

RESPOND WITH ONLY THIS JSON (no preamble, no markdown, start with {):
{"companies":[{"company":"exact name only","role":"GP/Owner|LP/Co-Owner|Property Manager|Leasing Company","contacts_to_find":[{"title":"Asset Manager","why":"controls capex budget"}],"angle":"1-2 sentence pitch"}],"it_contact":{"likely_company":"name","titles_to_find":["Director of IT","CIO","Director of Facilities Technology"],"angle":"1-2 sentence pitch"},"transaction_history":[{"date":"","event":"Sold","buyer":"","seller":"","price":"","source":""}],"current_property_manager":"name or null","building_profile":"2-3 sentences on tech landscape","likely_systems":"BMS/tech systems","top_pain_points":["","",""],"discovery_questions":["","",""],"next_step_suggestion":"","data_needed":[],"sources_searched":[]}

RULES: Only add a company to "companies" if you know its ACTUAL name. If unknown after searching, add to "data_needed". Empty transaction_history=[]`;

  try {
    // Call Anthropic API directly (bypasses SDK version constraints for beta features)
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1500,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      throw new Error(`Anthropic API ${anthropicRes.status}: ${errText}`);
    }

    const message = await anthropicRes.json();

    // Extract the final text block (web search adds tool_use/tool_result blocks before it)
    const rawText = (message.content as Array<{type: string; text?: string}>)
      .filter((b: {type: string}) => b.type === "text")
      .map((b: {text?: string}) => b.text || "")
      .join("");

    const tokensIn  = message.usage?.input_tokens  ?? 0;
    const tokensOut = message.usage?.output_tokens ?? 0;

    logCall(address as string, tokensIn, tokensOut);

    let parsed: Record<string, unknown>;
    try {
      // Try direct parse first
      parsed = JSON.parse(rawText);
    } catch {
      // Strip markdown fences if present
      let stripped = rawText.replace(/^```json\s*/i, "").replace(/\s*```$/, "").trim();
      try {
        parsed = JSON.parse(stripped);
      } catch {
        // Extract JSON object even if Claude added text before/after it
        const match = stripped.match(/\{[\s\S]*\}/);
        if (!match) throw new Error("No JSON object found in response");
        parsed = JSON.parse(match[0]);
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        data: parsed,
        usage: { tokens_in: tokensIn, tokens_out: tokensOut, calls_today: count + 1 },
      }),
      { headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("AI Brief error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
    );
  }
});
