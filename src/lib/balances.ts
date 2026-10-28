import type { CurrencyCode } from './currencies';
import { toBaseMinor } from './fx';
import type { Expense, Member } from './types';

export interface Balance {
  memberId: string;
  /** Net position in base-currency minor units: positive = is owed money, negative = owes. */
  netMinor: number;
}

export interface Settlement {
  fromMemberId: string;
  toMemberId: string;
  amountMinor: number;
}

/**
 * Net balance per member in the trip's base currency.
 *
 * Each split is converted to the base currency independently, and the payer is credited
 * with exactly the sum of those conversions — so balances always sum to zero, no matter
 * how currencies mix.
 */
export function computeBalances(members: Member[], expenses: Expense[], baseCurrency: CurrencyCode): Balance[] {
  const net = new Map<string, number>(members.map((member) => [member.id, 0]));
  for (const expense of expenses) {
    for (const split of expense.splits) {
      const shareBase = toBaseMinor(split.amountMinor, expense.fxRate, expense.currency, baseCurrency);
      net.set(split.memberId, (net.get(split.memberId) ?? 0) - shareBase);
      net.set(expense.payerId, (net.get(expense.payerId) ?? 0) + shareBase);
    }
  }
  return members.map((member) => ({ memberId: member.id, netMinor: net.get(member.id) ?? 0 }));
}

/**
 * Minimal set of transfers that settles all debts (greedy min-cash-flow).
 * Deterministic: debtors are processed most-in-debt first, creditors largest first.
 */
export function suggestSettlements(balances: Balance[]): Settlement[] {
  const debtors = balances
    .filter((b) => b.netMinor < 0)
    .map((b) => ({ ...b }))
    .sort((a, b) => a.netMinor - b.netMinor);
  const creditors = balances
    .filter((b) => b.netMinor > 0)
    .map((b) => ({ ...b }))
    .sort((a, b) => b.netMinor - a.netMinor);

  const settlements: Settlement[] = [];
  let di = 0;
  let ci = 0;
  while (di < debtors.length && ci < creditors.length) {
    const debtor = debtors[di];
    const creditor = creditors[ci];
    const amount = Math.min(-debtor.netMinor, creditor.netMinor);
    if (amount > 0) {
      settlements.push({ fromMemberId: debtor.memberId, toMemberId: creditor.memberId, amountMinor: amount });
    }
    debtor.netMinor += amount;
    creditor.netMinor -= amount;
    if (debtor.netMinor === 0) di += 1;
    if (creditor.netMinor === 0) ci += 1;
  }
  return settlements;
}

/** A wallet: one member, or several members sharing money (e.g. a couple). */
export interface UnitBalance {
  /** Stable key: the shared `unit` value, or `solo:<memberId>` for single members. */
  key: string;
  label: string;
  memberIds: string[];
  netMinor: number;
}

/**
 * Aggregate per-member balances into wallet balances. Members sharing a non-null
 * `unit` form one wallet; solo members are wallets of one. Splits stay per-person —
 * only the reporting level changes. Wallet nets still sum to zero.
 */
export function aggregateByUnit(members: Member[], balances: Balance[]): UnitBalance[] {
  const byId = new Map(members.map((member) => [member.id, member]));
  const keyOf = (memberId: string): string => byId.get(memberId)?.unit ?? `solo:${memberId}`;

  const wallets = new Map<string, UnitBalance>();
  for (const member of members) {
    const key = keyOf(member.id);
    let wallet = wallets.get(key);
    if (!wallet) {
      wallet = { key, label: member.name, memberIds: [], netMinor: 0 };
      wallets.set(key, wallet);
    }
    wallet.memberIds.push(member.id);
    wallet.label = wallet.memberIds.map((id) => byId.get(id)?.name ?? '—').join(' + ');
  }

  for (const balance of balances) {
    const wallet = wallets.get(keyOf(balance.memberId));
    if (wallet) wallet.netMinor += balance.netMinor;
  }

  return [...wallets.values()];
}
