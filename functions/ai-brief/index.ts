// IB-Scout — AI Brief Edge Function
// Calls Claude API to generate an enhanced property intelligence brief
// Deploy via: supabase functions deploy ai-brief
//
// Required secrets (Supabase Dashboard → Edge Functions → Secrets):
//   ANTHROPIC_API_KEY — from console.anthropic.com (key: scout-tests)
//   APP_SECRET        — shared secret (same as other functions: ib-scout-2026)
//   SB_URL            — https://lnldwxttyfjmaobluciy.supabase.co
//   SB_SERVICE_KEY    — service_role key (Settings → API)
//
// GATING:
//   1. x-app-secret header must match APP_SECRET
//   2. Daily call limit enforced via ai_brief_calls table (default: 50/day)
//   3. UI shows confirm dialog before every call
//
// USAGE TABLE — run this SQL in Supabase SQL editor first:
//   CREATE TABLE ai_brief_calls (
//     id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
//     created_at timestamptz DEFAULT now(),
//     address    text,
//     tokens_in  int,
//     tokens_out int
//   );

import Anthropic from "npm:@anthropic-ai/sdk@0.27.0";

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
    // If table doesn't exist yet, allow but don't track
    return { allowed: true, count: 0 };
  }
}

async function logCall(address: string, tokensIn: number, tokensOut: number) {
  try {
    await sbFetch("ai_brief_calls", {
      method: "POST",
      body: JSON.stringify({ address, tokens_in: tokensIn, tokens_out: tokensOut }),
    });
  } catch {
    // Non-fatal — don't fail the response if logging breaks
  }
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

  // Gate: shared app secret
  const secret = req.headers.get("x-app-secret");
  if (secret !== APP_SECRET) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
    });
  }

  // Gate: daily usage limit
  const { allowed, count } = await checkDailyLimit();
  if (!allowed) {
    return new Response(
      JSON.stringify({ error: `Daily limit of ${DAILY_LIMIT} AI briefs reached (${count} used). Try again tomorrow.` }),
      { status: 429, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
    );
  }

  let body: Record<string, string>;
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
  } = body;

  // Build ownership string for prompt
  const ownershipLines = [];
  if (owner_name) ownershipLines.push(`- GP/Owner: ${owner_name}`);
  const lps = Array.isArray(limited_partners) ? limited_partners : [];
  lps.forEach((lp: string) => ownershipLines.push(`- LP/Co-Owner: ${lp}`));
  if (property_manager) ownershipLines.push(`- Property Manager: ${property_manager}`);
  if (leasing_company) ownershipLines.push(`- Leasing Company: ${leasing_company}`);

  const prompt = `You are an expert commercial real estate analyst helping an Intelligent Buildings (Intellinet) BD rep prepare for prospect outreach.

Intellinet is a technology managed services company specializing in commercial real estate. They help building owners and operators manage OT/IT systems—BMS, access control, surveillance, networking, and cybersecurity—as a single managed service. Their key value proposition is reducing change orders, preventing downtime, addressing cybersecurity gaps in building OT systems, and replacing incomplete/siloed data with unified dashboards.

BUILDING DATA:
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
${ownershipLines.length ? ownershipLines.join("\n") : "- Unknown"}

Generate a JSON object with exactly these keys:

{
  "companies": [
    {
      "company": "Exact company name",
      "role": "One of: GP/Owner | LP/Co-Owner | Property Manager | Leasing Company",
      "known": true or false (true if provided in data above, false if inferred),
      "contacts_to_find": [
        { "title": "Asset Manager", "why": "Controls capital improvement budget and vendor decisions" },
        { "title": "VP Investments", "why": "Strategic technology and ESG priorities" }
      ],
      "angle": "1-2 sentence pitch angle specific to this company's role and typical priorities"
    }
  ],
  "it_contact": {
    "likely_company": "Which company above most likely employs the tech decision-maker",
    "titles_to_find": ["Director of IT", "CIO", "Director of Facilities Technology"],
    "angle": "1-2 sentence pitch angle for the IT/technology contact"
  },
  "building_profile": "2-3 sentence narrative about this building's likely technology landscape",
  "likely_systems": "BMS/technology systems likely installed based on building age and class",
  "top_pain_points": ["pain point 1", "pain point 2", "pain point 3"],
  "discovery_questions": ["question 1", "question 2", "question 3"],
  "next_step_suggestion": "Specific, actionable next step for this BD rep"
}

IMPORTANT:
- Include one entry in "companies" for EACH owner entity (GP + each LP) — they each have their own asset manager
- If property manager is known, include it; if unknown but inferable from building type/market, infer it and set known=false
- Be specific about titles — "Asset Manager" not just "Manager"
- Respond ONLY with valid JSON. No markdown, no explanation, no code fences.`;

  try {
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1536,
      messages: [{ role: "user", content: prompt }],
    });

    const rawText = message.content[0].type === "text" ? message.content[0].text : "";
    const tokensIn  = message.usage.input_tokens;
    const tokensOut = message.usage.output_tokens;

    // Log the call (non-blocking)
    logCall(address, tokensIn, tokensOut);

    // Parse and validate JSON
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      // If Claude wrapped in markdown fences, strip them
      const stripped = rawText.replace(/^```json\s*/i, "").replace(/\s*```$/, "").trim();
      parsed = JSON.parse(stripped);
    }

    return new Response(
      JSON.stringify({ ok: true, data: parsed, usage: { tokens_in: tokensIn, tokens_out: tokensOut, calls_today: count + 1 } }),
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
