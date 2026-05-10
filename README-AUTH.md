# IB Scout — Auth0 Gated Access

This branch puts an Auth0 login gate in front of IB Scout. After this lands,
unauthenticated users see a sign-in screen; authenticated users see the
existing app unchanged. Domain allowlist
(`@intelligentbuildings.com`, `@stiles.com`) is enforced inside Auth0 by a
Post-Login Action — not duplicated in app code.

## What changed

- **`js/auth.js`** (new) — Auth0 SPA SDK wrapper. Loaded before `app.js` /
  `bd-feed.html` script. Blocks render until login completes. Exposes
  `window.IBAuth.{ready, getAccessToken, getIdToken, getUser, logout}`.
- **`index.html`, `bd-feed.html`** — load `js/auth.js`. Init code is gated on
  `IBAuth.ready`.
- **`js/app.js`** — all Edge Function calls now go through `_ibFnFetch()`,
  which attaches the Auth0 access token. The deprecated `APP_SECRET` constant
  is still defined (set to `''`) so any straggler reference doesn't throw, but
  no headers carry it anymore.
- **5 Edge Functions** (`ai-brief`, `contact-enrich`, `hubspot-push`,
  `ib-scout`, `contact-search`) — each function now accepts **either** an
  Auth0 access token (new path) **or** the legacy `x-app-secret` header
  (transitional fallback) via a shared `authorize()` helper. Auth0 is tried
  first; if that fails or no token is present, the `x-app-secret` value is
  checked against `APP_SECRET`. The legacy path is removed in a follow-up
  cleanup PR after production cuts over. CORS allowlist now accepts Netlify
  branch-deploy URLs (`<branch>--ibscout.netlify.app`), not just PR previews.
- **`contact-search`** — only the *user-facing* path was switched. The Apollo
  phone webhook receiver (`?action=apollo_phone_webhook&secret=...`) still
  uses `APP_SECRET`, because Apollo can't send an Auth0 JWT.
- **`supabase-functions/auth-callback/`** (new) — small function that the
  frontend hits once after login. Verifies the Auth0 ID token, then upserts a
  row into `user_profiles` (idempotent on `auth0_sub`) using the
  service-role key. Defense-in-depth: re-checks `email_domain` against the
  IB/Stiles allowlist.
- **`migrations/auth0-user-profiles-migration.sql`** (new) — DDL for the new
  `user_profiles` table.

## What's deferred (out of scope for this branch)

- RLS policies on any table (incl. `user_profiles` itself)
- Role-based permissions
- Reading from `user_profiles` anywhere in the app — the row is captured for
  future use only
- Path A (Supabase third-party auth for Auth0). With Edge Functions verifying
  tokens themselves, Path A is no longer required for v1. Worth turning on
  later when we add RLS — see "Phase 2 hardening" below.
- Removing the Supabase anon key from `js/app.js` and `bd-feed.html` (still
  needed for direct PostgREST reads since RLS is deferred)
- Async polling architecture for the iPhone battery-saver bug
- Public/tokenized share links, MFA, custom Auth0 branding

## Pre-deploy checklist (do these first)

### 1. Run the SQL migration

In Supabase Dashboard → SQL Editor → New Query, paste and run:

```
migrations/auth0-user-profiles-migration.sql
```

### 2. Auth0 setup (Shannon)

**Application** (already created): SPA, name `IB Scout`. Confirm:
- Application Type: Single Page Application
- Token Endpoint Authentication Method: None
- Grant Types: Authorization Code, Refresh Token

**API resource** (new — needs to be created):
- Auth0 Dashboard → Applications → APIs → Create API
- Name: `IB Scout API`
- Identifier (audience): `https://scout-api.intelligentbuildings.com`
  (logical — does not have to resolve)
- Signing Algorithm: RS256

**Allowlist URLs** — add to Allowed Callback URLs, Allowed Logout URLs,
Allowed Web Origins, and Allowed Origins (CORS):

```
https://scout.intelligentbuildings.com
https://claude-auth0-gated-access-NJ7CX--ibscout.netlify.app
http://localhost:8080
```

(Auth0 wildcards work only as the leftmost full subdomain, so we add one URL
per active branch as testing progresses. The pattern is
`https://<branch-name>--ibscout.netlify.app` where `/` in the branch becomes
`-`.)

**Post-Login Action** (already in place per project brief): keep enforcing
the `@intelligentbuildings.com` / `@stiles.com` allowlist. The
`auth-callback` function re-checks this as defense-in-depth, but Auth0
remains the source of truth.

### 3. Supabase Edge Function secrets

Add (Dashboard → Project Settings → Edge Functions → Secrets):

| Key              | Value                                              | Notes                                                   |
| ---------------- | -------------------------------------------------- | ------------------------------------------------------- |
| `AUTH0_DOMAIN`   | `sales-intelligentbuildings.us.auth0.com`          | No protocol, no trailing slash                          |
| `AUTH0_AUDIENCE` | `https://scout-api.intelligentbuildings.com`       | Must match the API identifier registered in Auth0      |
| `AUTH0_SPA_CLIENT_ID` | `wFUijOO34dwCDI1CYubWRFRoVkIX4can`            | Used by `auth-callback` to verify ID token audience    |
| `SB_URL`         | `https://lnldwxttyfjmaobluciy.supabase.co`         | Used by `auth-callback`                                 |
| `SB_SERVICE_KEY` | (existing service-role key — already set)          | Used by `auth-callback` for the upsert                  |
| `APP_SECRET`     | (rotate — see below)                               | Now only used by the Apollo webhook path inside `contact-search` |

`APP_SECRET` is required during the Auth0 rollout window:
- Legacy fallback in the 5 user-facing functions (Option A — keeps production
  working until it cuts over to the auth-gated build).
- Permanent need for the Apollo phone webhook receiver inside `contact-search`.

**Do not rotate it now.** Production frontend code still has the value
`ib-scout-2026` bundled into `js/app.js`. Rotating during the testing window
breaks production. Rotation happens in Phase 8 (post-cutover cleanup) along
with removing the legacy fallback path entirely.

### 4. Deploy Edge Functions with `--no-verify-jwt`

The Supabase gateway's default JWT check would reject Auth0 tokens unless
Path A (third-party auth) is configured. Each touched function verifies the
Auth0 token in code, so deploy with the gateway check disabled:

```bash
supabase functions deploy auth-callback --no-verify-jwt
supabase functions deploy ai-brief       --no-verify-jwt
supabase functions deploy contact-enrich --no-verify-jwt
supabase functions deploy hubspot-push   --no-verify-jwt
supabase functions deploy ib-scout       --no-verify-jwt
supabase functions deploy contact-search --no-verify-jwt
```

The two unused webhook functions (`apollo-phone-webhook`, `scout-og`) are
not touched by this branch.

## How to test (preview branch)

1. Push the branch — Netlify auto-builds
   `https://claude-auth0-gated-access-NJ7CX--ibscout.netlify.app`.
2. Open it in a private window. You should land on the IB Scout login screen.
3. Click "Sign in with Auth0" → Auth0 universal login → sign up with an
   `@intelligentbuildings.com` email (verify via email link).
4. After redirect back, the app should load normally. Verify in the browser
   console that `auth-callback` returned 200 and a `profile` row.
5. In Supabase SQL Editor: `select * from user_profiles;` — your row should
   appear with `auth0_sub`, `email`, `email_domain = 'intelligentbuildings.com'`.
6. Test that an unauthenticated browser tab on the same URL redirects to the
   login screen.
7. Test the auth gate on `bd-feed.html` (linked from the header).
8. Test a few Edge-Function-driven actions: HubSpot push, AI Brief, IB Scout
   pipeline run. All should work; logs in Supabase should show successful
   token verification.
9. Sign out (programmatic — `IBAuth.logout()` from console for now; no UI
   button yet) and verify you bounce back to the login screen.

## Heads-up: existing Playwright tests

`tests/smoke.spec.ts` etc. hit `/` and assert against the IB Scout header.
With the auth gate live, those will now hit the login screen and fail.
Updating them to log in via Auth0 (or stub the session) is out of scope for
this branch — flagging so the next CI run isn't a surprise.

## Known residual exposures (acknowledged, deferred)

- **Anon key still in source.** `js/app.js` and `bd-feed.html` continue to
  expose the Supabase anon key for direct PostgREST reads. With no RLS, a
  scraped anon key still reads everything in `projects` etc. The auth gate
  is a UI-level gate, not a data-level gate. Closing this requires Path A
  + RLS (Phase 2).
- **`APP_SECRET` is rotatable but still in the Apollo webhook URL.** If
  Apollo logs are ever leaked, the new secret leaks with them. Acceptable
  for an Apollo-only callback path; revisit if scope grows.

## Phase 2 hardening (not in this branch)

When you're ready to remove the residual exposures:

1. Enable Supabase third-party auth for Auth0 (dashboard → Authentication →
   Third-Party Auth → add provider; issuer
   `https://sales-intelligentbuildings.us.auth0.com/`).
2. Remove the anon key from `js/app.js` and `bd-feed.html`. Update
   `sbFetch` to use the Auth0 access token in the `Authorization` header
   and a generic publishable key (or no key) in `apikey`.
3. Add RLS on `projects` and any other table you don't want world-readable.
   Starter policy: `using (auth.jwt() ->> 'sub' is not null)` for read,
   tighten from there.
4. Optionally re-enable `verify_jwt = true` on each Edge Function (drop the
   `--no-verify-jwt` flag at deploy) since Path A makes the gateway check
   pass on Auth0 tokens.
