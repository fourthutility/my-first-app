// IB Scout — Auth0 gate
// Loaded BEFORE app.js. Blocks page render until the user is authenticated.
// Exposes:
//   window.IBAuth.getAccessToken()  → Promise<string>
//   window.IBAuth.getIdToken()      → Promise<string>
//   window.IBAuth.getUser()         → Promise<{sub,email,name,...}>
//   window.IBAuth.logout()          → void
//   window.IBAuth.ready             → Promise<void>  (resolves once login complete)
//
// Auth0 Application: SPA, Authorization Code + PKCE.
// Domain allowlist (@intelligentbuildings.com, @stiles.com) is enforced
// by an Auth0 Post-Login Action — not duplicated here.

(function () {
  const AUTH0_DOMAIN    = "sales-intelligentbuildings.us.auth0.com";
  const AUTH0_CLIENT_ID = "wFUijOO34dwCDI1CYubWRFRoVkIX4can";
  // Logical API identifier registered in Auth0 → APIs.
  // Doesn't have to resolve. Edge Functions verify token audience against this.
  const AUTH0_AUDIENCE  = "https://scout-api.intelligentbuildings.com";
  // Where the auth-callback Edge Function lives.
  const SUPABASE_URL    = "https://lnldwxttyfjmaobluciy.supabase.co";

  // Anon key kept here (not a true secret — see README-AUTH.md "Residual exposure").
  // Required as the `apikey` header for PostgREST + Edge Function gateway.
  const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxubGR3eHR0eWZqbWFvYmx1Y2l5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzMDI4ODksImV4cCI6MjA5MTg3ODg4OX0.W0ujmEJpBqKJcMYdwd__bJ0yszSG5QGBfqwFl7hZdLc";

  let client = null;
  let user = null;

  function loadSdk() {
    return new Promise((resolve, reject) => {
      if (window.auth0) return resolve();
      const s = document.createElement("script");
      s.src = "https://cdn.auth0.com/js/auth0-spa-js/2.1/auth0-spa-js.production.js";
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Failed to load Auth0 SDK"));
      document.head.appendChild(s);
    });
  }

  function showLoginScreen(err) {
    // Overlay on top of the existing DOM rather than wiping it, so that
    // module-level DOM lookups in app.js (e.g. getElementById('modalOverlay'))
    // don't throw while the user is sitting at the login screen.
    document.getElementById("ib-auth-overlay")?.remove();
    const overlay = document.createElement("div");
    overlay.id = "ib-auth-overlay";
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#0a0a14;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;padding:24px;overflow:auto";
    overlay.innerHTML = `
      <div style="max-width:380px;width:100%;background:#0f172a;border:1px solid #1e2433;border-radius:12px;padding:32px 28px;text-align:center">
        <div style="width:48px;height:48px;border-radius:12px;background:linear-gradient(135deg,#1e3a8a,#0c2a3d);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;color:#7dd3fc;margin:0 auto 16px">IB</div>
        <div style="font-size:20px;font-weight:700;color:#f1f5f9;margin-bottom:6px">IB Scout</div>
        <div style="font-size:13px;color:#94a3b8;margin-bottom:24px">Sign in to continue</div>
        ${err ? `<div style="background:#1a0a0a;border:1px solid #7f1d1d;border-radius:6px;padding:10px;color:#fca5a5;font-size:12px;margin-bottom:16px;text-align:left">${String(err.message || err)}</div>` : ""}
        <button id="ibLoginBtn" style="width:100%;padding:11px 16px;border-radius:8px;font-size:14px;font-weight:600;background:#0c2a3d;border:1px solid #164e63;color:#7dd3fc;cursor:pointer">Sign in with Auth0</button>
        <div style="margin-top:20px;font-size:11px;color:#475569;line-height:1.5">Access is restricted to Intelligent Buildings and Stiles team members.</div>
      </div>`;
    document.body.appendChild(overlay);
    document.getElementById("ibLoginBtn").addEventListener("click", login);
  }

  function hideLoginOverlay() {
    document.getElementById("ib-auth-overlay")?.remove();
  }

  async function login() {
    await client.loginWithRedirect({
      authorizationParams: {
        redirect_uri: window.location.origin + window.location.pathname,
        audience: AUTH0_AUDIENCE,
        scope: "openid profile email",
      },
    });
  }

  async function logout() {
    await client.logout({
      logoutParams: { returnTo: window.location.origin + window.location.pathname },
    });
  }

  async function callAuthCallback(idToken) {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/auth-callback`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_ANON_KEY,
          "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ id_token: idToken }),
      });
      if (!res.ok) {
        const text = await res.text();
        console.warn("auth-callback failed:", res.status, text);
      }
    } catch (e) {
      console.warn("auth-callback error:", e);
    }
  }

  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });

  async function init() {
    try {
      await loadSdk();
      const factory = window.auth0?.createAuth0Client || window.createAuth0Client;
      client = await factory({
        domain: AUTH0_DOMAIN,
        clientId: AUTH0_CLIENT_ID,
        authorizationParams: {
          redirect_uri: window.location.origin + window.location.pathname,
          audience: AUTH0_AUDIENCE,
          scope: "openid profile email",
        },
        cacheLocation: "localstorage",
        useRefreshTokens: true,
      });

      // Handle the post-redirect callback (?code=&state=)
      const qs = window.location.search;
      if (qs.includes("code=") && qs.includes("state=")) {
        try {
          await client.handleRedirectCallback();
        } catch (e) {
          console.error("handleRedirectCallback error:", e);
        }
        // Strip auth params from URL so they aren't shareable / re-entered
        window.history.replaceState({}, document.title, window.location.pathname);
      }

      const isAuthed = await client.isAuthenticated();
      if (!isAuthed) {
        showLoginScreen();
        return;
      }

      hideLoginOverlay();
      user = await client.getUser();
      const claims = await client.getIdTokenClaims();
      if (claims?.__raw) {
        // Fire-and-forget profile upsert. Don't block the app on this.
        callAuthCallback(claims.__raw);
      }
      resolveReady();
    } catch (e) {
      console.error("Auth init failed:", e);
      showLoginScreen(e);
    }
  }

  window.IBAuth = {
    ready,
    getAccessToken: async () => client.getTokenSilently(),
    getIdToken: async () => {
      const claims = await client.getIdTokenClaims();
      return claims?.__raw || "";
    },
    getUser: async () => user || (user = await client.getUser()),
    logout,
    SUPABASE_ANON_KEY,
  };

  init();
})();
