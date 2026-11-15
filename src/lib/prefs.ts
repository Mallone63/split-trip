import type { ExpenseFilter } from './expenseView';

/** UI preferences persisted in localStorage. */

const MINE_ONLY_KEY = 'tripsplit:mineOnly';
const EXPENSE_FILTER_KEY = 'tripsplit:expenseFilter';
const LAST_TAB_KEY = 'tripsplit:lastTab';

export function readLastTab(): 'balances' | 'expenses' {
  const linked = new URLSearchParams(window.location.search).get('tab');
  if (linked === 'balances' || linked === 'expenses') return linked;
  try {
    return localStorage.getItem(LAST_TAB_KEY) === 'expenses' ? 'expenses' : 'balances';
  } catch {
    return 'balances';
  }
}

export function writeLastTab(tab: string): void {
  if (tab !== 'balances' && tab !== 'expenses') return;
  try {
    localStorage.setItem(LAST_TAB_KEY, tab);
  } catch { /* Storage is optional. */ }
}

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
