-- ============================================================
--  IB Scout — Portfolio Scout staging table
--  Run in: Supabase Dashboard → SQL Editor → New Query → Run
--
--  Portfolio Scout is a sibling to the existing CSV import flow.
--  Candidates land here first; user reviews in the verification grid;
--  approved rows are promoted to the main `projects` table by the
--  portfolio-scout-scrape Edge Function (action=approve).
-- ============================================================

create table if not exists portfolio_candidates (
  id                    uuid        primary key default gen_random_uuid(),

  -- input provenance
  owner_name            text        not null,
  source_url            text        not null,
  raw_snippet           text,

  -- extracted candidate fields (nullable — depends on what the page had)
  extracted_name        text,
  extracted_address     text,
  extracted_city        text,
  extracted_sqft        integer,
  extracted_asset_class text,

  -- 'high' | 'medium' | 'low' — set by the extractor in later commits.
  -- Free-text rather than enum so we can re-tier without a schema change
  -- while v1 iterates on the confidence signals.
  confidence            text,

  -- 'pending' | 'approved' | 'rejected' | 'duplicate'
  status                text        not null default 'pending',

  -- audit + review trail
  created_at            timestamptz not null default now(),
  reviewed_at           timestamptz,
  reviewed_by           text,                                          -- auth0_sub of reviewer
  imported_building_id  uuid        references projects(id) on delete set null
);

create index if not exists portfolio_candidates_status_idx
  on portfolio_candidates (status);

create index if not exists portfolio_candidates_owner_idx
  on portfolio_candidates (owner_name);

create index if not exists portfolio_candidates_created_idx
  on portfolio_candidates (created_at desc);

-- RLS: mirrors the existing `contacts` pattern — open for now, since the
-- frontend reads with the anon key and the auth-callback edge function is
-- the actual access gate. Service-role writes from the edge function
-- bypass RLS regardless. Lock down with an Auth0-sub policy in a follow-up.
alter table portfolio_candidates enable row level security;
create policy "portfolio_candidates_all"
  on portfolio_candidates for all using (true) with check (true);
