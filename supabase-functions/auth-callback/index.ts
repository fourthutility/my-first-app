// IB-Scout — Auth Callback Edge Function
// Called by the frontend exactly once after a successful Auth0 login.
// Verifies the Auth0 ID token, then upserts a row into user_profiles
// (idempotent on auth0_sub) using the service-role key.
//
// Deploy via: supabase functions deploy auth-callback
//
// Required secrets (set in: Supabase Dashboard → Edge Functions → Secrets):
//   AUTH0_DOMAIN          — sales-intelligentbuildings.us.auth0.com
//   AUTH0_SPA_CLIENT_ID   — wFUijOO34dwCDI1CYubWRFRoVkIX4can
//   SB_URL                — https://lnldwxttyfjmaobluciy.supabase.co
//   SB_SERVICE_KEY        — Supabase service-role key
//
// supabase/config.toml note: this function should run with verify_jwt = false
// so the Supabase gateway doesn't reject the request before our code can
// validate the Auth0 ID token itself.

import { createRemoteJWKSet, jwtVerify } from "https://esm.sh/jose@5.9.6";

const AUTH0_DOMAIN    = Deno.env.get("AUTH0_DOMAIN")!;
const AUTH0_CLIENT_ID = Deno.env.get("AUTH0_SPA_CLIENT_ID")!;
const SB_URL          = Deno.env.get("SB_URL")!;
const SB_SRK          = Deno.env.get("SB_SERVICE_KEY")!;

const ISSUER = `https://${AUTH0_DOMAIN}/`;
const JWKS   = createRemoteJWKSet(new URL(`${ISSUER}.well-known/jwks.json`));

const ALLOWED_ORIGINS = [
  "https://scout.intelligentbuildings.com",
  "https://ibscout.netlify.app",
  "http://localhost:8080",
];

function corsHeaders(origin: string | null) {
  const isAllowed = !!origin && (
    ALLOWED_ORIGINS.includes(origin) ||
    /^https:\/\/[a-z0-9-]+--ibscout\.netlify\.app$/i.test(origin)
  );
  const allowed = isAllowed ? origin! : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
    "Vary": "Origin",
  };
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

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  let body: { id_token?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const idToken = body?.id_token;
  if (!idToken) {
    return new Response(JSON.stringify({ error: "Missing id_token" }), {
      status: 400, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  let claims: Record<string, unknown>;
  try {
    const { payload } = await jwtVerify(idToken, JWKS, {
      issuer:   ISSUER,
      audience: AUTH0_CLIENT_ID,
    });
    claims = payload as Record<string, unknown>;
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid token", detail: (e as Error).message }), {
      status: 401, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const sub   = String(claims.sub || "");
  const email = String(claims.email || "");
  if (!sub || !email) {
    return new Response(JSON.stringify({ error: "Token missing sub or email" }), {
      status: 400, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  // Defense-in-depth: Auth0's Post-Login Action already enforces this, but
  // duplicating the check here means a misconfigured Action can't silently
  // let an outside domain through. Cheap insurance.
  const emailDomain = email.split("@")[1]?.toLowerCase() || "";
  const ALLOWED_DOMAINS = ["intelligentbuildings.com", "stiles.com"];
  if (!ALLOWED_DOMAINS.includes(emailDomain)) {
    return new Response(JSON.stringify({ error: "Domain not permitted" }), {
      status: 403, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const fullName = String(claims.name || claims.nickname || "");

  try {
    const rows = await sbFetch(
      "user_profiles?on_conflict=auth0_sub",
      {
        method: "POST",
        headers: { "Prefer": "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify({
          auth0_sub:    sub,
          email,
          full_name:    fullName,
          email_domain: emailDomain,
          // Updated on every Auth0 sign-in. Lets admins find inactive accounts
          // via `select * from user_profiles where last_seen_at < now() - interval '90 days'`.
          last_seen_at: new Date().toISOString(),
        }),
      },
    );
    const profile = Array.isArray(rows) ? rows[0] : rows;
    return new Response(JSON.stringify({ profile }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: "Upsert failed", detail: (e as Error).message }), {
      status: 500, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
