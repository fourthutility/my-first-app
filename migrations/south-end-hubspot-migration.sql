-- Migration: Add HubSpot tracking columns to projects table
-- Paste into: Supabase Dashboard → SQL Editor → Run

alter table projects
  add column if not exists hubspot_deal_id  text,
  add column if not exists hubspot_deal_url text,
  add column if not exists hubspot_pushed_at timestamptz;
