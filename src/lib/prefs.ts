import type { ExpenseFilter } from './expenseView';

/** UI preferences persisted in localStorage. */

const MINE_ONLY_KEY = 'tripsplit:mineOnly';
const EXPENSE_FILTER_KEY = 'tripsplit:expenseFilter';

/** "Только мои" filter on the balances tab (also used by older clients). */
export function readMineOnlyPref(): boolean {
  try {
    return localStorage.getItem(MINE_ONLY_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeMineOnlyPref(value: boolean): void {
  try {
    localStorage.setItem(MINE_ONLY_KEY, value ? '1' : '0');
  } catch {
    /* private mode — the pref just won't persist */
  }
}

/** Migrate the old two-state filter; the three-state expense filter is independent. */
export function readExpenseFilterPref(): ExpenseFilter {
  try {
    const value = localStorage.getItem(EXPENSE_FILTER_KEY);
    if (value === 'all' || value === 'involved' || value === 'personal') return value;
  } catch {
    /* private mode */
  }
  return readMineOnlyPref() ? 'involved' : 'all';
}

export function writeExpenseFilterPref(value: ExpenseFilter): void {
  try {
    localStorage.setItem(EXPENSE_FILTER_KEY, value);
  } catch {
    /* private mode — the pref just won't persist */
  }
}
