# Trip Split

A tiny PWA for tracking shared trip expenses: who paid, for what, and who owes
whom. Built for one trip, no accounts — the invite link is the access control.

- **Currencies:** pay in RUB / USD / JPY; every expense is frozen at its
  exchange rate on entry and all balances are shown in the trip's settlement
  currency.
- **Splits:** equal split among selected people (tap someone off if they
  weren't part of an expense) or exact amounts per person.
- **Settle up:** suggested minimal transfers (greedy min-cash-flow).
- **Shared wallets:** pair up members (e.g. a couple) — splits stay per-person,
  but balances and settlements are computed per wallet.
- **Russian UI:** the interface is in Russian by default (no i18n dependency).
- **Realtime:** everyone sees new expenses instantly (Supabase realtime).
- **Install:** iPhone Safari → Share → *Add to Home Screen* → runs standalone.

## Stack

React 19 + Vite + TypeScript + Tailwind CSS v4, Supabase (Postgres + realtime),
deployed as a static site (GitHub Pages by default; Vercel/Netlify also work).
FX rates from `open.er-api.com` (free, no API key).

## Run locally

```bash
npm install
cp .env.example .env   # then fill in your Supabase URL + anon key
npm run dev
```

The app shows setup instructions in place until `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY` are set.

## Backend setup (once)

1. Create a free project at [supabase.com](https://supabase.com).
2. SQL Editor → run [`supabase/schema.sql`](supabase/schema.sql).
   Already deployed earlier? Run:
   `alter table public.members add column if not exists unit text;`
   `alter table public.payments add column if not exists currency text;`
   `alter table public.payments add column if not exists paid_currency text;`
   `alter table public.payments add column if not exists paid_amount numeric;`
   And for the debt-transfer feature, create `public.debt_transfers` by copying
   its block from [`supabase/schema.sql`](supabase/schema.sql) (table + index +
   RLS policy + realtime publication).
3. Project Settings → API → copy the URL and the anon key into `.env`.

## Tests & build

```bash
npm test        # unit tests for the money math (vitest)
npm run build   # type-check + production build
npm run preview # serve the production build locally
npm run gen:icons
```

## Deploy

### GitHub Pages (default)

1. Push this folder to a GitHub repository (a public repo on the free plan).
2. Repo → *Settings → Secrets and variables → Actions* → add repository secrets
   `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
3. Repo → *Settings → Pages → Source: **GitHub Actions***.
4. Push to `main` (or run the workflow manually via *Actions → Deploy to GitHub
   Pages → Run workflow*). The included workflow
   [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) runs the
   tests, builds with the secrets injected, and publishes `dist/`.
   Site URL: `https://<user>.github.io/<repo>/`.

The Vite config uses a relative base (`base: './'`), so the same build also
works at a custom domain or any other static host.

### Vercel (alternative)

1. Push this folder to a GitHub repo.
2. Import it on Vercel (or Netlify) — framework preset: Vite.
3. Add env vars `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
4. Deploy. Open the URL on iPhone, Share → *Add to Home Screen*.

## Project layout

```
.github/workflows/  deploy.yml — build & publish to GitHub Pages
src/lib/        money math: currencies, fx, split, balances (+ unit tests)
src/lib/api.ts  Supabase access + trip link / "me" persistence
src/components/ TabBar, BalanceTab, ExpenseList, ExpenseForm, InviteTab, Setup*
supabase/       schema.sql (tables + RLS + realtime publication)
scripts/        gen-icon.mjs (dependency-free PNG icon generator)
```

## Known tradeoffs

- Requires connectivity; no offline queue.
- Anyone with the link can edit anything (fine for friends; delete the trip row
  after the trip to lock it down).
- FX rates update daily, and the rate field is editable so you can enter the
  rate your card actually charged.
