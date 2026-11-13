import { afterEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => vi.fn());
vi.mock('../supabase', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  return { supabase: createClient('https://example.supabase.co', 'test-key', {
    auth: { persistSession: false }, global: { fetch: http },
  }) };
});
import { addExpense, loadTripBundle, type NewExpenseInput } from '../api';

afterEach(() => vi.resetAllMocks());
const input: NewExpenseInput = {
  title: 'Fixture', payerId: 'payer', currency: 'JPY', amountMinor: 100,
  baseAmountMinor: 100, fxRate: 1, splits: [{ memberId: 'payer', amountMinor: 100 }], spentAt: '2026-11-13',
};
const row = { id: 'expense', trip_id: 'trip', payer_id: 'payer', title: input.title,
  currency: 'JPY', amount: 100, fx_rate: 1, base_amount: 100, splits: input.splits, spent_at: input.spentAt };

describe('expense author persistence', () => {
  it('keeps old databases writable until the migration is applied', async () => {
    http.mockResolvedValueOnce(new Response(JSON.stringify({ code: 'PGRST204',
      message: "Could not find the 'created_by_member_id' column of 'expenses' in the schema cache" }), { status: 400 }));
    http.mockImplementation(async (_url, init) => Response.json({ id: 'expense', ...JSON.parse(init.body) }));
    const saved = await addExpense('trip', { ...input, createdByMemberId: 'author' });
    expect(http).toHaveBeenCalledTimes(2);
    expect(JSON.parse(http.mock.calls[1][1].body)).not.toHaveProperty('created_by_member_id');
    expect(saved.createdByMemberId).toBeNull();
    // Once migrated, the next write includes the author without a cached downgrade.
    expect((await addExpense('trip', { ...input, createdByMemberId: 'author' })).createdByMemberId).toBe('author');
    expect(http).toHaveBeenCalledTimes(3);
  });

  it.each([
    { code: 'PGRST204', message: "Could not find the 'title' column" },
    { code: '23503', message: 'Invalid member' },
    { code: '503', message: 'Backend unavailable' },
  ])('does not retry other failures: $code', async (error) => {
    http.mockResolvedValue(new Response(JSON.stringify(error), { status: 400 }));
    await expect(addExpense('trip', input)).rejects.toThrow(error.message);
    expect(http).toHaveBeenCalledTimes(1);
  });

  it.each(['author', null, undefined])('writes and maps author %s', async (createdByMemberId) => {
    http.mockImplementation(async (_url, init) => new Response(JSON.stringify({ id: 'expense', ...JSON.parse(init.body) }), {
      status: 201, headers: { 'Content-Type': 'application/json' },
    }));
    const saved = await addExpense('trip', { ...input, createdByMemberId });
    expect(JSON.parse(http.mock.calls[0][1].body)).toMatchObject({
      payer_id: 'payer', created_by_member_id: createdByMemberId ?? null,
    });
    expect(saved).toMatchObject({ payerId: 'payer', createdByMemberId: createdByMemberId ?? null });
  });

  it.each(['author', null, undefined])('preserves author %s on reload and accepts legacy rows', async (createdByMemberId) => {
    http.mockImplementation(async (url) => {
      const table = new URL(String(url)).pathname.split('/').pop();
      const data = table === 'trips' ? { id: 'trip', name: 'Test', base_currency: 'JPY' }
        : table === 'expenses' ? [{ ...row, created_by_member_id: createdByMemberId }] : [];
      return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    });
    expect((await loadTripBundle('trip')).expenses[0]).toMatchObject({
      payerId: 'payer', createdByMemberId: createdByMemberId ?? null,
    });
  });
});
