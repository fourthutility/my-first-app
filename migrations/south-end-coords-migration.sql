-- Migration: Add lat/lng columns to projects table
-- Paste into: Supabase Dashboard → SQL Editor → Run
-- After running this, coordinates geocoded in the app will be
-- saved permanently so every user/device loads them instantly.

alter table projects
  add column if not exists lat numeric(10, 7),
  add column if not exists lng numeric(10, 7);
