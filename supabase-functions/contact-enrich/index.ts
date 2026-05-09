// contact-enrich — On-demand contact enrichment for IB Scout
//
// Three actions, two sources, transparent credit cost:
//
//   action:"search"  → HubSpot (free) + Apollo people search (names/titles only, free)
//   action:"reveal"  → Apollo people/match for selected IDs (1 credit per person)
//   action:"save"    → Persist contacts to Supabase contacts table
//
// Credits are ONLY spent when the user explicitly triggers "reveal" for chosen people.
// Search never costs Apollo credits.
//
// Deploy: supabase functions deploy contact-enrich
// Secrets needed: APOLLO_API_KEY, HUBSPOT_TOKEN, APP_SECRET

const APOLLO_KEY  = Deno.env.get("APOLLO_API_KEY")!;
const HS_TOKEN    = Deno.env.get("HUBSPOT_TOKEN")!;
const APP_SECRET  = Deno.env.get("APP_SECRET")!;
const SB_URL      = Deno.env.get("SUPABASE_URL")!;
const SB_SRK      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ALLOWED_ORIGIN = "https://fourthutility.github.io";

// CRE decision-maker titles Apollo will filter by
const CRE_TITLES = [
  "Asset Manager",
  "Managing Member",
  "Managing Director",
  "Managing Principal",
  "Principal",
  "President",
  "Chief Operating Officer",
  "VP Property Management",
  "Vice President Property Management",
  "Director of Property Management",
  "Property Manager",
  "General Manager",
  "Chief Engineer",
  "Director of Engineering",
  "Facilities Manager",
];

function corsHeaders(origin: string | null) {
  const allowed = origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;
  return {
    "Access-Control-Allow-Origin":  allowed,
    "Access-Control-Allow-Headers": "content-type, x-app-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

// ─── HubSpot: search contacts by company name ────────────────────────────────

async function searchHubspot(companyName: string): Promise<ContactResult[]> {
  if (!HS_TOKEN || !companyName) return [];
  try {
    // Search companies first
    const compRes = await fetch("https://api.hubapi.com/crm/v3/objects/companies/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${HS_TOKEN}` },
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "name", operator: "CONTAINS_TOKEN", value: companyName }] }],
        properties: ["name", "domain"],
        limit: 5,
      }),
    });
    if (!compRes.ok) return [];
    const compData = await compRes.json();
    const companies = compData.results || [];
    if (!companies.length) return [];

    // Get contacts associated with first matching company
    const companyId = companies[0].id;
    const assocRes = await fetch(
      `https://api.hubapi.com/crm/v3/objects/companies/${companyId}/associations/contacts?limit=10`,
      { headers: { "Authorization": `Bearer ${HS_TOKEN}` } }
    );
    if (!assocRes.ok) return [];
    const assocData = await assocRes.json();
    const contactIds = (assocData.results || []).map((r: { id: string }) => r.id).slice(0, 8);
    if (!contactIds.length) return [];

    // Batch fetch contact details
    const batchRes = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/batch/read", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${HS_TOKEN}` },
      body: JSON.stringify({
        inputs: contactIds.map((id: string) => ({ id })),
        properties: ["firstname", "lastname", "jobtitle", "email", "phone", "hs_linkedin_bio"],
      }),
    });
    if (!batchRes.ok) return [];
    const batchData = await batchRes.json();

    return (batchData.results || []).map((c: Record<string, { properties: Record<string, string> }>) => {
      const p = (c as unknown as { properties: Record<string, string> }).properties || {};
      return {
        source: "HubSpot" as const,
        name: [p.firstname, p.lastname].filter(Boolean).join(" ") || "Unknown",
        title: p.jobtitle || null,
        company: companyName,
        email: p.email || null,
        phone: p.phone || null,
        linkedin_url: null,
        apollo_id: null,
        revealed: true, // HubSpot contacts already have contact info
      };
    }).filter((c: ContactResult) => c.name !== "Unknown");
  } catch (e) {
    console.warn("HubSpot search error:", (e as Error).message);
    return [];
  }
}

// ─── Apollo: people search (names + titles, NO credit cost) ──────────────────

interface ApolloPersonRaw {
  id?: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  title?: string;
  organization_name?: string;
  linkedin_url?: string;
  email?: string;
  phone_numbers?: Array<{ raw_number?: string }>;
}

async function searchApollo(companyName: string): Promise<ContactResult[]> {
  if (!APOLLO_KEY || !companyName) return [];
  try {
    const res = await fetch("https://api.apollo.io/api/v1/mixed_people/api_search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": APOLLO_KEY,
      },
      body: JSON.stringify({
        organization_names: [companyName],
        person_titles: CRE_TITLES,
        page: 1,
        per_page: 10,
      }),
    });
    if (!res.ok) {
      console.warn(`Apollo search ${res.status}:`, await res.text().catch(() => ""));
      return [];
    }
    const data = await res.json();
    const people: ApolloPersonRaw[] = data.people || [];

    return people.map((p) => ({
      source: "Apollo" as const,
      apollo_id: p.id || null,
      name: p.name || [p.first_name, p.last_name].filter(Boolean).join(" ") || "Unknown",
      title: p.title || null,
      company: p.organization_name || companyName,
      email: null,    // not revealed yet — costs credits
      phone: null,    // not revealed yet
      linkedin_url: p.linkedin_url || null,
      revealed: false,
    }));
  } catch (e) {
    console.warn("Apollo search error:", (e as Error).message);
    return [];
  }
}

// ─── Apollo: reveal contact info for selected people (1 credit each) ─────────

async function revealApolloContact(apolloId: string, name: string, company: string): Promise<Partial<ContactResult>> {
  const [firstName, ...rest] = name.split(" ");
  const lastName = rest.join(" ");
  try {
    const res = await fetch("https://api.apollo.io/api/v1/people/match", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": APOLLO_KEY,
      },
      body: JSON.stringify({
        id: apolloId,
        first_name: firstName,
        // Omit last_name when empty — sending "" causes Apollo to return 400
        ...(lastName ? { last_name: lastName } : {}),
        organization_name: company,
        reveal_personal_emails: false,  // work emails only — cheaper
        reveal_phone_number: true,
      }),
    });
    if (!res.ok) {
      console.warn(`Apollo reveal failed: ${res.status} for "${name}"`);
      return {};
    }
    const data = await res.json();
    const p = data.person || {};

    // Log enough to diagnose "why no contact info" without dumping the whole object
    console.log(`Apollo reveal "${name}": matched=${!!p.id} email=${p.email||'—'} phones=${(p.phone_numbers||[]).length} linkedin=${p.linkedin_url?'yes':'—'} twitter=${p.twitter_url?'yes':'—'} city=${p.city||'—'} email_status=${p.email_status||'—'}`);

    return {
      email: p.email || null,
      phone: p.phone_numbers?.[0]?.raw_number || null,
      linkedin_url: p.linkedin_url || null,
      twitter_url: p.twitter_url || null,
      revealed: true,
    };
  } catch (e) {
    console.warn("Apollo reveal error:", (e as Error).message);
    return {};
  }
}

// ─── Supabase: save contacts to contacts table ────────────────────────────────

async function saveContacts(projectId: string, contacts: ContactResult[]): Promise<void> {
  if (!contacts.length) return;
  const rows = contacts.map(c => ({
    project_id: projectId,
    name: c.name,
    title: c.title,
    email: c.email,
    phone: c.phone,
    linkedin_url: c.linkedin_url,
    source: c.source,
  }));
  try {
    await fetch(`${SB_URL}/rest/v1/contacts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SB_SRK,
        "Authorization": `Bearer ${SB_SRK}`,
        "Prefer": "resolution=merge-duplicates",
      },
      body: JSON.stringify(rows),
    });
  } catch (e) {
    console.warn("Save contacts error:", (e as Error).message);
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface ContactResult {
  source: "HubSpot" | "Apollo";
  apollo_id: string | null;
  name: string;
  title: string | null;
  company: string;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
  twitter_url?: string | null;
  revealed: boolean;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);

  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  // Auth
  const secret = req.headers.get("x-app-secret");
  if (secret !== APP_SECRET) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: cors });
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: cors });
  }

  const action     = String(body.action || "search");
  const projectId  = String(body.project_id || "");
  const companyName = String(body.company_name || "");

  // ── action: search — HubSpot + Apollo names/titles (FREE) ──────────────────
  if (action === "search") {
    const [hubspotContacts, apolloContacts] = await Promise.all([
      searchHubspot(companyName),
      searchApollo(companyName),
    ]);

    // Deduplicate: remove Apollo entries whose name matches a HubSpot contact
    const hsNames = new Set(hubspotContacts.map(c => c.name.toLowerCase()));
    const apolloDeduped = apolloContacts.filter(c => !hsNames.has(c.name.toLowerCase()));

    // Auto-save HubSpot contacts (they already have full info) —
    // but only if none have been saved yet for this project.
    // Prevents duplicates when the user runs search multiple times.
    if (projectId && hubspotContacts.length) {
      const existingRes = await fetch(
        `${SB_URL}/rest/v1/contacts?project_id=eq.${projectId}&source=eq.HubSpot&select=id&limit=1`,
        { headers: { "apikey": SB_SRK, "Authorization": `Bearer ${SB_SRK}` } }
      ).catch(() => null);
      const existing = existingRes?.ok ? await existingRes.json().catch(() => []) : [];
      if (!existing.length) {
        await saveContacts(projectId, hubspotContacts);
      }
    }

    return new Response(JSON.stringify({
      hubspot: hubspotContacts,
      apollo: apolloDeduped,
      credits_used: 0,
    }), { headers: { ...cors, "Content-Type": "application/json" } });
  }

  // ── action: reveal — Apollo people/match for selected IDs (1 credit each) ──
  if (action === "reveal") {
    const selections = (body.selections as Array<{ apollo_id: string; name: string; company: string }>) || [];
    if (!selections.length) {
      return new Response(JSON.stringify({ error: "No selections provided" }), { status: 400, headers: cors });
    }

    const revealed: ContactResult[] = [];
    for (const sel of selections.slice(0, 10)) { // hard cap at 10
      const extra = await revealApolloContact(sel.apollo_id, sel.name, sel.company);
      revealed.push({
        source: "Apollo",
        apollo_id: sel.apollo_id,
        name: sel.name,
        title: (body.titles as Record<string, string>)?.[sel.apollo_id] || null,
        company: sel.company,
        email: null,
        phone: null,
        linkedin_url: null,
        revealed: true,
        ...extra,
      });
    }

    // Only persist contacts where Apollo actually returned something useful.
    // If all three fields are null the reveal matched nothing — don't pollute
    // the contacts table with empty rows (credit was still charged by Apollo).
    const usefulReveals = revealed.filter(c => c.email || c.phone || c.linkedin_url);
    if (projectId && usefulReveals.length) await saveContacts(projectId, usefulReveals);

    const emptyCount = revealed.length - usefulReveals.length;

    return new Response(JSON.stringify({
      revealed,
      credits_used: revealed.length,
      empty_reveals: emptyCount, // contacts that cost a credit but returned nothing
    }), { headers: { ...cors, "Content-Type": "application/json" } });
  }

  return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), { status: 400, headers: cors });
});
