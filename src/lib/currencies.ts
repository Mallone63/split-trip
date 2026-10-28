export type CurrencyCode = 'RUB' | 'USD' | 'JPY';

export interface CurrencyInfo {
  code: CurrencyCode;
  /** Number of decimal places in the currency's minor unit (JPY has none). */
  decimals: number;
  symbol: string;
}

export const CURRENCIES: Record<CurrencyCode, CurrencyInfo> = {
  RUB: { code: 'RUB', decimals: 2, symbol: '₽' },
  USD: { code: 'USD', decimals: 2, symbol: '$' },
  JPY: { code: 'JPY', decimals: 0, symbol: '¥' },
};

export const CURRENCY_CODES = Object.keys(CURRENCIES) as CurrencyCode[];

export function isCurrencyCode(value: string): value is CurrencyCode {
  return Object.prototype.hasOwnProperty.call(CURRENCIES, value);
}

/** Convert a human-entered major-unit amount (e.g. 12.34) into integer minor units (1234). */
export function toMinor(amount: number, code: CurrencyCode): number {
  return Math.round(amount * 10 ** CURRENCIES[code].decimals);
}

/** Convert integer minor units back to a major-unit number for display. */
export function fromMinor(minor: number, code: CurrencyCode): number {
  return minor / 10 ** CURRENCIES[code].decimals;
}

/** Format integer minor units as a localized currency string. */
export function formatMinor(minor: number, code: CurrencyCode): string {
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: code,
    minimumFractionDigits: CURRENCIES[code].decimals,
    maximumFractionDigits: CURRENCIES[code].decimals,
  }).format(fromMinor(minor, code));
}

/** Parse a user-typed amount, tolerating spaces and a comma decimal separator. Returns NaN if invalid. */
export function parseAmount(input: string): number {
  const cleaned = input.replace(/\s/g, '').replace(',', '.');
  if (!cleaned) return NaN;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : NaN;
}
