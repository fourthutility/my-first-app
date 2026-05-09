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
const ALLOWED_ORIGINS = [
  "https://scout.intelligentbuildings.com",
  "https://ibscout.netlify.app",
  "https://fourthutility.github.io",
];

function corsHeaders(origin: string | null) {
  const isAllowed = origin && (
    ALLOWED_ORIGINS.includes(origin) ||
    /^https:\/\/deploy-preview-\d+--ibscout\.netlify\.app$/.test(origin)
  );
  const allowed = isAllowed ? origin! : ALLOWED_ORIGINS[0];
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

// HubSpot portal ID — needed for deep-link URLs to contact records
// GET /account-info/v3/details returns { portalId, ... }
async function getHubSpotPortalId(): Promise<string | null> {
  try {
    const data = await hsGet("/account-info/v3/details");
    return String(data.portalId || "") || null;
  } catch {
    return null;
  }
}

// ── HubSpot person search (by name) — for contractor individual lookups ────────
async function findHubSpotContactsByPersonName(name: string) {
  const parts = name.trim().split(/\s+/);
  const firstName = parts[0] || "";
  const lastName  = parts.slice(1).join(" ") || "";
  const filters: object[] = [{ propertyName: "firstname", operator: "CONTAINS_TOKEN", value: firstName + "*" }];
  if (lastName) filters.push({ propertyName: "lastname", operator: "CONTAINS_TOKEN", value: lastName + "*" });
  const search = await hsPost("/crm/v3/objects/contacts/search", {
    filterGroups: [{ filters }],
    limit: 10,
    properties: ["firstname", "lastname", "jobtitle", "email", "phone", "mobilephone", "hs_object_id", "hs_linkedin_url", "company"],
  });
  return (search.results ?? []).map((c: any) => ({
    name:               [c.properties.firstname, c.properties.lastname].filter(Boolean).join(" "),
    title:              c.properties.jobtitle || "",
    email:              c.properties.email || "",
    phone:              c.properties.mobilephone || c.properties.phone || "",
    linkedin_url:       c.properties.hs_linkedin_url || "",
    hubspot_contact_id: c.id,
    company:            c.properties.company || "",
    source:             "HubSpot",
  })).filter((c: any) => c.name);
}

// ── Apollo person search (by name) — returns people + their employer ───────────
async function apolloSearchByPersonName(personName: string) {
  const apolloHeaders = { "Content-Type": "application/json", "Cache-Control": "no-cache", "X-Api-Key": APOLLO_KEY };
  try {
    const res = await fetch(`${APOLLO_BASE}/mixed_people/api_search`, {
      method: "POST", headers: apolloHeaders,
      body: JSON.stringify({ q_person_name: personName, page: 1, per_page: 10 }),
    });
    if (!res.ok) return { cached: [], pending_reveal: [], apollo_total: 0 };
    const data = await res.json();
    const people: any[] = data.people ?? [];
    console.log(`Apollo person search "${personName}": ${people.length} results`);

    const ids = people.map((p: any) => p.id).filter(Boolean);
    const cacheHits = ids.length ? await getCachedContacts(ids) : {};

    const cached: any[] = [];
    const pending_reveal: any[] = [];
    for (const p of people) {
      if (cacheHits[p.id]) {
        const hit = cacheHits[p.id];
        cached.push({ apollo_person_id: p.id, name: hit.name || [p.first_name, p.last_name].filter(Boolean).join(" "), title: hit.title || p.title || "", email: hit.email || "", phone: hit.phone || "", linkedin_url: hit.linkedin_url || "", company: p.organization_name || "", source: "Apollo" });
      } else {
        pending_reveal.push({ id: p.id, first_name: p.first_name || "", title: p.title || "", organization_name: p.organization_name || "" });
      }
    }
    return { cached, pending_reveal, apollo_total: data.total_entries ?? people.length };
  } catch (e: any) { console.warn("Apollo person search error:", e.message); return { cached: [], pending_reveal: [], apollo_total: 0 }; }
}

// ── HubSpot company typeahead ─────────────────────────────────────────────────
async function searchHubSpotCompanies(query: string) {
  const search = await hsPost("/crm/v3/objects/companies/search", {
    filterGroups: [{
      filters: [{ propertyName: "name", operator: "CONTAINS_TOKEN", value: query + "*" }],
    }],
    limit: 7,
    properties: ["name", "domain", "city", "state"],
    sorts: [{ propertyName: "name", direction: "ASCENDING" }],
  });
  return (search.results ?? []).map((c: any) => ({
    id:     c.id,
    name:   c.properties.name   || "",
    domain: c.properties.domain || "",
    city:   c.properties.city   || "",
    state:  c.properties.state  || "",
  })).filter((c: any) => c.name);
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

  // ── Paginate through ALL contact associations (500 per page max) ────────────
  const allContactIds: string[] = [];
  let after: string | undefined;
  do {
    const url = `/crm/v3/objects/companies/${company.id}/associations/contacts?limit=500` +
                (after ? `&after=${encodeURIComponent(after)}` : "");
    const assoc = await hsGet(url);
    for (const r of (assoc.results ?? [])) allContactIds.push(r.id);
    after = assoc.paging?.next?.after;
  } while (after);

  if (!allContactIds.length) return [];
  console.log(`HubSpot: found ${allContactIds.length} contacts for "${companyName}"`);

  // ── Batch-read in chunks of 100 (HubSpot limit per batch/read call) ─────────
  const CHUNK = 100;
  const allContacts: any[] = [];
  for (let i = 0; i < allContactIds.length; i += CHUNK) {
    const chunk = allContactIds.slice(i, i + CHUNK);
    const batch = await hsPost("/crm/v3/objects/contacts/batch/read", {
      inputs:     chunk.map((id: string) => ({ id })),
      properties: ["firstname", "lastname", "jobtitle", "email", "phone", "mobilephone", "hs_object_id", "hs_linkedin_url", "linkedin_url", "linkedinbio"],
    });
    allContacts.push(...(batch.results ?? []));
  }

  return allContacts.map((c: any) => ({
    name:               [c.properties.firstname, c.properties.lastname].filter(Boolean).join(" "),
    title:              c.properties.jobtitle || "",
    email:              c.properties.email || "",
    phone:              c.properties.mobilephone || c.properties.phone || "",
    linkedin_url:       c.properties.hs_linkedin_url || c.properties.linkedin_url || c.properties.linkedinbio || "",
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

  // ── Step 1: Resolve Apollo organization ID ───────────────────────────────────
  // q_organization_name people search is unreliable for private/small firms.
  // Finding the org ID first and using organization_ids is far more precise.
  let orgId: string | null = null;

  try {
    if (domain) {
      // Domain enrichment is free and highly reliable
      const enrichRes = await fetch(`${APOLLO_BASE}/organizations/enrich?domain=${encodeURIComponent(domain)}`, {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-cache", "X-Api-Key": APOLLO_KEY },
      });
      if (enrichRes.ok) {
        const enrichData = await enrichRes.json();
        orgId = enrichData.organization?.id ?? null;
        console.log(`Org enrich by domain "${domain}": id=${orgId ?? "not found"}`);
      }
    }

    if (!orgId) {
      // Fall back to company name org search
      const orgRes = await fetch(`${APOLLO_BASE}/mixed_companies/api_search`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Cache-Control": "no-cache", "X-Api-Key": APOLLO_KEY },
        body: JSON.stringify({ q_organization_name: companyName, page: 1, per_page: 5 }),
      });
      if (orgRes.ok) {
        const orgData = await orgRes.json();
        const orgs: any[] = orgData.organizations ?? orgData.accounts ?? [];
        if (orgs.length) {
          orgId = orgs[0].id;
          console.log(`Org search by name "${companyName}": found ${orgs.length} orgs, using id=${orgId}`);
        } else {
          console.log(`Org search by name "${companyName}": no orgs found`);
        }
      }
    }
  } catch (e: any) {
    console.warn("Org lookup failed:", e.message);
  }

  // ── Step 2: Search people using the most precise signal available ─────────
  async function peopleFetch(body: object) {
    const res = await fetch(`${APOLLO_BASE}/mixed_people/api_search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cache-Control": "no-cache", "X-Api-Key": APOLLO_KEY },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    console.log(`People search body: ${JSON.stringify(body)}`);
    console.log(`People search status: ${res.status} — result (first 400): ${raw.slice(0, 400)}`);
    if (!res.ok) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  let searchData: any = null;

  if (orgId) {
    // Best: exact org ID match
    searchData = await peopleFetch({ organization_ids: [orgId], page: 1, per_page: 25 });
  }

  if (!searchData || !(searchData.people ?? searchData.contacts ?? []).length) {
    // Fallback: domain-based people search
    if (domain) {
      searchData = await peopleFetch({ q_organization_domains: [domain], page: 1, per_page: 25 });
    }
  }

  if (!searchData || !(searchData.people ?? searchData.contacts ?? []).length) {
    // Last resort: name-based people search
    searchData = await peopleFetch({ q_organization_name: companyName, page: 1, per_page: 25 });
  }

  if (!searchData) return { cached: [], pending_reveal: [] };

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
  // has_direct_phone is passed through so the UI can gate the 8-credit phone reveal
  const pending_reveal = teasers
    .filter((p: any) => !cachedById[p.id])
    .map((p: any) => ({
      id:                p.id,
      first_name:        p.first_name,
      title:             p.title || "",
      organization_name: companyName,
      has_direct_phone:  p.has_direct_phone === "Yes",  // true only when Apollo has confirmed a number
      ...(domain ? { domain } : {}),
    }));

  return { cached, pending_reveal, apollo_total: searchData.total_entries ?? teasers.length };
}

// ── Apollo Phase 2 — email-only reveal (1 credit/person, no phone) ───────────
// Only called when user explicitly confirms credit spend.
// Phone is NOT revealed here — users click "Reveal Phone" per-contact (Phase 3).
// reveal_details = array of {id, first_name, organization_name, domain?}
// Batches into chunks of 8 to avoid Apollo API timeouts on large lists.
async function apolloReveal(revealDetails: any[], companyName: string, domain?: string) {
  if (!revealDetails.length) return [];

  const apolloHeaders = {
    "Content-Type":  "application/json",
    "Cache-Control": "no-cache",
    "X-Api-Key":     APOLLO_KEY,
  };

  const CHUNK_SIZE = 8;
  const allRevealed: any[] = [];

  for (let i = 0; i < revealDetails.length; i += CHUNK_SIZE) {
    const chunk = revealDetails.slice(i, i + CHUNK_SIZE);
    console.log(`Phase 2: revealing chunk ${Math.floor(i/CHUNK_SIZE)+1}/${Math.ceil(revealDetails.length/CHUNK_SIZE)} — ${chunk.length} people (email only, 1 credit each)`);

    const revealRes = await fetch(`${APOLLO_BASE}/people/bulk_match`, {
      method:  "POST",
      headers: apolloHeaders,
      body:    JSON.stringify({
        reveal_personal_emails: true,
        reveal_phone_number:    false,   // Phone is opt-in per contact (Phase 3, 8 credits each)
        details:                chunk,
      }),
    });

    const rawReveal = await revealRes.text();
    console.log(`Apollo reveal status (chunk ${Math.floor(i/CHUNK_SIZE)+1}): ${revealRes.status}`);
    console.log(`Apollo reveal (first 400): ${rawReveal.slice(0, 400)}`);

    if (!revealRes.ok) {
      console.error(`Apollo bulk_match failed on chunk ${Math.floor(i/CHUNK_SIZE)+1}:`, revealRes.status);
      continue; // skip failed chunk, keep going with the rest
    }

    let revealData: any;
    try { revealData = JSON.parse(rawReveal); } catch { continue; }

    const revealed: any[] = revealData.matches ?? revealData.people ?? revealData.contacts ?? [];

    // Save this chunk to cache so we never pay for these people again
    const revealedById: Record<string, any> = {};
    for (const p of revealed) { if (p.id) revealedById[p.id] = p; }

    const cacheRecords = chunk.map((t: any) => {
      const p = revealedById[t.id];
      return {
        apollo_person_id: t.id,
        name:             p ? [p.first_name, p.last_name].filter(Boolean).join(" ") : "",
        title:            p?.title || p?.headline || "",
        email:            p?.email || p?.personal_email || "",
        linkedin_url:     p?.linkedin_url || "",
        phone:            null,
        status:           "revealed",  // email/LinkedIn revealed; phone not yet requested
      };
    }).filter((r: any) => r.name);

    saveToCache(cacheRecords); // fire-and-forget

    allRevealed.push(...revealed);
  }

  return allRevealed.map((p: any) => ({
    apollo_person_id: p.id || "",
    name:             [p.first_name, p.last_name].filter(Boolean).join(" "),
    title:            p.title || p.headline || "",
    email:            p.email || p.personal_email || "",
    phone:            "",
    linkedin_url:     p.linkedin_url || "",
    source:           "Apollo",
  })).filter((c: any) => c.name);
}

// ── Supabase contacts table: persist revealed contacts to a project ───────────
async function saveToContactsTable(projectId: string, contacts: any[]): Promise<void> {
  if (!projectId || !contacts.length) return;
  // Only save contacts that have at least one useful field
  const useful = contacts.filter(c => c.email || c.phone || c.linkedin_url);
  if (!useful.length) return;

  const rows = useful.map(c => ({
    project_id:   projectId,
    name:         c.name         || null,
    title:        c.title        || null,
    email:        c.email        || null,
    phone:        c.phone        || null,
    linkedin_url: c.linkedin_url || null,
    source:       "Apollo",
  }));

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/contacts`, {
      method:  "POST",
      headers: {
        "apikey":        SERVICE_KEY,
        "Authorization": `Bearer ${SERVICE_KEY}`,
        "Content-Type":  "application/json",
        "Prefer":        "return=minimal",
      },
      body: JSON.stringify(rows),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error("contacts table save failed:", res.status, err.slice(0, 200));
    } else {
      console.log(`Saved ${rows.length} revealed contacts to project ${projectId}`);
    }
  } catch (e: any) {
    console.warn("saveToContactsTable error:", e.message);
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────
serve(async (req) => {
  const origin = req.headers.get("origin");
  const cors   = corsHeaders(origin);

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const reqUrl = new URL(req.url);

  // ── Apollo phone webhook receiver (bypasses x-app-secret, uses URL secret) ──
  // Apollo POSTs here asynchronously after a phone reveal completes.
  if (reqUrl.searchParams.get("action") === "apollo_phone_webhook") {
    const webhookSecret = reqUrl.searchParams.get("secret");
    if (webhookSecret !== APP_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }
    try {
      const rawBody = await req.text();
      console.log(`Webhook raw payload (first 800): ${rawBody.slice(0, 800)}`);
      let webhookBody: any;
      try { webhookBody = JSON.parse(rawBody); } catch { webhookBody = {}; }
      const person    = webhookBody.person ?? webhookBody.people?.[0] ?? webhookBody;
      const personId  = reqUrl.searchParams.get("person_id") || person?.id || "";
      // Try every known Apollo phone field location
      const phone =
        person?.phone ||
        person?.mobile_phone ||
        person?.sanitized_phone ||
        (person?.phone_numbers ?? []).find((p: any) => p.sanitized_number)?.sanitized_number ||
        (person?.phone_numbers ?? []).find((p: any) => p.raw_number)?.raw_number ||
        "";
      console.log(`Webhook: person=${personId} phone=${phone || "(none)"} keys=${Object.keys(person || {}).join(",")}`);
      if (personId) {
        // If phone found → mark as found.
        // If no phone → leave as pending. Apollo fires this webhook immediately as an ack,
        // then fires AGAIN (up to 48h later) when it actually finds the number.
        // Writing no_phone here would permanently mark it as unfound and miss the delayed callback.
        if (phone) {
          await saveToCache([{
            apollo_person_id: personId,
            name:         [person?.first_name, person?.last_name].filter(Boolean).join(" ") || "",
            title:        person?.title || "",
            email:        person?.email || "",
            phone,
            linkedin_url: person?.linkedin_url || "",
            status:       "found",
          }]);
          console.log(`Webhook: cached phone ${phone} for person ${personId}`);
        } else {
          console.log(`Webhook: no phone yet for ${personId} — leaving as pending for delayed callback`);
        }
      }
    } catch (e: any) {
      console.error("Webhook parse error:", e.message);
    }
    return new Response("ok", { status: 200 });
  }

  const secret = req.headers.get("x-app-secret");
  if (!secret || secret !== APP_SECRET) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json();
    const { company_name, domain, reveal_ids, action, query, project_id } = body;

    // ── Phase 3: phone reveal via people/match (8 credits) ──────────────────────
    // Apollo requires a webhook_url for phone reveals.
    // people/match sometimes returns the phone directly in the response if already
    // cached by Apollo — we check that first. If not, we queue async + poll cache.
    if (action === "reveal_phone") {
      const { person_id, first_name, last_name, email, organization_name } = body;

      if (!person_id && !first_name && !email) {
        return new Response(JSON.stringify({ error: "person_id, first_name, or email required" }), {
          status: 400, headers: { ...cors, "Content-Type": "application/json" },
        });
      }

      const apolloHeaders = {
        "Content-Type":  "application/json",
        "Cache-Control": "no-cache",
        "X-Api-Key":     APOLLO_KEY,
      };

      console.log(`Phase 3: phone reveal for ${first_name} ${last_name || ""} (known_id: ${person_id || "none"})`);

      // ── Step 1: Free match to resolve the Apollo person ID ───────────────────
      // We MUST know the real Apollo ID before building the webhook URL,
      // otherwise Apollo fires the callback with the wrong ID and the cache update fails.
      let resolvedId = person_id || "";
      let resolvedPerson: any = null;

      if (!resolvedId) {
        try {
          const freeRes = await fetch(`${APOLLO_BASE}/people/match`, {
            method:  "POST",
            headers: apolloHeaders,
            body: JSON.stringify({
              first_name, last_name, email, organization_name,
              reveal_phone_number:    false,
              reveal_personal_emails: false,
            }),
          });
          if (freeRes.ok) {
            const freeData = await freeRes.json();
            resolvedPerson = freeData.person;
            resolvedId     = resolvedPerson?.id || "";
            console.log(`Phase 3 free match: resolved_id=${resolvedId || "not found"}`);
          }
        } catch (e: any) {
          console.warn("Phase 3 free match failed:", e.message);
        }
      }

      if (!resolvedId) {
        console.log(`Phase 3: cannot resolve Apollo ID for ${first_name} — aborting reveal`);
        return new Response(JSON.stringify({ queued: false, phone: null, apollo_person_id: "" }), {
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }

      // ── Step 2: Seed cache with pending so poll exits cleanly on timeout ─────
      await saveToCache([{
        apollo_person_id: resolvedId,
        name:  resolvedPerson ? [resolvedPerson.first_name, resolvedPerson.last_name].filter(Boolean).join(" ") : [first_name, last_name].filter(Boolean).join(" "),
        title: resolvedPerson?.title || "",
        email: resolvedPerson?.email || email || "",
        linkedin_url: resolvedPerson?.linkedin_url || "",
        phone: null,
        status: "pending",
      }]);

      // ── Step 3: Paid reveal — webhook URL now has the correct Apollo ID ───────
      const webhookUrl = `${SUPABASE_URL}/functions/v1/contact-search?action=apollo_phone_webhook&secret=${encodeURIComponent(APP_SECRET)}&person_id=${encodeURIComponent(resolvedId)}`;
      console.log(`Phase 3: paid reveal for id=${resolvedId} — 8 credits`);
      console.log(`Phase 3: webhook_url = ${webhookUrl.slice(0, 100)}...`);

      const revealPayload: Record<string, any> = {
        id:                     resolvedId,
        first_name,
        reveal_phone_number:    true,
        reveal_personal_emails: false,
        webhook_url:            webhookUrl,
      };
      if (last_name)         revealPayload.last_name         = last_name;
      if (email)             revealPayload.email             = email;
      if (organization_name) revealPayload.organization_name = organization_name;

      const revealRes = await fetch(`${APOLLO_BASE}/people/match`, {
        method:  "POST",
        headers: apolloHeaders,
        body:    JSON.stringify(revealPayload),
      });

      const rawReveal = await revealRes.text();
      console.log(`Phase 3 paid reveal status: ${revealRes.status}`);
      console.log(`Phase 3 paid reveal response (first 400): ${rawReveal.slice(0, 400)}`);

      if (!revealRes.ok) {
        console.error("Phase 3 paid reveal failed:", revealRes.status);
        return new Response(JSON.stringify({ queued: false, phone: null, apollo_person_id: resolvedId }), {
          status: 502, headers: { ...cors, "Content-Type": "application/json" },
        });
      }

      // Check if phone came back synchronously (Apollo sometimes returns it immediately)
      let revealData: any;
      try { revealData = JSON.parse(rawReveal); } catch { revealData = {}; }

      const revealedPerson = revealData.person ?? revealData;
      const phone: string | null =
        revealedPerson?.phone_numbers?.find((p: any) => p.type === "work_direct")?.sanitized_number
        || revealedPerson?.phone_numbers?.find((p: any) => p.type === "mobile")?.sanitized_number
        || revealedPerson?.phone_numbers?.[0]?.sanitized_number
        || revealedPerson?.sanitized_phone
        || null;

      console.log(`Phase 3: phone_in_response=${phone ?? "none — waiting for webhook"}`);

      if (phone) {
        await saveToCache([{
          apollo_person_id: resolvedId,
          name:  [revealedPerson?.first_name, revealedPerson?.last_name].filter(Boolean).join(" ") || [first_name, last_name].filter(Boolean).join(" "),
          title: revealedPerson?.title || "",
          email: revealedPerson?.email || email || "",
          linkedin_url: revealedPerson?.linkedin_url || "",
          phone,
          status: "found",
        }]);
        return new Response(JSON.stringify({ phone, apollo_person_id: resolvedId }), {
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }

      // Phone not in response — queued async, frontend polls apollo_phone_cache
      return new Response(JSON.stringify({ queued: true, apollo_person_id: resolvedId }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // ── Sync missing contact data (LinkedIn + phone) from HubSpot ────────────
    if (action === "sync_linkedin") {
      const { hubspot_ids } = body;
      if (!Array.isArray(hubspot_ids) || !hubspot_ids.length) {
        return new Response(JSON.stringify({ contacts: {} }), {
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }
      const CHUNK = 100;
      const contactMap: Record<string, { linkedin_url?: string; phone?: string }> = {};
      for (let i = 0; i < hubspot_ids.length; i += CHUNK) {
        const chunk = hubspot_ids.slice(i, i + CHUNK);
        try {
          const batch = await hsPost("/crm/v3/objects/contacts/batch/read", {
            inputs:     chunk.map((id: string) => ({ id })),
            properties: ["hs_linkedin_url", "linkedin_url", "linkedinbio", "phone", "mobilephone"],
          });
          for (const c of (batch.results ?? [])) {
            const data: { linkedin_url?: string; phone?: string } = {};
            // Try all known LinkedIn property variants
            const linkedIn = c.properties?.hs_linkedin_url || c.properties?.linkedin_url || c.properties?.linkedinbio;
            if (linkedIn) data.linkedin_url = linkedIn;
            const phone = c.properties?.mobilephone || c.properties?.phone;
            if (phone) data.phone = phone;
            if (Object.keys(data).length) contactMap[c.id] = data;
          }
        } catch(e: any) { console.warn("sync_linkedin chunk failed:", e.message); }
      }
      return new Response(JSON.stringify({ contacts: contactMap }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // ── Company typeahead search ──────────────────────────────────────────────
    if (action === "company_search") {
      if (!query?.trim()) {
        return new Response(JSON.stringify({ companies: [] }), {
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }
      const companies = await searchHubSpotCompanies(query.trim());
      return new Response(JSON.stringify({ companies }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // ── Person search — contractor individual lookup ──────────────────────────
    // When person_name is provided instead of company_name, search by person name
    // across HubSpot contacts and Apollo people. Returns their company too.
    if (body.person_name?.trim() && !company_name?.trim()) {
      const personName = body.person_name.trim();
      console.log(`Person search: "${personName}"`);
      const [hsResult, apolloResult, portalIdResult] = await Promise.allSettled([
        findHubSpotContactsByPersonName(personName),
        apolloSearchByPersonName(personName),
        getHubSpotPortalId(),
      ]);
      const hs          = hsResult.status   === "fulfilled" ? hsResult.value   : [];
      const apolloData  = apolloResult.status === "fulfilled" ? apolloResult.value : { cached: [], pending_reveal: [], apollo_total: 0 };
      const hs_portal_id = portalIdResult.status === "fulfilled" ? portalIdResult.value : null;
      const hsEmails    = new Set(hs.map((c: any) => c.email?.toLowerCase()).filter(Boolean));
      const merged      = [...hs, ...apolloData.cached.filter((c: any) => !c.email || !hsEmails.has(c.email.toLowerCase()))];
      return new Response(JSON.stringify({ contacts: merged, hs_count: hs.length, apollo_count: apolloData.cached.length, apollo_total: apolloData.apollo_total, pending_reveal: apolloData.pending_reveal, hs_portal_id }), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    if (!company_name?.trim()) {
      return new Response(JSON.stringify({ error: "company_name required" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // ── Phase 2: explicit reveal — user confirmed credit spend ────────────────
    if (reveal_ids?.length) {
      console.log(`Phase 2: revealing ${reveal_ids.length} people for ${company_name}`);
      const newContacts = await apolloReveal(reveal_ids, company_name, domain);

      // Persist to contacts table if a project_id was provided (scout report flow)
      if (project_id) {
        saveToContactsTable(project_id, newContacts); // fire-and-forget
      }

      const emptyCount = reveal_ids.length - newContacts.filter(c => c.email || c.phone || c.linkedin_url).length;
      return new Response(
        JSON.stringify({
          contacts:      newContacts,
          hs_count:      0,
          apollo_count:  newContacts.length,
          pending_reveal: [],
          empty_reveals: emptyCount,  // contacts that cost a credit but returned nothing useful
        }),
        { headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ── Phase 1: free search + cache + HubSpot ────────────────────────────────
    const [hubspotResult, apolloResult, portalIdResult] = await Promise.allSettled([
      findHubSpotContacts(company_name),
      apolloSearchAndCache(company_name, domain),
      getHubSpotPortalId(),
    ]);

    const hs             = hubspotResult.status === "fulfilled" ? hubspotResult.value : [];
    const apolloData     = apolloResult.status  === "fulfilled" ? apolloResult.value  : { cached: [], pending_reveal: [], apollo_total: 0 };
    const hs_portal_id   = portalIdResult.status === "fulfilled" ? portalIdResult.value : null;
    const cachedApollo   = apolloData.cached;
    const pending_reveal = apolloData.pending_reveal;
    const apollo_total   = apolloData.apollo_total ?? 0;

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
        apollo_total,                          // total people Apollo knows about at this company
        pending_reveal,                        // stubs for the credit warning UI
        hs_portal_id,                          // HubSpot portal ID for deep-linking to contact records
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
