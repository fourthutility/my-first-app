// Playwright global setup — authenticate via Auth0 Resource Owner Password Grant.
//
// Why this exists
// ---------------
// Scout is gated by Auth0. Without a session, every test hits the unauthenticated
// landing page instead of the app. Running the UI login flow once per test is
// slow and brittle (an Auth0 password change in the test tenant would break
// every test).
//
// Instead, we POST credentials directly to Auth0's /oauth/token endpoint using
// the Resource Owner Password Grant, then inject the resulting tokens into
// localStorage in the exact format auth0-spa-js looks for on initialization.
// We save the storage state to a file that every other test project then
// loads via `storageState`, so each test starts authenticated with zero UI work.
//
// Switching to UI-based login (if Password grant is ever turned off)
// ------------------------------------------------------------------
// Replace the fetch + page.evaluate block with:
//   await page.goto('/');
//   await page.getByRole('button', { name: /sign in/i }).click();
//   await page.fill('input[name="username"]', email);
//   await page.fill('input[name="password"]', password);
//   await page.getByRole('button', { name: /continue/i }).click();
//   await page.waitForURL(new RegExp('^' + baseURL));  // back at Scout
// Then save storageState as we do today. No other file changes required.
//
// Test user reference (not used at runtime)
//   Auth0 user_id: auth0|6a0461c1f388f0c22ebd8e0c
//
// Required env vars:
//   SCOUT_TEST_EMAIL     — test user email (e.g. scout-e2e@intelligentbuildings.com)
//   SCOUT_TEST_PASSWORD  — test user password
// In CI, these come from GitHub Actions secrets. Locally, from .env (see .env.example).

import { test as setup } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// MUST match the values used by the Auth0 SDK client in js/auth.js. The SDK
// computes its localStorage cache key from (clientId, audience, scope), so any
// divergence here means we write to one key and the SDK reads from another.
//
// Subtle: js/auth.js passes useRefreshTokens: true. In that mode auth0-spa-js
// silently appends 'offline_access' to the scope it uses for the cache-key
// lookup, even though the configured authorizationParams.scope is just
// 'openid profile email'. We have to mirror that here, or the SDK looks up a
// key that doesn't exist, isAuthenticated() returns false, and every spec
// runs against the login overlay.
const AUTH0_DOMAIN    = 'sales-intelligentbuildings.us.auth0.com';
const AUTH0_CLIENT_ID = 'wFUijOO34dwCDI1CYubWRFRoVkIX4can';
const AUTH0_AUDIENCE  = 'https://scout-api.intelligentbuildings.com';
const AUTH0_SCOPE     = 'openid profile email offline_access';

const AUTH_STATE_PATH = path.resolve(__dirname, '..', 'playwright', '.auth', 'user.json');

setup('authenticate', async ({ page }) => {
  const email    = process.env.SCOUT_TEST_EMAIL;
  const password = process.env.SCOUT_TEST_PASSWORD;

  if (!email || !password) {
    throw new Error(
      'SCOUT_TEST_EMAIL and SCOUT_TEST_PASSWORD must be set before running tests.\n' +
      'Locally: create a .env file from .env.example.\n' +
      'CI: configured as GitHub Actions secrets in .github/workflows/playwright.yml.'
    );
  }

  // ── 1. Get tokens from Auth0 ────────────────────────────────────────────
  // Password Grant requires:
  //   - Auth0 Application has "Password" grant type enabled (Shannon did this)
  //   - Tenant has a Default Directory set to the connection holding the test user
  //   - User exists in that connection
  const tokenRes = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'password',
      username:   email,
      password,
      client_id:  AUTH0_CLIENT_ID,
      audience:   AUTH0_AUDIENCE,
      scope:      AUTH0_SCOPE,
    }),
  });

  if (!tokenRes.ok) {
    // Surface Auth0's response body — the two common failures here are
    // "Password grant not enabled" and "wrong audience/scope".
    const body = await tokenRes.text();
    throw new Error(`Auth0 /oauth/token returned ${tokenRes.status}: ${body}`);
  }

  const tokens = await tokenRes.json() as {
    access_token: string;
    id_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
    token_type: string;
  };

  // ── 2. Land on the app so localStorage is scoped to the right origin ────
  await page.goto('/');

  // ── 3. Inject the tokens into localStorage in the SDK's exact format ────
  await page.evaluate(({ tokens, clientId, audience, scope }) => {
    // Key format: @@auth0spajs@@::<client_id>::<audience>::<scope>
    // (Spaces in scope are preserved, NOT URL-encoded.)
    const cacheKey = `@@auth0spajs@@::${clientId}::${audience}::${scope}`;

    // Decode the id_token so the SDK can hydrate user info via getUser() /
    // getIdTokenClaims() without an extra network call.
    function urlBase64DecodeJson(seg: string) {
      const padded = seg.replace(/-/g, '+').replace(/_/g, '/');
      // atob doesn't tolerate non-padded base64 in some browsers
      const padding = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
      return JSON.parse(atob(padded + padding));
    }
    const [encHeader, encPayload, encSignature] = tokens.id_token.split('.');
    const decodedToken = {
      encoded: { header: encHeader, payload: encPayload, signature: encSignature },
      header:  urlBase64DecodeJson(encHeader),
      claims:  urlBase64DecodeJson(encPayload),
      user:    urlBase64DecodeJson(encPayload),
    };

    const entry = {
      body: {
        client_id:     clientId,
        access_token:  tokens.access_token,
        id_token:      tokens.id_token,
        refresh_token: tokens.refresh_token,
        scope,
        audience,
        expires_in:    tokens.expires_in,
        decodedToken,
      },
      expiresAt: Math.floor(Date.now() / 1000) + tokens.expires_in,
    };

    localStorage.setItem(cacheKey, JSON.stringify(entry));
  }, { tokens, clientId: AUTH0_CLIENT_ID, audience: AUTH0_AUDIENCE, scope: AUTH0_SCOPE });

  // ── 4. Verify the SDK actually accepts the injected session ─────────────
  // Reload so js/auth.js re-runs its init against the populated localStorage,
  // then wait for the POSITIVE signal that auth fully succeeded:
  // window.IBAuth.ready resolves only after Auth0 SDK init AND the
  // auth-callback Edge Function both approve. Any failure in the chain (cache
  // miss, scope/audience mismatch, callback denial, logout redirect) leaves
  // the Promise unresolved.
  //
  // Why not just check the login button isn't visible? Because that's a
  // negative signal under timing pressure. On slow CI networks the auth
  // pipeline can take longer than the wait window — the login overlay
  // eventually renders AFTER setup has already saved a half-baked storageState
  // (e.g. mid-logout-redirect), producing a silent setup ✓ and every spec
  // unauthenticated. Waiting on IBAuth.ready is robust because it's the same
  // signal js/app.js uses to gate loadProjects().
  await page.reload();

  const authResult = await page.evaluate(async () => {
    const ib = (window as unknown as { IBAuth?: { ready?: Promise<void> } }).IBAuth;
    if (!ib?.ready) {
      return { ok: false, reason: 'window.IBAuth.ready missing — js/auth.js failed to load' };
    }
    return Promise.race<{ ok: boolean; reason: string }>([
      ib.ready.then(() => ({ ok: true, reason: 'IBAuth.ready resolved' })),
      new Promise((resolve) => setTimeout(
        () => resolve({ ok: false, reason: 'IBAuth.ready did not resolve within 30s' }),
        30_000,
      )),
    ]);
  });

  if (!authResult.ok) {
    const diag = await page.evaluate(() => ({
      keys: Object.keys(localStorage).filter(k => k.startsWith('@@auth0spajs@@')),
      loginOverlayPresent: !!document.getElementById('ibLoginBtn'),
    }));
    throw new Error(
      `Auth setup did not take: ${authResult.reason}\n` +
      `Expected SDK to find key suffix ::${AUTH0_AUDIENCE}::${AUTH0_SCOPE}\n` +
      `localStorage @@auth0spajs@@ keys present: ${JSON.stringify(diag.keys)}\n` +
      `Login overlay rendered: ${diag.loginOverlayPresent}\n` +
      `Common causes:\n` +
      `  - scope mismatch (js/auth.js's useRefreshTokens appends offline_access)\n` +
      `  - audience mismatch with js/auth.js\n` +
      `  - auth-callback Edge Function denied the user's email domain (allowlist: intelligentbuildings.com, stiles.com)\n` +
      `  - SCOUT_TEST_EMAIL / SCOUT_TEST_PASSWORD secrets misconfigured in CI`
    );
  }

  // Belt-and-braces: confirm the cache entry survived the auth chain. The SDK
  // may rotate the refresh token during init; if that rotation fails the
  // entry can be cleared even though .ready already resolved on the first
  // valid lookup. Saving an empty storageState makes every spec fail.
  const cacheKeysAfter = await page.evaluate(() =>
    Object.keys(localStorage).filter(k => k.startsWith('@@auth0spajs@@'))
  );
  if (cacheKeysAfter.length === 0) {
    throw new Error(
      `Auth setup completed but SDK cleared the cache entry after init. ` +
      `Likely cause: refresh-token rotation failure. ` +
      `Try disabling refresh-token rotation on the Auth0 Application, or ` +
      `removing useRefreshTokens from js/auth.js for the test flow.`
    );
  }

  // ── 5. Save storage state for the other projects to reuse ───────────────
  fs.mkdirSync(path.dirname(AUTH_STATE_PATH), { recursive: true });
  await page.context().storageState({ path: AUTH_STATE_PATH });
});
