# AGENTS.md

## What this is

Trip Split — a single-purpose PWA for splitting group trip expenses (RUB / USD / JPY).
No accounts by design: the trip invite link is the access control. One trip per
deployment, hosted on GitHub Pages via `.github/workflows/deploy.yml`.

## Stack

- React 19 + TypeScript + Vite 6 + Tailwind CSS v4 (`@tailwindcss/vite` plugin)
- Supabase (Postgres + realtime), queried directly from the browser
- Vitest for unit tests. No router, no state library — keep it that way.

## Commands

```bash
npm install        # install
npm run dev        # dev server
npm test           # vitest (must pass before any commit)
npm run build      # tsc --noEmit + vite build (both must pass)
npm run preview    # serve the production build
npm run gen:icons  # regenerate PWA icons (pure Node script)
```

## Layout

- `src/lib/` — pure money math: `currencies.ts`, `fx.ts`, `split.ts`, `balances.ts`.
  Keep these functions pure and covered by tests in `src/lib/__tests__/`.
- `src/lib/api.ts` — all Supabase access + trip-link / "me" localStorage persistence.
- `src/lib/tripCache.ts`, `tripLoader.ts`, `useTripLoader.ts` — validated local
  snapshots, cancellable/timeout-bounded loads, and React lifecycle integration.
  Preserve cached data on transient failure; clear it on confirmed not-found.
  Keep Retry on the same loading path as initial load so subscriptions recover.
- `src/components/` — one component per file, mobile-first Tailwind, max-w-md layout.
- `supabase/schema.sql` — single source of truth for the DB (tables + permissive RLS + realtime).

## Rules & gotchas

- Money is **integer minor units** everywhere (`amountMinor`). Never use floats.
  JPY has 0 decimals — always convert via `toMinor` / `fromMinor` / `toBaseMinor`.
- Every expense stores `fxRate` frozen at entry time. `baseAmountMinor` is the sum
  of **per-split** base conversions — this is what keeps balances summing to zero.
  Do not "simplify" it to `amount × fxRate`.
- Splits are fully materialized in `expenses.splits` at entry time (equal split
  computed up front; remainder cents go to the payer).
- `vite.config.ts` uses `base: './'` and `index.html` references public assets
  relatively — required for GitHub Pages project sites. Do not use absolute paths.
- `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` are build-time env vars. Without
  them the app renders a setup screen — keep that guard.
- TypeScript is strict with `verbatimModuleSyntax`: use `import type` for
  type-only imports; unused locals/params fail the build.
- UI is Russian by default (hardcoded strings, no i18n lib); formatters use ru-RU.
- The manifest deliberately omits `start_url`: installation must retain the
  document URL including `?trip=`. iOS standalone storage may be separate from
  Safari's. `src/lib/pwa.ts` restores a saved trip into the URL before attaching
  the manifest link. Keep that order; do not add a fixed root `start_url`.
  `localStorage` (`tripsplit:lastTrip`) is only a fallback for ordinary visits.
- Shared wallets: `members.unit` groups people (e.g. a couple). Splits stay
  per-person; balances/settlements aggregate per wallet via `aggregateByUnit`.
- Settling up: recorded in the `payments` table (never by deleting/editing
  expenses — history is immutable). Debts are tracked **per currency ledger**:
  a ledger = expenses of that currency + payments of the same currency
  (computeBalances at rate 1:1; zero-sum inside each ledger). All ledgers are
  shown at once — no tabs/switcher; zero amounts omit the currency name.
  Overpaying a settlement is allowed: the excess automatically becomes a
  reverse debt via payment netting. A payment may carry `paid_currency` +
  `paid_amount` — what was actually handed over when settling in another
  currency (the debt itself still nets in its own ledger; today's fx rate).
  `payments.currency` null = legacy trip base.
- Definition of done: `npm test` and `npm run build` both green.
