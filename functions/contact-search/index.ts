// IB-Scout — Contact Search Edge Function
// Deploy via: Supabase Dashboard → Edge Functions → New Function → name: "contact-search"
//
// Required secrets (Edge Functions → Secrets):
//   HUBSPOT_TOKEN  — HubSpot Private App access token
//   APOLLO_API_KEY — Apollo.io API key
//   APP_SECRET     — shared secret (x-app-secret header + Apollo webhook ?secret= param)
//   SB_URL         — https://lnldwxttyfjmaobluciy.supabase.co
//   SB_SERVICE_KEY — service_role key (Settings → API in Supabase dashboard)
//
// TWO-PHASE CREDIT FLOW:
//   Phase 1 — free:  { company_name } → returns HubSpot + cached Apollo contacts
//                    + pending_reveal:[{id,first_name,title}] for uncached people
//   Phase 2 — paid:  { company_name, reveal_ids:[...] } → bulk_match only those IDs
//                    UI shows credit warning before Phase 2 is triggered.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const HS_TOKEN       = Deno.env.get("HUBSPOT_TOKEN")!;
const APOLLO_KEY     = Deno.env.get("APOLLO_API_KEY")!;
const APP_SECRET     = Deno.env.get("APP_SECRET")!;
const SUPABASE_URL   = Deno.env.get("SB_URL")!;
const SERVICE_KEY    = Deno.env.get("SB_SERVICE_KEY")!;
const HS_BASE        = "https://api.hubapi.com";
const APOLLO_BASE    = "https://api.apollo.io/v1";
const ALLOWED_ORIGIN = "https://fourthutility.github.io";

function corsHeaders(origin: string | null) {
  const allowed = origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;
  return {
    "Access-Control-Allow-Origin":  allowed,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-app-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

// ── HubSpot helpers ───────────────────────────────────────────────────────────
async function hsPost(path: string, body: object) {
  const res = await fetch(`${HS_BASE}${path}`, {
    method:  "POST",
    headers: { Authorization: `Bearer ${HS_TOKEN}`, "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  return res.json();
}

async function hsGet(path: string) {
  const res = await fetch(`${HS_BASE}${path}`, {
    headers: { Authorization: `Bearer ${HS_TOKEN}` },
  });
  return res.json();
}

async function findHubSpotContacts(companyName: string) {
  const search = await hsPost("/crm/v3/objects/companies/search", {
    filterGroups: [{
      filters: [{ propertyName: "name", operator: "EQ", value: companyName }],
    }],
    limit: 1,
    properties: ["name", "hs_object_id"],
  });

  const company = search.results?.[0];
  if (!company) return [];

  const assoc = await hsGet(`/crm/v3/objects/companies/${company.id}/associations/contacts`);
  const contactIds = (assoc.results ?? []).map((r: any) => r.id).slice(0, 10);
  if (!contactIds.length) return [];

  const batch = await hsPost("/crm/v3/objects/contacts/batch/read", {
    inputs:     contactIds.map((id: string) => ({ id })),
    properties: ["firstname", "lastname", "jobtitle", "email", "phone", "mobilephone", "hs_object_id"],
  });

  return (batch.results ?? []).map((c: any) => ({
    name:               [c.properties.firstname, c.properties.lastname].filter(Boolean).join(" "),
    title:              c.properties.jobtitle || "",
    email:              c.properties.email || "",
    phone:              c.properties.mobilephone || c.properties.phone || "",
    hubspot_contact_id: c.id,
    source:             "HubSpot",
  })).filter((c: any) => c.name);
}

// ── Supabase cache helpers ────────────────────────────────────────────────────
async function getCachedContacts(personIds: string[]): Promise<Record<string, any>> {
  if (!personIds.length) return {};
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/apollo_phone_cache?apollo_person_id=in.(${personIds.join(",")})&status=neq.pending&select=apollo_person_id,name,title,email,linkedin_url,phone,status`,
      { headers: { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}` } }
    );
    if (!res.ok) return {};
    const rows: any[] = await res.json();
    const byId: Record<string, any> = {};
    for (const row of rows) {
      if (row.name) byId[row.apollo_person_id] = row;
    }
    console.log(`Cache hits: ${Object.keys(byId).length} / ${personIds.length}`);
    return byId;
  } catch (e: any) {
    console.error("Cache read error:", e.message);
    return {};
  }
}

async function saveToCache(records: object[]) {
  if (!records.length) return;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/apollo_phone_cache?on_conflict=apollo_person_id`, {
      method:  "POST",
      headers: {
        "apikey":        SERVICE_KEY,
        "Authorization": `Bearer ${SERVICE_KEY}`,
        "Content-Type":  "application/json",
        "Prefer":        "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(records),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error("Cache upsert failed:", res.status, err.slice(0, 200));
    } else {
      console.log(`Cache: upserted ${records.length} records`);
    }
  } catch (e: any) {
    console.error("Cache error:", e.message);
  }
}

// ── Apollo Phase 1 — free search + cache check ───────────────────────────────
// Returns cached contacts immediately and a pending_reveal list for uncached people.
// No credits consumed.
async function apolloSearchAndCache(companyName: string, domain?: string) {
  const apolloHeaders = {
    "Content-Type":  "application/json",
    "Cache-Control": "no-cache",
    "X-Api-Key":     APOLLO_KEY,
  };

  const searchBody: any = { q_organization_name: companyName, page: 1, per_page: 10 };
  if (domain) searchBody.q_organization_domains = [domain];

  const searchRes = await fetch(`${APOLLO_BASE}/mixed_people/api_search`, {
    method: "POST", headers: apolloHeaders, body: JSON.stringify(searchBody),
  });

  const rawSearch = await searchRes.text();
  console.log(`Apollo search status: ${searchRes.status}`);
  console.log(`Apollo search (first 400): ${rawSearch.slice(0, 400)}`);
  if (!searchRes.ok) return { cached: [], pending_reveal: [] };

  let searchData: any;
  try { searchData = JSON.parse(rawSearch); } catch { return { cached: [], pending_reveal: [] }; }

  const teasers: any[] = searchData.people ?? searchData.contacts ?? [];
  if (!teasers.length) return { cached: [], pending_reveal: [] };

  const allIds    = teasers.map((p: any) => p.id);
  const cachedById = await getCachedContacts(allIds);

  const cached = Object.values(cachedById).map((c: any) => ({
    apollo_person_id: c.apollo_person_id,
    name:             c.name,
    title:            c.title        || "",
    email:            c.email        || "",
    phone:            c.phone        || "",
    linkedin_url:     c.linkedin_url || "",
    source:           "Apollo",
  }));

  // People not yet revealed — returned as lightweight stubs for the warning banner
  const pending_reveal = teasers
    .filter((p: any) => !cachedById[p.id])
    .map((p: any) => ({
      id:                p.id,
      first_name:        p.first_name,
      title:             p.title || "",
      organization_name: companyName,
      ...(domain ? { domain } : {}),
    }));

  return { cached, pending_reveal };
}

// ── Apollo Phase 2 — paid reveal ─────────────────────────────────────────────
// Only called when user explicitly confirms credit spend.
// reveal_details = array of {id, first_name, organization_name, domain?}
async function apolloReveal(revealDetails: any[], companyName: string, domain?: string) {
  if (!revealDetails.length) return [];

  const apolloHeaders = {
    "Content-Type":  "application/json",
    "Cache-Control": "no-cache",
    "X-Api-Key":     APOLLO_KEY,
  };

  const webhookUrl = `${SUPABASE_URL}/functions/v1/apollo-phone-webhook?secret=${APP_SECRET}`;

  console.log(`Revealing ${revealDetails.length} people — credits will be consumed`);

  const revealRes = await fetch(`${APOLLO_BASE}/people/bulk_match`, {
    method:  "POST",
    headers: apolloHeaders,
    body:    JSON.stringify({
      reveal_personal_emails: true,
      reveal_phone_number:    true,
      webhook_url:            webhookUrl,
      details:                revealDetails,
    }),
  });

  const rawReveal = await revealRes.text();
  console.log(`Apollo reveal status: ${revealRes.status}`);
  console.log(`Apollo reveal (first 600): ${rawReveal.slice(0, 600)}`);

  if (!revealRes.ok) {
    console.error("Apollo bulk_match failed:", revealRes.status);
    return [];
  }

  let revealData: any;
  try { revealData = JSON.parse(rawReveal); } catch { return []; }

  const revealed: any[] = revealData.matches ?? revealData.people ?? revealData.contacts ?? [];

  // Save full contact data to cache so we never pay for these people again
  const revealedById: Record<string, any> = {};
  for (const p of revealed) { if (p.id) revealedById[p.id] = p; }

  const cacheRecords = revealDetails.map((t: any) => {
    const p = revealedById[t.id];
    return {
      apollo_person_id: t.id,
      name:             p ? [p.first_name, p.last_name].filter(Boolean).join(" ") : "",
      title:            p?.title || p?.headline || "",
      email:            p?.email || p?.personal_email || "",
      linkedin_url:     p?.linkedin_url || "",
      phone:            null,
      status:           "pending",
    };
  }).filter((r: any) => r.name);

  saveToCache(cacheRecords); // fire-and-forget

  return revealed.map((p: any) => ({
    apollo_person_id: p.id || "",
    name:             [p.first_name, p.last_name].filter(Boolean).join(" "),
    title:            p.title || p.headline || "",
    email:            p.email || p.personal_email || "",
    phone:            "",
    linkedin_url:     p.linkedin_url || "",
    source:           "Apollo",
  })).filter((c: any) => c.name);
}

// ── Main handler ──────────────────────────────────────────────────────────────
serve(async (req) => {
  const origin = req.headers.get("origin");
  const cors   = corsHeaders(origin);

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const secret = req.headers.get("x-app-secret");
  if (!secret || secret !== APP_SECRET) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  try {
    const { company_name, domain, reveal_ids } = await req.json();
    if (!company_name?.trim()) {
      return new Response(JSON.stringify({ error: "company_name required" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // ── Phase 2: explicit reveal — user confirmed credit spend ────────────────
    if (reveal_ids?.length) {
      console.log(`Phase 2: revealing ${reveal_ids.length} people for ${company_name}`);
      const newContacts = await apolloReveal(reveal_ids, company_name, domain);
      return new Response(
        JSON.stringify({ contacts: newContacts, hs_count: 0, apollo_count: newContacts.length, pending_reveal: [] }),
        { headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ── Phase 1: free search + cache + HubSpot ────────────────────────────────
    const [hubspotResult, apolloResult] = await Promise.allSettled([
      findHubSpotContacts(company_name),
      apolloSearchAndCache(company_name, domain),
    ]);

    const hs             = hubspotResult.status === "fulfilled" ? hubspotResult.value : [];
    const apolloData     = apolloResult.status  === "fulfilled" ? apolloResult.value  : { cached: [], pending_reveal: [] };
    const cachedApollo   = apolloData.cached;
    const pending_reveal = apolloData.pending_reveal;

    // Deduplicate: prefer HubSpot records
    const hsEmails = new Set(hs.map((c: any) => c.email?.toLowerCase()).filter(Boolean));
    const merged = [
      ...hs,
      ...cachedApollo.filter((c: any) => !c.email || !hsEmails.has(c.email.toLowerCase())),
    ];

    return new Response(
      JSON.stringify({
        contacts:       merged,
        hs_count:       hs.length,
        apollo_count:   cachedApollo.length,
        pending_reveal,                        // stubs for the credit warning UI
      }),
      { headers: { ...cors, "Content-Type": "application/json" } }
    );

  } catch (err: any) {
    console.error("contact-search error:", err.message);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }
});
