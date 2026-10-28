// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TripBundle } from './lib/api';

vi.mock('./lib/supabase', () => ({ supabaseConfigured: true, supabase: null }));
vi.mock('./lib/api', async (original) => ({
  ...await original<typeof import('./lib/api')>(),
  loadTripBundle: vi.fn(),
  subscribeToExpenses: vi.fn(() => vi.fn()),
  subscribeToPayments: vi.fn(() => vi.fn()),
  subscribeToTransfers: vi.fn(() => vi.fn()),
}));
vi.mock('./lib/fx', async (original) => ({
  ...await original<typeof import('./lib/fx')>(),
  fetchRates: vi.fn().mockResolvedValue({ base: 'USD', rates: { USD: 1, RUB: 90, JPY: 150 } }),
}));

import App from './App';
import { loadTripBundle, subscribeToExpenses, subscribeToPayments, subscribeToTransfers } from './lib/api';
import { writeTripCache } from './lib/tripCache';
import { TRIP_LOAD_TIMEOUT_MS } from './lib/tripLoader';

const bundle = (name = 'Свежая поездка'): TripBundle => ({
  trip: { id: 'trip-a', name, baseCurrency: 'JPY' },
  members: [], expenses: [], payments: [], transfers: [],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let container: HTMLDivElement;
let root: Root;
const load = vi.mocked(loadTripBundle);

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  load.mockReset();
  const storage = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    },
  });
  window.history.replaceState(null, '', '/split-trip/?trip=trip-a');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const render = () => act(async () => root.render(<App />));
const click = async (label: string) => {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
  expect(button, `button ${label}`).toBeDefined();
  await act(async () => button!.click());
};

describe('trip loading UI', () => {
  it('shows cached content during refresh, keeps it on failure, and updates after Retry', async () => {
    writeTripCache(bundle('Сохранённая поездка'), Date.now() - 60_000);
    const response = deferred<TripBundle>();
    load.mockImplementationOnce(() => response.promise).mockResolvedValueOnce(bundle());
    await render();
    expect(container.textContent).toContain('Сохранённая поездка');
    expect(container.textContent).toContain('Обновляем…');
    await act(async () => response.reject(new Error('Нет связи')));
    expect(container.textContent).toContain('Сохранённая поездка');
    expect(container.textContent).toContain('Показаны сохранённые данные');
    await click('Повторить обновление');
    expect(container.textContent).toContain('Свежая поездка');
    expect(container.textContent).not.toContain('Нет связи');
  });

  it('restores both the trip and all realtime subscriptions after initial failure + Retry', async () => {
    load.mockRejectedValueOnce(new Error('Нет связи')).mockResolvedValueOnce(bundle());
    await render();
    expect(container.textContent).toContain('Нет связи');
    expect(subscribeToExpenses).not.toHaveBeenCalled();
    await click('Повторить');
    expect(container.textContent).toContain('Свежая поездка');
    for (const subscribe of [subscribeToExpenses, subscribeToPayments, subscribeToTransfers]) {
      expect(subscribe).toHaveBeenCalledWith('trip-a', expect.any(Function));
    }
  });

  it('stops the initial spinner after timeout and allows a successful Retry', async () => {
    vi.useFakeTimers();
    load.mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce(bundle());
    await render();
    expect(container.textContent).toContain('Загружаем поездку');
    await act(async () => { await vi.advanceTimersByTimeAsync(TRIP_LOAD_TIMEOUT_MS); });
    expect(container.textContent).not.toContain('Загружаем поездку');
    expect(container.textContent).toContain('12 секунд');
    await click('Повторить');
    expect(container.textContent).toContain('Свежая поездка');
  });

  it('refreshes on reconnect and returning to the app without hiding existing content', async () => {
    load.mockResolvedValue(bundle());
    await render();
    const next = deferred<TripBundle>();
    load.mockImplementationOnce(() => next.promise);
    await act(async () => { window.dispatchEvent(new Event('online')); });
    expect(container.textContent).toContain('Свежая поездка');
    expect(container.textContent).toContain('Обновляем…');
    await act(async () => next.resolve(bundle('Обновлённая поездка')));
    expect(container.textContent).toContain('Обновлённая поездка');
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(load).toHaveBeenCalledTimes(3);
  });
  it('can leave a failed trip to create a new one within the deployment path', async () => {
    window.localStorage.setItem('tripsplit:lastTrip', 'trip-a');
    load.mockRejectedValueOnce(new Error('Нет связи'));
    await render();
    await click('Начать новую поездку');
    expect(window.location.pathname).toBe('/split-trip/');
    expect(window.location.search).toBe('');
    expect(window.localStorage.getItem('tripsplit:lastTrip')).toBeNull();
    expect(container.textContent).toContain('Создать поездку');
  });

});
