-- IB Scout: add hubspot_deal_stage column to projects
-- Run in Supabase Dashboard → SQL Editor

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS hubspot_deal_stage TEXT;
