// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ExpenseList from './ExpenseList';
import { formatMinor } from '../lib/currencies';
import type { Expense, Member } from '../lib/types';

const members: Member[] = [
  { id: 'a', tripId: 't', name: 'Пава', unit: 'pair' },
  { id: 'b', tripId: 't', name: 'Наташа', unit: 'pair' },
  { id: 'c', tripId: 't', name: 'Ден' },
];
const shared: Expense = {
  id: 'shared', tripId: 't', title: 'Общий ужин', payerId: 'c', currency: 'JPY',
  amountMinor: 3000, baseAmountMinor: 3000, fxRate: 1, spentAt: '2026-11-12',
  splits: members.map((m) => ({ memberId: m.id, amountMinor: 1000 })),
};
const personal: Expense = { ...shared, id: 'personal', title: 'Кофе пары', payerId: 'b',
  amountMinor: 1000, baseAmountMinor: 1000,
  splits: [{ memberId: 'a', amountMinor: 500 }, { memberId: 'b', amountMinor: 500, paidMinor: 1000 }],
};
const outsider: Expense = { ...shared, id: 'outsider', title: 'Покупка Дена',
  amountMinor: 500, baseAmountMinor: 500, splits: [{ memberId: 'c', amountMinor: 500 }],
};
const forFriend: Expense = { ...outsider, id: 'for-friend', title: 'Билет Дена', payerId: 'a',
  amountMinor: 900, baseAmountMinor: 900, splits: [{ memberId: 'c', amountMinor: 900 }],
};
const expenses = [shared, personal, outsider, forFriend];
let container: HTMLDivElement;
let root: Root;
const onAdd = vi.fn();
const onDelete = vi.fn().mockResolvedValue(undefined);
type Overrides = Partial<Parameters<typeof ExpenseList>[0]>;
const render = (overrides: Overrides = {}) => act(async () => root.render(
  <ExpenseList {...{ expenses, members, meId: 'a', baseCurrency: 'JPY', onAdd, onDelete, ...overrides }} />,
));
const click = (text: string) => act(async () => {
  const button = [...container.querySelectorAll('button')].find((el) => el.textContent?.trim() === text);
  expect(button).toBeDefined();
  button!.click();
});
const row = (title: string) => [...container.querySelectorAll('section > ul > li')]
  .find((el) => el.textContent?.includes(title))!;
const summary = () => container.querySelector('h3')!.textContent!;
const money = (amount: number) => formatMinor(amount, 'JPY');

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('expense filters and daily summaries', () => {
  it('keeps full bill amounts, shows wallet shares, and updates daily totals for all three filters', async () => {
    await render();
    expect(container.querySelector('h2')).toBeNull();
    expect(summary()).toContain(`Σ ${money(5400)}`);
    expect(summary()).toContain(`Наша доля: ${money(3000)}`);
    expect(row('Общий ужин').textContent).toContain(money(3000));
    expect(row('Общий ужин').textContent).toContain(`Наша доля: ${money(2000)}`);
    expect(row('Кофе пары').textContent).toContain('Личная');
    expect(row('Кофе пары').textContent).not.toContain('Наша доля');
    expect(row('Билет Дена').textContent).not.toContain('Наша доля');
    expect(row('Билет Дена').textContent).toContain('Оплачено за другого');
    expect(row('Покупка Дена').textContent).toContain(`Наша доля: ${money(0)}`);
    await click('С нами');
    expect(container.textContent).not.toContain('Покупка Дена');
    expect(summary()).toContain(`Σ ${money(4900)}`);
    expect(summary()).toContain(`Наша доля: ${money(3000)}`);
    await click('Личные');
    expect(container.querySelectorAll('section > ul > li')).toHaveLength(1);
    expect(row('Кофе пары')).toBeDefined();
    expect(summary()).toContain(`Σ ${money(1000)}`);
    expect(summary()).toContain(`Наша доля: ${money(1000)}`);
    await click('Все');
    expect(container.querySelectorAll('section > ul > li')).toHaveLength(4);
  });

  it('converts mixed-currency day totals with frozen rates and retains the original row currency', async () => {
    const rub: Expense = { ...shared, id: 'rub', title: 'Рубли', currency: 'RUB', amountMinor: 100,
      baseAmountMinor: 1, fxRate: 1.5, splits: [
        { memberId: 'a', amountMinor: 33 }, { memberId: 'b', amountMinor: 33 },
        { memberId: 'c', amountMinor: 34 },
      ] };
    await render({ expenses: [shared, rub] });
    expect(summary()).toContain(`Σ ${money(3001)}`);
    expect(summary()).toContain(`Наша доля: ${money(2000)}`);
    expect(row('Рубли').textContent).toContain(`Наша доля: ${formatMinor(66, 'RUB')}`);
    expect(row('Рубли').textContent).toContain(`≈ ${money(1)}`);
  });

  it('uses solo labels and responds to identity, membership and live expense changes', async () => {
    await render();
    await click('Личные');
    await render({ meId: 'b' });
    expect(row('Кофе пары')).toBeDefined();
    await render({ meId: 'c' });
    expect(row('Покупка Дена')).toBeDefined();
    expect(container.textContent).not.toContain('Кофе пары');
    expect(summary()).toContain(`Моя доля: ${money(500)}`);
    await click('Со мной');
    expect(row('Билет Дена').textContent).toContain(`Моя доля: ${money(900)}`);
    await render({ meId: 'a', members: members.map((m) => ({ ...m, unit: null })) });
    expect(row('Общий ужин').textContent).toContain(`Моя доля: ${money(1000)}`);
    await click('Личные');
    expect(container.textContent).toContain('Личных расходов пока нет.');
    await render({ expenses: [personal] });
    expect(summary()).toContain(`Наша доля: ${money(1000)}`);
  });

  it.each([null, 'removed'])('falls back to all expenses without guessing identity %s', async (meId) => {
    localStorage.setItem('tripsplit:expenseFilter', 'personal');
    await render({ meId });
    expect(container.querySelector('[aria-label="Фильтр расходов"]')).toBeNull();
    expect(container.querySelectorAll('section > ul > li')).toHaveLength(4);
    expect(summary()).toContain(`Σ ${money(5400)}`);
    expect(summary()).not.toContain('доля');
  });

  it('migrates the old filter, remembers the new choice, and leaves the balance filter unchanged', async () => {
    localStorage.setItem('tripsplit:mineOnly', '1');
    await render();
    expect(container.querySelector('[aria-pressed="true"]')?.textContent).toBe('С нами');
    await click('Личные');
    expect(localStorage.getItem('tripsplit:expenseFilter')).toBe('personal');
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(container.querySelector('[aria-pressed="true"]')?.textContent).toBe('Личные');
    await click('Все');
    expect(localStorage.getItem('tripsplit:mineOnly')).toBe('1');
  });

  it('renders without browser storage and keeps the filter usable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Unavailable'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Unavailable'); });
    await render();
    await click('Личные');
    expect(row('Кофе пары')).toBeDefined();
  });

  it('keeps date groups ordered, labels today locally and displays complete six-digit sums', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 12, 0, 15));
    const large: Expense = { ...shared, amountMinor: 500000, baseAmountMinor: 500000,
      splits: [{ memberId: 'a', amountMinor: 50000 }, { memberId: 'b', amountMinor: 50000 },
        { memberId: 'c', amountMinor: 400000 }],
    };
    await render({ expenses: [{ ...large, id: 'yesterday', spentAt: '2026-11-11' }, large] });
    const headings = [...container.querySelectorAll('h3')];
    expect(headings[0].textContent).toContain('Сегодня');
    expect(headings[1].textContent).toContain('11 нояб.');
    for (const heading of headings) {
      expect(heading.textContent).toContain(`Σ ${money(500000)}`);
      expect(heading.textContent).toContain(`Наша доля: ${money(100000)}`);
    }
  });

  it('preserves add and expanded expense actions', async () => {
    await render();
    await click('+ Добавить');
    expect(onAdd).toHaveBeenCalledOnce();
    await act(async () => row('Общий ужин').querySelector('button')!.click());
    expect(row('Общий ужин').querySelectorAll('li')).toHaveLength(3);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await click('Удалить расход');
    expect(onDelete).toHaveBeenCalledWith('shared');
  });
});
