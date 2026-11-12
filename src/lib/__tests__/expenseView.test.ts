import { describe, expect, it } from 'vitest';
import { expenseDayTotals, expenseInvolvesWallet, isWalletOnlyExpense, walletExpenseShare } from '../expenseView';
import type { Expense } from '../types';

const wallet = new Set(['a', 'b']);
const expense: Expense = {
  id: 'e', tripId: 'trip', title: 'Ужин', payerId: 'c', currency: 'JPY',
  amountMinor: 1001, baseAmountMinor: 1001, fxRate: 1, spentAt: '2026-11-12',
  splits: [
    { memberId: 'a', amountMinor: 334 },
    { memberId: 'b', amountMinor: 333 },
    { memberId: 'c', amountMinor: 334 },
  ],
};

describe('expense wallet views', () => {
  it('sums both partners’ consumption, independent of who paid', () => {
    expect(walletExpenseShare(expense, wallet)).toBe(667);
    expect(expenseInvolvesWallet(expense, wallet)).toBe(true);
    expect(isWalletOnlyExpense(expense, wallet)).toBe(false);
  });

  it('includes legacy and secondary payers with no share, but not idle zero splits', () => {
    const paidForFriend = { ...expense, payerId: 'a', splits: [{ memberId: 'c', amountMinor: 1001 }] };
    expect(expenseInvolvesWallet(paidForFriend, wallet)).toBe(true);
    expect(walletExpenseShare(paidForFriend, wallet)).toBe(0);
    expect(isWalletOnlyExpense(paidForFriend, wallet)).toBe(false);
    const joint = { ...expense, splits: [
      { memberId: 'a', amountMinor: 0, paidMinor: 100 },
      { memberId: 'c', amountMinor: 1001, paidMinor: 901 },
    ] };
    expect(expenseInvolvesWallet(joint, wallet)).toBe(true);
    expect(expenseInvolvesWallet({ ...joint, splits: [
      { memberId: 'a', amountMinor: 0, paidMinor: 0 },
      { memberId: 'c', amountMinor: 1001, paidMinor: 1001 },
    ] }, wallet)).toBe(false);
  });

  it('requires all consumers and actual payers to be in the personal wallet', () => {
    const personal = { ...expense, payerId: 'a', splits: [
      { memberId: 'a', amountMinor: 501, paidMinor: 1001 },
      { memberId: 'b', amountMinor: 500 },
      { memberId: 'c', amountMinor: 0 },
    ] };
    expect(isWalletOnlyExpense(personal, wallet)).toBe(true);
    expect(isWalletOnlyExpense(personal, new Set(['a']))).toBe(false);
    expect(isWalletOnlyExpense({ ...personal, splits: [
      { memberId: 'a', amountMinor: 501, paidMinor: 901 },
      { memberId: 'b', amountMinor: 500 },
      { memberId: 'c', amountMinor: 0, paidMinor: 100 },
    ] }, wallet)).toBe(false);
    expect(isWalletOnlyExpense({ ...expense, splits: [
      { memberId: 'a', amountMinor: 501 }, { memberId: 'b', amountMinor: 500 },
    ] }, wallet)).toBe(false); // External legacy payer.
  });

  it('recognizes a solo personal expense without treating it as private data', () => {
    const personal = { ...expense, payerId: 'a', splits: [{ memberId: 'a', amountMinor: 1001 }] };
    expect(isWalletOnlyExpense(personal, new Set(['a']))).toBe(true);
    expect(isWalletOnlyExpense(personal, new Set())).toBe(false);
    expect(expenseInvolvesWallet(personal, new Set())).toBe(false);
  });

  it('combines currencies using frozen per-split rounding, not live or rounded aggregate FX', () => {
    const rub = { ...expense, currency: 'RUB' as const, amountMinor: 100, fxRate: 1.5,
      baseAmountMinor: 1, splits: [
        { memberId: 'a', amountMinor: 33 }, { memberId: 'b', amountMinor: 33 },
        { memberId: 'c', amountMinor: 34 },
      ] };
    const usd = { ...expense, currency: 'USD' as const, amountMinor: 100, fxRate: 150,
      baseAmountMinor: 151, splits: [
        { memberId: 'a', amountMinor: 34 }, { memberId: 'b', amountMinor: 33 },
        { memberId: 'c', amountMinor: 33 },
      ] };
    expect(expenseDayTotals([expense, rub, usd], wallet, 'JPY')).toEqual({ totalMinor: 1153, shareMinor: 768 });
    expect(expenseDayTotals([rub], wallet, 'JPY')).toEqual({ totalMinor: 1, shareMinor: 0 });
    expect(expenseDayTotals([], wallet, 'JPY')).toEqual({ totalMinor: 0, shareMinor: 0 });
  });
});
