-- Migration: Apollo phone cache for async phone reveals
-- Paste into: Supabase Dashboard → SQL Editor → Run

create table if not exists apollo_phone_cache (
  id               uuid primary key default gen_random_uuid(),
  apollo_person_id text unique not null,
  email            text,
  phone            text,
  status           text default 'pending',  -- 'pending', 'found', 'not_found'
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

create index if not exists apc_email_idx        on apollo_phone_cache(email);
create index if not exists apc_status_idx       on apollo_phone_cache(status);

-- RLS (open — this is backend-to-backend)
alter table apollo_phone_cache enable row level security;
create policy "apc_all" on apollo_phone_cache for all using (true) with check (true);

-- Enable Realtime for live UI updates
alter publication supabase_realtime add table apollo_phone_cache;
