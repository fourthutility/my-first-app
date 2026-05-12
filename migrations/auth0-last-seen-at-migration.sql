-- ============================================================
--  IB Scout — Add last_seen_at to user_profiles
--  Run in: Supabase Dashboard → SQL Editor → New Query → Run
--
--  Adds a timestamp updated on every Auth0 sign-in so admins can
--  identify inactive accounts (last_seen_at < now() - interval '90 days')
--  and clean them up during quarterly access reviews.
-- ============================================================

alter table user_profiles
  add column if not exists last_seen_at timestamptz;

-- Backfill existing rows to created_at (best historical approximation).
update user_profiles
   set last_seen_at = created_at
 where last_seen_at is null;

alter table user_profiles
  alter column last_seen_at set default now(),
  alter column last_seen_at set not null;

create index if not exists user_profiles_last_seen_idx
  on user_profiles (last_seen_at desc);
