-- ============================================================
--  IB Scout — Portfolio Scout dedupe-detection fields
--  Run in: Supabase Dashboard → SQL Editor → New Query → Run
--
--  Adds two columns populated at scrape time when the extractor
--  detects that a candidate's normalized address matches an
--  existing row in the projects table.
--
--    duplicate_of_project_id   FK back to the matched project row
--    duplicate_match_address   The original (non-normalized)
--                              address string from the matched
--                              project, for display in the
--                              verification grid
--
--  The match is point-in-time of scrape. If a project is added to
--  inventory after a candidate is staged, the candidate's
--  duplicate flag stays stale until the operator re-scrapes —
--  acceptable for v1 since the scrape-review-approve loop is
--  meant to be tight.
--
--  Conservative match strategy: normalized exact match only
--  (case + punctuation + common abbreviations + directionals).
--  No fuzzy matching, no Sonnet adjudication. False negatives
--  are expected; false positives essentially zero.
--
--  Idempotent: ADD COLUMN IF NOT EXISTS is safe to re-run.
-- ============================================================

alter table portfolio_candidates
  add column if not exists duplicate_of_project_id  uuid references projects(id) on delete set null,
  add column if not exists duplicate_match_address  text;

-- Partial index — only the (typically minority of) candidates that
-- actually matched a project. Keeps the index small.
create index if not exists portfolio_candidates_dup_idx
  on portfolio_candidates (duplicate_of_project_id)
  where duplicate_of_project_id is not null;
