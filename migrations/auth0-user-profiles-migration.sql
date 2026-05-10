-- ============================================================
--  IB Scout — Auth0 user_profiles table
--  Run in: Supabase Dashboard → SQL Editor → New Query → Run
--  Required before the auth-callback Edge Function will succeed.
-- ============================================================

create table if not exists user_profiles (
  id            uuid        primary key default gen_random_uuid(),
  auth0_sub     text        not null unique,
  email         text        not null,
  full_name     text,
  email_domain  text,
  created_at    timestamptz not null default now()
);

create index if not exists user_profiles_email_domain_idx
  on user_profiles (email_domain);

-- RLS intentionally left disabled in this phase.
-- Service-role writes via the auth-callback Edge Function bypass RLS regardless.
-- When RLS is added later, recommended starter policy:
--
--   alter table user_profiles enable row level security;
--   create policy "users read own profile"
--     on user_profiles for select
--     using (auth.jwt() ->> 'sub' = auth0_sub);
