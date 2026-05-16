-- ============================================================
--  IB Scout — Portfolio Scout v1 field additions
--  Run in: Supabase Dashboard → SQL Editor → New Query → Run
--
--  Extends portfolio_candidates with the fields v1 needs:
--    - Detail-page link + extra fields (image, year built) for the
--      per-row enrichment action.
--    - Property Management company + its own confidence signal,
--      separated from the overall candidate confidence because the
--      PM value comes from a different pipeline (publisher default
--      or web-search enrichment) than the rest of the row.
--    - extraction_method as method-of-record provenance — which
--      path produced the row (haiku_html / sitemap / skip:*).
--    - enriched_at timestamps the per-row Enrich button.
--    - parcel_id reserved per the strategic doc (Ring 2 parcel-
--      anchored architecture); v1 leaves it null.
--
--  Idempotent: ADD COLUMN IF NOT EXISTS is safe to re-run.
-- ============================================================

alter table portfolio_candidates
  add column if not exists extracted_image_url          text,
  add column if not exists extracted_detail_url         text,
  add column if not exists extracted_year_built         integer,
  add column if not exists property_management_company  text,
  add column if not exists pm_confidence                text,
  add column if not exists enriched_at                  timestamptz,
  add column if not exists extraction_method            text,
  add column if not exists parcel_id                    text;

create index if not exists portfolio_candidates_pm_idx
  on portfolio_candidates (property_management_company);
