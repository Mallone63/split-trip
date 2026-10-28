import { describe, expect, it, vi } from 'vitest';
import { crossRate, suggestRate, toBaseMinor } from '../fx';
import { fromMinor, parseAmount, toMinor, type CurrencyCode } from '../currencies';

const RATES = { USD: 1, JPY: 157.9, RUB: 80.5, EUR: 0.9 };

it('can enter expenses in the base currency without contacting the exchange-rate service', async () => {
  const fetch = vi.fn().mockRejectedValue(new Error('offline'));
  vi.stubGlobal('fetch', fetch);
  try {
    expect(await suggestRate('JPY', 'JPY')).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

describe('crossRate', () => {
  it('returns 1 for identical currencies', () => {
    expect(crossRate(RATES, 'USD', 'USD')).toBe(1);
    expect(crossRate(RATES, 'JPY', 'JPY')).toBe(1);
  });

  it('converts USD → JPY', () => {
    expect(crossRate(RATES, 'USD', 'JPY')).toBeCloseTo(157.9, 10);
  });

  it('computes cross rates through the USD base (RUB → USD)', () => {
    expect(crossRate(RATES, 'RUB', 'USD')).toBeCloseTo(1 / 80.5, 10);
  });

  it('computes cross rates between non-USD currencies (RUB → JPY)', () => {
    expect(crossRate(RATES, 'RUB', 'JPY')).toBeCloseTo(157.9 / 80.5, 10);
  });

  it('throws when a currency has no rate', () => {
    expect(() => crossRate(RATES, 'USD', 'GBP' as CurrencyCode)).toThrow(/GBP/);
  });
});

describe('toBaseMinor', () => {
  it('converts ¥4,700 → $29.77 at 0.006333 USD/JPY (0-decimal → 2-decimal)', () => {
    expect(toBaseMinor(4700, 0.006333, 'JPY', 'USD')).toBe(2977);
  });

  it('converts $30.00 → ¥4,737 at 157.9 JPY/USD (2-decimal → 0-decimal)', () => {
    expect(toBaseMinor(3000, 157.9, 'USD', 'JPY')).toBe(4737);
  });

  it('converts ₽500.00 → $6.21 at 1/80.5 (same decimals)', () => {
    expect(toBaseMinor(50000, 1 / 80.5, 'RUB', 'USD')).toBe(621);
  });

  it('is exact when currencies match', () => {
    expect(toBaseMinor(1234, 1, 'USD', 'USD')).toBe(1234);
  });
});

describe('minor unit helpers', () => {
  it('round-trips major ↔ minor units', () => {
    expect(toMinor(12.34, 'USD')).toBe(1234);
    expect(fromMinor(1234, 'USD')).toBeCloseTo(12.34, 10);
    expect(toMinor(4700, 'JPY')).toBe(4700);
    expect(fromMinor(4700, 'JPY')).toBe(4700);
    expect(toMinor(0.005, 'RUB')).toBe(1);
  });
});

describe('parseAmount', () => {
  it('parses plain, spaced, and comma-decimal inputs', () => {
    expect(parseAmount('12.5')).toBe(12.5);
    expect(parseAmount('1 234,56')).toBeCloseTo(1234.56, 10);
    expect(parseAmount('9400')).toBe(9400);
  });

  it('returns NaN for junk', () => {
    expect(parseAmount('')).toBeNaN();
    expect(parseAmount('abc')).toBeNaN();
  });
});
