begin;
alter table public.expenses add column if not exists silent boolean not null default false;
alter table public.payments add column if not exists created_by_member_id uuid references public.members(id) on delete set null;
alter table public.debt_transfers add column if not exists created_by_member_id uuid references public.members(id) on delete set null;

-- Private delivery data: never expose endpoints, secrets, or payloads to anon.
create table public.push_subscriptions (
  id uuid primary key,
  token_hash text not null,
  trip_id uuid not null references public.trips(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  expenses boolean not null default true,
  settlements boolean not null default true,
  reminders boolean not null default true,
  created_at timestamptz not null default now()
);
create index push_subscriptions_member on public.push_subscriptions(trip_id, member_id);
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;

create table public.push_jobs (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.push_subscriptions(id) on delete cascade,
  trip_id uuid not null references public.trips(id) on delete cascade,
  kind text not null,
  source_id uuid not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','sending','sent','failed','cancelled')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  last_error text,
  unique (subscription_id, kind, source_id)
);
create index push_jobs_pending on public.push_jobs(available_at) where status in ('pending','sending');
alter table public.push_jobs enable row level security;
revoke all on public.push_jobs from anon, authenticated;

create table public.push_reminders (
  trip_id uuid not null references public.trips(id) on delete cascade,
  creditor_wallet text not null,
  debtor_wallet text not null,
  sent_at timestamptz not null default now(),
  primary key (trip_id, creditor_wallet, debtor_wallet)
);
alter table public.push_reminders enable row level security;
revoke all on public.push_reminders from anon, authenticated;

create function public.enqueue_trip_push() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r jsonb; event_kind text; member_snapshot jsonb; recipients uuid[]; actor uuid; t uuid;
begin
  r := case when TG_OP = 'DELETE' then to_jsonb(OLD) else to_jsonb(NEW) end;
  t := (r->>'trip_id')::uuid;
  actor := (r->>'created_by_member_id')::uuid;
  if TG_TABLE_NAME = 'expenses' then
    if (r->>'silent')::boolean then return null; end if;
    event_kind := 'expense';
    select array_agg(distinct m.id) into recipients from public.members m
    where m.trip_id = t and (
      exists (select 1 from jsonb_array_elements(r->'splits') s
        where s->>'memberId' = m.id::text and
          ((s->>'amountMinor')::numeric > 0 or coalesce((s->>'paidMinor')::numeric, 0) > 0))
      or (m.id = (r->>'payer_id')::uuid and not exists (
        select 1 from jsonb_array_elements(r->'splits') s where s->>'paidMinor' is not null))
    );
  else
    event_kind := case when TG_TABLE_NAME = 'payments' then 'payment' else 'transfer' end;
    select array_agg(distinct m.id) into recipients from public.members m
    where m.trip_id = t and exists (
      select 1 from public.members side where side.trip_id = t
      and side.id in ((r->>'payer_id')::uuid, (r->>'receiver_id')::uuid)
      and (m.id = side.id or (side.unit is not null and m.unit = side.unit))
    );
  end if;
  if TG_OP = 'DELETE' then
    -- Cancel unsent originals; already displayed notifications get an explicit undo.
    update public.push_jobs set status = 'cancelled' where source_id = (r->>'id')::uuid
      and kind = event_kind and status in ('pending','sending');
    event_kind := event_kind || '_undo';
    actor := null; -- Deleting actor is unknown; never misattribute to original author.
  end if;
  select jsonb_agg(jsonb_build_object('id',id,'name',name,'unit',unit)) into member_snapshot
    from public.members where trip_id = t;
  insert into public.push_jobs(subscription_id,trip_id,kind,source_id,payload)
  select s.id,t,event_kind,(r->>'id')::uuid,
    jsonb_build_object('record',r,'members',member_snapshot,'recipientId',s.member_id,
      'baseCurrency',(select base_currency from public.trips where id = t))
  from public.push_subscriptions s where s.trip_id = t and s.member_id = any(recipients)
    and (actor is null or s.member_id <> actor)
    and case when TG_TABLE_NAME = 'expenses' then s.expenses else s.settlements end
  on conflict do nothing;
  return null;
end $$;
revoke all on function public.enqueue_trip_push() from public, anon, authenticated;
create trigger expense_push after insert or delete on public.expenses for each row execute function public.enqueue_trip_push();
create trigger payment_push after insert or delete on public.payments for each row execute function public.enqueue_trip_push();
create trigger transfer_push after insert or delete on public.debt_transfers for each row execute function public.enqueue_trip_push();

create function public.claim_push_jobs(batch_size integer default 30)
returns setof public.push_jobs language sql security definer set search_path = '' as $$
  update public.push_jobs set status = 'sending', attempts = attempts + 1,
    available_at = now() + interval '5 minutes'
  where id in (select id from public.push_jobs
    where status in ('pending','sending') and available_at <= now()
      and attempts < 8 and created_at > now() - interval '24 hours'
    order by created_at for update skip locked limit least(greatest(batch_size,1),50))
  returning *;
$$;
revoke all on function public.claim_push_jobs(integer) from public, anon, authenticated;
grant execute on function public.claim_push_jobs(integer) to service_role;

-- Atomic cooldown: concurrent requests cannot each enqueue a reminder.
create function public.queue_debt_reminder(t uuid, creditor text, debtor text,
  actor uuid, recipients uuid[], reminder_id uuid, data jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(t::text || creditor || debtor, 0));
  if exists(select 1 from public.push_jobs where source_id=reminder_id and kind='reminder'
      and trip_id=t and payload->'record'->>'actor_id'=actor::text
      and ((payload->'record') - 'amount') = ((data->'record') - 'amount')) then return true; end if;
  if exists (select 1 from public.push_reminders where trip_id=t
    and creditor_wallet=creditor and debtor_wallet=debtor and sent_at > now()-interval '24 hours') then
    raise exception 'REMINDER_COOLDOWN';
  end if;
  if not exists (select 1 from public.push_subscriptions
    where trip_id=t and member_id=any(recipients) and reminders) then return false; end if;
  insert into public.push_jobs(subscription_id,trip_id,kind,source_id,payload)
    select id,t,'reminder',reminder_id,data || jsonb_build_object('recipientId',member_id)
    from public.push_subscriptions where trip_id=t and member_id=any(recipients) and reminders;
  insert into public.push_reminders values (t,creditor,debtor,now())
    on conflict (trip_id,creditor_wallet,debtor_wallet) do update set sent_at=excluded.sent_at;
  return true;
end $$;
revoke all on function public.queue_debt_reminder(uuid,text,text,uuid,uuid[],uuid,jsonb) from public, anon, authenticated;
grant execute on function public.queue_debt_reminder(uuid,text,text,uuid,uuid[],uuid,jsonb) to service_role;

-- Endpoint rebinding and cancelling old queued deliveries must be one transaction.
create function public.save_push_subscription(device uuid, secret_hash text, t uuid, member uuid,
  push_endpoint text, dh text, auth_key text, prefs jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(device::text,0));
  if not exists (select 1 from public.members where id=member and trip_id=t) then raise exception 'INVALID_MEMBER'; end if;
  if exists (select 1 from public.push_subscriptions where id=device and token_hash<>secret_hash) then raise exception 'INVALID_DEVICE'; end if;
  if exists (select 1 from public.push_subscriptions where endpoint=push_endpoint and id<>device) then raise exception 'ENDPOINT_IN_USE'; end if;
  delete from public.push_jobs j where j.subscription_id=device and j.status in ('pending','sending')
    and exists (select 1 from public.push_subscriptions old where old.id=device and (
      old.trip_id<>t or old.member_id<>member or old.endpoint<>push_endpoint or old.p256dh<>dh or old.auth<>auth_key
      or (j.kind like 'expense%' and not (prefs->>'expenses')::boolean)
      or (j.kind='reminder' and not (prefs->>'reminders')::boolean)
      or (j.kind not like 'expense%' and j.kind<>'reminder' and not (prefs->>'settlements')::boolean)));
  insert into public.push_subscriptions(id,token_hash,trip_id,member_id,endpoint,p256dh,auth,expenses,settlements,reminders)
    values(device,secret_hash,t,member,push_endpoint,dh,auth_key,
      (prefs->>'expenses')::boolean,(prefs->>'settlements')::boolean,(prefs->>'reminders')::boolean)
    on conflict(id) do update set trip_id=t,member_id=member,endpoint=push_endpoint,p256dh=dh,auth=auth_key,
      expenses=excluded.expenses,settlements=excluded.settlements,reminders=excluded.reminders;
end $$;
revoke all on function public.save_push_subscription(uuid,text,uuid,uuid,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.save_push_subscription(uuid,text,uuid,uuid,text,text,text,jsonb) to service_role;
grant all on public.push_subscriptions,public.push_jobs,public.push_reminders to service_role;
create function public.push_trip_snapshot(t uuid) returns jsonb
language sql security definer set search_path = '' as $$
  select jsonb_build_object('trip',to_jsonb(trip),
    'members',coalesce((select jsonb_agg(m order by created_at,id) from public.members m where trip_id=t),'[]'::jsonb),
    'expenses',coalesce((select jsonb_agg(e) from public.expenses e where trip_id=t),'[]'::jsonb),
    'payments',coalesce((select jsonb_agg(p) from public.payments p where trip_id=t),'[]'::jsonb),
    'transfers',coalesce((select jsonb_agg(d) from public.debt_transfers d where trip_id=t),'[]'::jsonb))
  from public.trips trip where id=t;
$$;
revoke all on function public.push_trip_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.push_trip_snapshot(uuid) to service_role;
notify pgrst, 'reload schema';
commit;
