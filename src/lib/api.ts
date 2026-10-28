import type { CurrencyCode } from './currencies';
import { supabase } from './supabase';
import type { Expense, Member, Payment, Split, Trip } from './types';

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
  created_at: string;
}

function mapPayment(row: DbPayment): Payment {
  return {
    id: row.id,
    tripId: row.trip_id,
    payerId: row.payer_id,
    receiverId: row.receiver_id,
    amountMinor: Number(row.amount),
    createdAt: row.created_at,
  };
}

export interface TripBundle {
  trip: Trip;
  members: Member[];
  expenses: Expense[];
  payments: Payment[];
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

/** Trip id from the ?trip= URL param, falling back to the last opened trip (for PWA launches). */
export function getTripIdFromUrl(): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get(TRIP_URL_PARAM);
  if (fromUrl) return fromUrl;
  return window.localStorage.getItem(LAST_TRIP_KEY);
}

export function putTripIdInUrl(tripId: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set(TRIP_URL_PARAM, tripId);
  window.history.replaceState(null, '', url.toString());
  window.localStorage.setItem(LAST_TRIP_KEY, tripId);
}

export function getMe(tripId: string): string | null {
  return window.localStorage.getItem(ME_KEY_PREFIX + tripId);
}

export function setMe(tripId: string, memberId: string | null): void {
  if (memberId === null) window.localStorage.removeItem(ME_KEY_PREFIX + tripId);
  else window.localStorage.setItem(ME_KEY_PREFIX + tripId, memberId);
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
  return { trip, members, expenses: [], payments: [] };
}

export async function loadTripBundle(tripId: string): Promise<TripBundle> {
  const client = db();
  const [tripResult, membersResult, expensesResult, paymentsResult] = await Promise.all([
    client.from('trips').select().eq('id', tripId).maybeSingle(),
    client.from('members').select().eq('trip_id', tripId).order('created_at'),
    client
      .from('expenses')
      .select()
      .eq('trip_id', tripId)
      .order('spent_at', { ascending: false })
      .order('created_at', { ascending: false }),
    client
      .from('payments')
      .select()
      .eq('trip_id', tripId)
      .order('created_at', { ascending: false }),
  ]);
  if (tripResult.error) throw new Error(tripResult.error.message);
  if (!tripResult.data) throw new Error('Trip not found — double-check the invite link.');
  if (membersResult.error) throw new Error(membersResult.error.message);
  if (expensesResult.error) throw new Error(expensesResult.error.message);
  if (paymentsResult.error) throw new Error(paymentsResult.error.message);
  return {
    trip: mapTrip(tripResult.data as DbTrip),
    members: (membersResult.data as DbMember[]).map(mapMember),
    expenses: (expensesResult.data as DbExpense[]).map(mapExpense),
    payments: (paymentsResult.data as DbPayment[]).map(mapPayment),
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

/** Record that `payerId` repaid `receiverId` (base-currency minor units). */
export async function addPayment(
  tripId: string,
  payerId: string,
  receiverId: string,
  amountMinor: number,
): Promise<Payment> {
  const client = db();
  const { data, error } = await client
    .from('payments')
    .insert({
      trip_id: tripId,
      payer_id: payerId,
      receiver_id: receiverId,
      amount: amountMinor,
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

