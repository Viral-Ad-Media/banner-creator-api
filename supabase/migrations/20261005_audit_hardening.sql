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
