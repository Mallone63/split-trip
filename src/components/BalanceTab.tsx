import { useEffect, useMemo, useState } from 'react';
import {
  aggregateByUnit,
  computeBalances,
  suggestSettlements,
  type Settlement,
} from '../lib/balances';
import {
  CURRENCIES,
  CURRENCY_CODES,
  formatMinor,
  fromMinor,
  isCurrencyCode,
  parseAmount,
  toMinor,
  type CurrencyCode,
} from '../lib/currencies';
import { crossRate, fetchRates, type Rates } from '../lib/fx';
import type { Expense, Member, Payment } from '../lib/types';

type Wallets = ReturnType<typeof aggregateByUnit>;

interface Ledger {
  currency: CurrencyCode;
  totalMinor: number;
  wallets: Wallets;
  settlements: Settlement[];
}

interface Props {
  members: Member[];
  expenses: Expense[];
  payments: Payment[];
  /** Trip base currency — fallback for legacy payments without a currency. */
  baseCurrency: CurrencyCode;
  meId: string | null;
  onMarkSettled: (
    payerId: string,
    receiverId: string,
    amountMinor: number,
    currency: CurrencyCode,
  ) => Promise<void>;
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
  // No tabs: all three currency ledgers are shown at once. A ledger is all
  // expenses of that currency + payments of the same currency (rate 1:1,
  // zero-sum inside the ledger).
  const ledgers = useMemo<Ledger[]>(
    () =>
      CURRENCY_CODES.map((currency) => {
        const ledgerExpenses = expenses.filter((expense) => expense.currency === currency);
        const ledgerPayments = payments.filter((payment) => {
          const c =
            payment.currency && isCurrencyCode(payment.currency) ? payment.currency : baseCurrency;
          return c === currency;
        });
        const balances = computeBalances(members, ledgerExpenses, ledgerPayments);
        const wallets = aggregateByUnit(members, balances);
        const settlements = suggestSettlements(
          wallets.map((w) => ({ memberId: w.key, netMinor: w.netMinor })),
        );
        return {
          currency,
          totalMinor: ledgerExpenses.reduce((sum, expense) => sum + expense.amountMinor, 0),
          wallets,
          settlements,
        };
      }),
    [members, expenses, payments, baseCurrency],
  );

  const paymentsSorted = useMemo(
    () =>
      [...payments].sort((a, b) => (a.createdAt ?? a.id).localeCompare(b.createdAt ?? b.id)),
    [payments],
  );

  const paymentCcy = (payment: Payment): CurrencyCode =>
    payment.currency && isCurrencyCode(payment.currency) ? payment.currency : baseCurrency;

  // Inline partial-settlement form: which settlement is open and what is typed.
  const [partialKey, setPartialKey] = useState<string | null>(null);
  const [partialAmount, setPartialAmount] = useState('');
  const [partialError, setPartialError] = useState<string | null>(null);

  // Live rates for the small multi-currency hints. Canonical amounts stay in
  // their own currency; hints are informational and hidden when unavailable.
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

  const altAmounts = (amountMinor: number, from: CurrencyCode): string => {
    if (!rates) return '';
    return CURRENCY_CODES.filter((c) => c !== from)
      .map((c) => {
        // Informational hint: round to whole units of the target currency.
        const whole = Math.round(fromMinor(amountMinor, from) * crossRate(rates, from, c));
        return new Intl.NumberFormat('ru-RU', {
          style: 'currency',
          currency: c,
          maximumFractionDigits: 0,
        }).format(whole);
      })
      .join(' / ');
  };

  const labelOf = (currency: CurrencyCode, unitKey: string): string => {
    const ledger = ledgers.find((l) => l.currency === currency);
    const wallet = ledger?.wallets.find((w) => w.key === unitKey);
    if (!wallet) return '—';
    return wallet.memberIds.includes(meId ?? '') ? `${wallet.label} (вы)` : wallet.label;
  };

  const memberName = (memberId: string): string =>
    members.find((m) => m.id === memberId)?.name ?? '—';

  async function markSettled(currency: CurrencyCode, settlement: Settlement) {
    const ledger = ledgers.find((l) => l.currency === currency);
    if (!ledger) return;
    const from = ledger.wallets.find((w) => w.key === settlement.fromMemberId);
    const to = ledger.wallets.find((w) => w.key === settlement.toMemberId);
    if (!from || !to) return;
    await onMarkSettled(from.memberIds[0], to.memberIds[0], settlement.amountMinor, currency);
  }

  async function submitPartial(currency: CurrencyCode, settlement: Settlement) {
    const entered = parseAmount(partialAmount);
    if (!Number.isFinite(entered) || entered <= 0) {
      setPartialError('Введите сумму больше нуля');
      return;
    }
    const ledger = ledgers.find((l) => l.currency === currency);
    if (!ledger) return;
    const from = ledger.wallets.find((w) => w.key === settlement.fromMemberId);
    const to = ledger.wallets.find((w) => w.key === settlement.toMemberId);
    if (!from || !to) return;
    const amountMinor = toMinor(entered, currency);
    setPartialError(null);
    try {
      // Overpayment is allowed (e.g. no change available): the excess
      // automatically becomes a reverse debt via payment netting.
      await onMarkSettled(from.memberIds[0], to.memberIds[0], amountMinor, currency);
      setPartialKey(null);
      setPartialAmount('');
    } catch (err) {
      setPartialError(err instanceof Error ? err.message : String(err));
    }
  }

  const partialPreview = (settlement: Settlement, currency: CurrencyCode): string => {
    const entered = parseAmount(partialAmount);
    if (!Number.isFinite(entered) || entered <= 0) return '';
    const amountMinor = toMinor(entered, currency);
    const diff = settlement.amountMinor - amountMinor;
    if (diff === 0) return 'Долг будет закрыт полностью';
    if (diff > 0) {
      return `Внесено ${formatMinor(amountMinor, currency)}, останется: ${formatMinor(diff, currency)}`;
    }
    const over = formatMinor(amountMinor - settlement.amountMinor, currency);
    return `Переплата ${over} — теперь ${labelOf(currency, settlement.toMemberId)} должен ${labelOf(
      currency,
      settlement.fromMemberId,
    )}`;
  };

  return (
    <div className="space-y-4">
      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Всего потрачено
          </h2>
          <div className="space-y-0.5 text-right">
            {ledgers.some((ledger) => ledger.totalMinor !== 0) ? (
              ledgers.map((ledger) =>
                ledger.totalMinor === 0 ? null : (
                  <p key={ledger.currency} className="text-base font-bold text-slate-900">
                    {formatMinor(ledger.totalMinor, ledger.currency)}
                  </p>
                ),
              )
            ) : (
              <p className="text-base font-bold text-slate-900">0</p>
            )}
          </div>
        </div>
      </section>

      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Балансы
        </h2>
        <ul className="divide-y divide-slate-100">
          {ledgers[0].wallets.map((wallet) => {
            const label = wallet.memberIds.includes(meId ?? '')
              ? `${wallet.label} (вы)`
              : wallet.label;
            return (
              <li key={wallet.key} className="flex items-start justify-between py-2.5">
                <span className="text-base text-slate-800">{label}</span>
                <span className="space-y-0.5 text-right">
                  {ledgers.some(
                    (ledger) =>
                      (ledger.wallets.find((w) => w.key === wallet.key)?.netMinor ?? 0) !== 0,
                  ) ? (
                    ledgers.map((ledger) => {
                      const net = ledger.wallets.find((w) => w.key === wallet.key)?.netMinor ?? 0;
                      if (net === 0) return null;
                      return (
                        <p
                          key={ledger.currency}
                          className={`text-sm font-semibold ${
                            net > 0 ? 'text-emerald-600' : 'text-red-500'
                          }`}
                        >
                          {`${net > 0 ? '+' : ''}${formatMinor(net, ledger.currency)}`}
                        </p>
                      );
                    })
                  ) : (
                    <p className="text-sm font-semibold text-slate-400">Не заржавело</p>
                  )}
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
        {ledgers.every((ledger) => ledger.settlements.length === 0) ? (
          <p className="text-sm text-slate-500">
            {expenses.length === 0 ? 'Расходов пока нет.' : 'Все в расчёте 🎉'}
          </p>
        ) : (
          <div className="space-y-4">
            {ledgers.map((ledger) =>
              ledger.settlements.length === 0 ? null : (
                <div key={ledger.currency}>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                    {CURRENCIES[ledger.currency].symbol} {ledger.currency}
                  </p>
                  <ul className="space-y-2">
                    {ledger.settlements.map((settlement, index) => {
                      const alt = altAmounts(settlement.amountMinor, ledger.currency);
                      const settlementKey = `${ledger.currency}-${settlement.fromMemberId}-${settlement.toMemberId}-${index}`;
                      const isPartialOpen = partialKey === settlementKey;
                      const preview = partialPreview(settlement, ledger.currency);
                      return (
                        <li key={settlementKey} className="rounded-lg bg-slate-50 px-3 py-2.5">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="min-w-0 text-sm text-slate-700">
                              <strong>{labelOf(ledger.currency, settlement.fromMemberId)}</strong>
                              {' → '}
                              <strong>{labelOf(ledger.currency, settlement.toMemberId)}</strong>
                            </span>
                            <span className="shrink-0 text-right">
                              <span className="block text-sm font-semibold text-slate-900">
                                {formatMinor(settlement.amountMinor, ledger.currency)}
                              </span>
                              {alt && (
                                <span className="block text-[10px] leading-tight text-slate-400">
                                  {alt}
                                </span>
                              )}
                            </span>
                          </div>
                          <div className="mt-2 grid grid-cols-2 gap-2">
                            <button
                              type="button"
                              onClick={() => void markSettled(ledger.currency, settlement)}
                              className="rounded-lg bg-emerald-600 px-3 py-2.5 text-sm font-semibold text-white active:bg-emerald-700"
                            >
                              Погасить полностью
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setPartialKey(isPartialOpen ? null : settlementKey);
                                setPartialAmount('');
                                setPartialError(null);
                              }}
                              className="rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm font-medium text-slate-600 active:bg-slate-100"
                            >
                              Погасить частично
                            </button>
                          </div>

                          {isPartialOpen && (
                            <form
                              onSubmit={(e) => {
                                e.preventDefault();
                                void submitPartial(ledger.currency, settlement);
                              }}
                              className="mt-2 border-t border-slate-200 pt-2"
                            >
                              <div className="flex items-center gap-2">
                                <input
                                  value={partialAmount}
                                  onChange={(e) => setPartialAmount(e.target.value)}
                                  inputMode="decimal"
                                  autoFocus
                                  placeholder={String(
                                    fromMinor(settlement.amountMinor, ledger.currency),
                                  )}
                                  className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-teal-500 focus:outline-none"
                                />
                                <span className="text-xs text-slate-400">{ledger.currency}</span>
                                <button
                                  type="submit"
                                  disabled={!partialAmount.trim()}
                                  className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
                                >
                                  ОК
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setPartialKey(null);
                                    setPartialAmount('');
                                    setPartialError(null);
                                  }}
                                  className="text-xs font-medium text-slate-500"
                                >
                                  Отмена
                                </button>
                              </div>
                              {preview && (
                                <p className="mt-1 text-xs text-slate-500">{preview}</p>
                              )}
                              {partialError && (
                                <p className="mt-1 text-xs text-red-500">{partialError}</p>
                              )}
                            </form>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ),
            )}
          </div>
        )}
        <p className="mt-3 text-xs text-slate-400">
          Расчёты ведутся отдельно по каждой валюте. Из общего кошелька деньги может принять
          любой из его участников. Переплата разрешена — излишек станет обратным долгом.
        </p>
      </section>

      {paymentsSorted.length > 0 && (
        <section className="rounded-2xl bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Отмеченные расчёты
          </h2>
          <ul className="divide-y divide-slate-100">
            {paymentsSorted.map((payment) => {
              const ccy = paymentCcy(payment);
              const alt = altAmounts(payment.amountMinor, ccy);
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
                        ✓ {formatMinor(payment.amountMinor, ccy)}
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
