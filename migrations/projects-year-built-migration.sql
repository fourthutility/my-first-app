-- ============================================================
--  IB Scout — projects.year_built column
--  Run in: Supabase Dashboard → SQL Editor → New Query → Run
--
--  Portfolio Scout extracts year_built from owner portfolio pages
--  but had nowhere to write it on the projects table. This adds
--  the column so the Approve and Merge flows can persist
--  vintage data for new construction and recent deliveries —
--  important for the energy-cost and BD-relevance heuristics
--  in the Scout report.
--
--  Idempotent: ADD COLUMN IF NOT EXISTS is safe to re-run.
-- ============================================================

alter table projects
  add column if not exists year_built integer;

-- Useful for the Scout report's "recent deliveries" / vintage
-- filtering and for downstream analytics on the pipeline.
create index if not exists projects_year_built_idx
  on projects (year_built);
