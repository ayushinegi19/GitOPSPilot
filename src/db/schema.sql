-- GitOpsPilot database schema
-- Run this once against your Supabase Postgres database (SQL Editor or psql).

create extension if not exists pgcrypto;

create table if not exists pipeline_runs (
  id uuid primary key default gen_random_uuid(),
  triggered_by text,
  status text not null default 'running',
  started_at timestamp not null default now(),
  finished_at timestamp
);

create table if not exists pipeline_stages (
  id uuid primary key default gen_random_uuid(),
  pipeline_run_id uuid references pipeline_runs(id) on delete cascade,
  stage_name text not null,
  status text not null default 'pending',
  output text,
  started_at timestamp,
  finished_at timestamp
);

create table if not exists deployments (
  id uuid primary key default gen_random_uuid(),
  image_tag text not null,
  status text not null check (status in ('live', 'rolled_back', 'failed')),
  deployed_at timestamp not null default now(),
  rollback_reason text
);

create index if not exists idx_pipeline_stages_run_id on pipeline_stages(pipeline_run_id);
create index if not exists idx_deployments_status on deployments(status);
create index if not exists idx_deployments_deployed_at on deployments(deployed_at desc);
