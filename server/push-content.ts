import {
  aggregateByUnit,
  computeBalances,
  suggestSettlements,
} from '../src/lib/balances';
import {
  formatMinor,
  isCurrencyCode,
  type CurrencyCode,
} from '../src/lib/currencies';
import type { Expense, Member, Payment, DebtTransfer } from '../src/lib/types';

export interface PushMember {
  id: string;
  name: string;
  unit: string | null;
}
export interface PushPayload {
  record: Record<string, unknown>;
  members: PushMember[];
  recipientId?: string;
  baseCurrency: CurrencyCode;
}
export interface PushMessage {
  title: string;
  body: string;
  tag: string;
  data: { url: string };
}
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const amount = (value: unknown) => Number(value);
export function pushMessage(
  kind: string,
  sourceId: string,
  tripId: string,
  payload: PushPayload,
  appUrl: string,
): PushMessage {
  const r = payload.record;
  const name = (id: unknown) =>
    payload.members.find((m) => m.id === id)?.name ?? 'Участник';
  const wallet = (id: unknown) => {
    const m = payload.members.find((m) => m.id === id);
    return m?.unit
      ? payload.members
          .filter((p) => p.unit === m.unit)
          .map((p) => p.name)
          .join(' + ')
      : name(id);
  };
  const money = (value: unknown, c: unknown) =>
    formatMinor(
      amount(value),
      typeof c === 'string' && isCurrencyCode(c) ? c : payload.baseCurrency,
    );
  const url = new URL(appUrl);
  url.search = '';
  url.searchParams.set('trip', tripId);
  url.searchParams.set(
    'tab',
    kind.startsWith('expense') ? 'expenses' : 'balances',
  );
  let title: string, body: string;
  if (kind === 'expense') {
    title = r.created_by_member_id
      ? `${name(r.created_by_member_id)} добавил(а) расход`
      : 'Новый расход';
    const splits = r.splits as { memberId: string; amountMinor: number }[];
    const share =
      splits.find((s) => s.memberId === payload.recipientId)?.amountMinor ?? 0;
    body = `${text(r.title).slice(0, 100)} · ${money(r.amount, r.currency)}. Твоя доля: ${money(share, r.currency)}.`;
    url.searchParams.set('expense', sourceId);
  } else if (kind === 'payment') {
    title = 'Записано погашение долга';
    body = `${wallet(r.payer_id)} → ${wallet(r.receiver_id)}: ${money(r.amount, r.currency)}.`;
    if (
      r.paid_currency &&
      r.paid_amount != null &&
      r.paid_currency !== r.currency
    )
      body += ` Передано: ${money(r.paid_amount, r.paid_currency)}.`;
  } else if (kind === 'transfer') {
    title = 'Изменена валюта долга';
    body = `${wallet(r.payer_id)} → ${wallet(r.receiver_id)}: ${money(r.source_amount, r.source_currency)} → ${money(r.target_amount, r.target_currency)}. Оплаты ещё не было.`;
  } else if (kind === 'reminder') {
    title = `${name(r.actor_id)} напоминает о расчёте`;
    body = `${wallet(r.payer_id)} → ${wallet(r.receiver_id)}: ${money(r.amount, r.currency)}.`;
  } else {
    title =
      kind === 'payment_undo'
        ? 'Погашение отменено'
        : kind === 'transfer_undo'
          ? 'Смена валюты отменена'
          : 'Расход удалён';
    body =
      kind === 'expense_undo'
        ? `${text(r.title).slice(0, 100)} · ${money(r.amount, r.currency)}.`
        : `${wallet(r.payer_id)} → ${wallet(r.receiver_id)}. Баланс пересчитан.`;
  }
  return {
    title: title.slice(0, 120),
    body: body.slice(0, 700),
    tag: `${kind.replace('_undo', '')}:${sourceId}`,
    data: { url: url.href },
  };
}

export interface RawBundle {
  trip: { id: string; base_currency: CurrencyCode };
  members: (PushMember & { trip_id: string })[];
  expenses: Record<string, unknown>[];
  payments: Record<string, unknown>[];
  transfers: Record<string, unknown>[];
}
/** Use exactly the PWA's wallet/ledger calculation, including conversions and overpayment. */
export function currentDebt(
  bundle: RawBundle,
  payerId: string,
  receiverId: string,
  currency: CurrencyCode,
) {
  const members: Member[] = bundle.members.map((m) => ({
    id: m.id,
    name: m.name,
    unit: m.unit,
    tripId: m.trip_id,
  }));
  const expenses: Expense[] = bundle.expenses
    .filter((e) => e.currency === currency)
    .map((e) => ({
      id: text(e.id),
      tripId: text(e.trip_id),
      payerId: text(e.payer_id),
      title: text(e.title),
      currency,
      amountMinor: amount(e.amount),
      fxRate: amount(e.fx_rate),
      baseAmountMinor: amount(e.base_amount),
      splits: e.splits as Expense['splits'],
      spentAt: text(e.spent_at),
    }));
  const payments: Payment[] = bundle.payments
    .filter((p) => (p.currency ?? bundle.trip.base_currency) === currency)
    .map((p) => ({
      id: text(p.id),
      tripId: text(p.trip_id),
      payerId: text(p.payer_id),
      receiverId: text(p.receiver_id),
      amountMinor: amount(p.amount),
      currency,
    }));
  const transfers: DebtTransfer[] = bundle.transfers.map((t) => ({
    id: text(t.id),
    tripId: text(t.trip_id),
    payerId: text(t.payer_id),
    receiverId: text(t.receiver_id),
    sourceCurrency: t.source_currency as CurrencyCode,
    sourceAmountMinor: amount(t.source_amount),
    targetCurrency: t.target_currency as CurrencyCode,
    targetAmountMinor: amount(t.target_amount),
  }));
  const wallets = aggregateByUnit(
    members,
    computeBalances(members, expenses, currency, payments, transfers),
  );
  const from = wallets.find((w) => w.memberIds.includes(payerId)),
    to = wallets.find((w) => w.memberIds.includes(receiverId));
  if (!from || !to || from.key === to.key) return null;
  const debt = suggestSettlements(
    wallets.map((w) => ({ memberId: w.key, netMinor: w.netMinor })),
  ).find((s) => s.fromMemberId === from.key && s.toMemberId === to.key);
  return debt ? { amountMinor: debt.amountMinor, from, to } : null;
}
