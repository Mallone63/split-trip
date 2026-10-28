import { describe, expect, it } from 'vitest';
import { aggregateByUnit, computeBalances, suggestSettlements } from '../balances';
import type { Expense, Member } from '../types';

const members: Member[] = [
  { id: 'ana', tripId: 't', name: 'Ana' },
  { id: 'ben', tripId: 't', name: 'Ben' },
  { id: 'carl', tripId: 't', name: 'Carl' },
  { id: 'dana', tripId: 't', name: 'Dana' },
];

let seq = 0;
function mkExpense(partial: Partial<Expense> & { payerId: string; splits: Expense['splits'] }): Expense {
  seq += 1;
  return {
    id: `e${seq}`,
    tripId: 't',
    title: `expense ${seq}`,
    currency: 'USD',
    amountMinor: 0,
    fxRate: 1,
    baseAmountMinor: 0,
    spentAt: '2026-10-01',
    ...partial,
  };
}

describe('computeBalances', () => {
  it('computes mixed-currency balances and always sums to zero', () => {
    const expenses: Expense[] = [
      // Ana pays $60, split among all 4 → $15 each.
      mkExpense({
        payerId: 'ana',
        currency: 'USD',
        amountMinor: 6000,
        fxRate: 1,
        splits: [
          { memberId: 'ana', amountMinor: 1500 },
          { memberId: 'ben', amountMinor: 1500 },
          { memberId: 'carl', amountMinor: 1500 },
          { memberId: 'dana', amountMinor: 1500 },
        ],
      }),
      // Ben pays ¥9,400 at 0.005 USD/JPY → $47; split among all 4 → $11.75 each.
      mkExpense({
        payerId: 'ben',
        currency: 'JPY',
        amountMinor: 9400,
        fxRate: 0.005,
        splits: [
          { memberId: 'ana', amountMinor: 2350 },
          { memberId: 'ben', amountMinor: 2350 },
          { memberId: 'carl', amountMinor: 2350 },
          { memberId: 'dana', amountMinor: 2350 },
        ],
      }),
      // Ana pays ₽3,000 at 0.01 USD/RUB → $30, but only 3 of 4 took part (no Dana).
      mkExpense({
        payerId: 'ana',
        currency: 'RUB',
        amountMinor: 300000,
        fxRate: 0.01,
        splits: [
          { memberId: 'ana', amountMinor: 100000 },
          { memberId: 'ben', amountMinor: 100000 },
          { memberId: 'carl', amountMinor: 100000 },
        ],
      }),
    ];

    const balances = computeBalances(members, expenses, 'USD');
    const byId = new Map(balances.map((b) => [b.memberId, b.netMinor]));

    // Ana: paid 90.00, owes 15 + 11.75 + 10 = 36.75 → +53.25
    expect(byId.get('ana')).toBe(5325);
    // Ben: paid 47.00, owes 36.75 → +10.25
    expect(byId.get('ben')).toBe(1025);
    // Carl: owes everything → −36.75
    expect(byId.get('carl')).toBe(-3675);
    // Dana: skipped the ₽ expense → −26.75
    expect(byId.get('dana')).toBe(-2675);

    const sum = balances.reduce((acc, b) => acc + b.netMinor, 0);
    expect(sum).toBe(0);
  });

  it('returns zero balances when there are no expenses', () => {
    const balances = computeBalances(members, [], 'USD');
    expect(balances).toEqual(members.map((m) => ({ memberId: m.id, netMinor: 0 })));
  });
});

describe('suggestSettlements', () => {
  it('settles the mixed-currency scenario with minimal transfers', () => {
    const balances = computeBalances(members, [
      mkExpense({
        payerId: 'ana',
        splits: [
          { memberId: 'ana', amountMinor: 1500 },
          { memberId: 'ben', amountMinor: 1500 },
          { memberId: 'carl', amountMinor: 1500 },
          { memberId: 'dana', amountMinor: 1500 },
        ],
        amountMinor: 6000,
      }),
      mkExpense({
        payerId: 'ben',
        currency: 'JPY',
        amountMinor: 9400,
        fxRate: 0.005,
        splits: [
          { memberId: 'ana', amountMinor: 2350 },
          { memberId: 'ben', amountMinor: 2350 },
          { memberId: 'carl', amountMinor: 2350 },
          { memberId: 'dana', amountMinor: 2350 },
        ],
      }),
      mkExpense({
        payerId: 'ana',
        currency: 'RUB',
        amountMinor: 300000,
        fxRate: 0.01,
        splits: [
          { memberId: 'ana', amountMinor: 100000 },
          { memberId: 'ben', amountMinor: 100000 },
          { memberId: 'carl', amountMinor: 100000 },
        ],
      }),
    ], 'USD');

    const settlements = suggestSettlements(balances);
    const total = settlements.reduce((acc, s) => acc + s.amountMinor, 0);
    // Total owed = 36.75 + 26.75 = 63.50
    expect(total).toBe(6350);
    expect(settlements.length).toBeLessThanOrEqual(members.length - 1);

    // Applying the settlements must zero out every balance.
    const net = new Map(balances.map((b) => [b.memberId, b.netMinor]));
    for (const s of settlements) {
      net.set(s.fromMemberId, (net.get(s.fromMemberId) ?? 0) + s.amountMinor);
      net.set(s.toMemberId, (net.get(s.toMemberId) ?? 0) - s.amountMinor);
    }
    expect([...net.values()].every((v) => v === 0)).toBe(true);
  });

  it('returns no settlements when everyone is even', () => {
    const balances = computeBalances(members, [], 'USD');
    expect(suggestSettlements(balances)).toEqual([]);
  });

  it('handles a simple one-way debt', () => {
    const settlements = suggestSettlements([
      { memberId: 'ana', netMinor: 1200 },
      { memberId: 'ben', netMinor: -1200 },
    ]);
    expect(settlements).toEqual([{ fromMemberId: 'ben', toMemberId: 'ana', amountMinor: 1200 }]);
  });
});

describe('aggregateByUnit', () => {
  const pairedMembers: Member[] = [
    { id: 'ana', tripId: 't', name: 'Ana', unit: 'u1' },
    { id: 'ben', tripId: 't', name: 'Ben', unit: 'u1' },
    { id: 'carl', tripId: 't', name: 'Carl', unit: null },
  ];

  it('merges a couple into one wallet, labels it, and keeps wallets zero-sum', () => {
    // Ana pays 100.00 for all three: shares 33.34 / 33.33 / 33.33.
    const balances = computeBalances(
      pairedMembers,
      [
        mkExpense({
          payerId: 'ana',
          amountMinor: 10000,
          splits: [
            { memberId: 'ana', amountMinor: 3334 },
            { memberId: 'ben', amountMinor: 3333 },
            { memberId: 'carl', amountMinor: 3333 },
          ],
        }),
      ],
      'USD',
    );

    const wallets = aggregateByUnit(pairedMembers, balances);
    const byKey = new Map(wallets.map((w) => [w.key, w]));

    // The couple paid 100.00 and consumed 66.67 → +33.33; Carl owes 33.33.
    expect(byKey.get('u1')?.netMinor).toBe(3333);
    expect(byKey.get('u1')?.label).toBe('Ana + Ben');
    expect(byKey.get('solo:carl')?.netMinor).toBe(-3333);
    expect(wallets.reduce((sum, w) => sum + w.netMinor, 0)).toBe(0);
  });

  it('credits the shared wallet when one partner pays for someone outside it', () => {
    // Ana (of the u1 couple) pays 50.00; participants: Ana and Carl only.
    const balances = computeBalances(
      pairedMembers,
      [
        mkExpense({
          payerId: 'ana',
          amountMinor: 5000,
          splits: [
            { memberId: 'ana', amountMinor: 2500 },
            { memberId: 'carl', amountMinor: 2500 },
          ],
        }),
      ],
      'USD',
    );

    const wallets = aggregateByUnit(pairedMembers, balances);
    expect(wallets.find((w) => w.key === 'u1')?.netMinor).toBe(2500);

    const settlements = suggestSettlements(
      wallets.map((w) => ({ memberId: w.key, netMinor: w.netMinor })),
    );
    expect(settlements).toEqual([
      { fromMemberId: 'solo:carl', toMemberId: 'u1', amountMinor: 2500 },
    ]);
  });

  it('behaves like per-member balances when nothing is paired', () => {
    const wallets = aggregateByUnit(members, []);
    expect(wallets.map((w) => [w.key, w.netMinor])).toEqual(
      members.map((m) => [`solo:${m.id}`, 0]),
    );
  });
});
