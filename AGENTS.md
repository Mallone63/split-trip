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
- `src/lib/api.ts` — all Supabase access + trip-link / "me" localStorage persistence
  (keys `tripsplit:lastTrip`, `tripsplit:me:<tripId>`).
- `src/lib/prefs.ts` — small localStorage UI prefs (`tripsplit:mineOnly`); `errors.ts`
  turns thrown values into user-facing Russian messages (`TripNotFoundError`).
- `src/lib/tripCache.ts`, `tripLoader.ts`, `useTripLoader.ts` — validated local
  snapshots, cancellable/timeout-bounded loads, and React lifecycle integration.
  Preserve cached data on transient failure; clear it on confirmed not-found.
  Keep Retry on the same loading path as initial load so subscriptions recover.
- `src/components/` — one component per file, mobile-first Tailwind, max-w-md layout.
  `App.tsx` owns all state/mutations and wraps every screen in `Shell`; components
  stay presentational and receive async callbacks.
- `supabase/schema.sql` — single source of truth for the DB (tables + permissive RLS + realtime).

## UI & theming

- Light **and** dark themes follow the OS setting (`prefers-color-scheme`) via
  Tailwind v4's default media-query `dark:` variant — pure CSS, no JS, no toggle,
  no persistence. Every color utility is paired with its `dark:` counterpart in the
  same className string; don't introduce a class-strategy toggle or theme state.
- Surfaces: the page canvas is painted only by `body` in `index.css`
  (`bg-white dark:bg-slate-950`). Cards `bg-white` → `dark:bg-slate-900`; nested
  rows `bg-slate-50` → `dark:bg-slate-800/60`; chips/tracks `bg-slate-100` →
  `dark:bg-slate-800`; gray buttons `bg-slate-200`/`bg-slate-800` →
  `dark:bg-slate-700`. Text ramp `slate-900/800/700/600/500/400/300` pairs with
  `dark:slate-100/200/300/400/400/500/600`; borders & dividers `100/200/300` →
  `dark:800/700/600`. Accents: `text-teal-700` → `dark:text-teal-300`,
  `bg-teal-100` → `dark:bg-teal-900/40`, selected `border-teal-300 bg-teal-50` →
  `dark:border-teal-700 dark:bg-teal-900/30`. Status text `emerald-600`,
  `red-500/600`, `amber-600` → `dark:*-400`; `red-700` → `dark:red-300` and error
  boxes `bg-red-50` → `dark:bg-red-950/40`. Solid `bg-teal-600`/`bg-emerald-600`
  buttons with `text-white` (incl. the FAB) are shared by both themes.
- Native controls follow the theme via `color-scheme: light dark` (kept in both
  `index.css` and an `index.html` meta); the `theme-color` meta carries light/dark
  media variants.
- The invite QR always stays black-on-white for scannability — never theme it.
  Manifest `theme_color`/`background_color` cannot react to media queries
  (install splash only) — leave them brand teal.
- Safe-area / fixed-position helpers live in `index.css` (`.app-shell`, `.pb-safe`,
  `.expense-add`, `.safe-sheet-overlay`, `.safe-sheet`): iOS draws under the status
  bar and home indicator, so fixed UI must use these instead of ad-hoc padding.
- Tests: vitest defaults to a `node` environment; `src/App.test.tsx` opts into jsdom
  via a `// @vitest-environment jsdom` comment and mocks `./lib/api` + `./lib/fx`.

## Rules & gotchas

- Money is **integer minor units** everywhere (`amountMinor`). Never use floats.
  JPY has 0 decimals — always convert via `toMinor` / `fromMinor` / `toBaseMinor`.
- Every expense stores `fxRate` frozen at entry time. `baseAmountMinor` is the sum
  of **per-split** base conversions — this is what keeps balances summing to zero.
  Do not "simplify" it to `amount × fxRate`.
- Splits are fully materialized in `expenses.splits` at entry time (equal split
  computed up front; remainder cents go to the payer).
  If the payer is not a participant, allocate the remainder to the first selected
  participants instead; the shares must still sum to the full expense.
- Realtime may deliver a successful write before its API response arrives.
  Merge inserted rows by ID, including members/payments/transfers; never append
  an already-present ID. Cached snapshots may contain duplicates from old clients.
- `BalanceTab` ledger memoization must depend on `transfers` as well as expenses,
  payments and members, including transfer creation/undo without other changes.
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
