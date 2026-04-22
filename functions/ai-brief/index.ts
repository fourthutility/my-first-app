// IB-Scout — AI Brief Edge Function (Sonnet + Web Search)
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

  const prompt = `You are a commercial real estate intelligence analyst helping an Intelligent Buildings (Intellinet) BD rep prepare for prospect outreach. Intellinet provides technology managed services for CRE — managing BMS, access control, surveillance, networking, and cybersecurity as a single managed service.

BUILDING:
- Address: ${address}
- Name: ${building_name || "Unknown"}
- Year Built: ${year_built || "Unknown"}
- Class: ${building_class || "Unknown"}
- LEED: ${leed_certified || "None"}
- Size: ${sf ? sf + " SF" : "Unknown"}
- Status: ${status || "Unknown"}
- Market: ${city || ""}${state ? ", " + state : ""}
- IB Stage: ${ib_stage || "Prospect"}

OWNERSHIP & MANAGEMENT:
${ownershipLines.length ? ownershipLines.join("\n") : "- Unknown — please search"}

RESEARCH TASKS — use web search to find:
1. Current property management company (if not listed above)
2. Recent sale or transaction history (buyer, seller, price, date)
3. For each ownership entity, identify the asset manager or key decision-maker by name if possible
4. Any recent news about this building, ownership changes, or renovations
5. Current major tenants or notable lease activity

After researching, respond with ONLY a JSON object using exactly these keys:

{
  "companies": [
    {
      "company": "Exact known company name — never use 'Unknown' or 'Inferred'",
      "role": "GP/Owner | LP/Co-Owner | Property Manager | Leasing Company",
      "contacts_to_find": [
        { "title": "Asset Manager", "why": "Controls capital improvement budget" }
      ],
      "angle": "1-2 sentence pitch tailored to this company's role and what you found"
    }
  ],
  "it_contact": {
    "likely_company": "Which company likely employs the IT/tech decision-maker",
    "titles_to_find": ["Director of IT", "CIO", "VP of Facilities Technology"],
    "angle": "1-2 sentence pitch for the IT/technology contact"
  },
  "transaction_history": [
    { "date": "2019", "event": "Sold", "buyer": "Shorenstein", "seller": "Highwoods", "price": "$87M", "source": "CoStar" }
  ],
  "current_property_manager": "Company name or null if not found",
  "building_profile": "2-3 sentences on the technology landscape: what systems are likely in place given age, class, and anything you found about renovations or tenants",
  "likely_systems": "Specific BMS/tech systems likely installed based on age and class",
  "top_pain_points": ["Specific pain point 1", "Specific pain point 2", "Specific pain point 3"],
  "discovery_questions": ["Specific question 1", "Specific question 2", "Specific question 3"],
  "next_step_suggestion": "Specific, actionable next step for the BD rep",
  "data_needed": ["List fields still unknown after searching, e.g. owner, property_manager"],
  "sources_searched": ["What you searched for and what you found or didn't find"]
}

RULES:
- Only include a company in "companies" if you know its ACTUAL name (from input or web search). Never invent or infer names.
- If you cannot confirm a company name after searching, omit it and add the role to "data_needed"
- Pain points and discovery questions must be SPECIFIC to this building's age, class, ownership, and market — not generic
- transaction_history must be [] if nothing found
- YOUR ENTIRE RESPONSE MUST BE A SINGLE JSON OBJECT. No preamble, no explanation, no markdown fences. Start with { and end with }`;

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
        model: "claude-3-7-sonnet-20250219",
        max_tokens: 4096,
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
