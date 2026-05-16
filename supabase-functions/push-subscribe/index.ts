// Push Subscription Management — POST to subscribe, DELETE to unsubscribe.
//
// POST   /functions/v1/push-subscribe   body: PushSubscription JSON + optional device_label
// DELETE /functions/v1/push-subscribe   body: { endpoint }
//
// Auth: Auth0 access token in Authorization header. The token's `sub`
// claim is used as user_sub (the join key for pushing later).
//
// Deploy: supabase functions deploy push-subscribe --no-verify-jwt
// (we verify Auth0 ourselves; --no-verify-jwt disables Supabase's own check)

import { createRemoteJWKSet, jwtVerify } from "https://esm.sh/jose@5.9.6";

const AUTH0_DOMAIN   = Deno.env.get("AUTH0_DOMAIN")!;
const AUTH0_AUDIENCE = Deno.env.get("AUTH0_AUDIENCE")!;
const SB_URL         = Deno.env.get("SUPABASE_URL")!;
const SB_SRK         = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ALLOWED_ORIGINS = [
  "https://scout.intelligentbuildings.com",
  "https://ibscout.netlify.app",
  "https://fourthutility.github.io",
];

const AUTH0_ISSUER = `https://${AUTH0_DOMAIN}/`;
const JWKS = createRemoteJWKSet(new URL(`${AUTH0_ISSUER}.well-known/jwks.json`));

async function authorize(req: Request): Promise<string> {
  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) throw new Error("Missing access token");
  const { payload } = await jwtVerify(token, JWKS, {
    issuer: AUTH0_ISSUER,
    audience: AUTH0_AUDIENCE,
  });
  if (!payload.sub) throw new Error("Token has no sub claim");
  return payload.sub as string;
}

function corsHeaders(origin: string | null) {
  const isAllowed = origin && (
    ALLOWED_ORIGINS.includes(origin) ||
    /^https:\/\/[a-z0-9-]+--ibscout\.netlify\.app$/i.test(origin)
  );
  const allowed = isAllowed ? origin! : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
    "Vary": "Origin",
  };
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(origin) });
  }

  let userSub: string;
  try {
    userSub = await authorize(req);
  } catch (e) {
    return new Response(JSON.stringify({ error: "Unauthorized", detail: (e as Error).message }), {
      status: 401,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
    });
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

  if (req.method === "POST") {
    // Expected body shape: { endpoint, keys: { p256dh, auth }, expirationTime, device_label? }
    const endpoint = body.endpoint as string | undefined;
    const keys = body.keys as { p256dh?: string; auth?: string } | undefined;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return new Response(JSON.stringify({ error: "endpoint and keys required" }), {
        status: 400,
        headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
      });
    }
    const deviceLabel = (body.device_label as string) || null;
    const expirationTime = body.expirationTime as number | null | undefined;
    const expiresAt = typeof expirationTime === "number"
      ? new Date(expirationTime).toISOString()
      : null;

    const upsertBody = {
      user_sub: userSub,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      device_label: deviceLabel,
      expires_at: expiresAt,
      last_used_at: new Date().toISOString(),
    };
    const res = await fetch(
      `${SB_URL}/rest/v1/push_subscriptions?on_conflict=user_sub,endpoint`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SB_SRK,
          "Authorization": `Bearer ${SB_SRK}`,
          "Prefer": "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(upsertBody),
      },
    );
    if (!res.ok) {
      const err = await res.text();
      console.error("push subscribe upsert failed:", res.status, err.slice(0, 300));
      return new Response(JSON.stringify({ error: "subscribe failed" }), {
        status: 500,
        headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
    });
  }

  if (req.method === "DELETE") {
    const endpoint = body.endpoint as string | undefined;
    if (!endpoint) {
      return new Response(JSON.stringify({ error: "endpoint required" }), {
        status: 400,
        headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
      });
    }
    const params = new URLSearchParams({
      user_sub: `eq.${userSub}`,
      endpoint: `eq.${endpoint}`,
    });
    const res = await fetch(`${SB_URL}/rest/v1/push_subscriptions?${params}`, {
      method: "DELETE",
      headers: { "apikey": SB_SRK, "Authorization": `Bearer ${SB_SRK}` },
    });
    if (!res.ok) {
      console.error("push unsubscribe failed:", res.status);
      return new Response(JSON.stringify({ error: "unsubscribe failed" }), {
        status: 500,
        headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
});
