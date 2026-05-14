-- Migration: scout_jobs — per-project async pipeline state
--
-- One row per project. The IB Scout edge function inserts/upserts a row on POST,
-- kicks off the pipeline via EdgeRuntime.waitUntil, and updates `phase` + `status`
-- as work progresses. The frontend polls this row instead of holding a long fetch
-- open — which is what was failing silently on iPhone (Safari throttles long
-- fetches when the tab loses focus or Low Power Mode kicks in).
--
-- Run in Supabase SQL Editor.

create table if not exists scout_jobs (
  project_id    uuid primary key references projects(id) on delete cascade,
  status        text not null default 'running'
                  check (status in ('running','done','error')),
  phase         text not null default 'queued',
  error         text,
  address       text,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  updated_at    timestamptz not null default now()
);

create index if not exists scout_jobs_status_idx on scout_jobs(status);

alter table scout_jobs enable row level security;

-- Read is public (same posture as projects.scout_brief, which is already public).
-- Writes go through the edge function with the service role key, so no insert/
-- update/delete policies are exposed to anon.
drop policy if exists "scout_jobs_public_read" on scout_jobs;
create policy "scout_jobs_public_read" on scout_jobs for select using (true);

create or replace function scout_jobs_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists scout_jobs_set_updated_at on scout_jobs;
create trigger scout_jobs_set_updated_at
  before update on scout_jobs
  for each row execute function scout_jobs_touch_updated_at();
