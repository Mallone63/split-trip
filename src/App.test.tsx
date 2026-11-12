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
import { aggregateByUnit, computeBalances } from './lib/balances';
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
const select = (label: string, value: string) => act(async () => {
  const element = [...container.querySelectorAll('label')]
    .find((item) => item.querySelector('span')?.textContent === label)!.querySelector('select')!;
  element.value = value;
  element.dispatchEvent(new Event('change', { bubbles: true }));
});

describe('trip loading UI', () => {
  it('shows cached content during refresh, keeps it on failure, and updates after Retry', async () => {
    vi.useFakeTimers();
    writeTripCache(bundle('Сохранённая поездка'), Date.now() - 60_000);
    const response = deferred<TripBundle>();
    load.mockImplementationOnce(() => response.promise).mockResolvedValueOnce(bundle());
    await render();
    expect(container.textContent).toContain('Сохранённая поездка');
    expect(container.textContent).not.toContain('Обновляем…');
    await act(async () => { await vi.advanceTimersByTimeAsync(1499); });
    expect(container.textContent).not.toContain('Обновляем…');
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(container.textContent).toContain('Обновляем…');
    await act(async () => response.reject(new Error('Нет связи')));
    expect(container.textContent).toContain('Сохранённая поездка');
    expect(container.textContent).toContain('Показаны сохранённые данные');
    await click('Повторить обновление');
    expect(container.textContent).toContain('Свежая поездка');
    expect(container.textContent).not.toContain('Нет связи');
  });

  it('never flashes the notice for a fast refresh and shows errors immediately', async () => {
    vi.useFakeTimers();
    writeTripCache(bundle());
    const response = deferred<TripBundle>();
    load.mockImplementationOnce(() => response.promise).mockRejectedValueOnce(new Error('Нет связи'));
    await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    await act(async () => response.resolve(bundle()));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(container.querySelector('[role="status"]')).toBeNull();
    await act(async () => window.dispatchEvent(new Event('online')));
    expect(container.textContent).toContain('Нет связи');
    expect(container.textContent).toContain('Повторить обновление');
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
    expect(container.textContent).not.toContain('Обновляем…');
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

describe('personal expense entry', () => {
  const group: Member[] = [
    ...members.map((member) => ({ ...member, unit: 'couple' })),
    { id: 'solo', tripId: 'trip-a', name: 'Ден', unit: null },
    { id: 'other', tripId: 'trip-a', name: 'Крис' },
  ];
  const saveButton = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const personalInput = 'input[inputmode="decimal"][placeholder="0"]';
  async function open(meId: string | null) {
    if (meId) window.localStorage.setItem('tripsplit:me:trip-a', meId);
    load.mockResolvedValue({ ...bundle(), members: group });
    vi.mocked(addExpense).mockImplementation(async (_, data) => ({ ...expense, ...data }));
    await render();
    await chooseTab(1);
    await click('+ Добавить');
  }

  it.each(['ana', 'ben', 'solo', 'other'])('saves only the wallet of %s without changing wallet debts', async (meId) => {
    await open(meId);
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Общая трата');
    await click('Личная');
    expect(container.textContent).not.toContain('Разделить счёт');
    expect(container.querySelector('input[aria-label^="Заплатил"]')).toBeNull();
    await input('input[placeholder="Ужин в раменной"]', 'Кофе');
    await input(personalInput, '1001');
    await click('Сохранить расход');
    expect(addExpense).toHaveBeenCalledTimes(1);
    const data = vi.mocked(addExpense).mock.calls[0][1];
    const coupled = ['ana', 'ben'].includes(meId);
    expect(data.payerId).toBe(meId);
    expect(data.amountMinor).toBe(1001);
    expect(data.baseAmountMinor).toBe(1001);
    expect(data.splits.map((split) => split.memberId)).toEqual(coupled ? ['ana', 'ben'] : [meId]);
    expect(data.splits.find((split) => split.memberId === meId)).toEqual({
      memberId: meId, amountMinor: coupled ? 501 : 1001, paidMinor: 1001,
    });
    expect(data.splits.reduce((sum, split) => sum + split.amountMinor, 0)).toBe(1001);
    const saved = { ...expense, ...data };
    const existing = { ...expense, splits: [
      { memberId: 'ana', amountMinor: 500 }, { memberId: 'solo', amountMinor: 500 },
    ] };
    const before = aggregateByUnit(group, computeBalances(group, [existing], 'JPY'));
    const after = aggregateByUnit(group, computeBalances(group, [existing, saved], 'JPY'));
    expect(after).toEqual(before);
    // Both partners see the personal expense through the existing wallet-aware filter.
    await click('Только мои');
    expect(container.textContent).toContain('Кофе');
    await click('+ Добавить');
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Общая трата');
  });

  it.each([null, 'removed-member'])('requires a valid identity instead of guessing when me = %s', async (meId) => {
    await open(meId);
    await click('Личная');
    await input('input[placeholder="Ужин в раменной"]', 'Покупки');
    await input(personalInput, '500');
    expect(saveButton().disabled).toBe(true);
    await select('Кто вы?', 'ben');
    expect(window.localStorage.getItem('tripsplit:me:trip-a')).toBe('ben');
    expect(container.textContent).toContain('Аня + Бен');
    expect(saveButton().disabled).toBe(false);
    await click('Сохранить расход');
    expect(vi.mocked(addExpense).mock.calls[0][1].payerId).toBe('ben');
  });

  it('preserves both drafts, currency, date and custom shares when switching tabs', async () => {
    await open('ana');
    await input('input[placeholder="Ужин в раменной"]', 'Черновик');
    await input('input[type="date"]', '2026-11-10');
    await select('Валюта', 'RUB');
    await click('Разделить счёт');
    await input('input[aria-label="Доля счёта: Аня"]', '100');
    await input('input[aria-label="Доля счёта: Ден"]', '50');
    await input('input[aria-label="Заплатил(а): Ден"]', '150');
    await click('Личная');
    expect(container.querySelector<HTMLInputElement>(personalInput)?.value).toBe('150');
    await input(personalInput, '12,35');
    await click('Общая трата');
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Заплатил(а): Ден"]')?.value).toBe('150');
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Доля счёта: Аня"]')?.value).toBe('100');
    await click('Личная');
    expect(container.querySelector<HTMLInputElement>(personalInput)?.value).toBe('12,35');
    await input('input[placeholder="1 RUB = ? JPY"]', '1.95');
    await click('Сохранить расход');
    const data = vi.mocked(addExpense).mock.calls[0][1];
    expect(data).toMatchObject({ title: 'Черновик', amountMinor: 1235, currency: 'RUB', spentAt: '2026-11-10', fxRate: 1.95, baseAmountMinor: 24 });
    expect(data.splits).toEqual([
      { memberId: 'ana', amountMinor: 618, paidMinor: 1235 },
      { memberId: 'ben', amountMinor: 617 },
    ]);
  });

  it('blocks invalid amounts, supports keyboard tabs and retains the draft after a failed save', async () => {
    await open('solo');
    const sharedTab = container.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')!;
    await act(async () => {
      sharedTab.focus();
      sharedTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(document.activeElement?.textContent).toBe('Личная');
    expect(document.activeElement?.getAttribute('aria-selected')).toBe('true');
    await input('input[placeholder="Ужин в раменной"]', 'Кофе');
    for (const value of ['', '0', '-5', 'abc', '0.001', '1e100']) {
      await input(personalInput, value);
      expect(saveButton().disabled, value).toBe(true);
    }
    await input(personalInput, '550');
    vi.mocked(addExpense).mockRejectedValueOnce(new Error('Нет сети'));
    await click('Сохранить расход');
    expect(container.textContent).toContain('Нет сети');
    expect(container.querySelector<HTMLInputElement>(personalInput)?.value).toBe('550');
    expect(saveButton().disabled).toBe(false);
    await click('Сохранить расход');
    expect(addExpense).toHaveBeenCalledTimes(2);
  });
});

describe('trip regression audit', () => {
  it('filters spending by wallet shares in each currency and restores group totals', async () => {
    const group: Member[] = [
      ...members.map((member) => ({ ...member, unit: 'couple' })),
      { id: 'den', tripId: 'trip-a', name: 'Ден' },
    ];
    const expenses: Expense[] = [
      { ...expense, id: 'shared', amountMinor: 1001, payerId: 'den', splits: [
        { memberId: 'ana', amountMinor: 334 },
        { memberId: 'ben', amountMinor: 333 },
        { memberId: 'den', amountMinor: 334, paidMinor: 1001 },
      ] },
      { ...expense, id: 'paid-for-den', amountMinor: 800, splits: [
        { memberId: 'ana', amountMinor: 0, paidMinor: 800 },
        { memberId: 'den', amountMinor: 800 },
      ] },
      { ...expense, id: 'personal-pair', payerId: 'ben', amountMinor: 501, splits: [
        { memberId: 'ana', amountMinor: 250 },
        { memberId: 'ben', amountMinor: 251, paidMinor: 501 },
      ] },
      { ...expense, id: 'partner-only', payerId: 'ben', currency: 'RUB', amountMinor: 12345,
        splits: [{ memberId: 'ben', amountMinor: 12345 }] },
      { ...expense, id: 'den-personal', payerId: 'den', currency: 'USD', amountMinor: 999,
        splits: [{ memberId: 'den', amountMinor: 999 }] },
    ];
    const props = {
      members: group, expenses, baseCurrency: 'JPY' as const, meId: 'ana',
      payments: [{ id: 'payment', tripId: 'trip-a', payerId: 'ana', receiverId: 'den', amountMinor: 200, currency: 'JPY' }],
      transfers: [{ id: 'transfer', tripId: 'trip-a', payerId: 'ana', receiverId: 'den',
        sourceCurrency: 'JPY' as const, sourceAmountMinor: 100, targetCurrency: 'RUB' as const, targetAmountMinor: 6000 }],
      onMarkSettled: vi.fn(), onUndoPayment: vi.fn(), onAddTransfer: vi.fn(), onUndoTransfer: vi.fn(),
    };
    const totals = () => [...container.querySelectorAll('h2')]
      .find((heading) => heading.textContent === 'Всего потрачено')!.closest('section')!;
    const amounts = () => [...totals().querySelectorAll('p')].map((p) => p.textContent);
    await act(async () => root.render(<BalanceTab {...props} />));
    expect(amounts()).toEqual([formatMinor(12345, 'RUB'), formatMinor(999, 'USD'), formatMinor(2302, 'JPY')]);
    await click('Только мои');
    // Pair: 334 + 333 from the shared bill and the full personal 501 JPY.
    // Paying 800 JPY for Den, repayments and debt transfers are not spending.
    expect(amounts()).toEqual([formatMinor(12345, 'RUB'), formatMinor(1168, 'JPY')]);
    await act(async () => root.render(<BalanceTab {...props} meId="ben" />));
    expect(amounts()).toEqual([formatMinor(12345, 'RUB'), formatMinor(1168, 'JPY')]);
    await act(async () => root.render(<BalanceTab {...props} meId="den" />));
    expect(amounts()).toEqual([formatMinor(999, 'USD'), formatMinor(1134, 'JPY')]);
    await click('Только мои');
    expect(amounts()).toEqual([formatMinor(12345, 'RUB'), formatMinor(999, 'USD'), formatMinor(2302, 'JPY')]);
  });

  it('honors the saved spending filter and updates totals when expenses or wallet membership change', async () => {
    window.localStorage.setItem('tripsplit:mineOnly', '1');
    const props = {
      members, expenses: [expense], payments: [], transfers: [], baseCurrency: 'JPY' as const,
      meId: 'ana', onMarkSettled: vi.fn(), onUndoPayment: vi.fn(),
      onAddTransfer: vi.fn(), onUndoTransfer: vi.fn(),
    };
    const total = () => [...container.querySelectorAll('h2')]
      .find((heading) => heading.textContent === 'Всего потрачено')!.closest('section')!.querySelector('p')!.textContent;
    await act(async () => root.render(<BalanceTab {...props} />));
    expect(total()).toBe(formatMinor(500, 'JPY'));
    const paired = members.map((member) => ({ ...member, unit: 'couple' }));
    await act(async () => root.render(<BalanceTab {...props} members={paired} />));
    expect(total()).toBe(formatMinor(1000, 'JPY'));
    await act(async () => root.render(<BalanceTab {...props} members={paired} expenses={[]} />));
    expect(total()).toBe('0');
    await act(async () => root.render(<BalanceTab {...props} members={paired} />));
    expect(total()).toBe(formatMinor(1000, 'JPY'));
  });

  it('shows zero for a wallet without shares even when it paid the whole bill', async () => {
    const props = {
      members, expenses: [{ ...expense, splits: [{ memberId: 'ben', amountMinor: 1000 }] }],
      payments: [], transfers: [], baseCurrency: 'JPY' as const,
      meId: 'ana', onMarkSettled: vi.fn(), onUndoPayment: vi.fn(),
      onAddTransfer: vi.fn(), onUndoTransfer: vi.fn(),
    };
    await act(async () => root.render(<BalanceTab {...props} />));
    await click('Только мои');
    const summary = [...container.querySelectorAll('h2')]
      .find((heading) => heading.textContent === 'Всего потрачено')!.closest('section')!;
    expect([...summary.querySelectorAll('p')].map((p) => p.textContent)).toEqual(['0']);
    // A persisted filter must not zero the summary if no valid user is selected.
    await act(async () => root.render(<BalanceTab {...props} meId={null} />));
    expect(summary.querySelector('p')!.textContent).toBe(formatMinor(1000, 'JPY'));
    await act(async () => root.render(<BalanceTab {...props} meId="missing" />));
    expect(summary.querySelector('p')!.textContent).toBe(formatMinor(1000, 'JPY'));
  });

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
    await input('input[aria-label="Заплатил(а): Аня"]', '1000');
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
    await input('input[aria-label="Заплатил(а): Аня"]', '1234');
    await act(async () => window.dispatchEvent(new Event('online')));
    expect(container.querySelector<HTMLInputElement>('input[placeholder="Ужин в раменной"]')?.value).toBe('Черновик');
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Заплатил(а): Аня"]')?.value).toBe('1234');
  });

  it('saves a «Поровну» expense paid by several people: total = sum of payments, equal shares, paidMinor recorded', async () => {
    load.mockResolvedValue({ ...bundle(), members });
    vi.mocked(addExpense).mockResolvedValue(expense);
    await render();
    await chooseTab(1);
    await click('+ Добавить');
    await input('input[placeholder="Ужин в раменной"]', 'Маркет');
    await input('input[aria-label="Заплатил(а): Аня"]', '1000');
    await input('input[aria-label="Заплатил(а): Бен"]', '500');
    await click('Сохранить расход');
    expect(addExpense).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(addExpense).mock.calls[0][1];
    expect(arg.title).toBe('Маркет');
    expect(arg.amountMinor).toBe(1500); // 1000 + 500 JPY, derived from the payments
    expect(arg.payerId).toBe('ana'); // the primary payer (largest contribution)
    expect(arg.splits).toEqual([
      { memberId: 'ana', amountMinor: 750, paidMinor: 1000 },
      { memberId: 'ben', amountMinor: 750, paidMinor: 500 },
    ]);
    expect(arg.baseAmountMinor).toBe(1500); // JPY is the trip base at rate 1
  });

  it('saves a «Разделить счёт» expense with exact shares and payments, blocking a mismatch', async () => {
    const four: Member[] = [
      ...members,
      { id: 'carl', tripId: 'trip-a', name: 'Крис' },
      { id: 'dana', tripId: 'trip-a', name: 'Дана' },
    ];
    load.mockResolvedValue({ ...bundle(), members: four });
    vi.mocked(addExpense).mockResolvedValue(expense);
    await render();
    await chooseTab(1);
    await click('+ Добавить');
    await input('input[placeholder="Ужин в раменной"]', 'Счёт');
    await click('Разделить счёт');
    // Shares 500 + 700 + 300 + 400 = 1900; the first two paid equally.
    await input('input[aria-label="Доля счёта: Аня"]', '500');
    await input('input[aria-label="Доля счёта: Бен"]', '700');
    await input('input[aria-label="Доля счёта: Крис"]', '300');
    await input('input[aria-label="Доля счёта: Дана"]', '400');
    await input('input[aria-label="Заплатил(а): Аня"]', '950');
    await input('input[aria-label="Заплатил(а): Бен"]', '900');
    expect(container.textContent).toContain('суммы должны совпадать'); // 1850 ≠ 1900
    const save = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Сохранить расход',
    );
    expect(save!.disabled).toBe(true);
    expect(addExpense).not.toHaveBeenCalled();
    await input('input[aria-label="Заплатил(а): Бен"]', '950');
    await click('Сохранить расход');
    expect(addExpense).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(addExpense).mock.calls[0][1];
    expect(arg.amountMinor).toBe(1900); // Σ shares: 500 + 700 + 300 + 400
    expect(arg.payerId).toBe('ana'); // 950 = 950 → member order breaks the tie
    expect(arg.splits).toEqual([
      { memberId: 'ana', amountMinor: 500, paidMinor: 950 },
      { memberId: 'ben', amountMinor: 700, paidMinor: 950 },
      { memberId: 'carl', amountMinor: 300 },
      { memberId: 'dana', amountMinor: 400 },
    ]);
    expect(arg.baseAmountMinor).toBe(1900); // JPY is the trip base at rate 1
  });
});
