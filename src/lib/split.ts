import type { Split } from './types';

export interface ExactSplitValidation {
  ok: boolean;
  error?: string;
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

export function validateExactSplit(splits: Split[], totalMinor: number): ExactSplitValidation {
  if (splits.length === 0) return { ok: false, error: 'Add at least one participant' };
  const seen = new Set<string>();
  for (const split of splits) {
    if (!Number.isInteger(split.amountMinor) || split.amountMinor <= 0) {
      return { ok: false, error: 'Each share must be a positive amount' };
    }
    if (seen.has(split.memberId)) return { ok: false, error: 'Duplicate participant in split' };
    seen.add(split.memberId);
  }
  const total = sumSplits(splits);
  if (total !== totalMinor) {
    return { ok: false, error: `Shares must add up to the total (off by ${Math.abs(totalMinor - total)} minor units)` };
  }
  return { ok: true };
}
