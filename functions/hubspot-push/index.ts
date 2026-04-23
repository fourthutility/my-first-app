// IB-Scout — HubSpot Push Edge Function
// Deploy via: Supabase Dashboard → Edge Functions → New Function → name: "hubspot-push"
// Required secrets (Edge Functions → Secrets):
//   HUBSPOT_TOKEN  — HubSpot Private App access token
//   APP_SECRET     — shared secret sent by the tracker (x-app-secret header)
//                   current value: ib-scout-2026

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const HS_TOKEN     = Deno.env.get("HUBSPOT_TOKEN")!;
const APP_SECRET   = Deno.env.get("APP_SECRET")!;
const HS_BASE      = "https://api.hubapi.com";
const PORTAL_ID    = "8675191";
const PIPELINE_ID  = "default";
// Fallback stage label used when no hs_dealstage_label is provided in the payload
const FALLBACK_STAGE_LABEL = "Lead (Deal Created)";

// ── CORS — locked to the tracker's origin only ────────────────────────────────
const ALLOWED_ORIGIN = "https://fourthutility.github.io";

function corsHeaders(origin: string | null) {
  const allowed = origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;
  return {
    "Access-Control-Allow-Origin":  allowed,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-app-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

// ── HubSpot API helper ────────────────────────────────────────────────────────
async function hs(method: string, path: string, body?: object) {
  const res = await fetch(`${HS_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${HS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`HubSpot ${method} ${path} → ${res.status}: ${err}`);
  }
  return res.json();
}

// ── Main handler ──────────────────────────────────────────────────────────────
serve(async (req) => {
  const origin = req.headers.get("origin");
  const cors   = corsHeaders(origin);

  // Preflight
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // ── Security check 1: verify shared app secret ────────────────
  const incomingSecret = req.headers.get("x-app-secret");
  if (!incomingSecret || incomingSecret !== APP_SECRET) {
    console.warn("Rejected request — missing or invalid x-app-secret");
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  // ── Parse body ────────────────────────────────────────────────
  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  // ── Action: get_deal_stage — fetch current stage from HubSpot deal ──────
  if (body?.action === "get_deal_stage") {
    const { deal_id } = body;
    if (!deal_id) {
      return new Response(JSON.stringify({ error: "deal_id required" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const deal = await hs("GET", `/crm/v3/objects/deals/${deal_id}?properties=dealstage`);
    const stageId = deal.properties?.dealstage;
    const pipeline = await hs("GET", `/crm/v3/pipelines/deals/${PIPELINE_ID}`);
    const stage = (pipeline.stages ?? []).find((s: any) => s.id === stageId);
    return new Response(
      JSON.stringify({ stageId, stageLabel: stage?.label ?? null }),
      { headers: { ...cors, "Content-Type": "application/json" } }
    );
  }

  // ── Action: update_deal_stage — sync IB Stage change to HubSpot deal ────
  if (body?.action === "update_deal_stage") {
    const { deal_id, hs_dealstage_label } = body;
    if (!deal_id || !hs_dealstage_label) {
      return new Response(JSON.stringify({ error: "deal_id and hs_dealstage_label required" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    // Resolve the stage label to its HubSpot stage ID
    const pipeline = await hs("GET", `/crm/v3/pipelines/deals/${PIPELINE_ID}`);
    const allStages: any[] = pipeline.stages ?? [];
    let stage = allStages.find((s: any) => s.label === hs_dealstage_label);
    if (!stage) {
      const lower = hs_dealstage_label.toLowerCase();
      stage = allStages.find((s: any) => s.label.toLowerCase() === lower);
    }
    if (!stage) {
      return new Response(JSON.stringify({ error: `Stage "${hs_dealstage_label}" not found in pipeline` }), {
        status: 404, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    await hs("PATCH", `/crm/v3/objects/deals/${deal_id}`, {
      properties: { dealstage: stage.id },
    });
    console.log(`Updated deal ${deal_id} to stage "${stage.label}" (${stage.id})`);
    return new Response(
      JSON.stringify({ success: true, dealStage: stage.label }),
      { headers: { ...cors, "Content-Type": "application/json" } }
    );
  }

  // ── Action: update_contact_phones — backfill Apollo phones into HubSpot ──
  if (body?.action === "update_contact_phones") {
    const { contacts } = body;
    if (!Array.isArray(contacts) || !contacts.length) {
      return new Response(JSON.stringify({ error: "contacts array required" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const results = [];
    for (const c of contacts) {
      if (!c.hubspot_contact_id || !c.phone) continue;
      try {
        await hs("PATCH", `/crm/v3/objects/contacts/${c.hubspot_contact_id}`, {
          properties: { phone: c.phone },
        });
        results.push({ hubspot_contact_id: c.hubspot_contact_id, name: c.name, ok: true });
        console.log(`Backfilled phone for contact ${c.hubspot_contact_id} (${c.name}): ${c.phone}`);
      } catch (e: any) {
        console.warn(`Phone backfill failed for ${c.hubspot_contact_id}:`, e.message);
        results.push({ hubspot_contact_id: c.hubspot_contact_id, name: c.name, error: e.message });
      }
    }
    return new Response(JSON.stringify({ results, updated: results.filter(r => r.ok).length }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  // ── Action: push_contacts — create HubSpot contacts from Apollo ──
  if (body?.action === "push_contacts") {
    const { contacts, company_name } = body;
    if (!Array.isArray(contacts) || !contacts.length) {
      return new Response(JSON.stringify({ error: "contacts array required" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // Find HubSpot company ID (to associate contacts)
    let companyId: string | null = null;
    if (company_name) {
      const search = await hs("POST", "/crm/v3/objects/companies/search", {
        filterGroups: [{ filters: [{ propertyName: "name", operator: "EQ", value: company_name }] }],
        limit: 1, properties: ["name"],
      });
      companyId = search.results?.[0]?.id ?? null;
    }

    const results = [];
    for (const c of contacts) {
      try {
        const nameParts = (c.name || "").trim().split(" ");
        let contactId: string | null = null;

        try {
          const created = await hs("POST", "/crm/v3/objects/contacts", {
            properties: {
              firstname: nameParts[0] || c.name,
              lastname:  nameParts.slice(1).join(" ") || "",
              jobtitle:  c.title  || "",
              email:     c.email  || "",
              phone:     c.phone  || "",
            },
          });
          contactId = created.id;
          console.log(`Created contact ${c.name}: ${contactId}`);
        } catch(createErr: any) {
          // 409 = contact already exists — extract existing ID from error message
          const existingMatch = createErr.message?.match(/Existing ID:\s*(\d+)/i);
          if (existingMatch) {
            contactId = existingMatch[1];
            console.log(`Contact ${c.name} already exists in HubSpot (ID: ${contactId}) — using existing`);
          } else {
            throw createErr; // unexpected error, re-throw
          }
        }

        // Associate with company
        if (companyId && contactId) {
          await hs("POST", "/crm/v3/associations/contacts/companies/batch/create", {
            inputs: [{ from: { id: contactId }, to: { id: companyId }, type: "contact_to_company" }],
          });
        }
        results.push({ name: c.name, hubspot_contact_id: contactId });
      } catch(e: any) {
        console.warn(`Failed to create contact ${c.name}:`, e.message);
        results.push({ name: c.name, error: e.message });
      }
    }
    return new Response(JSON.stringify({ results }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  // ── Action: push deal (original flow) ────────────────────────
  const project = body;
  if (!project?.address || typeof project.address !== "string" || project.address.length < 5) {
    return new Response(JSON.stringify({ error: "Valid address required" }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  try {
    // 1. Resolve deal stage from pipeline
    //    Priority: match hs_dealstage (internal stageId sent by the client, derived from IB stage)
    //    Fallback:  match FALLBACK_STAGE_LABEL by label (legacy behaviour)
    const pipeline = await hs("GET", `/crm/v3/pipelines/deals/${PIPELINE_ID}`);
    const allStages: any[] = pipeline.stages ?? [];

    // IB stage labels now match HubSpot stage labels exactly — look up by label first.
    // hs_dealstage_label is the preferred field; hs_dealstage (legacy internal name) is secondary.
    const requestedLabel: string =
      project.hs_dealstage_label || project.hs_dealstage || FALLBACK_STAGE_LABEL;

    let stage = allStages.find((s: any) => s.label === requestedLabel);

    // If no exact label match, try case-insensitive
    if (!stage) {
      const lower = requestedLabel.toLowerCase();
      stage = allStages.find((s: any) => s.label.toLowerCase() === lower);
    }

    // Last resort: first stage in pipeline so we never hard-fail
    if (!stage && allStages.length > 0) {
      stage = allStages[0];
      console.warn(`Stage "${requestedLabel}" not found — using first stage: "${stage.label}"`);
    }
    if (!stage) throw new Error(`No stages found in pipeline "${PIPELINE_ID}"`);
    console.log(`Using deal stage: "${stage.label}" (id: ${stage.id})`);

    // 2. Find or create Company from owner_developer
    let companyId: string | null = null;
    if (project.owner_developer && typeof project.owner_developer === "string") {
      const search = await hs("POST", "/crm/v3/objects/companies/search", {
        filterGroups: [{
          filters: [{
            propertyName: "name",
            operator: "EQ",
            value: project.owner_developer.slice(0, 200), // cap length
          }],
        }],
        limit: 1,
        properties: ["name"],
      });

      if (search.results?.length > 0) {
        companyId = search.results[0].id;
        console.log(`Found existing company: ${companyId}`);
      } else {
        const co = await hs("POST", "/crm/v3/objects/companies", {
          properties: {
            name:    project.owner_developer.slice(0, 200),
            city:    "Charlotte",
            state:   "NC",
            country: "United States",
          },
        });
        companyId = co.id;
        console.log(`Created new company: ${companyId}`);
      }
    }

    // 3. Build deal name and description
    const dealName = (project.property_name
      ? `${project.property_name} — ${project.address}`
      : `${project.address} — ${project.property_type || "Property"}`
    ).slice(0, 255);

    const descLines = [
      project.property_name      && `Property: ${project.property_name}`,
      `Address: ${project.address}`,
      project.property_type      && `Type: ${project.property_type}`,
      project.status             && `Project Status: ${project.status}`,
      project.building_class     && `Building Class: ${project.building_class}`,
      project.num_stories        && `Stories: ${project.num_stories}`,
      project.year_built         && `Year Built / Expected: ${project.year_built}`,
      project.total_available_sf && `Available SF: ${Number(project.total_available_sf).toLocaleString()}`,
      project.leed_certified     && `LEED: ${project.leed_certified}`,
      project.leasing_company    && `Leasing Co: ${project.leasing_company}`,
      project.percent_leased     && `% Leased: ${project.percent_leased}%`,
    ].filter(Boolean).join("\n");

    // 4. Create Deal (close date 90 days out as placeholder)
    const closeDate = new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10);
    const deal = await hs("POST", "/crm/v3/objects/deals", {
      properties: {
        dealname:    dealName,
        pipeline:    PIPELINE_ID,
        dealstage:   stage.id,
        description: descLines,
        closedate:   closeDate,
      },
    });
    const dealId = deal.id;
    console.log(`Created deal: ${dealId} — ${dealName}`);

    // 5. Associate deal ↔ company
    if (companyId && dealId) {
      await hs("POST", "/crm/v3/associations/deals/companies/batch/create", {
        inputs: [{
          from: { id: dealId },
          to:   { id: companyId },
          type: "deal_to_company",
        }],
      });
    }

    // 6. Associate deal ↔ contacts (all contacts that already exist in HubSpot)
    let contactsLinked = 0;
    const hsContacts: any[] = Array.isArray(project.hs_contacts) ? project.hs_contacts : [];
    const contactInputs = hsContacts
      .filter((c: any) => c.hubspot_contact_id)
      .map((c: any) => ({
        from: { id: dealId },
        to:   { id: String(c.hubspot_contact_id) },
        type: "deal_to_contact",
      }));

    if (contactInputs.length > 0) {
      try {
        await hs("POST", "/crm/v3/associations/deals/contacts/batch/create", {
          inputs: contactInputs,
        });
        contactsLinked = contactInputs.length;
        console.log(`Linked ${contactsLinked} contact(s) to deal ${dealId}`);
      } catch (e: any) {
        // Non-fatal — deal is still created, just log the issue
        console.warn("Contact association failed:", e.message);
      }
    } else {
      console.log("No HubSpot contacts to associate with deal");
    }

    return new Response(
      JSON.stringify({
        success:        true,
        dealId,
        companyId,
        dealUrl:        `https://app.hubspot.com/contacts/${PORTAL_ID}/deal/${dealId}`,
        dealStage:      stage.label,  // human-readable label stored back in IB Scout
        contactsLinked,
      }),
      { headers: { ...cors, "Content-Type": "application/json" } }
    );

  } catch (err: any) {
    console.error("hubspot-push error:", err.message);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }
});
