-- ============================================================
--  IB South End Tracker — Supabase Setup
--  Paste this entire file into:
--  Supabase Dashboard → SQL Editor → New Query → Run
-- ============================================================

-- 1. CREATE TABLE
create table if not exists projects (
  id               uuid        default gen_random_uuid() primary key,
  address          text        not null,
  status           text,
  use_type         text,
  owner_developer  text,
  architect        text,
  general_contractor text,
  ib_stage         text,
  stiles_interest  text,
  permit_status    text,
  key_contacts     text,
  notes            text,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

-- 2. ROW LEVEL SECURITY
--    Anon key is safe to expose in public GitHub repos because
--    RLS controls what it can actually do.
alter table projects enable row level security;

-- Allow anyone to read
create policy "public_read"   on projects for select using (true);
-- Allow anyone to insert/update/delete (single-user tracker, no auth needed yet)
create policy "public_insert" on projects for insert with check (true);
create policy "public_update" on projects for update using (true);
create policy "public_delete" on projects for delete using (true);

-- 3. AUTO-UPDATE updated_at ON SAVE
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_updated_at on projects;
create trigger set_updated_at
  before update on projects
  for each row execute function update_updated_at();

-- 4. SEED — 28 South End Charlotte buildings
insert into projects (address, status, owner_developer) values
  ('1447 S Tryon St',       'Conversion',         'Radford W. Koltz'),
  ('1102 S Tryon St',       'Planned',            'Crescent Communities'),
  ('1203 S Caldwell St',    'Planned',            'Inlivian'),
  ('125 West Blvd',         'Planned',            'Design Center Phase II LLC'),
  ('1320 S Tryon St',       'Planned',            'White Lodging'),
  ('1427 S Tryon St',       'Planned',            'Cousins Properties'),
  ('1933 South Blvd',       'Planned',            'Southern Land Company'),
  ('205 E Bland Street',    'Planned',            'Cousins Properties'),
  ('2103 S Tryon St',       'Planned',            'Portman Residential'),
  ('2401 Distribution St',  'Planned',            'Cousins Properties'),
  ('2500 Distribution St',  'Planned',            'MPV Properties'),
  ('409 Basin St',          'Planned',            'Griffin Brothers'),
  ('1120 S Tryon St',       'Planned',            'Cousins Properties'),
  ('1301 South Blvd',       'Planned',            'Inlivian'),
  ('1426 S Tryon St',       'Planned',            'Highwood Properties'),
  ('1600 Camden Rd',        'Planned',            'Harris Development Group LLC'),
  ('1601 South Blvd',       'Planned',            'Sterling Bay'),
  ('1603 South Blvd',       'Planned',            'Sterling Bay'),
  ('1728 South Blvd',       'Planned',            'MRP Realty'),
  ('2120 S Tryon',          'Planned',            'Vision Ventures'),
  ('2132 Hawkins St',       'Planned',            'Omersha Holdings LLC'),
  ('216 E Worthington Ave', 'Planned',            'Centrum Realty & Development'),
  ('2915 Griffith St',      'Planned',            'George Barrett'),
  ('300 W Tremont Ave',     'Planned',            'Cousins Properties'),
  ('1111 S Tryon St',       'Under Construction', 'Riverside Investment & Development'),
  ('1726 S Tryon St',       'Under Construction', 'Panorama Holdings'),
  ('2810 S Tryon St',       'Under Construction', 'Avery Hall Investments'),
  ('510 W Tremont Ave',     'Under Construction', 'Northwood Investors LLC');

-- Done! You should see 28 rows in the projects table.
-- select count(*) from projects;
