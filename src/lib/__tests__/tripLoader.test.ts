import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TripBundle } from '../api';
import { TripNotFoundError } from '../errors';
import { readTripCache, writeTripCache } from '../tripCache';
import { TripLoader, TRIP_LOAD_TIMEOUT_MS } from '../tripLoader';

const bundle = (name = 'Поездка', id = 'trip-a'): TripBundle => ({
  trip: { id, name, baseCurrency: 'JPY' },
  members: [{ id: 'me', tripId: id, name: 'Аня', unit: null }],
  expenses: [{ id: 'expense', tripId: id, payerId: 'me', title: 'Ужин', currency: 'JPY',
    amountMinor: 1000, fxRate: 1, baseAmountMinor: 1000,
    splits: [{ memberId: 'me', amountMinor: 1000 }], spentAt: '2026-10-28' }],
  payments: [{ id: 'payment', tripId: id, payerId: 'me', receiverId: 'other', amountMinor: 100,
    currency: null, paidCurrency: null, paidAmountMinor: null }],
  transfers: [{ id: 'transfer', tripId: id, payerId: 'me', receiverId: 'other',
    sourceCurrency: 'JPY', sourceAmountMinor: 100, targetCurrency: 'RUB', targetAmountMinor: 50 }],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let values: Map<string, string>;
beforeEach(() => {
  values = new Map();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    },
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('trip snapshot cache', () => {
  it('round-trips all ledgers and isolates trips', () => {
    writeTripCache(bundle(), 123);
    expect(readTripCache('trip-a')).toEqual({ bundle: bundle(), updatedAt: 123 });
    expect(readTripCache('trip-b')).toBeNull();
  });

  it.each([
    'invalid-json',
    JSON.stringify({ version: 999, bundle: bundle(), updatedAt: 123 }),
    JSON.stringify({ version: 1, bundle: bundle('Other', 'trip-b'), updatedAt: 123 }),
    JSON.stringify({ version: 1, bundle: { ...bundle(), expenses: [{}] }, updatedAt: 123 }),
    JSON.stringify({ version: 1, bundle: { ...bundle(), transfers: null }, updatedAt: 123 }),
    JSON.stringify({ version: 1, bundle: bundle(), updatedAt: 'yesterday' }),
  ])('ignores corrupted, incompatible or mismatched snapshots: %s', (raw) => {
    writeTripCache(bundle());
    const key = [...values.keys()][0];
    values.set(key, raw);
    expect(readTripCache('trip-a')).toBeNull();
  });

  it('does not fail if storage is inaccessible or full', async () => {
    vi.stubGlobal('window', { get localStorage() { throw new Error('blocked'); } });
    expect(readTripCache('trip-a')).toBeNull();
    expect(() => writeTripCache(bundle())).not.toThrow();
    const loader = new TripLoader('trip-a', async () => bundle());
    await loader.refresh();
    expect(loader.getSnapshot().bundle).toEqual(bundle());
  });
});

describe('trip loading and recovery', () => {
  it('shows a cached trip immediately while refreshing, then replaces and persists it', async () => {
    writeTripCache(bundle('Cached'), 123);
    const response = deferred<TripBundle>();
    const loader = new TripLoader('trip-a', () => response.promise);
    expect(loader.getSnapshot()).toMatchObject({ bundle: bundle('Cached'), updatedAt: 123 });
    const refresh = loader.refresh();
    expect(loader.getSnapshot()).toMatchObject({ refreshing: true, bundle: bundle('Cached') });
    response.resolve(bundle('Fresh'));
    await refresh;
    expect(loader.getSnapshot()).toMatchObject({ refreshing: false, error: null, bundle: bundle('Fresh') });
    expect(readTripCache('trip-a')?.bundle).toEqual(bundle('Fresh'));
  });

  it('keeps a cached trip after a network error and recovers on Retry', async () => {
    writeTripCache(bundle('Cached'));
    const load = vi.fn().mockRejectedValueOnce(new Error('Network error')).mockResolvedValueOnce(bundle('Fresh'));
    const loader = new TripLoader('trip-a', load);
    await loader.refresh();
    expect(loader.getSnapshot()).toMatchObject({ bundle: bundle('Cached'), error: 'Network error', refreshing: false });
    await loader.refresh();
    expect(loader.getSnapshot()).toMatchObject({ bundle: bundle('Fresh'), error: null, refreshing: false });
  });

  it('recovers on Retry after the very first load fails with no cached data', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce(bundle());
    const loader = new TripLoader('trip-a', load);
    await loader.refresh();
    expect(loader.getSnapshot()).toMatchObject({ bundle: null, error: 'Offline', refreshing: false });
    const retry = loader.refresh();
    expect(loader.getSnapshot()).toMatchObject({ error: null, refreshing: true });
    await retry;
    expect(loader.getSnapshot()).toMatchObject({ bundle: bundle(), error: null, refreshing: false });
  });

  it('aborts a hung request after 12 seconds even when the loader ignores AbortSignal', async () => {
    vi.useFakeTimers();
    const response = deferred<TripBundle>();
    const load = vi.fn((_trip: string, _signal?: AbortSignal) => response.promise);
    const loader = new TripLoader('trip-a', load);
    const refresh = loader.refresh();
    await vi.advanceTimersByTimeAsync(TRIP_LOAD_TIMEOUT_MS);
    await refresh;
    expect(load.mock.calls[0][1]?.aborted).toBe(true);
    expect(loader.getSnapshot()).toMatchObject({ bundle: null, refreshing: false });
    expect(loader.getSnapshot().error).toContain('12 секунд');
    response.resolve(bundle('Late'));
    await Promise.resolve();
    expect(loader.getSnapshot().bundle).toBeNull();
    expect(readTripCache('trip-a')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('can Retry successfully after timeout without a late response overwriting it', async () => {
    vi.useFakeTimers();
    const response = deferred<TripBundle>();
    const load = vi.fn().mockImplementationOnce(() => response.promise).mockResolvedValueOnce(bundle('Fresh'));
    const loader = new TripLoader('trip-a', load);
    const first = loader.refresh();
    await vi.advanceTimersByTimeAsync(TRIP_LOAD_TIMEOUT_MS);
    await first;
    await loader.refresh();
    response.resolve(bundle('Old'));
    await Promise.resolve();
    expect(loader.getSnapshot()).toMatchObject({ bundle: bundle('Fresh'), error: null, refreshing: false });
    expect(readTripCache('trip-a')?.bundle).toEqual(bundle('Fresh'));
  });

  it('coalesces overlapping refresh triggers into one request', async () => {
    const response = deferred<TripBundle>();
    const load = vi.fn(() => response.promise);
    const loader = new TripLoader('trip-a', load);
    const first = loader.refresh();
    const second = loader.refresh();
    expect(first).toBe(second);
    response.resolve(bundle());
    await first;
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('cancels on teardown and can start again (including React StrictMode)', async () => {
    const old = deferred<TripBundle>();
    const load = vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValueOnce(bundle('Fresh'));
    const loader = new TripLoader('trip-a', load);
    const first = loader.refresh();
    await Promise.resolve();
    loader.cancel();
    await loader.refresh();
    old.resolve(bundle('Old'));
    await first;
    expect(loader.getSnapshot()).toMatchObject({ bundle: bundle('Fresh'), refreshing: false, error: null });
  });

  it('preserves a successful write against an older background read and caches the write', async () => {
    writeTripCache(bundle('Cached'), 123);
    const response = deferred<TripBundle>();
    const load = vi.fn().mockImplementationOnce(() => response.promise)
      .mockResolvedValueOnce({ ...bundle(), expenses: [] });
    const loader = new TripLoader('trip-a', load);
    const refresh = loader.refresh();
    await Promise.resolve();
    loader.setBundle((current) => current ? { ...current, expenses: [] } : null);
    response.resolve(bundle('Old'));
    await refresh;
    expect(loader.getSnapshot().bundle?.expenses).toEqual([]);
    expect(readTripCache('trip-a')?.bundle.expenses).toEqual([]);
    await loader.refresh();
    expect(loader.getSnapshot().bundle?.expenses).toEqual([]);
  });

  it('revalidates once after realtime events arrive during an older read', async () => {
    const first = deferred<TripBundle>();
    const load = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValueOnce(bundle('Latest'));
    const loader = new TripLoader('trip-a', load);
    const refresh = loader.refresh();
    loader.invalidate();
    loader.invalidate();
    first.resolve(bundle('Earlier'));
    await refresh;
    await loader.refresh();
    expect(load).toHaveBeenCalledTimes(2);
    expect(loader.getSnapshot().bundle).toEqual(bundle('Latest'));
  });

  it('removes a deleted trip snapshot on a definitive not-found response', async () => {
    writeTripCache(bundle());
    const loader = new TripLoader('trip-a', async () => { throw new TripNotFoundError(); });
    await loader.refresh();
    expect(loader.getSnapshot()).toMatchObject({ bundle: null, updatedAt: null, refreshing: false });
    expect(loader.getSnapshot().error).toContain('не найдена');
    expect(readTripCache('trip-a')).toBeNull();
  });
});
