-- Migration: Add IB Scout storage columns to projects table
-- Run this in Supabase SQL Editor

alter table projects
  add column if not exists scout_brief      jsonb,
  add column if not exists scout_brief_at   timestamptz;
