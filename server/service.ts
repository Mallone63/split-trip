import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { isCurrencyCode } from '../src/lib/currencies';
import { suggestRate, toBaseMinor } from '../src/lib/fx';
import { materializeCustomSplit, materializePaidSplit } from '../src/lib/split';
import type { Split } from '../src/lib/types';

const entry = z.object({
  memberId: z.uuid(),
  amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();

export const expenseInput = z.object({
  requestId: z.uuid().describe('New UUID per expense; reuse exactly on retries.'),
  kind: z.enum(['shared', 'personal']).default('shared')
    .describe('shared (default): use participantIds and paid, optionally shares. personal: use memberId and amountMinor only; includes their whole wallet automatically.'),
  title: z.string().trim().min(1).max(500),
  currency: z.enum(['RUB', 'USD', 'JPY']),
  spentAt: z.iso.date().describe('Explicit local spending date, YYYY-MM-DD.'),
  memberId: z.uuid().optional()
    .describe('Personal only: identified member recording/paying, as me in the app. Reuse a known get_trip ID; fetch only if unresolved.'),
  amountMinor: entry.shape.amountMinor.optional()
    .describe('Required for personal only: total in integer minor units; JPY has no decimals.'),
  participantIds: z.array(z.uuid()).min(1).max(100).optional()
    .describe('Required for shared only: members participating in the expense.'),
  paid: z.array(entry).min(1).max(100).optional()
    .describe('Required for shared only: who paid, in integer minor units; JPY has no decimals.'),
  shares: z.array(entry).min(1).max(100).optional()
    .describe('Shared only: exact bill shares. Omit for equal split, as in the app.'),
  fxRate: z.number().positive().finite().optional()
    .describe('Base currency per one expense currency unit. Omit to use the current rate.'),
}).strict();

// Keep a flat object for MCP clients; enforce mode-specific requirements for both
// transports in the service. Reject mixed payloads rather than ignoring money fields.
const sharedExpenseInput = expenseInput.required({ participantIds: true, paid: true }).extend({
  kind: z.literal('shared'),
  memberId: z.never().optional(),
  amountMinor: z.never().optional(),
});
const personalExpenseInput = expenseInput.required({ memberId: true, amountMinor: true }).extend({
  kind: z.literal('personal'),
  participantIds: z.never().optional(),
  paid: z.never().optional(),
  shares: z.never().optional(),
});

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function errorResponse(error: unknown): { status: number; error: string } {
  if (error instanceof ApiError) return { status: error.status, error: error.message };
  if (error instanceof z.ZodError) return { status: 400, error: error.message };
  return { status: 502, error: 'Backend request failed. Retry with the same requestId.' };
}

interface ExpenseRow {
  id: string;
  trip_id: string;
  payer_id: string;
  title: string;
  currency: string;
  amount: number;
  fx_rate: number;
  base_amount: number;
  splits: Split[];
  spent_at: string;
  created_at?: string;
}

// JSONB does not preserve object key order. Compare the persisted values only.
function sameExpense(a: ExpenseRow, b: ExpenseRow): boolean {
  const canonical = (row: ExpenseRow) => [
    row.id, row.trip_id, row.payer_id, row.title, row.currency,
    row.amount, row.fx_rate, row.base_amount, row.spent_at,
    row.splits.map(s => ({
      memberId: s.memberId, amountMinor: s.amountMinor, paidMinor: s.paidMinor ?? 0,
    })).sort((x, y) => x.memberId.localeCompare(y.memberId)),
  ];
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** One configured trip, using the same anon client/access model as the app. */
export function createService(db: SupabaseClient, tripId: string) {
  async function getTrip() {
    const [trip, members] = await Promise.all([
      db.from('trips').select('id,name,base_currency').eq('id', tripId).maybeSingle(),
      db.from('members').select('id,trip_id,name,unit').eq('trip_id', tripId).order('created_at'),
    ]);
    if (trip.error || members.error) throw new Error('Cannot load trip');
    if (!trip.data) throw new ApiError(404, 'Trip not found');
    return { trip: trip.data, members: members.data! };
  }

  async function listExpenses() {
    const { data, error } = await db.from('expenses').select('*').eq('trip_id', tripId)
      .order('spent_at', { ascending: false }).order('created_at', { ascending: false }).limit(100);
    if (error) throw new Error('Cannot load expenses');
    return { expenses: data! };
  }

  async function findExpense(id: string): Promise<ExpenseRow | null> {
    const { data, error } = await db.from('expenses').select('*')
      .eq('trip_id', tripId).eq('id', id).maybeSingle();
    if (error) throw new Error('Cannot check requestId');
    return data;
  }

  async function addExpense(value: unknown) {
    const raw = expenseInput.parse(value);
    const input = raw.kind === 'personal'
      ? personalExpenseInput.parse(raw) : sharedExpenseInput.parse(raw);
    // These reads are independent: keep membership fresh without making the
    // duplicate check wait for a second database round trip.
    const [{ trip, members }, existing] = await Promise.all([
      getTrip(), findExpense(input.requestId),
    ]);
    if (!isCurrencyCode(trip.base_currency)) throw new ApiError(400, 'Unsupported trip currency');
    const memberOrder = members.map(m => m.id as string);
    let participantIds: string[];
    if (input.kind === 'personal') {
      const member = members.find(m => m.id === input.memberId);
      if (!member) throw new ApiError(400, 'Personal expense member must belong to this trip');
      // Same semantics as the app's personal form: me plus my non-null wallet.
      // Unpaired members stay solo; null units must never group unrelated people.
      participantIds = members.filter(m => m.id === member.id ||
        (member.unit != null && m.unit === member.unit)).map(m => m.id as string);
    } else {
      participantIds = input.participantIds;
      if (new Set(participantIds).size !== participantIds.length ||
          participantIds.some(id => !memberOrder.includes(id))) {
        throw new ApiError(400, 'Participants must be unique members of this trip');
      }
    }
    // Match the form's member ordering, tie breaks and rounding; do not recalculate in the model.
    const participants = memberOrder.filter(id => participantIds.includes(id));
    let resolved;
    try {
      if (input.kind === 'personal') {
        resolved = materializePaidSplit(
          [{ memberId: input.memberId, amountMinor: input.amountMinor }], participants, memberOrder,
        );
      } else {
        resolved = input.shares
          ? materializeCustomSplit(input.shares, input.paid, participants, memberOrder)
          : materializePaidSplit(input.paid, participants, memberOrder);
      }
    } catch (error) {
      throw new ApiError(400, error instanceof Error ? error.message : 'Invalid split');
    }
    // A retry must retain the originally frozen rate even if the live rate changed.
    const rate = input.fxRate ?? existing?.fx_rate ?? await suggestRate(input.currency, trip.base_currency);
    const amount = resolved.splits.reduce((sum, split) => sum + split.amountMinor, 0);
    const baseAmount = resolved.splits.reduce((sum, split) =>
      sum + toBaseMinor(split.amountMinor, rate, input.currency, trip.base_currency), 0);
    if (![amount, baseAmount].every(n => Number.isSafeInteger(n) && n > 0)) {
      throw new ApiError(400, 'Expense total is outside the supported range');
    }
    const row: ExpenseRow = {
      id: input.requestId, trip_id: tripId, payer_id: resolved.primaryPayerId,
      title: input.title, currency: input.currency, amount, fx_rate: rate,
      base_amount: baseAmount, splits: resolved.splits, spent_at: input.spentAt,
    };
    const replay = (saved: ExpenseRow) => {
      if (!sameExpense(saved, row)) throw new ApiError(409, 'requestId already used for a different expense');
      return { expense: saved, created: false };
    };
    if (existing) return replay(existing);
    const { data, error } = await db.from('expenses').insert(row).select().single();
    if (error?.code === '23505') {
      const saved = await findExpense(input.requestId);
      if (saved) return replay(saved);
      throw new ApiError(409, 'requestId is already in use');
    }
    if (error) throw new Error('Cannot save expense');
    return { expense: data as ExpenseRow, created: true };
  }

  return { getTrip, listExpenses, addExpense };
}

export type ExpenseService = ReturnType<typeof createService>;
