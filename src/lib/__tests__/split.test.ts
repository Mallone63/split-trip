import { describe, expect, it } from 'vitest';
import { expensePayers, materializeEqualSplit, materializePaidSplit, sumSplits } from '../split';
import type { Expense } from '../types';

describe('materializeEqualSplit', () => {
  it('allocates the remainder when the payer is not one of the participants', () => {
    const splits = materializeEqualSplit(10001, ['ben', 'carl'], 'ana');
    expect(splits).toEqual([
      { memberId: 'ben', amountMinor: 5001 },
      { memberId: 'carl', amountMinor: 5000 },
    ]);
    expect(sumSplits(splits)).toBe(10001);
  });
  it('splits ¥10,000 across 3 people with the remainder cent going to the payer', () => {
    const splits = materializeEqualSplit(10000, ['ana', 'ben', 'carl'], 'ben');
    expect(sumSplits(splits)).toBe(10000);
    expect(splits).toEqual([
      { memberId: 'ana', amountMinor: 3333 },
      { memberId: 'ben', amountMinor: 3334 },
      { memberId: 'carl', amountMinor: 3333 },
    ]);
  });

  it('splits evenly when the total is divisible', () => {
    const splits = materializeEqualSplit(10000, ['a', 'b', 'c', 'd'], 'a');
    expect(splits).toEqual([
      { memberId: 'a', amountMinor: 2500 },
      { memberId: 'b', amountMinor: 2500 },
      { memberId: 'c', amountMinor: 2500 },
      { memberId: 'd', amountMinor: 2500 },
    ]);
  });

  it('covers only selected participants (3 of 4 people)', () => {
    const splits = materializeEqualSplit(9000, ['ana', 'ben', 'carl'], 'ana');
    expect(splits).toHaveLength(3);
    expect(splits.map((s) => s.memberId).sort()).toEqual(['ana', 'ben', 'carl']);
    expect(sumSplits(splits)).toBe(9000);
  });

  it('handles a single participant', () => {
    expect(materializeEqualSplit(4999, ['solo'], 'solo')).toEqual([{ memberId: 'solo', amountMinor: 4999 }]);
  });

  it('rejects non-positive or fractional totals', () => {
    expect(() => materializeEqualSplit(0, ['a'], 'a')).toThrow();
    expect(() => materializeEqualSplit(-5, ['a'], 'a')).toThrow();
    expect(() => materializeEqualSplit(1.5, ['a'], 'a')).toThrow();
  });

  it('rejects an empty participant list', () => {
    expect(() => materializeEqualSplit(100, [], 'a')).toThrow();
  });
});

describe('materializePaidSplit', () => {
  const order = ['ana', 'ben', 'carl'];

  it('divides the sum of payments equally and records who handed over what', () => {
    const { splits, primaryPayerId } = materializePaidSplit(
      [
        { memberId: 'ana', amountMinor: 6000 },
        { memberId: 'ben', amountMinor: 4000 },
      ],
      order,
      order,
    );
    expect(primaryPayerId).toBe('ana'); // largest contribution
    expect(sumSplits(splits)).toBe(10000);
    expect(splits).toEqual([
      { memberId: 'ana', amountMinor: 3334, paidMinor: 6000 },
      { memberId: 'ben', amountMinor: 3333, paidMinor: 4000 },
      { memberId: 'carl', amountMinor: 3333 },
    ]);
  });

  it('breaks ties for the primary payer by member order', () => {
    const { primaryPayerId } = materializePaidSplit(
      [
        { memberId: 'carl', amountMinor: 5000 },
        { memberId: 'ana', amountMinor: 5000 },
      ],
      order,
      order,
    );
    expect(primaryPayerId).toBe('ana');
  });

  it('works with a single payer covering the whole expense', () => {
    const { splits, primaryPayerId } = materializePaidSplit(
      [{ memberId: 'ben', amountMinor: 4999 }],
      ['ben'],
      order,
    );
    expect(primaryPayerId).toBe('ben');
    expect(splits).toEqual([{ memberId: 'ben', amountMinor: 4999, paidMinor: 4999 }]);
  });

  it('rejects empty payments, non-positive amounts, duplicates, and outside payers', () => {
    expect(() => materializePaidSplit([], order, order)).toThrow();
    expect(() => materializePaidSplit([{ memberId: 'ana', amountMinor: 0 }], order, order)).toThrow();
    expect(() => materializePaidSplit([{ memberId: 'ana', amountMinor: 1.5 }], order, order)).toThrow();
    expect(() =>
      materializePaidSplit(
        [
          { memberId: 'ana', amountMinor: 100 },
          { memberId: 'ana', amountMinor: 100 },
        ],
        order,
        order,
      ),
    ).toThrow();
    expect(() =>
      materializePaidSplit([{ memberId: 'ana', amountMinor: 100 }], ['ben', 'carl'], order),
    ).toThrow();
  });
});

describe('expensePayers', () => {
  it('falls back to the single payer with the whole total for legacy expenses', () => {
    const expense: Expense = {
      id: 'e1',
      tripId: 't',
      payerId: 'ben',
      title: 'Ужин',
      currency: 'USD',
      amountMinor: 9000,
      fxRate: 1,
      baseAmountMinor: 9000,
      splits: [
        { memberId: 'ana', amountMinor: 3000 },
        { memberId: 'ben', amountMinor: 6000 },
      ],
      spentAt: '2026-10-01',
    };
    expect(expensePayers(expense)).toEqual([{ memberId: 'ben', amountMinor: 9000 }]);
  });

  it('lists only the members who actually handed over money', () => {
    const expense: Expense = {
      id: 'e2',
      tripId: 't',
      payerId: 'ana',
      title: 'Маркет',
      currency: 'USD',
      amountMinor: 10000,
      fxRate: 1,
      baseAmountMinor: 10000,
      splits: [
        { memberId: 'ana', amountMinor: 3334, paidMinor: 6000 },
        { memberId: 'ben', amountMinor: 3333, paidMinor: 4000 },
        { memberId: 'carl', amountMinor: 3333 },
      ],
      spentAt: '2026-10-01',
    };
    expect(expensePayers(expense)).toEqual([
      { memberId: 'ana', amountMinor: 6000 },
      { memberId: 'ben', amountMinor: 4000 },
    ]);
  });
});
