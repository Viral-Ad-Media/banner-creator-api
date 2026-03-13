-- Supabase schema for Social Studio SaaS
-- Run this in the Supabase SQL editor.

create extension if not exists pgcrypto;

create table if not exists public.app_users (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  name text not null,
  plan text not null default 'FREE' check (plan in ('FREE', 'PRO', 'ENTERPRISE')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users (id) on delete cascade,
  name text not null,
  prompt text,
  aspect_ratio text check (
    aspect_ratio is null
    or aspect_ratio in ('1:1', '16:9', '9:16', '3:4', '4:5')
  ),
  data jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.generations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users (id) on delete cascade,
  project_id uuid references public.projects (id) on delete set null,
  type text not null check (type in ('BANNER_PLAN', 'IMAGE_GENERATION', 'IMAGE_EDIT')),
  status text not null check (status in ('SUCCESS', 'FAILED')),
  prompt text not null,
  aspect_ratio text check (
    aspect_ratio is null
    or aspect_ratio in ('1:1', '16:9', '9:16', '3:4', '4:5')
  ),
  input jsonb,
  result jsonb,
  error_message text,
  created_at timestamptz not null default now()
);

create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users (id) on delete cascade,
  kind text not null check (kind in ('BANNER_PLAN', 'IMAGE_GENERATION', 'IMAGE_EDIT')),
  credits integer not null check (credits > 0),
  created_at timestamptz not null default now()
);

create table if not exists public.billing_customers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.app_users (id) on delete cascade,
  provider text not null default 'stripe',
  customer_id text not null unique,
  subscription_id text,
  status text not null default 'inactive',
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_projects_user_updated
  on public.projects (user_id, updated_at desc);

create index if not exists idx_generations_user_created
  on public.generations (user_id, created_at desc);

create index if not exists idx_generations_project_created
  on public.generations (project_id, created_at desc);

create index if not exists idx_usage_events_user_created
  on public.usage_events (user_id, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_app_users_updated_at on public.app_users;
create trigger trg_app_users_updated_at
before update on public.app_users
for each row
execute function public.set_updated_at();

drop trigger if exists trg_projects_updated_at on public.projects;
create trigger trg_projects_updated_at
before update on public.projects
for each row
execute function public.set_updated_at();

drop trigger if exists trg_billing_customers_updated_at on public.billing_customers;
create trigger trg_billing_customers_updated_at
before update on public.billing_customers
for each row
execute function public.set_updated_at();

alter table public.app_users enable row level security;
alter table public.projects enable row level security;
alter table public.generations enable row level security;
alter table public.usage_events enable row level security;
alter table public.billing_customers enable row level security;

drop policy if exists app_users_select_own on public.app_users;
create policy app_users_select_own
on public.app_users
for select
using (auth.uid() = id);

drop policy if exists app_users_insert_own on public.app_users;
create policy app_users_insert_own
on public.app_users
for insert
with check (auth.uid() = id);

drop policy if exists app_users_update_own on public.app_users;
create policy app_users_update_own
on public.app_users
for update
using (auth.uid() = id)
with check (auth.uid() = id);

drop policy if exists projects_select_own on public.projects;
create policy projects_select_own
on public.projects
for select
using (auth.uid() = user_id);

drop policy if exists projects_insert_own on public.projects;
create policy projects_insert_own
on public.projects
for insert
with check (auth.uid() = user_id);

drop policy if exists projects_update_own on public.projects;
create policy projects_update_own
on public.projects
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists projects_delete_own on public.projects;
create policy projects_delete_own
on public.projects
for delete
using (auth.uid() = user_id);

drop policy if exists generations_select_own on public.generations;
create policy generations_select_own
on public.generations
for select
using (auth.uid() = user_id);

drop policy if exists generations_insert_own on public.generations;
create policy generations_insert_own
on public.generations
for insert
with check (auth.uid() = user_id);

drop policy if exists usage_events_select_own on public.usage_events;
create policy usage_events_select_own
on public.usage_events
for select
using (auth.uid() = user_id);

drop policy if exists usage_events_insert_own on public.usage_events;
create policy usage_events_insert_own
on public.usage_events
for insert
with check (auth.uid() = user_id);

drop policy if exists billing_customers_select_own on public.billing_customers;
create policy billing_customers_select_own
on public.billing_customers
for select
using (auth.uid() = user_id);

drop policy if exists billing_customers_insert_own on public.billing_customers;
create policy billing_customers_insert_own
on public.billing_customers
for insert
with check (auth.uid() = user_id);

drop policy if exists billing_customers_update_own on public.billing_customers;
create policy billing_customers_update_own
on public.billing_customers
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);
