// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TripBundle } from './lib/api';

vi.mock('./lib/supabase', () => ({ supabaseConfigured: true, supabase: null }));
vi.mock('./lib/api', async (original) => ({
  ...await original<typeof import('./lib/api')>(),
  loadTripBundle: vi.fn(),
  addExpense: vi.fn(),
  addMember: vi.fn(),
  subscribeToExpenses: vi.fn(() => vi.fn()),
  subscribeToPayments: vi.fn(() => vi.fn()),
  subscribeToTransfers: vi.fn(() => vi.fn()),
}));
vi.mock('./lib/fx', async (original) => ({
  ...await original<typeof import('./lib/fx')>(),
  fetchRates: vi.fn().mockResolvedValue({ USD: 1, RUB: 90, JPY: 150 }),
  suggestRate: vi.fn().mockResolvedValue(1),
}));

import App from './App';
import { addExpense, addMember, loadTripBundle, subscribeToExpenses, subscribeToPayments, subscribeToTransfers } from './lib/api';
import { readTripCache, writeTripCache } from './lib/tripCache';
import { TRIP_LOAD_TIMEOUT_MS } from './lib/tripLoader';
import BalanceTab from './components/BalanceTab';
import { formatMinor } from './lib/currencies';
import type { Expense, Member } from './lib/types';

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
const members: Member[] = [
  { id: 'ana', tripId: 'trip-a', name: 'Аня' },
  { id: 'ben', tripId: 'trip-a', name: 'Бен' },
];
const expense: Expense = {
  id: 'expense-a', tripId: 'trip-a', payerId: 'ana', title: 'Ужин', currency: 'JPY',
  amountMinor: 1000, fxRate: 1, baseAmountMinor: 1000,
  splits: [{ memberId: 'ana', amountMinor: 500 }, { memberId: 'ben', amountMinor: 500 }],
  spentAt: '2026-10-28',
};

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
const chooseTab = (index: number) => act(async () => {
  (container.querySelectorAll('nav button')[index] as HTMLButtonElement).click();
});
const input = (selector: string, value: string) => act(async () => {
  const element = container.querySelector<HTMLInputElement>(selector)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
});

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

describe('trip regression audit', () => {
  it('recalculates balances when only debt transfers change, including undo', async () => {
    const props = {
      members, expenses: [expense], payments: [], transfers: [], baseCurrency: 'JPY' as const,
      meId: null, onMarkSettled: vi.fn(), onUndoPayment: vi.fn(),
      onAddTransfer: vi.fn(), onUndoTransfer: vi.fn(),
    };
    const balancesText = () => [...container.querySelectorAll('h2')]
      .find((h) => h.textContent === 'Балансы')!.parentElement!.textContent;
    await act(async () => root.render(<BalanceTab {...props} />));
    expect(balancesText()).toContain(formatMinor(-500, 'JPY'));
    const transfers = [{ id: 'transfer-a', tripId: 'trip-a', payerId: 'ben', receiverId: 'ana',
      sourceCurrency: 'JPY' as const, sourceAmountMinor: 500,
      targetCurrency: 'RUB' as const, targetAmountMinor: 30000 }];
    await act(async () => root.render(<BalanceTab {...props} transfers={transfers} />));
    expect(balancesText()).toContain(formatMinor(-30000, 'RUB'));
    expect(balancesText()).not.toContain(formatMinor(-500, 'JPY'));
    await act(async () => root.render(<BalanceTab {...props} />));
    expect(balancesText()).toContain(formatMinor(-500, 'JPY'));
    expect(balancesText()).not.toContain(formatMinor(-30000, 'RUB'));
  });

  it('does not duplicate an expense when realtime finishes before its save response', async () => {
    const initial = { ...bundle(), members };
    const saved = { ...initial, expenses: [expense] };
    const response = deferred<Expense>();
    load.mockResolvedValueOnce(initial).mockResolvedValue(saved);
    vi.mocked(addExpense).mockImplementationOnce(() => response.promise);
    await render();
    await chooseTab(1);
    await click('+ Добавить');
    await input('input[placeholder="Ужин в раменной"]', 'Ужин');
    await input('input[inputmode="decimal"]', '1000');
    await click('Сохранить расход');
    expect(addExpense).toHaveBeenCalledTimes(1);
    await act(async () => vi.mocked(subscribeToExpenses).mock.calls[0][1]());
    await act(async () => response.resolve(expense));
    expect(readTripCache('trip-a')?.bundle.expenses).toHaveLength(1);
    expect(container.querySelectorAll('li')).toHaveLength(1);
  });

  it('does not duplicate a member when a refresh finishes before the add response', async () => {
    const initial = { ...bundle(), members: [members[0]] };
    const response = deferred<Member>();
    load.mockResolvedValueOnce(initial).mockResolvedValue({ ...initial, members });
    vi.mocked(addMember).mockImplementationOnce(() => response.promise);
    await render();
    await chooseTab(2);
    await input('input[placeholder="Добавить человека…"]', 'Бен');
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(addMember).toHaveBeenCalledTimes(1);
    await act(async () => vi.mocked(subscribeToExpenses).mock.calls[0][1]());
    await act(async () => response.resolve(members[1]));
    expect(readTripCache('trip-a')?.bundle.members).toHaveLength(2);
  });

  it('preserves the selected participant and filters across cached/background loads', async () => {
    const saved = { ...bundle(), members, expenses: [expense] };
    writeTripCache(saved);
    window.localStorage.setItem('tripsplit:me:trip-a', 'ana');
    load.mockResolvedValue(saved);
    await render();
    expect(container.textContent).toContain('Только мои');
    await chooseTab(1);
    expect(container.textContent).toContain('Только мои');
    await act(async () => window.dispatchEvent(new Event('online')));
    expect(container.textContent).toContain('Только мои');
    expect(window.localStorage.getItem('tripsplit:me:trip-a')).toBe('ana');
  });

  it('keeps an unsaved expense form intact during a background refresh', async () => {
    load.mockResolvedValue({ ...bundle(), members });
    await render();
    await chooseTab(1);
    await click('+ Добавить');
    await input('input[placeholder="Ужин в раменной"]', 'Черновик');
    await input('input[inputmode="decimal"]', '1234');
    await act(async () => window.dispatchEvent(new Event('online')));
    expect(container.querySelector<HTMLInputElement>('input[placeholder="Ужин в раменной"]')?.value).toBe('Черновик');
    expect(container.querySelector<HTMLInputElement>('input[inputmode="decimal"]')?.value).toBe('1234');
  });
});
