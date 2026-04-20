// IB-Scout — Contact Search Edge Function
// Deploy via: Supabase Dashboard → Edge Functions → New Function → name: "contact-search"
//
// Required secrets (Edge Functions → Secrets):
//   HUBSPOT_TOKEN  — HubSpot Private App access token
//   APOLLO_API_KEY — Apollo.io API key
//   APP_SECRET     — shared secret (x-app-secret header + Apollo webhook ?secret= param)
//   SB_URL         — https://lnldwxttyfjmaobluciy.supabase.co
//   SB_SERVICE_KEY — service_role key (Settings → API in Supabase dashboard)

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
  // 1. Find company by name
  const search = await hsPost("/crm/v3/objects/companies/search", {
    filterGroups: [{
      filters: [{ propertyName: "name", operator: "EQ", value: companyName }],
    }],
    limit: 1,
    properties: ["name", "hs_object_id"],
  });

  const company = search.results?.[0];
  if (!company) return [];

  // 2. Get contacts associated with that company
  const assoc = await hsGet(`/crm/v3/objects/companies/${company.id}/associations/contacts`);
  const contactIds = (assoc.results ?? []).map((r: any) => r.id).slice(0, 10);
  if (!contactIds.length) return [];

  // 3. Batch fetch contact details
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

// ── Supabase helper — write phone cache ───────────────────────────────────────
async function saveToPhoneCache(records: object[]) {
  if (!records.length) return;
  try {
    // NOTE: ?on_conflict=apollo_person_id is required so PostgREST knows which
    // unique column to merge on. Without it, resolution=merge-duplicates only
    // uses the primary key (id), causing a 409 on the apollo_person_id constraint.
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
      console.error("Phone cache upsert failed:", res.status, err.slice(0, 200));
    } else {
      console.log(`Phone cache: upserted ${records.length} records`);
    }
  } catch (e: any) {
    console.error("Phone cache error:", e.message);
  }
}

// ── Apollo helpers ────────────────────────────────────────────────────────────
async function findApolloContacts(companyName: string, domain?: string) {
  const apolloHeaders = {
    "Content-Type":  "application/json",
    "Cache-Control": "no-cache",
    "X-Api-Key":     APOLLO_KEY,
  };

  // ── Step 1: Search to get person IDs ─────────────────────────────────────
  const searchBody: any = {
    q_organization_name: companyName,
    page:                1,
    per_page:            10,
  };
  if (domain) searchBody.q_organization_domains = [domain];

  const searchRes = await fetch(`${APOLLO_BASE}/mixed_people/api_search`, {
    method:  "POST",
    headers: apolloHeaders,
    body:    JSON.stringify(searchBody),
  });

  const rawSearch = await searchRes.text();
  console.log(`Apollo search status: ${searchRes.status}`);
  console.log(`Apollo search (first 400): ${rawSearch.slice(0, 400)}`);

  if (!searchRes.ok) return [];

  let searchData: any;
  try { searchData = JSON.parse(rawSearch); } catch { return []; }

  const teasers: any[] = searchData.people ?? searchData.contacts ?? [];
  if (!teasers.length) return [];

  // ── Step 2: bulk_match — reveal emails (sync) + trigger phone (async→webhook)
  // Apollo returns emails in the HTTP response.
  // Phone numbers arrive separately via the webhook URL after async lookup.
  const webhookUrl = `${SUPABASE_URL}/functions/v1/apollo-phone-webhook?secret=${APP_SECRET}`;

  const details = teasers.map((p: any) => ({
    id:                p.id,
    first_name:        p.first_name,
    organization_name: companyName,
    ...(domain ? { domain } : {}),
  }));

  const revealRes = await fetch(`${APOLLO_BASE}/people/bulk_match`, {
    method:  "POST",
    headers: apolloHeaders,
    body:    JSON.stringify({
      reveal_personal_emails: true,
      reveal_phone_number:    true,
      webhook_url:            webhookUrl,
      details,
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

  // ── Step 3: Save to phone cache (status: pending, phone arrives via webhook)
  // Build a lookup of id → revealed person for matching
  const revealedById: Record<string, any> = {};
  for (const p of revealed) { if (p.id) revealedById[p.id] = p; }

  const cacheRecords = teasers.map((t: any) => ({
    apollo_person_id: t.id,
    email:            revealedById[t.id]?.email || "",
    phone:            null,
    status:           "pending",
  }));

  // Fire-and-forget: don't await so we don't delay the response
  saveToPhoneCache(cacheRecords);

  // ── Return contacts — phone will be empty until webhook fires ─────────────
  return revealed.map((p: any) => ({
    apollo_person_id: p.id || "",
    name:             [p.first_name, p.last_name].filter(Boolean).join(" "),
    title:            p.title || p.headline || "",
    email:            p.email || p.personal_email || "",
    phone:            "",  // populated async via webhook + phone poller in UI
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
    const { company_name, domain } = await req.json();
    if (!company_name?.trim()) {
      return new Response(JSON.stringify({ error: "company_name required" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const [hubspotContacts, apolloContacts] = await Promise.allSettled([
      findHubSpotContacts(company_name),
      findApolloContacts(company_name, domain),
    ]);

    const hs  = hubspotContacts.status === "fulfilled" ? hubspotContacts.value : [];
    const apo = apolloContacts.status  === "fulfilled" ? apolloContacts.value  : [];

    // Deduplicate: prefer HubSpot records, remove Apollo dupes by email
    const hsEmails = new Set(hs.map((c: any) => c.email?.toLowerCase()).filter(Boolean));
    const merged = [
      ...hs,
      ...apo.filter((c: any) => !c.email || !hsEmails.has(c.email.toLowerCase())),
    ];

    return new Response(
      JSON.stringify({ contacts: merged, hs_count: hs.length, apollo_count: apo.length }),
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
