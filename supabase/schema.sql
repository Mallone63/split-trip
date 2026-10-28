-- Trip Split schema. Run this once in the Supabase SQL editor.
--
-- Access model: there are no user accounts. Anyone who knows the trip link
-- (which contains the trip id) can read and write that trip's data. RLS is
-- enabled with permissive policies so the public anon key works.

create table public.trips (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  base_currency text not null default 'USD',
  created_at timestamptz not null default now()
);

create table public.members (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  payer_id uuid not null references public.members (id) on delete restrict,
  title text not null,
  currency text not null,
  amount numeric not null check (amount > 0),      -- integer minor units (e.g. cents)
  fx_rate numeric not null check (fx_rate > 0),    -- base-currency units per 1 unit of `currency`
  base_amount numeric not null check (base_amount > 0), -- integer minor units of the base currency
  splits jsonb not null,                           -- [{ "memberId": "...", "amountMinor": 1234 }]
  spent_at date not null default current_date,
  created_at timestamptz not null default now()
);

create index members_trip_idx on public.members (trip_id);
create index expenses_trip_idx on public.expenses (trip_id, spent_at desc);

alter table public.trips enable row level security;
alter table public.members enable row level security;
alter table public.expenses enable row level security;

create policy "anon full access to trips" on public.trips
  for all using (true) with check (true);
create policy "anon full access to members" on public.members
  for all using (true) with check (true);
create policy "anon full access to expenses" on public.expenses
  for all using (true) with check (true);

-- Realtime: push expense changes to all connected trip members.
alter publication supabase_realtime add table public.expenses;
