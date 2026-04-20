-- Migration: Contacts table for IB Scout
-- Paste into: Supabase Dashboard → SQL Editor → Run

create table if not exists contacts (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid references projects(id) on delete cascade,
  name             text not null,
  title            text,
  email            text,
  phone            text,
  linkedin_url     text,
  source           text,           -- 'HubSpot', 'Apollo', 'Manual'
  hubspot_contact_id text,         -- HubSpot contact ID if pushed
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

-- Index for fast lookup by project
create index if not exists contacts_project_id_idx on contacts(project_id);

-- RLS (open for now, lock down when Auth0 is added)
alter table contacts enable row level security;
create policy "contacts_all" on contacts for all using (true) with check (true);
