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

create table if not exists public.avatars (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users (id) on delete cascade,
  name text not null,
  image_data_url text not null,
  source text not null check (source in ('upload', 'generated')),
  prompt text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.generations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users (id) on delete cascade,
  project_id uuid references public.projects (id) on delete set null,
  type text not null check (type in ('BANNER_PLAN', 'IMAGE_GENERATION', 'IMAGE_EDIT', 'VIDEO_GENERATION')),
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
  kind text not null check (kind in ('BANNER_PLAN', 'IMAGE_GENERATION', 'IMAGE_EDIT', 'VIDEO_GENERATION')),
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

create index if not exists idx_avatars_user_updated
  on public.avatars (user_id, updated_at desc);

create index if not exists idx_generations_user_created
  on public.generations (user_id, created_at desc);

create index if not exists idx_generations_project_created
  on public.generations (project_id, created_at desc);

create index if not exists idx_usage_events_user_created
  on public.usage_events (user_id, created_at desc);

alter table public.generations
  drop constraint if exists generations_type_check;

alter table public.generations
  add constraint generations_type_check
  check (type in ('BANNER_PLAN', 'IMAGE_GENERATION', 'IMAGE_EDIT', 'VIDEO_GENERATION'));

alter table public.usage_events
  drop constraint if exists usage_events_kind_check;

alter table public.usage_events
  add constraint usage_events_kind_check
  check (kind in ('BANNER_PLAN', 'IMAGE_GENERATION', 'IMAGE_EDIT', 'VIDEO_GENERATION'));

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

drop trigger if exists trg_avatars_updated_at on public.avatars;
create trigger trg_avatars_updated_at
before update on public.avatars
for each row
execute function public.set_updated_at();

drop trigger if exists trg_billing_customers_updated_at on public.billing_customers;
create trigger trg_billing_customers_updated_at
before update on public.billing_customers
for each row
execute function public.set_updated_at();

alter table public.app_users enable row level security;
alter table public.projects enable row level security;
alter table public.avatars enable row level security;
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

drop policy if exists avatars_select_own on public.avatars;
create policy avatars_select_own
on public.avatars
for select
using (auth.uid() = user_id);

drop policy if exists avatars_insert_own on public.avatars;
create policy avatars_insert_own
on public.avatars
for insert
with check (auth.uid() = user_id);

drop policy if exists avatars_update_own on public.avatars;
create policy avatars_update_own
on public.avatars
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists avatars_delete_own on public.avatars;
create policy avatars_delete_own
on public.avatars
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

-- Additive hardening migration. Run once on existing databases; schema.sql includes it for fresh installs.
begin;
alter table public.generations add column if not exists request_key uuid;
alter table public.generations add column if not exists request_hash text;
alter table public.generations add column if not exists updated_at timestamptz not null default now();
alter table public.generations drop constraint if exists generations_status_check;
alter table public.generations add constraint generations_status_check
  check (status in ('QUEUED','RUNNING','UNKNOWN','SUCCESS','FAILED'));
-- Reconcile legacy pending videos previously mislabeled SUCCESS. Their historical usage is retained.
update public.generations set status='RUNNING' where type='VIDEO_GENERATION' and status='SUCCESS' and request_key is null and result->'job'->>'status' in ('PENDING','RUNNING');
create unique index if not exists idx_generation_request on public.generations(user_id, request_key);
alter table public.usage_events add column if not exists generation_id uuid references public.generations(id);
create unique index if not exists idx_usage_generation on public.usage_events(generation_id);

create table if not exists public.credit_reservations (
  generation_id uuid primary key references public.generations(id),
  user_id uuid not null references public.app_users(id),
  credits integer not null check(credits > 0),
  period_start timestamptz not null,
  state text not null default 'held' check(state in ('held','settled','released')),
  created_at timestamptz not null default now()
);
create index if not exists idx_reservation_balance on public.credit_reservations(user_id,period_start,state);
alter table public.credit_reservations enable row level security;
create table if not exists public.rate_limit_buckets (
  key text primary key, hits integer not null, reset_at timestamptz not null
);
alter table public.rate_limit_buckets enable row level security;

-- Ownership policies cannot protect individual columns or server-generated facts.
revoke all on public.app_users, public.projects, public.avatars, public.generations,
  public.usage_events, public.billing_customers, public.credit_reservations, public.rate_limit_buckets
  from anon, authenticated;
grant select on public.app_users, public.projects, public.avatars, public.generations,
  public.usage_events, public.billing_customers to authenticated;
grant all on public.app_users, public.projects, public.avatars, public.generations,
  public.usage_events, public.billing_customers, public.credit_reservations, public.rate_limit_buckets to service_role;

create or replace function public.enforce_generation_owner() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.project_id is not null and not exists
    (select 1 from public.projects where id=new.project_id and user_id=new.user_id) then
    raise exception 'Project not found' using errcode='P0002';
  end if;
  return new;
end $$;
drop trigger if exists generation_owner on public.generations;
create trigger generation_owner before insert or update of project_id,user_id on public.generations
for each row execute function public.enforce_generation_owner();

create or replace function public.credit_summary(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare tier text; lim integer; used bigint; held bigint;
  period timestamptz := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
begin
  select plan into strict tier from public.app_users where id=p_user_id;
  lim := case tier when 'PRO' then 3000 when 'ENTERPRISE' then 50000 else 120 end;
  select coalesce(sum(credits),0) into used from public.usage_events where user_id=p_user_id and created_at>=period;
  select coalesce(sum(credits),0) into held from public.credit_reservations where user_id=p_user_id and period_start=period and state='held';
  return jsonb_build_object('usedCredits',used,'reservedCredits',held,'remainingCredits',greatest(0,lim-used-held),'limit',lim);
end $$;

create or replace function public.reserve_generation(p_user_id uuid,p_request_key uuid,p_hash text,p_kind text,
 p_prompt text,p_aspect text,p_project_id uuid,p_input jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g public.generations; cost integer; summary jsonb;
  period timestamptz := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
begin
  perform 1 from public.app_users where id=p_user_id for update;
  if not found then raise exception 'Profile not found' using errcode='P0002'; end if;
  select * into g from public.generations where user_id=p_user_id and request_key=p_request_key;
  if found then
    if g.request_hash is distinct from p_hash or g.type is distinct from p_kind then raise exception 'Idempotency key reused with different input' using errcode='23505'; end if;
    return jsonb_build_object('generation',to_jsonb(g),'existing',true);
  end if;
  if p_project_id is not null and not exists(select 1 from public.projects where id=p_project_id and user_id=p_user_id) then
    raise exception 'Project not found' using errcode='P0002';
  end if;
  cost := case p_kind when 'BANNER_PLAN' then 3 when 'IMAGE_GENERATION' then 5 when 'IMAGE_EDIT' then 5 when 'VIDEO_GENERATION' then 25 else null end;
  if cost is null then raise exception 'Invalid generation kind' using errcode='22023'; end if;
  summary := public.credit_summary(p_user_id);
  if (summary->>'remainingCredits')::bigint < cost then raise exception 'Monthly credit limit reached' using errcode='P0001'; end if;
  insert into public.generations(user_id,request_key,request_hash,type,status,prompt,aspect_ratio,project_id,input)
    values(p_user_id,p_request_key,p_hash,p_kind,'QUEUED',p_prompt,p_aspect,p_project_id,p_input) returning * into g;
  insert into public.credit_reservations(generation_id,user_id,credits,period_start) values(g.id,p_user_id,cost,period);
  return jsonb_build_object('generation',to_jsonb(g),'existing',false);
end $$;

create or replace function public.finish_generation(p_user_id uuid,p_generation_id uuid,p_status text,p_result jsonb,p_error text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare g public.generations; r public.credit_reservations;
begin
  perform 1 from public.app_users where id=p_user_id for update;
  select * into strict g from public.generations where id=p_generation_id and user_id=p_user_id for update;
  if g.status in ('SUCCESS','FAILED') then return to_jsonb(g); end if;
  if p_status not in ('RUNNING','UNKNOWN','SUCCESS','FAILED') then raise exception 'Invalid status' using errcode='22023'; end if;
  select * into r from public.credit_reservations where generation_id=g.id for update;
  if p_status='SUCCESS' and r.state='held' then
    insert into public.usage_events(user_id,kind,credits,generation_id,created_at) values(p_user_id,g.type,r.credits,g.id,g.created_at) on conflict(generation_id) do nothing;
    update public.credit_reservations set state='settled' where generation_id=g.id;
  elsif p_status='FAILED' then
    update public.credit_reservations set state='released' where generation_id=g.id and state='held';
  end if;
  update public.generations set status=p_status,result=coalesce(p_result,result),error_message=p_error,updated_at=now()
    where id=g.id returning * into g;
  return to_jsonb(g);
end $$;

create or replace function public.create_resource(p_user_id uuid,p_kind text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare tier text; lim integer; n bigint; output jsonb;
begin
  select plan into strict tier from public.app_users where id=p_user_id for update;
  if p_kind='project' then
    lim := case tier when 'PRO' then 100 when 'ENTERPRISE' then 1000 else 5 end;
    select count(*) into n from public.projects where user_id=p_user_id;
    if n>=lim then raise exception 'Project limit reached' using errcode='P0001'; end if;
    insert into public.projects(user_id,name,prompt,aspect_ratio,data) values(p_user_id,p_payload->>'name',p_payload->>'prompt',p_payload->>'aspectRatio',p_payload->'data') returning to_jsonb(projects.*) into output;
  elsif p_kind='avatar' then
    select count(*) into n from public.avatars where user_id=p_user_id;
    if n>=12 then raise exception 'Avatar limit reached' using errcode='P0001'; end if;
    insert into public.avatars(user_id,name,image_data_url,source,prompt) values(p_user_id,p_payload->>'name',p_payload->>'imageDataUrl',p_payload->>'source',p_payload->>'prompt') returning to_jsonb(avatars.*) into output;
  else raise exception 'Invalid resource kind' using errcode='22023'; end if;
  return output;
end $$;

create or replace function public.consume_rate_limit(p_key text,p_max integer,p_window_seconds integer) returns boolean
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from public.rate_limit_buckets where key in (select key from public.rate_limit_buckets where reset_at<now() limit 100);
  insert into public.rate_limit_buckets(key,hits,reset_at) values(p_key,1,now()+make_interval(secs=>p_window_seconds))
  on conflict(key) do update set hits=case when rate_limit_buckets.reset_at<=now() then 1 else rate_limit_buckets.hits+1 end,
    reset_at=case when rate_limit_buckets.reset_at<=now() then excluded.reset_at else rate_limit_buckets.reset_at end
  returning hits into n;
  return n<=p_max;
end $$;

-- No client may invoke security-definer write procedures.
revoke all on function public.credit_summary(uuid), public.reserve_generation(uuid,uuid,text,text,text,text,uuid,jsonb),
 public.finish_generation(uuid,uuid,text,jsonb,text),public.create_resource(uuid,text,jsonb),public.consume_rate_limit(text,integer,integer)
 from public,anon,authenticated;
grant execute on function public.credit_summary(uuid), public.reserve_generation(uuid,uuid,text,text,text,text,uuid,jsonb),
 public.finish_generation(uuid,uuid,text,jsonb,text),public.create_resource(uuid,text,jsonb),public.consume_rate_limit(text,integer,integer)
 to service_role;
commit;
