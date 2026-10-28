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

-- members.unit: members with the same non-null value share one wallet (e.g. a couple).
create table public.members (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  name text not null,
  unit text,
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

-- Payments: settling up without touching expense history. A payment moves money
-- from payer (debtor) to receiver (creditor) and reduces both nets toward zero.
-- Debts are tracked per currency: a payment belongs to the ledger of `currency`.
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  payer_id uuid not null references public.members (id) on delete cascade,
  receiver_id uuid not null references public.members (id) on delete cascade,
  amount numeric not null check (amount > 0), -- integer minor units of `currency`
  currency text, -- ledger currency (null = legacy trip base currency)
  paid_currency text, -- currency actually handed over (null = same as `currency`)
  paid_amount numeric, -- integer minor units of `paid_currency`
  created_at timestamptz not null default now()
);

create index payments_trip_idx on public.payments (trip_id);

alter table public.payments enable row level security;
create policy "anon full access to payments" on public.payments
  for all using (true) with check (true);

alter publication supabase_realtime add table public.payments;

-- Debt transfers: re-denomination of a debt into another currency ("хочу
-- оплатить в..."). The payer's debt of `source_amount` in `source_currency`
-- closes in that ledger and reopens as `target_amount` in `target_currency`.
-- No money moves — this is a declaration of the currency of a future payment.
create table public.debt_transfers (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  payer_id uuid not null references public.members (id) on delete cascade,
  receiver_id uuid not null references public.members (id) on delete cascade,
  source_currency text not null,
  source_amount numeric not null check (source_amount > 0),
  target_currency text not null,
  target_amount numeric not null check (target_amount > 0),
  created_at timestamptz not null default now()
);

create index debt_transfers_trip_idx on public.debt_transfers (trip_id);

alter table public.debt_transfers enable row level security;
create policy "anon full access to debt_transfers" on public.debt_transfers
  for all using (true) with check (true);

alter publication supabase_realtime add table public.debt_transfers;
