-- ============================================================
--  IB Scout — projects.property_management_company column
--  Run in: Supabase Dashboard → SQL Editor → New Query → Run
--
--  Portfolio Scout extracts property_management_company from
--  owner portfolio pages (Pipeline 1 publisher-implied default,
--  Pipeline 2 detail-page extraction + web-search verification +
--  leasing-contact email-domain heuristic). The portfolio_
--  candidates staging table already has this column; the
--  projects table did not, which meant the merge_preview action
--  blew up on a "column does not exist" Postgres error every
--  time a BD rep clicked Update Scout on a dedupe-matched
--  candidate (PostgreSQL 42703). This migration closes the gap.
--
--  Coupling:
--    - portfolio-scout-scrape merge_preview SELECT clause needs
--      this column to exist
--    - portfolio-scout.html MERGE_FIELDS maps the candidate's PM
--      onto this column when the operator confirms a merge
--    - The Scout report can render PM in its "📋 Data sources"
--      strip once values start landing here
--
--  Idempotent: ADD COLUMN IF NOT EXISTS is safe to re-run.
-- ============================================================

alter table projects
  add column if not exists property_management_company text;

-- Index for PM-firm lookups (BD reports filtering by manager,
-- HubSpot sync queries looking up all buildings for a PM firm).
create index if not exists projects_property_management_company_idx
  on projects (property_management_company);
