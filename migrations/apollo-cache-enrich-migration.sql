-- Extend apollo_phone_cache to store full contact data
-- so we never pay Apollo credits for the same person twice.
ALTER TABLE apollo_phone_cache
  ADD COLUMN IF NOT EXISTS name         TEXT,
  ADD COLUMN IF NOT EXISTS title        TEXT,
  ADD COLUMN IF NOT EXISTS linkedin_url TEXT;
