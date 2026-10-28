import { CURRENCIES, type CurrencyCode } from './currencies';

/** Exchange rates quoted as "units of currency per 1 USD", as returned by open.er-api.com. */
export type Rates = Record<string, number>;

const API_URL = 'https://open.er-api.com/v6/latest/USD';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

let cache: { rates: Rates; fetchedAt: number } | null = null;

/** Rate to convert an amount in `from` into `to` (units of `to` per 1 unit of `from`). */
export function crossRate(rates: Rates, from: CurrencyCode, to: CurrencyCode): number {
  if (from === to) return 1;
  const fromPerUsd = rates[from];
  const toPerUsd = rates[to];
  if (!fromPerUsd || !toPerUsd) throw new Error(`No FX rate available for ${from} or ${to}`);
  return toPerUsd / fromPerUsd;
}

export async function fetchRates(): Promise<Rates> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.rates;
  const res = await fetch(API_URL);
  if (!res.ok) throw new Error(`FX request failed with status ${res.status}`);
  const json = (await res.json()) as { result?: string; rates?: Rates };
  if (!json.rates) throw new Error('FX response did not contain rates');
  cache = { rates: json.rates, fetchedAt: Date.now() };
  return cache.rates;
}

/** Live rate suggestion; callers must handle failure (offline) by falling back to manual entry. */
export async function suggestRate(from: CurrencyCode, to: CurrencyCode): Promise<number> {
  return crossRate(await fetchRates(), from, to);
}

/**
 * Convert integer minor units of `from` into integer minor units of `to` using `rate`
 * (major `to` units per 1 major `from` unit). All balance math goes through this so
 * member balances always sum to exactly zero.
 */
export function toBaseMinor(amountMinor: number, rate: number, from: CurrencyCode, to: CurrencyCode): number {
  const scale = 10 ** (CURRENCIES[to].decimals - CURRENCIES[from].decimals);
  return Math.round(amountMinor * rate * scale);
}

export function formatRate(rate: number): string {
  return new Intl.NumberFormat(undefined, { maximumSignificantDigits: 6 }).format(rate);
}
