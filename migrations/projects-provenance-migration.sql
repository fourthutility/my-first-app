-- ============================================================
--  IB Scout — projects.provenance JSONB column
--  Run in: Supabase Dashboard → SQL Editor → New Query → Run
--
--  Tracks where each field on a project row came from. Per-field
--  entries are keyed by the project column name (year_built,
--  total_available_sf, etc.) and carry source + url + timestamp:
--
--    {
--      "year_built": {
--        "source":     "portfolio_scout",
--        "url":        "https://www.stiles.com",
--        "updated_at": "2026-05-16T18:30:00Z"
--      },
--      "total_available_sf": { ... }
--    }
--
--  Source vocabulary (allowlisted on the write path):
--    portfolio_scout — written by the Portfolio Scout
--                      Approve or Merge action.
--    (future: attom, csv_import, manual_edit, ai_brief)
--
--  Existing rows default to {} — the Scout report renders the
--  field without a provenance indicator in that case.
--
--  Idempotent: ADD COLUMN IF NOT EXISTS is safe to re-run.
-- ============================================================

alter table projects
  add column if not exists provenance jsonb not null default '{}'::jsonb;

-- GIN index for JSONB lookups by field key. Useful for queries
-- like "show me every row where year_built came from Portfolio
-- Scout" — a near-term analytics pattern as the source mix grows.
create index if not exists projects_provenance_gin_idx
  on projects using gin (provenance jsonb_path_ops);
