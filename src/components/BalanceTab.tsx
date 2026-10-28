import { useEffect, useMemo, useState } from 'react';
import {
  aggregateByUnit,
  computeBalances,
  suggestSettlements,
  type Settlement,
} from '../lib/balances';
import { CURRENCY_CODES, formatMinor, fromMinor, type CurrencyCode } from '../lib/currencies';
import { crossRate, fetchRates, type Rates } from '../lib/fx';
import type { Expense, Member, Payment } from '../lib/types';

interface Props {
  members: Member[];
  expenses: Expense[];
  payments: Payment[];
  baseCurrency: CurrencyCode;
  meId: string | null;
  onMarkSettled: (payerId: string, receiverId: string, amountMinor: number) => Promise<void>;
  onUndoPayment: (paymentId: string) => Promise<void>;
}

export default function BalanceTab({
  members,
  expenses,
  payments,
  baseCurrency,
  meId,
  onMarkSettled,
  onUndoPayment,
}: Props) {
  const balances = useMemo(
    () => computeBalances(members, expenses, baseCurrency, payments),
    [members, expenses, baseCurrency, payments],
  );
  const wallets = useMemo(() => aggregateByUnit(members, balances), [members, balances]);
  const settlements = useMemo(
    () => suggestSettlements(wallets.map((w) => ({ memberId: w.key, netMinor: w.netMinor }))),
    [wallets],
  );
  const totalSpent = useMemo(
    () => expenses.reduce((sum, expense) => sum + expense.baseAmountMinor, 0),
    [expenses],
  );
  const paymentsSorted = useMemo(
    () => [...payments].sort((a, b) => (a.createdAt ?? a.id).localeCompare(b.createdAt ?? b.id)),
    [payments],
  );

  // Live rates for the small multi-currency hints. The canonical amount stays
  // in the base currency; hints are informational (today's rate) and simply
  // hidden when rates are unavailable (offline).
  const [rates, setRates] = useState<Rates | null>(null);
  useEffect(() => {
    let active = true;
    fetchRates()
      .then((r) => {
        if (active) setRates(r);
      })
      .catch(() => {
        /* offline — hints stay hidden */
      });
    return () => {
      active = false;
    };
  }, []);

  const altAmounts = (amountMinor: number): string => {
    if (!rates) return '';
    return CURRENCY_CODES.filter((c) => c !== baseCurrency)
      .map((c) => {
        // Informational hint: round to whole units of the target currency.
        const whole = Math.round(
          fromMinor(amountMinor, baseCurrency) * crossRate(rates, baseCurrency, c),
        );
        return new Intl.NumberFormat('ru-RU', {
          style: 'currency',
          currency: c,
          maximumFractionDigits: 0,
        }).format(whole);
      })
      .join(' / ');
  };

  const labelOf = (unitKey: string): string => {
    const wallet = wallets.find((w) => w.key === unitKey);
    if (!wallet) return '—';
    return wallet.memberIds.includes(meId ?? '') ? `${wallet.label} (вы)` : wallet.label;
  };

  const amountOf = (netMinor: number): string =>
    netMinor === 0 ? 'ок' : `${netMinor > 0 ? '+' : ''}${formatMinor(netMinor, baseCurrency)}`;

  const memberName = (memberId: string): string =>
    members.find((m) => m.id === memberId)?.name ?? '—';

  async function markSettled(settlement: Settlement) {
    const from = wallets.find((w) => w.key === settlement.fromMemberId);
    const to = wallets.find((w) => w.key === settlement.toMemberId);
    if (!from || !to) return;
    await onMarkSettled(from.memberIds[0], to.memberIds[0], settlement.amountMinor);
  }

  return (
    <div className="space-y-4">
      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Всего потрачено
          </h2>
          <p className="text-lg font-bold text-slate-900">
            {formatMinor(totalSpent, baseCurrency)}
          </p>
        </div>
      </section>

      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Балансы
        </h2>
        <ul className="divide-y divide-slate-100">
          {wallets.map((wallet) => {
            const label = wallet.memberIds.includes(meId ?? '')
              ? `${wallet.label} (вы)`
              : wallet.label;
            return (
              <li key={wallet.key} className="flex items-center justify-between py-2.5">
                <span className="text-base text-slate-800">{label}</span>
                <span
                  className={`text-base font-semibold ${
                    wallet.netMinor > 0
                      ? 'text-emerald-600'
                      : wallet.netMinor < 0
                        ? 'text-red-500'
                        : 'text-slate-400'
                  }`}
                >
                  {amountOf(wallet.netMinor)}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Предлагаемые расчёты
        </h2>
        {settlements.length === 0 ? (
          <p className="text-sm text-slate-500">Все в расчёте 🎉</p>
        ) : (
          <ul className="space-y-2">
            {settlements.map((settlement, index) => {
              const alt = altAmounts(settlement.amountMinor);
              return (
                <li
                  key={`${settlement.fromMemberId}-${settlement.toMemberId}-${index}`}
                  className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2"
                >
                  <span className="min-w-0 text-sm text-slate-700">
                    <strong>{labelOf(settlement.fromMemberId)}</strong>
                    {' → '}
                    <strong>{labelOf(settlement.toMemberId)}</strong>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="text-right">
                      <span className="block text-sm font-semibold text-slate-900">
                        {formatMinor(settlement.amountMinor, baseCurrency)}
                      </span>
                      {alt && (
                        <span className="block text-[10px] leading-tight text-slate-400">
                          {alt}
                        </span>
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() => void markSettled(settlement)}
                      className="rounded-full bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white"
                    >
                      ✓ Оплачено
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-3 text-xs text-slate-400">
          Суммы в {baseCurrency}. Из общего кошелька деньги может принять любой из его участников.
        </p>
      </section>

      {paymentsSorted.length > 0 && (
        <section className="rounded-2xl bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Отмеченные расчёты
          </h2>
          <ul className="divide-y divide-slate-100">
            {paymentsSorted.map((payment) => {
              const alt = altAmounts(payment.amountMinor);
              return (
                <li key={payment.id} className="flex items-center justify-between py-2">
                  <span className="min-w-0 text-sm text-slate-700">
                    <strong>{memberName(payment.payerId)}</strong>
                    {' → '}
                    <strong>{memberName(payment.receiverId)}</strong>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="text-right">
                      <span className="block text-sm text-emerald-600">
                        ✓ {formatMinor(payment.amountMinor, baseCurrency)}
                      </span>
                      {alt && (
                        <span className="block text-[10px] leading-tight text-slate-400">
                          {alt}
                        </span>
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() => void onUndoPayment(payment.id)}
                      className="text-xs font-medium text-red-500"
                    >
                      отменить
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-xs text-slate-400">
            «Отменить» убирает платёж — задолженность вернётся в балансы.
          </p>
        </section>
      )}
    </div>
  );
}
