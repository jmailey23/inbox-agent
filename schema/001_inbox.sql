-- inbox-agent schema.
--
-- The same shape as src/types.ts and production's Supabase tables, with the
-- rules that matter enforced by the database rather than the app:
--
--   * a user reads their own settings, runs and decisions, and nobody else's
--   * runs and decisions are written by the server only; a signed in user can
--     resolve their own decisions (Keep, Block) but never create one
--   * one decision per message per user, so a repeated run cannot duplicate it
--
-- The policies are production's, as deployed. Portable Postgres: on Supabase,
-- replace app_uid() with auth.uid().


create table user_settings (
  user_id               uuid primary key,
  spam_score_threshold  float  not null default 0.5,   -- the appetite dial
  auto_trash_after_days int    not null default 30,
  whitelist_emails      text[] not null default '{}',  -- Keep
  whitelist_domains     text[] not null default '{}',
  blocklist_domains     text[] not null default '{}',  -- Block
  updated_at            timestamptz not null default now()
);

create table job_runs (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null,
  gmail_email         text not null,
  started_at          timestamptz not null default now(),
  completed_at        timestamptz,
  status              text not null default 'running',  -- running | completed | failed
  mode                text,                              -- clean | maintain
  backlog_size        int,
  emails_processed    int not null default 0,
  emails_unsubscribed int not null default 0,
  emails_flagged      int not null default 0,
  emails_skipped      int not null default 0,
  errors              int not null default 0,
  error_message       text
);
create index job_runs_user_started on job_runs (user_id, started_at desc);

-- Production calls this flagged_emails. It holds every decision, not only
-- flags: the status says whether a person still has to look at it.
create table flagged_emails (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null,
  gmail_email      text not null,
  gmail_message_id text not null,
  sender           text not null,
  sender_domain    text not null,
  subject          text not null,
  spam_score       float not null,
  detection_reason text,
  status           text not null default 'pending',  -- pending | resolved
  resolution       text,  -- clean | skipped | unsubscribe | blocked | whitelist
  resolved_at      timestamptz,
  trashed_at       timestamptz,
  job_run_id       uuid references job_runs,
  created_at       timestamptz not null default now(),
  -- Idempotency: the engine upserts on this, so seeing a message twice is a no-op.
  unique (user_id, gmail_message_id)
);

-- The two housekeeping sweeps, each a bounded index seek rather than a scan.
-- Stale flags by score: which pending rows Gary was leaning toward eating.
create index idx_flagged_pending_score on flagged_emails (user_id, spam_score, created_at)
  where status = 'pending';
-- Eaten mail due for Trash, oldest first. Kept and pending rows are not in it.
create index idx_flagged_trash_due on flagged_emails (user_id, resolved_at)
  where trashed_at is null and resolution in ('unsubscribe', 'blocked');

-- ── who is asking ────────────────────────────────────────────────────────

create function app_uid() returns uuid language sql stable as $$
  select nullif(current_setting('app.uid', true), '')::uuid
$$;

-- ── row level security ───────────────────────────────────────────────────

alter table user_settings  enable row level security;
alter table job_runs       enable row level security;
alter table flagged_emails enable row level security;

create policy settings_own on user_settings for all using (app_uid() = user_id);

create policy runs_read_own on job_runs for select using (app_uid() = user_id);

create policy decisions_read_own   on flagged_emails for select using (app_uid() = user_id);
create policy decisions_update_own on flagged_emails for update using (app_uid() = user_id);
