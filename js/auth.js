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
    // Login screen uses fixed IB corporate brand colors (IB Blue + IB Orange)
    // regardless of in-app theme — first-impression marketing surface.
    document.getElementById("ib-auth-overlay")?.remove();
    const IB_BLUE        = "#122048";
    const IB_BLUE_DEEP   = "#0c1733";  // for the gradient
    const IB_ORANGE      = "#F04B24";
    const IB_ORANGE_DARK = "#d63d18";
    const overlay = document.createElement("div");
    overlay.id = "ib-auth-overlay";
    overlay.style.cssText = `position:fixed;inset:0;z-index:2147483647;background:radial-gradient(ellipse at top right, ${IB_BLUE} 0%, ${IB_BLUE_DEEP} 70%);color:#ffffff;font-family:'Epilogue',system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;padding:24px;overflow:auto`;

    const logoLockup = `<img src="ib-logo.png" alt="Intelligent Buildings" style="height:54px;width:auto;display:inline-block">`;

    overlay.innerHTML = `
      <div style="max-width:440px;width:100%;background:#ffffff;border-radius:10px;padding:36px 36px 28px;box-shadow:0 30px 80px rgba(0,0,0,0.4);color:${IB_BLUE}">
        <div style="text-align:center;margin-bottom:22px">${logoLockup}</div>
        <div style="height:2px;width:48px;background:${IB_ORANGE};margin:0 auto 24px"></div>
        <div style="text-align:center;font-size:13px;font-weight:600;color:${IB_ORANGE};text-transform:uppercase;letter-spacing:0.12em;margin-bottom:10px">IB Scout</div>
        <div style="text-align:center;font-size:24px;font-weight:700;color:${IB_BLUE};line-height:1.25;margin-bottom:8px;letter-spacing:-0.01em">Know the building<br>before the meeting.</div>
        <div style="text-align:center;font-size:13px;color:#5a5f6e;line-height:1.55;margin-bottom:26px">Permits, ownership, contacts, and AI-generated property briefs — for every building on your radar.</div>
        ${err ? `<div style="background:#fef2f0;border:1px solid ${IB_ORANGE};border-radius:6px;padding:10px 12px;color:${IB_ORANGE_DARK};font-size:12px;margin-bottom:18px;text-align:left;line-height:1.5">${String(err.message || err)}</div>` : ""}
        <button id="ibLoginBtn" style="width:100%;padding:14px 16px;border-radius:6px;font-size:14px;font-weight:700;background:${IB_ORANGE};border:1px solid ${IB_ORANGE};color:#ffffff;cursor:pointer;font-family:inherit;letter-spacing:0.02em;display:inline-flex;align-items:center;justify-content:center;gap:8px;transition:all .15s;box-shadow:0 2px 0 rgba(0,0,0,0.06)">Sign in <span style="font-size:15px;font-weight:400">→</span></button>
        <div style="margin-top:18px;font-size:11px;color:#7f7f7f;line-height:1.6;text-align:center">First time here? Click <strong style="color:${IB_BLUE}">Sign in</strong>, then <strong style="color:${IB_BLUE}">Sign up</strong> on the next screen.<br><span style="color:#a0a0a0">Access is for Intelligent Buildings &amp; Stiles team members.</span></div>
      </div>
      <div style="position:absolute;bottom:28px;left:0;right:0;text-align:center;font-size:11px;color:rgba(255,255,255,0.5);letter-spacing:0.04em">© Intelligent Buildings, LLC</div>`;
    document.body.appendChild(overlay);
    const btn = document.getElementById("ibLoginBtn");
    btn.addEventListener("click", login);
    btn.addEventListener("mouseenter", () => { btn.style.background = IB_ORANGE_DARK; btn.style.borderColor = IB_ORANGE_DARK; });
    btn.addEventListener("mouseleave", () => { btn.style.background = IB_ORANGE; btn.style.borderColor = IB_ORANGE; });
  }

  function hideLoginOverlay() {
    document.getElementById("ib-auth-overlay")?.remove();
  }

  function initialsFrom(u) {
    const name = (u?.name && u.name !== u.email) ? u.name : (u?.email || "");
    const parts = name.replace(/@.*/, "").split(/[.\s_-]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return "??";
  }

  function renderUserMenu(u) {
    // Mount the avatar button into the existing header (right side) once it
    // exists, then attach a dropdown panel anchored beneath it.
    const headerRight = document.querySelector(".header-right");
    if (!headerRight) return;
    document.getElementById("ibUserBtn")?.remove();
    document.getElementById("ibUserPanel")?.remove();

    const initials = initialsFrom(u);
    const displayName = (u?.name && u.name !== u.email) ? u.name : (u?.email || "");

    const btn = document.createElement("button");
    btn.id = "ibUserBtn";
    btn.title = "Account";
    btn.style.cssText = "width:32px;height:32px;border-radius:50%;border:1px solid var(--border2,#2e2e38);background:var(--surface2,#18181d);color:var(--accent,#4ade80);font-family:'DM Mono',monospace;font-size:11px;font-weight:700;letter-spacing:0.04em;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0;transition:all .15s";
    btn.textContent = initials;
    btn.addEventListener("mouseenter", () => { btn.style.borderColor = "var(--accent,#4ade80)"; });
    btn.addEventListener("mouseleave", () => { btn.style.borderColor = "var(--border2,#2e2e38)"; });

    const panel = document.createElement("div");
    panel.id = "ibUserPanel";
    panel.style.cssText = "position:fixed;top:54px;right:18px;z-index:9999;display:none;min-width:240px;max-width:300px;background:var(--surface,#111114);border:1px solid var(--border2,#2e2e38);border-radius:8px;padding:14px 16px;box-shadow:0 12px 32px rgba(0,0,0,0.5);font-family:'Epilogue',system-ui,sans-serif";
    panel.innerHTML = `
      <div style="font-size:13px;font-weight:600;color:var(--text,#e8e8f0);margin-bottom:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</div>
      <div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--text3,#55556a);margin-bottom:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(u?.email || "")}">${escapeHtml(u?.email || "")}</div>
      <button id="ibSignOutBtn" style="width:100%;padding:7px 12px;border-radius:6px;font-size:12px;font-weight:600;background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.3);color:var(--red,#f87171);cursor:pointer;font-family:inherit;transition:all .15s">Sign out</button>
    `;

    function openPanel() {
      panel.style.display = "block";
      // Position the panel anchored to the bottom-right of the button.
      const rect = btn.getBoundingClientRect();
      panel.style.top = (rect.bottom + 6) + "px";
      panel.style.right = (window.innerWidth - rect.right) + "px";
    }
    function closePanel() { panel.style.display = "none"; }
    function togglePanel(e) {
      e?.stopPropagation();
      panel.style.display === "block" ? closePanel() : openPanel();
    }

    btn.addEventListener("click", togglePanel);
    document.addEventListener("click", (e) => {
      if (panel.style.display === "block" && !panel.contains(e.target) && e.target !== btn) closePanel();
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePanel(); });

    headerRight.appendChild(btn);
    document.body.appendChild(panel);

    const signOutBtn = panel.querySelector("#ibSignOutBtn");
    signOutBtn.addEventListener("click", () => { closePanel(); logout(); });
    signOutBtn.addEventListener("mouseenter", () => { signOutBtn.style.background = "rgba(248,113,113,0.16)"; signOutBtn.style.borderColor = "var(--red,#f87171)"; });
    signOutBtn.addEventListener("mouseleave", () => { signOutBtn.style.background = "rgba(248,113,113,0.08)"; signOutBtn.style.borderColor = "rgba(248,113,113,0.3)"; });
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
      // Mount the header avatar + dropdown. The header may not be in the DOM
      // yet on first paint, so retry briefly until .header-right appears.
      let tries = 0;
      const mount = () => {
        if (document.querySelector(".header-right")) { renderUserMenu(user); return; }
        if (++tries < 50) setTimeout(mount, 100);
      };
      mount();
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
