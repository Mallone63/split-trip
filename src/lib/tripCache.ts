import type { TripBundle } from './api';
import { CURRENCY_CODES } from './currencies';

export interface CachedTrip {
  bundle: TripBundle;
  updatedAt: number;
}

// Separate deployments/backends sharing an origin must not share snapshots.
const PREFIX = `tripsplit:cache:v1:${import.meta.env.VITE_SUPABASE_URL ?? 'unconfigured'}:`;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const text = (value: unknown): value is string => typeof value === 'string';
const amount = (value: unknown) => Number.isSafeInteger(value);
const currency = (value: unknown) => CURRENCY_CODES.some((code) => code === value);
const optionalText = (value: unknown) => value == null || text(value);

function validBundle(value: unknown, tripId: string): value is TripBundle {
  if (!object(value) || !object(value.trip) || value.trip.id !== tripId ||
      !text(value.trip.name) || !currency(value.trip.baseCurrency)) return false;
  const rows = (key: string, valid: (row: Record<string, unknown>) => boolean) => {
    const list = value[key];
    return Array.isArray(list) && list.every((row) =>
      object(row) && text(row.id) && row.tripId === tripId && valid(row));
  };
  return rows('members', (row) => text(row.name) && optionalText(row.unit)) &&
    rows('expenses', (row) => text(row.payerId) && text(row.title) &&
      currency(row.currency) && amount(row.amountMinor) && amount(row.baseAmountMinor) &&
      typeof row.fxRate === 'number' && Number.isFinite(row.fxRate) &&
      text(row.spentAt) && /^\d{4}-\d{2}-\d{2}$/.test(row.spentAt) &&
      optionalText(row.createdAt) && Array.isArray(row.splits) &&
      row.splits.every((split) => object(split) && text(split.memberId) && amount(split.amountMinor))) &&
    rows('payments', (row) => text(row.payerId) && text(row.receiverId) &&
      amount(row.amountMinor) && (row.currency == null || currency(row.currency)) &&
      (row.paidCurrency == null || currency(row.paidCurrency)) &&
      (row.paidAmountMinor == null || amount(row.paidAmountMinor)) && optionalText(row.createdAt)) &&
    rows('transfers', (row) => text(row.payerId) && text(row.receiverId) &&
      currency(row.sourceCurrency) && currency(row.targetCurrency) &&
      amount(row.sourceAmountMinor) && amount(row.targetAmountMinor) && optionalText(row.createdAt));
}

export function readTripCache(tripId: string): CachedTrip | null {
  try {
    const raw = window.localStorage.getItem(PREFIX + tripId);
    if (!raw) return null;
    const cached: unknown = JSON.parse(raw);
    if (!object(cached) || cached.version !== 1 ||
        typeof cached.updatedAt !== 'number' || !Number.isFinite(cached.updatedAt) ||
        !validBundle(cached.bundle, tripId)) return null;
    return { bundle: cached.bundle, updatedAt: cached.updatedAt };
  } catch {
    return null;
  }
}

export function writeTripCache(bundle: TripBundle, updatedAt = Date.now()): void {
  try {
    window.localStorage.setItem(PREFIX + bundle.trip.id, JSON.stringify({ version: 1, bundle, updatedAt }));
  } catch {
    // Storage may be blocked or full; live data must remain usable.
  }
}

export function removeTripCache(tripId: string): void {
  try {
    window.localStorage.removeItem(PREFIX + tripId);
  } catch {
    // Best effort when the server confirms the trip no longer exists.
  }
}
