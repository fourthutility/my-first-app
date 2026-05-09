// IB-Scout — Apollo Phone Webhook Edge Function
// Deploy via: Supabase Dashboard → Edge Functions → New Function → name: "apollo-phone-webhook"
//
// Apollo calls this URL after async phone reveal completes.
// Auth: shared secret passed as ?secret= query param (Apollo doesn't support custom headers).
//
// Required secrets (Edge Functions → Secrets):
//   APP_SECRET     — shared secret (same value used in contact-search & hubspot-push)
//   SB_URL         — https://lnldwxttyfjmaobluciy.supabase.co
//   SB_SERVICE_KEY — service_role key (Settings → API → service_role in Supabase dashboard)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const APP_SECRET     = Deno.env.get("APP_SECRET")!;
const SUPABASE_URL   = Deno.env.get("SB_URL")!;
const SERVICE_KEY    = Deno.env.get("SB_SERVICE_KEY")!;

const SB_HEADERS = {
  "apikey":        SERVICE_KEY,
  "Authorization": `Bearer ${SERVICE_KEY}`,
  "Content-Type":  "application/json",
  "Prefer":        "return=minimal",
};

async function sbPatch(table: string, filter: string, body: object) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method:  "PATCH",
    headers: SB_HEADERS,
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`sbPatch ${table} failed:`, res.status, err.slice(0, 200));
  }
}

serve(async (req) => {
  // ── Auth: secret in query param ───────────────────────────────────────────
  const url    = new URL(req.url);
  const secret = url.searchParams.get("secret");
  if (!secret || secret !== APP_SECRET) {
    console.warn("Apollo webhook — unauthorized request");
    return new Response("Unauthorized", { status: 401 });
  }

  // ── Log full payload for debugging ────────────────────────────────────────
  let payload: any;
  try {
    const raw = await req.text();
    console.log("Apollo phone webhook payload:", raw.slice(0, 1500));
    payload = JSON.parse(raw);
  } catch (e) {
    console.error("Failed to parse Apollo webhook payload:", e);
    return new Response("Bad Request", { status: 400 });
  }

  // Apollo may wrap the people array under different keys depending on the endpoint
  const people: any[] = payload.people ?? payload.matches ?? payload.contacts ?? [];
  console.log(`Processing ${people.length} people from Apollo phone webhook`);

  for (const person of people) {
    const apolloId = person.id;
    if (!apolloId) continue;

    // Extract best available phone number
    const phone =
      person.phone_numbers?.find((p: any) => p.type === "work_direct")?.sanitized_number
      || person.phone_numbers?.find((p: any) => p.type === "mobile")?.sanitized_number
      || person.phone_numbers?.[0]?.sanitized_number
      || person.phone_numbers?.[0]?.raw_number
      || person.sanitized_phone
      || person.phone
      || null;

    const status = phone ? "found" : "not_found";
    console.log(`Person ${apolloId}: phone=${phone ?? "none"} status=${status}`);

    // ── Update apollo_phone_cache ─────────────────────────────────────────
    await sbPatch(
      "apollo_phone_cache",
      `apollo_person_id=eq.${encodeURIComponent(apolloId)}`,
      { phone, status, updated_at: new Date().toISOString() }
    );

    // ── Also update contacts table if this person is already saved ────────
    // This catches the case where the user saved the contact before Apollo called back.
    if (person.email && phone) {
      await sbPatch(
        "contacts",
        `email=eq.${encodeURIComponent(person.email)}`,
        { phone, updated_at: new Date().toISOString() }
      );
    }
  }

  return new Response(JSON.stringify({ ok: true, processed: people.length }), {
    status:  200,
    headers: { "Content-Type": "application/json" },
  });
});
