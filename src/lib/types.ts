import type { CurrencyCode } from './currencies';

export interface Trip {
  id: string;
  name: string;
  baseCurrency: CurrencyCode;
}

export interface Member {
  id: string;
  tripId: string;
  name: string;
  /** Members with the same non-null `unit` share one wallet (e.g. a couple). */
  unit?: string | null;
}

/** One member's share of an expense, in the expense's own currency (integer minor units). */
export interface Split {
  memberId: string;
  amountMinor: number;
}

export interface Expense {
  id: string;
  tripId: string;
  payerId: string;
  title: string;
  /** Currency the money was actually paid in. */
  currency: CurrencyCode;
  amountMinor: number;
  /** Base-currency units per 1 unit of `currency`, frozen at entry time. */
  fxRate: number;
  /** Sum of the per-split base-currency conversions (keeps balances zero-sum). */
  baseAmountMinor: number;
  splits: Split[];
  /** ISO date (yyyy-mm-dd) the money was spent. */
  spentAt: string;
  createdAt?: string;
}

/** Settling up: payer repaid receiver. Debts are tracked per currency, so a
 * payment belongs to one currency ledger (null = legacy trip base currency).
 * paidCurrency/paidAmountMinor record what was actually handed over when the
 * payer settled in a different currency (null = paid in `currency` itself). */
export interface Payment {
  id: string;
  tripId: string;
  payerId: string;
  receiverId: string;
  amountMinor: number;
  currency?: string | null;
  paidCurrency?: string | null;
  paidAmountMinor?: number | null;
  createdAt?: string;
}

/** Debt re-denomination ("хочу оплатить в..."): the payer's debt of
 * sourceAmountMinor in sourceCurrency closes in that ledger and reopens as
 * targetAmountMinor in targetCurrency. No money moves — it declares the
 * currency of the future payment. */
export interface DebtTransfer {
  id: string;
  tripId: string;
  payerId: string;
  receiverId: string;
  sourceCurrency: CurrencyCode;
  sourceAmountMinor: number;
  targetCurrency: CurrencyCode;
  targetAmountMinor: number;
  createdAt?: string;
}
