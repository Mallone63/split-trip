import { describe, expect, it } from 'vitest';
import { materializeEqualSplit, sumSplits, validateExactSplit } from '../split';

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

describe('validateExactSplit', () => {
  it('accepts an exact split', () => {
    const result = validateExactSplit(
      [
        { memberId: 'ana', amountMinor: 3000 },
        { memberId: 'ben', amountMinor: 2000 },
      ],
      5000,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects shares that do not add up', () => {
    const result = validateExactSplit([{ memberId: 'ana', amountMinor: 3000 }], 5000);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/add up/i);
  });

  it('rejects non-positive shares and duplicates', () => {
    expect(validateExactSplit([{ memberId: 'a', amountMinor: 0 }], 0).ok).toBe(false);
    expect(
      validateExactSplit(
        [
          { memberId: 'a', amountMinor: 500 },
          { memberId: 'a', amountMinor: 500 },
        ],
        1000,
      ).ok,
    ).toBe(false);
  });
});
