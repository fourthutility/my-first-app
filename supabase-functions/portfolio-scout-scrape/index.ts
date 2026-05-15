// IB Scout — Portfolio Scout Edge Function (SKELETON / MOCK)
//
// v1 will:
//   1. Fetch the owner's portfolio page (static + JS-render fallback)
//   2. Send the HTML to Claude Haiku for candidate extraction
//   3. Dedupe extracted candidates against the existing `projects` table
//      (fuzzy match on normalized address — Sonnet for the ambiguous cases)
//   4. Persist candidates to `portfolio_candidates` (status='pending')
//
// THIS COMMIT is the skeleton only. The fetch + Haiku + Sonnet pipeline is
// not wired up — `action=scrape` returns a hard-coded mock set so the
// end-to-end UX (submit → review grid → approve → main inventory) can be
// validated on the preview environment before any scraping logic lands.
//
// Deploy: supabase functions deploy portfolio-scout-scrape --no-verify-jwt
// (--no-verify-jwt because the function verifies the Auth0 access token itself)
//
// Required secrets (already set for the other Scout functions):
//   AUTH0_DOMAIN, AUTH0_AUDIENCE
//   APP_SECRET (LEGACY — accepted as fallback during Auth0 rollout)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injected by Supabase)

import { createRemoteJWKSet, jwtVerify } from "https://esm.sh/jose@5.9.6";

const AUTH0_DOMAIN   = Deno.env.get("AUTH0_DOMAIN")!;
const AUTH0_AUDIENCE = Deno.env.get("AUTH0_AUDIENCE")!;
const APP_SECRET     = Deno.env.get("APP_SECRET") || "";  // legacy fallback
const SB_URL         = Deno.env.get("SUPABASE_URL")!;
const SB_SRK         = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const AUTH0_ISSUER = `https://${AUTH0_DOMAIN}/`;
const JWKS = createRemoteJWKSet(new URL(`${AUTH0_ISSUER}.well-known/jwks.json`));

const ALLOWED_ORIGINS = [
  "https://scout.intelligentbuildings.com",
  "https://ibscout.netlify.app",
  "https://fourthutility.github.io",
  "http://localhost:8080",
];

function corsHeaders(origin: string | null) {
  const isAllowed = !!origin && (
    ALLOWED_ORIGINS.includes(origin) ||
    /^https:\/\/[a-z0-9-]+--ibscout\.netlify\.app$/i.test(origin)
  );
  const allowed = isAllowed ? origin! : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin":  allowed,
    "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-app-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

// Accept Auth0 access token (preferred) or x-app-secret (legacy).
// Returns the verified Auth0 sub when present, "" for legacy.
async function authorize(req: Request): Promise<string> {
  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (token) {
    try {
      const { payload } = await jwtVerify(token, JWKS, {
        issuer: AUTH0_ISSUER, audience: AUTH0_AUDIENCE,
      });
      return String(payload.sub || "");
    } catch { /* fall through */ }
  }
  const secret = req.headers.get("x-app-secret");
  if (secret && APP_SECRET && secret === APP_SECRET) return "";
  throw new Error("Unauthorized");
}

async function sbFetch(path: string, opts: RequestInit = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      "apikey": SB_SRK,
      "Authorization": `Bearer ${SB_SRK}`,
      "Prefer": "return=representation",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

// ─── Mock extractor (SKELETON) ────────────────────────────────────────────────
// Returns 3 candidates with mixed confidence so the verification grid can be
// exercised against both bulk-approve (high) and individual-approve (low) paths
// during the preview validation gate.
function mockCandidates(ownerName: string, sourceUrl: string) {
  return [
    {
      owner_name:            ownerName,
      source_url:            sourceUrl,
      raw_snippet:           "1100 South Boulevard — 5-story Class A multifamily, 312,000 SF, delivered 2015.",
      extracted_name:        "1100 South",
      extracted_address:     "1100 South Blvd",
      extracted_city:        "Charlotte",
      extracted_sqft:        312000,
      extracted_asset_class: "Multi-Family",
      confidence:            "high",
      status:                "pending",
    },
    {
      owner_name:            ownerName,
      source_url:            sourceUrl,
      raw_snippet:           "The Square at 200 West Boulevard — 10-story Class A office, LEED Silver.",
      extracted_name:        "The Square",
      extracted_address:     "200 West Blvd",
      extracted_city:        "Charlotte",
      extracted_sqft:        null,
      extracted_asset_class: "Office",
      confidence:            "high",
      status:                "pending",
    },
    {
      owner_name:            ownerName,
      source_url:            sourceUrl,
      raw_snippet:           "Featured asset: Sunbelt Logistics Center (address not listed on site).",
      extracted_name:        "Sunbelt Logistics Center",
      extracted_address:     null,
      extracted_city:        null,
      extracted_sqft:        null,
      extracted_asset_class: "Industrial",
      confidence:            "low",
      status:                "pending",
    },
  ];
}

// ─── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);

  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  let reviewerSub = "";
  try {
    reviewerSub = await authorize(req);
  } catch (e) {
    return new Response(JSON.stringify({ error: "Unauthorized", detail: (e as Error).message }), {
      status: 401, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const action = String(body.action || "scrape");

  // ── action: scrape — return + persist mock candidates ──────────────────────
  if (action === "scrape") {
    const ownerName = String(body.owner_name || "").trim();
    const sourceUrl = String(body.source_url || "").trim();
    if (!ownerName || !sourceUrl) {
      return new Response(JSON.stringify({ error: "owner_name and source_url required" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // TODO (next commit):
    //   - fetch sourceUrl (static first, headless fallback)
    //   - hand HTML to Claude Haiku for extraction
    //   - normalize addresses, run dedupe against `projects`
    //   - replace mockCandidates() with the real result set
    const rows = mockCandidates(ownerName, sourceUrl);
    const inserted = await sbFetch("portfolio_candidates", {
      method: "POST",
      body: JSON.stringify(rows),
    });
    return new Response(JSON.stringify({ candidates: inserted, mock: true }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  // ── action: approve — promote a staging row into `projects` ────────────────
  if (action === "approve") {
    const candidateId = String(body.candidate_id || "").trim();
    if (!candidateId) {
      return new Response(JSON.stringify({ error: "candidate_id required" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const cands = await sbFetch(`portfolio_candidates?id=eq.${candidateId}&select=*`);
    const candidate = Array.isArray(cands) ? cands[0] : null;
    if (!candidate) {
      return new Response(JSON.stringify({ error: "Candidate not found" }), {
        status: 404, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    if (!candidate.extracted_address) {
      return new Response(JSON.stringify({ error: "Cannot import candidate without an address" }), {
        status: 422, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // TODO (next commit): real dedupe — for the skeleton, every approve is a
    // straight insert into `projects`. Owner attribution comes from the
    // owner_name the user typed into the form, not from the candidate row.
    const projectRows = await sbFetch("projects", {
      method: "POST",
      body: JSON.stringify([{
        address:            candidate.extracted_address,
        property_name:      candidate.extracted_name,
        owner_developer:    candidate.owner_name,
        property_type:      candidate.extracted_asset_class,
        total_available_sf: candidate.extracted_sqft,
        status:             "Existing",
      }]),
    });
    const project = Array.isArray(projectRows) ? projectRows[0] : projectRows;

    const updated = await sbFetch(`portfolio_candidates?id=eq.${candidateId}`, {
      method: "PATCH",
      body: JSON.stringify({
        status:               "approved",
        reviewed_at:          new Date().toISOString(),
        reviewed_by:          reviewerSub || null,
        imported_building_id: project?.id || null,
      }),
    });

    return new Response(JSON.stringify({
      candidate: Array.isArray(updated) ? updated[0] : updated,
      project,
    }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  }

  // ── action: reject ─────────────────────────────────────────────────────────
  if (action === "reject") {
    const candidateId = String(body.candidate_id || "").trim();
    if (!candidateId) {
      return new Response(JSON.stringify({ error: "candidate_id required" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const updated = await sbFetch(`portfolio_candidates?id=eq.${candidateId}`, {
      method: "PATCH",
      body: JSON.stringify({
        status:      "rejected",
        reviewed_at: new Date().toISOString(),
        reviewed_by: reviewerSub || null,
      }),
    });
    return new Response(JSON.stringify({ candidate: Array.isArray(updated) ? updated[0] : updated }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
    status: 400, headers: { ...cors, "Content-Type": "application/json" },
  });
});
