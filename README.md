# Trip Split

A tiny PWA for tracking shared trip expenses: who paid, for what, and who owes
whom. Built for one trip, no accounts — the invite link is the access control.

- **Currencies:** pay in RUB / USD / JPY; every expense is frozen at its
  exchange rate on entry and all balances are shown in the trip's settlement
  currency.
- **Splits:** equal split among selected people (tap someone off if they
  weren't part of an expense), or a jointly-paid entry («Совместная оплата»)
  where each participant records how much they handed over — the total is the
  sum of the payments and is still divided equally among the participants.
- **Settle up:** suggested minimal transfers (greedy min-cash-flow).
- **Shared wallets:** pair up members (e.g. a couple) — splits stay per-person,
  but balances and settlements are computed per wallet.
- **Russian UI:** the interface is in Russian by default (no i18n dependency).
- **Realtime:** everyone sees new expenses instantly (Supabase realtime).
- **Install:** iPhone Safari → Share → *Add to Home Screen* → runs standalone.

Open the trip invite link in Safari **before** adding it to the Home Screen.
The installed app retains that URL (including `?trip=`), because iOS may keep
Safari and standalone app storage separate. The manifest intentionally omits
`start_url`, and is linked only after a previously saved trip is restored to
the page URL. Do not replace this with a fixed root start URL.

If an existing Home Screen icon opens “Начать поездку”, remove that icon,
open the invite link in Safari, wait for the trip to load, and add it again.
Removing the icon does not delete the shared trip or its expenses. The local
“это вы” selection may need to be selected again in the installed app.

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

- Trip data is cached per trip and backend in localStorage after successful
  reads and writes. Cached data opens immediately; the server refresh runs in
  the background, including on reconnect and when returning to the app.
  Failed refreshes keep the snapshot visible with its last full-refresh time
  and a Retry action. Requests time out after 12 seconds and are cancelled.
  A successful Retry also restores realtime subscriptions after initial failure.
- The cache is a last-known snapshot, not a guarantee of current balances.
  Writes require connectivity and are never queued offline. The app shell is
  not cached by a service worker, so a fully offline cold launch is not guaranteed.
- On the expenses tab, the existing Add button floats above the bottom tabs
  at the right content edge, with unchanged dimensions and iPhone safe-area spacing.
- The app shell also reserves the iOS status-bar/notch safe area at the top;
  bottom sheets and navigation respect the home indicator and landscape side insets.
- Anyone with the link can edit anything (fine for friends; delete the trip row
  after the trip to lock it down).
- FX rates update daily, and the rate field is editable so you can enter the
  rate your card actually charged.
