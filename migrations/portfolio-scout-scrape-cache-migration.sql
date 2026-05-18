-- ============================================================
--  IB Scout — Portfolio Scout scrape cache
--  Run in: Supabase Dashboard → SQL Editor → New Query → Run
--
--  Caches the candidate set produced by the portfolio-scout-scrape
--  edge function, keyed by normalized URL. Static building data
--  doesn't change often, so re-scraping the same directory on every
--  request burns Haiku tokens and ScrapingAnt credits for no
--  meaningful change. Default TTL is 14 days; a `force_refresh`
--  flag on the scrape request bypasses the cache and overwrites
--  the row.
--
--  Dedupe runs against the LIVE projects table on every scrape
--  (cache hit or miss), so a cached candidate set can still pick
--  up newly-added projects without re-extraction.
--
--  Skip outcomes (skip:cloudflare, skip:fund_structure, errors)
--  are NOT cached — the next request gets a fresh attempt.
--
--  Idempotent: CREATE TABLE IF NOT EXISTS is safe to re-run.
-- ============================================================

create table if not exists scrape_cache (
  id              uuid        primary key default gen_random_uuid(),

  -- normalized URL — lowercased, trailing slash stripped, query
  -- string preserved (some directories paginate via ?page=2).
  -- UNIQUE so the edge function can UPSERT on it.
  url_normalized  text        not null unique,

  -- which tier produced this result: static_fetch | cloudflare_bypass |
  -- json_ld | haiku_html | haiku_html_headless | sitemap | etc.
  method          text        not null,

  -- denormalized for cheap status-line rendering without parsing
  -- the payload JSON.
  candidate_count integer     not null,

  -- the full SSE event payload as it would be re-emitted:
  --   { candidates: [...], publisher: {...}, attribution: {...},
  --     suggestions: [...], meta: {...} }
  -- shape mirrors what the `complete` event carries on a fresh
  -- scrape, minus the dedupe annotations (those re-run live).
  payload         jsonb       not null,

  -- denormalized for "Cached for <publisher>, N days ago" status
  -- copy without parsing payload.
  publisher_name  text,

  scraped_at      timestamptz not null default now(),
  expires_at      timestamptz not null default (now() + interval '14 days')
);

create index if not exists scrape_cache_expires_idx
  on scrape_cache (expires_at);

-- RLS: matches the portfolio_candidates pattern. Edge function
-- writes with the service role and bypasses RLS regardless;
-- this policy keeps anon reads possible for future debug surfaces.
alter table scrape_cache enable row level security;
create policy "scrape_cache_all"
  on scrape_cache for all using (true) with check (true);
