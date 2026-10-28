import type { CurrencyCode } from './currencies';
import { supabase } from './supabase';
import { TripNotFoundError } from './errors';
import type {
  DebtTransfer,
  Expense,
  Member,
  Payment,
  Split,
  Trip,
} from './types';

const TRIP_URL_PARAM = 'trip';
const LAST_TRIP_KEY = 'tripsplit:lastTrip';
const ME_KEY_PREFIX = 'tripsplit:me:';

function db() {
  if (!supabase) throw new Error('Supabase is not configured');
  return supabase;
}

interface DbTrip {
  id: string;
  name: string;
  base_currency: string;
}

interface DbMember {
  id: string;
  trip_id: string;
  name: string;
  unit: string | null;
}

interface DbExpense {
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
  created_at: string;
}

function mapTrip(row: DbTrip): Trip {
  return { id: row.id, name: row.name, baseCurrency: row.base_currency as CurrencyCode };
}

function mapMember(row: DbMember): Member {
  return { id: row.id, tripId: row.trip_id, name: row.name, unit: row.unit ?? null };
}

function mapExpense(row: DbExpense): Expense {
  return {
    id: row.id,
    tripId: row.trip_id,
    payerId: row.payer_id,
    title: row.title,
    currency: row.currency as CurrencyCode,
    amountMinor: Number(row.amount),
    fxRate: Number(row.fx_rate),
    baseAmountMinor: Number(row.base_amount),
    splits: row.splits ?? [],
    spentAt: row.spent_at,
    createdAt: row.created_at,
  };
}

interface DbPayment {
  id: string;
  trip_id: string;
  payer_id: string;
  receiver_id: string;
  amount: number;
  currency: string | null;
  paid_currency: string | null;
  paid_amount: number | null;
  created_at: string;
}

function mapPayment(row: DbPayment): Payment {
  return {
    id: row.id,
    tripId: row.trip_id,
    payerId: row.payer_id,
    receiverId: row.receiver_id,
    amountMinor: Number(row.amount),
    currency: row.currency ?? null,
    paidCurrency: row.paid_currency ?? null,
    paidAmountMinor: row.paid_amount == null ? null : Number(row.paid_amount),
    createdAt: row.created_at,
  };
}

interface DbDebtTransfer {
  id: string;
  trip_id: string;
  payer_id: string;
  receiver_id: string;
  source_currency: string;
  source_amount: number;
  target_currency: string;
  target_amount: number;
  created_at: string;
}

function mapDebtTransfer(row: DbDebtTransfer): DebtTransfer {
  return {
    id: row.id,
    tripId: row.trip_id,
    payerId: row.payer_id,
    receiverId: row.receiver_id,
    sourceCurrency: row.source_currency as CurrencyCode,
    sourceAmountMinor: Number(row.source_amount),
    targetCurrency: row.target_currency as CurrencyCode,
    targetAmountMinor: Number(row.target_amount),
    createdAt: row.created_at,
  };
}

export interface TripBundle {
  trip: Trip;
  members: Member[];
  expenses: Expense[];
  payments: Payment[];
  transfers: DebtTransfer[];
}

export interface NewExpenseInput {
  payerId: string;
  title: string;
  currency: CurrencyCode;
  amountMinor: number;
  fxRate: number;
  baseAmountMinor: number;
  splits: Split[];
  spentAt: string;
}

// ---- URL / local storage helpers -----------------------------------------

/** The install URL carries the trip; storage is a fallback for ordinary visits. */
export function getTripIdFromUrl(): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get(TRIP_URL_PARAM);
  if (fromUrl) return fromUrl;
  try {
    return window.localStorage.getItem(LAST_TRIP_KEY);
  } catch {
    return null;
  }
}

export function putTripIdInUrl(tripId: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set(TRIP_URL_PARAM, tripId);
  window.history.replaceState(null, '', url.toString());
  try {
    window.localStorage.setItem(LAST_TRIP_KEY, tripId);
  } catch {
    // The invite URL remains usable when storage is unavailable.
  }
}

export function clearTripId(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete(TRIP_URL_PARAM);
  window.history.replaceState(null, '', url.toString());
  try {
    window.localStorage.removeItem(LAST_TRIP_KEY);
  } catch {
    // Clearing the URL still lets this session create another trip.
  }
}

export function getMe(tripId: string): string | null {
  try {
    return window.localStorage.getItem(ME_KEY_PREFIX + tripId);
  } catch {
    return null;
  }
}

export function setMe(tripId: string, memberId: string | null): void {
  try {
    if (memberId === null) window.localStorage.removeItem(ME_KEY_PREFIX + tripId);
    else window.localStorage.setItem(ME_KEY_PREFIX + tripId, memberId);
  } catch {
    // Choosing a participant must not prevent access to the trip.
  }
}

// ---- Data access ----------------------------------------------------------

export async function createTrip(
  name: string,
  baseCurrency: CurrencyCode,
  memberNames: string[],
): Promise<TripBundle> {
  const client = db();
  const { data: tripRow, error: tripError } = await client
    .from('trips')
    .insert({ name, base_currency: baseCurrency })
    .select()
    .single();
  if (tripError) throw new Error(tripError.message);
  const trip = mapTrip(tripRow as DbTrip);

  const { data: memberRows, error: memberError } = await client
    .from('members')
    .insert(memberNames.map((memberName) => ({ trip_id: trip.id, name: memberName })))
    .select();
  if (memberError) throw new Error(memberError.message);
  const members = (memberRows as DbMember[]).map(mapMember);

  const meId = members[0]?.id;
  if (meId) setMe(trip.id, meId);
  return { trip, members, expenses: [], payments: [], transfers: [] };
}

export async function loadTripBundle(tripId: string, signal?: AbortSignal): Promise<TripBundle> {
  const client = db();
  const requestSignal = signal ?? new AbortController().signal;
  const [tripResult, membersResult, expensesResult, paymentsResult, transfersResult] =
    await Promise.all([
    client.from('trips').select().eq('id', tripId).abortSignal(requestSignal).maybeSingle(),
    client.from('members').select().eq('trip_id', tripId).order('created_at').abortSignal(requestSignal),
    client
      .from('expenses')
      .select()
      .eq('trip_id', tripId)
      .order('spent_at', { ascending: false })
      .order('created_at', { ascending: false }).abortSignal(requestSignal),
    client
      .from('payments')
      .select()
      .eq('trip_id', tripId)
      .order('created_at', { ascending: false }).abortSignal(requestSignal),
    client
      .from('debt_transfers')
      .select()
      .eq('trip_id', tripId)
      .order('created_at', { ascending: false }).abortSignal(requestSignal),
  ]);
  if (tripResult.error) throw new Error(tripResult.error.message);
  if (!tripResult.data) throw new TripNotFoundError();
  if (membersResult.error) throw new Error(membersResult.error.message);
  if (expensesResult.error) throw new Error(expensesResult.error.message);
  if (paymentsResult.error) throw new Error(paymentsResult.error.message);
  if (transfersResult.error) throw new Error(transfersResult.error.message);
  return {
    trip: mapTrip(tripResult.data as DbTrip),
    members: (membersResult.data as DbMember[]).map(mapMember),
    expenses: (expensesResult.data as DbExpense[]).map(mapExpense),
    payments: (paymentsResult.data as DbPayment[]).map(mapPayment),
    transfers: (transfersResult.data as DbDebtTransfer[]).map(mapDebtTransfer),
  };
}

export async function addExpense(tripId: string, input: NewExpenseInput): Promise<Expense> {
  const client = db();
  const { data, error } = await client
    .from('expenses')
    .insert({
      trip_id: tripId,
      payer_id: input.payerId,
      title: input.title,
      currency: input.currency,
      amount: input.amountMinor,
      fx_rate: input.fxRate,
      base_amount: input.baseAmountMinor,
      splits: input.splits,
      spent_at: input.spentAt,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return mapExpense(data as DbExpense);
}

export async function deleteExpense(expenseId: string): Promise<void> {
  const client = db();
  const { error } = await client.from('expenses').delete().eq('id', expenseId);
  if (error) throw new Error(error.message);
}

export async function addMember(tripId: string, name: string): Promise<Member> {
  const client = db();
  const { data, error } = await client
    .from('members')
    .insert({ trip_id: tripId, name })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return mapMember(data as DbMember);
}

/** Put several members on one shared wallet (e.g. a couple). Returns the updated members. */
export async function linkWallet(memberIds: string[]): Promise<Member[]> {
  const client = db();
  const unit = crypto.randomUUID();
  const { data, error } = await client
    .from('members')
    .update({ unit })
    .in('id', memberIds)
    .select();
  if (error) throw new Error(error.message);
  return (data as DbMember[]).map(mapMember);
}

/** Detach every member of a shared wallet. Returns the updated members. */
export async function unlinkWallet(unit: string): Promise<Member[]> {
  const client = db();
  const { data, error } = await client
    .from('members')
    .update({ unit: null })
    .eq('unit', unit)
    .select();
  if (error) throw new Error(error.message);
  return (data as DbMember[]).map(mapMember);
}

export function subscribeToExpenses(tripId: string, onChange: () => void): () => void {
  const client = db();
  const channel = client
    .channel(`expenses-${tripId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'expenses', filter: `trip_id=eq.${tripId}` },
      onChange,
    )
    .subscribe();
  return () => {
    void client.removeChannel(channel);
  };
}

export function subscribeToPayments(tripId: string, onChange: () => void): () => void {
  const client = db();
  const channel = client
    .channel(`payments-${tripId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'payments', filter: `trip_id=eq.${tripId}` },
      onChange,
    )
    .subscribe();
  return () => {
    void client.removeChannel(channel);
  };
}

/** Record that `payerId` repaid `receiverId` in the given ledger currency.
 * `paid` optionally records the currency actually handed over when it differs
 * (e.g. the ¥ debt was settled with ₽ cash). */
export async function addPayment(
  tripId: string,
  payerId: string,
  receiverId: string,
  amountMinor: number,
  currency: string,
  paid?: { amountMinor: number; currency: string },
): Promise<Payment> {
  const client = db();
  const { data, error } = await client
    .from('payments')
    .insert({
      trip_id: tripId,
      payer_id: payerId,
      receiver_id: receiverId,
      amount: amountMinor,
      currency,
      paid_amount: paid?.amountMinor ?? null,
      paid_currency: paid?.currency ?? null,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return mapPayment(data as DbPayment);
}

export async function deletePayment(paymentId: string): Promise<void> {
  const client = db();
  const { error } = await client.from('payments').delete().eq('id', paymentId);
  if (error) throw new Error(error.message);
}

/** Debt re-denomination ("хочу оплатить в..."): the payer's debt of
 * sourceAmountMinor (sourceCurrency) closes and reopens as targetAmountMinor
 * in targetCurrency. One record — undo deletes it. */
export async function addDebtTransfer(
  tripId: string,
  payerId: string,
  receiverId: string,
  sourceCurrency: string,
  sourceAmountMinor: number,
  targetCurrency: string,
  targetAmountMinor: number,
): Promise<DebtTransfer> {
  const client = db();
  const { data, error } = await client
    .from('debt_transfers')
    .insert({
      trip_id: tripId,
      payer_id: payerId,
      receiver_id: receiverId,
      source_currency: sourceCurrency,
      source_amount: sourceAmountMinor,
      target_currency: targetCurrency,
      target_amount: targetAmountMinor,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return mapDebtTransfer(data as DbDebtTransfer);
}

export async function deleteDebtTransfer(transferId: string): Promise<void> {
  const client = db();
  const { error } = await client.from('debt_transfers').delete().eq('id', transferId);
  if (error) throw new Error(error.message);
}

export function subscribeToTransfers(tripId: string, onChange: () => void): () => void {
  const client = db();
  const channel = client
    .channel(`debt-transfers-${tripId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'debt_transfers', filter: `trip_id=eq.${tripId}` },
      onChange,
    )
    .subscribe();
  return () => {
    void client.removeChannel(channel);
  };
}

