import type { Expense, Split } from './types';

export interface PaidEntry {
  memberId: string;
  amountMinor: number;
}

export interface PaidSplit {
  /** Equal shares for every participant; payers carry `paidMinor`. */
  splits: Split[];
  /** The member who handed over the most (ties broken by `memberOrder`). */
  primaryPayerId: string;
}

/**
 * Split `totalMinor` equally among `participantIds`. Rounding remainder cents are given
 * to the payer first (deterministic), so shares always sum back to the exact total.
 */
export function materializeEqualSplit(totalMinor: number, participantIds: string[], payerId: string): Split[] {
  if (!Number.isInteger(totalMinor) || totalMinor <= 0) {
    throw new Error('Total must be a positive integer amount in minor units');
  }
  const unique = [...new Set(participantIds)];
  if (unique.length === 0) throw new Error('At least one participant is required');

  const base = Math.floor(totalMinor / unique.length);
  const remainder = totalMinor - base * unique.length;
  const order = unique.includes(payerId)
    ? [payerId, ...unique.filter((id) => id !== payerId)]
    : unique;

  return unique.map((memberId) => {
    const index = order.indexOf(memberId);
    const extra = index >= 0 && index < remainder ? 1 : 0;
    return { memberId, amountMinor: base + extra };
  });
}

export function sumSplits(splits: Split[]): number {
  return splits.reduce((sum, split) => sum + split.amountMinor, 0);
}

/**
 * Materialize a «Поровну» expense paid by several members: the total is the
 * sum of what the members handed over (`paid`), divided equally among all
 * participants — remainder cents go to the primary payer (largest
 * contribution, ties broken by `memberOrder`). Every entry must be a positive
 * integer minor amount from one of the participants. The returned splits carry
 * `paidMinor` on each payer so balances can net payment − share; store
 * `primaryPayerId` as the expense's `payerId` (the DB column is single-valued).
 */
export function materializePaidSplit(paid: PaidEntry[], participantIds: string[], memberOrder: string[]): PaidSplit {
  if (paid.length === 0) throw new Error('At least one member must have paid');
  const participants = new Set(participantIds);
  const paidByMember = new Map<string, number>();
  let totalMinor = 0;
  for (const entry of paid) {
    if (!Number.isInteger(entry.amountMinor) || entry.amountMinor <= 0) {
      throw new Error('Each paid amount must be a positive integer amount in minor units');
    }
    if (paidByMember.has(entry.memberId)) throw new Error('Duplicate payer in paid amounts');
    if (!participants.has(entry.memberId)) throw new Error('A payer must be one of the participants');
    paidByMember.set(entry.memberId, entry.amountMinor);
    totalMinor += entry.amountMinor;
  }
  const rankOf = (memberId: string): number => {
    const index = memberOrder.indexOf(memberId);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  const primaryPayerId = [...paid].sort(
    (a, b) => b.amountMinor - a.amountMinor || rankOf(a.memberId) - rankOf(b.memberId),
  )[0].memberId;
  const splits = materializeEqualSplit(totalMinor, participantIds, primaryPayerId);
  return {
    primaryPayerId,
    splits: splits.map((split) => {
      const paidMinor = paidByMember.get(split.memberId);
      return paidMinor === undefined ? split : { ...split, paidMinor };
    }),
  };
}

export interface CustomSplit {
  /** Exact per-person bill shares; payers carry `paidMinor`. */
  splits: Split[];
  /** The member who handed over the most (ties broken by `memberOrder`). */
  primaryPayerId: string;
}

/**
 * Materialize a «Разделить счёт» expense: every participant holds an exact
 * share of the bill (`shares`) and payers record what they handed over
 * (`paid`). The two sums must match exactly — that equality is what keeps
 * balances zero-sum, since everyone nets payment − share. Returns splits
 * carrying `paidMinor` on each payer (members who neither hold a share nor
 * paid are omitted; a payer without a share keeps `amountMinor: 0`) and
 * `primaryPayerId` for the expense's single-valued `payerId` column.
 */
export function materializeCustomSplit(
  shares: PaidEntry[],
  paid: PaidEntry[],
  participantIds: string[],
  memberOrder: string[],
): CustomSplit {
  const participants = new Set(participantIds);
  const shareByMember = new Map<string, number>();
  let shareTotal = 0;
  for (const entry of shares) {
    if (!Number.isInteger(entry.amountMinor) || entry.amountMinor <= 0) {
      throw new Error('Each bill share must be a positive integer amount in minor units');
    }
    if (shareByMember.has(entry.memberId)) throw new Error('Duplicate member in bill shares');
    if (!participants.has(entry.memberId)) {
      throw new Error('A member holding a share must be one of the participants');
    }
    shareByMember.set(entry.memberId, entry.amountMinor);
    shareTotal += entry.amountMinor;
  }
  if (shareByMember.size === 0) throw new Error('At least one member must hold a share of the bill');

  const paidByMember = new Map<string, number>();
  let paidTotal = 0;
  for (const entry of paid) {
    if (!Number.isInteger(entry.amountMinor) || entry.amountMinor <= 0) {
      throw new Error('Each paid amount must be a positive integer amount in minor units');
    }
    if (paidByMember.has(entry.memberId)) throw new Error('Duplicate payer in paid amounts');
    if (!participants.has(entry.memberId)) throw new Error('A payer must be one of the participants');
    paidByMember.set(entry.memberId, entry.amountMinor);
    paidTotal += entry.amountMinor;
  }
  if (paidTotal !== shareTotal) {
    throw new Error('Paid amounts must sum to the bill shares');
  }

  const rankOf = (memberId: string): number => {
    const index = memberOrder.indexOf(memberId);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  // paid is non-empty here: paidTotal = shareTotal > 0.
  const primaryPayerId = [...paid].sort(
    (a, b) => b.amountMinor - a.amountMinor || rankOf(a.memberId) - rankOf(b.memberId),
  )[0].memberId;

  const splits: Split[] = [];
  for (const memberId of new Set(participantIds)) {
    const share = shareByMember.get(memberId);
    const paidMinor = paidByMember.get(memberId);
    if (share === undefined && paidMinor === undefined) continue;
    const split: Split = { memberId, amountMinor: share ?? 0 };
    if (paidMinor !== undefined) split.paidMinor = paidMinor;
    splits.push(split);
  }
  return { splits, primaryPayerId };
}

/**
 * Who handed over money for an expense: the splits carrying `paidMinor` for
 * jointly-paid expenses, otherwise the single payer with the whole total
 * (legacy expenses store no per-member paid amounts).
 */
export function expensePayers(expense: Expense): PaidEntry[] {
  const paid = expense.splits.flatMap((split) =>
    split.paidMinor != null && split.paidMinor > 0
      ? [{ memberId: split.memberId, amountMinor: split.paidMinor }]
      : [],
  );
  if (paid.length > 0) return paid;
  return [{ memberId: expense.payerId, amountMinor: expense.amountMinor }];
}
