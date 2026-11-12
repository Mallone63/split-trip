import { toBaseMinor } from './fx';
import { expensePayers } from './split';
import type { CurrencyCode } from './currencies';
import type { Expense } from './types';

export type ExpenseFilter = 'all' | 'involved' | 'personal';

/** Consumption and payments are separate: paying for a friend gives a zero share. */
export function walletExpenseShare(expense: Expense, memberIds: ReadonlySet<string>): number {
  return expense.splits.reduce(
    (sum, split) => sum + (memberIds.has(split.memberId) ? split.amountMinor : 0), 0,
  );
}

export function expenseInvolvesWallet(expense: Expense, memberIds: ReadonlySet<string>): boolean {
  return expense.splits.some((split) => split.amountMinor > 0 && memberIds.has(split.memberId))
    || expensePayers(expense).some((payer) => memberIds.has(payer.memberId));
}

/** A personal expense stays entirely inside this wallet, including who paid. */
export function isWalletOnlyExpense(expense: Expense, memberIds: ReadonlySet<string>): boolean {
  return walletExpenseShare(expense, memberIds) > 0
    && expense.splits.every((split) => split.amountMinor === 0 || memberIds.has(split.memberId))
    && expensePayers(expense).every((payer) => memberIds.has(payer.memberId));
}

/** Daily totals use the trip currency and the same frozen, per-split FX as balances. */
export function expenseDayTotals(
  expenses: Expense[], memberIds: ReadonlySet<string>, baseCurrency: CurrencyCode,
): { totalMinor: number; shareMinor: number } {
  let totalMinor = 0;
  let shareMinor = 0;
  for (const expense of expenses) {
    totalMinor += expense.baseAmountMinor;
    for (const split of expense.splits) {
      if (memberIds.has(split.memberId)) {
        shareMinor += toBaseMinor(split.amountMinor, expense.fxRate, expense.currency, baseCurrency);
      }
    }
  }
  return { totalMinor, shareMinor };
}
