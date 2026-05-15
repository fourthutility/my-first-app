-- Migration: push_subscriptions — Web Push device subscriptions
--
-- One row per (user, device endpoint). When the user grants notification
-- permission and subscribes via the Push API, the client POSTs the
-- resulting PushSubscription object to /functions/v1/push-subscribe which
-- writes a row here. At pipeline completion, the ib-scout edge function
-- looks up all subscriptions for the user_sub that triggered the scout
-- and sends a Web Push to each endpoint.
--
-- Run in Supabase SQL Editor.

create table if not exists push_subscriptions (
  id            uuid not null default gen_random_uuid() primary key,
  user_sub      text not null,
  device_label  text,
  endpoint      text not null,
  p256dh        text not null,
  auth          text not null,
  expires_at    timestamptz,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  unique (user_sub, endpoint)
);

create index if not exists push_subscriptions_user_sub_idx
  on push_subscriptions(user_sub);

alter table push_subscriptions enable row level security;

-- All writes go through the push-subscribe edge function using the
-- service role key. Anon role has no policies → can't read/write.
-- (If you ever want client-side reads, add a select policy gated by
--  the JWT's sub claim.)

-- Also: link scout_jobs to the user who kicked it off so we know who
-- to notify when the pipeline completes.
alter table scout_jobs
  add column if not exists triggered_by_user_sub text;
