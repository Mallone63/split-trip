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
  it('counts ledger splits 1:1 and never applies the frozen fxRate', () => {
    // Regression: fxRate is frozen against the TRIP base (e.g. ¥ per ₽ at entry
    // time) and must never leak into a same-currency ledger.
    const expenses: Expense[] = [
      // Ana pays ₽9,800.00 for all 4 → ₽2,450.00 each.
      mkExpense({
        payerId: 'ana',
        currency: 'RUB',
        amountMinor: 980000,
        fxRate: 1.9599, // stale RUB→JPY rate stored on the expense
        splits: [
          { memberId: 'ana', amountMinor: 245000 },
          { memberId: 'ben', amountMinor: 245000 },
          { memberId: 'carl', amountMinor: 245000 },
          { memberId: 'dana', amountMinor: 245000 },
        ],
      }),
    ];

    const balances = computeBalances(members, expenses);
    const byId = new Map(balances.map((b) => [b.memberId, b.netMinor]));
    expect(byId.get('ana')).toBe(735000); // paid 9800, owes 2450 → +7350 (not ×1.9599)
    expect(byId.get('ben')).toBe(-245000);
    expect(byId.get('carl')).toBe(-245000);
    expect(byId.get('dana')).toBe(-245000);
    expect(balances.reduce((sum, b) => sum + b.netMinor, 0)).toBe(0);
  });

  it('keeps separate ledgers independent: each currency nets inside itself', () => {
    const expenses: Expense[] = [
      // RUB ledger: Ana pays ₽3,000.00, 3 of 4 took part → ₽1,000.00 each.
      mkExpense({
        payerId: 'ana',
        currency: 'RUB',
        amountMinor: 300000,
        splits: [
          { memberId: 'ana', amountMinor: 100000 },
          { memberId: 'ben', amountMinor: 100000 },
          { memberId: 'carl', amountMinor: 100000 },
        ],
      }),
      // USD ledger: Ben pays $12.00 for all 4 → $3.00 each.
      mkExpense({
        payerId: 'ben',
        currency: 'USD',
        amountMinor: 1200,
        splits: [
          { memberId: 'ana', amountMinor: 300 },
          { memberId: 'ben', amountMinor: 300 },
          { memberId: 'carl', amountMinor: 300 },
          { memberId: 'dana', amountMinor: 300 },
        ],
      }),
    ];

    const rub = computeBalances(
      members,
      expenses.filter((e) => e.currency === 'RUB'),
    );
    const rubById = new Map(rub.map((b) => [b.memberId, b.netMinor]));
    expect(rubById.get('ana')).toBe(200000); // paid 3000, owes 1000 → +2000
    expect(rubById.get('dana')).toBe(0); // not in the splits → owes nothing here
    expect(rub.reduce((sum, b) => sum + b.netMinor, 0)).toBe(0);

    const usd = computeBalances(
      members,
      expenses.filter((e) => e.currency === 'USD'),
    );
    const usdById = new Map(usd.map((b) => [b.memberId, b.netMinor]));
    expect(usdById.get('ben')).toBe(900); // paid 12.00, owes 3.00 → +9.00
    expect(usdById.get('ana')).toBe(-300);
    expect(usd.reduce((sum, b) => sum + b.netMinor, 0)).toBe(0);
  });

  it('nets payments toward zero; an overpayment flips the debtor into a creditor', () => {
    const balances = computeBalances(
      members,
      [
        mkExpense({
          payerId: 'ana',
          amountMinor: 3000,
          splits: [
            { memberId: 'ana', amountMinor: 1000 },
            { memberId: 'ben', amountMinor: 1000 },
            { memberId: 'carl', amountMinor: 1000 },
          ],
        }),
      ],
      // Carl owed $10.00 but paid $15.00 (no change available) → now +5.00.
      [{ id: 'p1', tripId: 't', payerId: 'carl', receiverId: 'ana', amountMinor: 1500 }],
    );
    const byId = new Map(balances.map((b) => [b.memberId, b.netMinor]));
    expect(byId.get('ana')).toBe(500); // +2000, received 1500
    expect(byId.get('ben')).toBe(-1000); // untouched
    expect(byId.get('carl')).toBe(500); // owed 1000, paid 1500 → now owed back
    expect(byId.get('dana')).toBe(0);
    expect(balances.reduce((sum, b) => sum + b.netMinor, 0)).toBe(0);
  });

  it('returns zero balances when there are no expenses', () => {
    const balances = computeBalances(members, []);
    expect(balances).toEqual(members.map((m) => ({ memberId: m.id, netMinor: 0 })));
  });
});

describe('suggestSettlements', () => {
  it('settles the ledger with minimal transfers', () => {
    const balances = computeBalances(members, [
      // Ana pays $60.00 for all 4 → $15.00 each.
      mkExpense({
        payerId: 'ana',
        amountMinor: 6000,
        splits: [
          { memberId: 'ana', amountMinor: 1500 },
          { memberId: 'ben', amountMinor: 1500 },
          { memberId: 'carl', amountMinor: 1500 },
          { memberId: 'dana', amountMinor: 1500 },
        ],
      }),
      // Ana pays $30.00, only 3 of 4 took part (no Dana) → $10.00 each.
      mkExpense({
        payerId: 'ana',
        amountMinor: 3000,
        splits: [
          { memberId: 'ana', amountMinor: 1000 },
          { memberId: 'ben', amountMinor: 1000 },
          { memberId: 'carl', amountMinor: 1000 },
        ],
      }),
    ]);

    const settlements = suggestSettlements(balances);
    const total = settlements.reduce((acc, s) => acc + s.amountMinor, 0);
    // Total owed = 25.00 + 25.00 + 15.00 = 65.00, all to Ana.
    expect(total).toBe(6500);
    expect(settlements).toEqual([
      { fromMemberId: 'ben', toMemberId: 'ana', amountMinor: 2500 },
      { fromMemberId: 'carl', toMemberId: 'ana', amountMinor: 2500 },
      { fromMemberId: 'dana', toMemberId: 'ana', amountMinor: 1500 },
    ]);
  });

  it('returns no settlements when everyone is even', () => {
    const balances = computeBalances(members, []);
    expect(suggestSettlements(balances)).toEqual([]);
  });

  it('handles a simple one-way debt', () => {
    const settlements = suggestSettlements([
      { memberId: 'ana', netMinor: 1200 },
      { memberId: 'ben', netMinor: -1200 },
    ]);
    expect(settlements).toEqual([
      { fromMemberId: 'ben', toMemberId: 'ana', amountMinor: 1200 },
    ]);
  });

  it('wallets settle as one; partial payment leaves one debtor', () => {
    const pairedMembers: Member[] = [
      { id: 'denis', tripId: 't', name: 'Denis', unit: 'u1' },
      { id: 'ana', tripId: 't', name: 'Ana', unit: 'u1' },
      { id: 'pasha', tripId: 't', name: 'Pasha', unit: null },
      { id: 'ben', tripId: 't', name: 'Ben', unit: null },
    ];
    const balances = computeBalances(
      pairedMembers,
      [
        // Pasha pays $50.00 for all 4 → $12.50 each.
        mkExpense({
          payerId: 'pasha',
          amountMinor: 5000,
          splits: [
            { memberId: 'denis', amountMinor: 1250 },
            { memberId: 'ana', amountMinor: 1250 },
            { memberId: 'pasha', amountMinor: 1250 },
            { memberId: 'ben', amountMinor: 1250 },
          ],
        }),
      ],
      // Ben already settled his share.
      [{ id: 'p1', tripId: 't', payerId: 'ben', receiverId: 'pasha', amountMinor: 1250 }],
    );
    const byId = new Map(balances.map((b) => [b.memberId, b.netMinor]));
    expect(byId.get('ben')).toBe(0); // paid — settled
    expect(byId.get('pasha')).toBe(2500); // was owed 37.50, received 12.50 → still owed 25.00
    expect(byId.get('denis')).toBe(-1250);
    expect(byId.get('ana')).toBe(-1250);
    expect(balances.reduce((sum, b) => sum + b.netMinor, 0)).toBe(0);

    // The wallet still shows the outstanding debt, and only u1 is suggested.
    const wallets = aggregateByUnit(pairedMembers, balances);
    expect(wallets.find((w) => w.key === 'u1')?.netMinor).toBe(-2500);
    const settlements = suggestSettlements(
      wallets.map((w) => ({ memberId: w.key, netMinor: w.netMinor })),
    );
    expect(settlements).toEqual([
      { fromMemberId: 'u1', toMemberId: 'solo:pasha', amountMinor: 2500 },
    ]);
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
    const balances = computeBalances(pairedMembers, [
      mkExpense({
        payerId: 'ana',
        amountMinor: 10000,
        splits: [
          { memberId: 'ana', amountMinor: 3334 },
          { memberId: 'ben', amountMinor: 3333 },
          { memberId: 'carl', amountMinor: 3333 },
        ],
      }),
    ]);

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
    const balances = computeBalances(pairedMembers, [
      mkExpense({
        payerId: 'ana',
        amountMinor: 5000,
        splits: [
          { memberId: 'ana', amountMinor: 2500 },
          { memberId: 'carl', amountMinor: 2500 },
        ],
      }),
    ]);

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