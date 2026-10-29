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
import { readMineOnlyPref, writeMineOnlyPref } from '../lib/prefs';
import type { DebtTransfer, Expense, Member, Payment } from '../lib/types';

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
  transfers: DebtTransfer[];
  /** Trip base currency — fallback for legacy payments without a currency. */
  baseCurrency: CurrencyCode;
  meId: string | null;
  onMarkSettled: (
    payerId: string,
    receiverId: string,
    amountMinor: number,
    currency: CurrencyCode,
    paid?: { amountMinor: number; currency: CurrencyCode },
  ) => Promise<void>;
  onUndoPayment: (paymentId: string) => Promise<void>;
  onAddTransfer: (
    payerId: string,
    receiverId: string,
    sourceCurrency: CurrencyCode,
    sourceAmountMinor: number,
    targetCurrency: CurrencyCode,
    targetAmountMinor: number,
  ) => Promise<void>;
  onUndoTransfer: (transferId: string) => Promise<void>;
}

export default function BalanceTab({
  members,
  expenses,
  payments,
  transfers,
  baseCurrency,
  meId,
  onMarkSettled,
  onUndoPayment,
  onAddTransfer,
  onUndoTransfer,
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
        const balances = computeBalances(
          members,
          ledgerExpenses,
          currency,
          ledgerPayments,
          transfers,
        );
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
    [members, expenses, payments, transfers, baseCurrency],
  );

  const paymentsSorted = useMemo(
    () =>
      [...payments].sort((a, b) => (a.createdAt ?? a.id).localeCompare(b.createdAt ?? b.id)),
    [payments],
  );

  const transfersSorted = useMemo(
    () =>
      [...transfers].sort((a, b) => (a.createdAt ?? a.id).localeCompare(b.createdAt ?? b.id)),
    [transfers],
  );

  const paymentCcy = (payment: Payment): CurrencyCode =>
    payment.currency && isCurrencyCode(payment.currency) ? payment.currency : baseCurrency;

  // "Только мои" filter: show balances/settlements/payments involving me only.
  const [mineOnly, setMineOnly] = useState(readMineOnlyPref);
  useEffect(() => {
    writeMineOnlyPref(mineOnly);
  }, [mineOnly]);
  // "Перевести в…" popup: the settlement being paid in another currency.
  const [payAs, setPayAs] = useState<{ ledger: Ledger; settlement: Settlement } | null>(null);
  // Currency chosen inside the partial form (null = the ledger's currency).
  const [partialCcy, setPartialCcy] = useState<CurrencyCode | null>(null);

  // Wallets (and their members) that include the current user.
  const myWallets = useMemo(
    () => (meId ? ledgers[0].wallets.filter((w) => w.memberIds.includes(meId)) : []),
    [ledgers, meId],
  );
  const myMemberIds = useMemo(
    () => new Set(myWallets.flatMap((w) => w.memberIds)),
    [myWallets],
  );

  const settlementInvolvesMe = (ledger: Ledger, settlement: Settlement): boolean => {
    if (!meId) return false;
    const from = ledger.wallets.find((w) => w.key === settlement.fromMemberId);
    const to = ledger.wallets.find((w) => w.key === settlement.toMemberId);
    return (from?.memberIds.includes(meId) ?? false) || (to?.memberIds.includes(meId) ?? false);
  };

  const visiblePayments = useMemo(
    () =>
      mineOnly
        ? paymentsSorted.filter(
            (payment) => myMemberIds.has(payment.payerId) || myMemberIds.has(payment.receiverId),
          )
        : paymentsSorted,
    [paymentsSorted, mineOnly, myMemberIds],
  );

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
    // The amount is typed in `partialCcy`; the debt always shrinks in the
    // ledger currency, the original input is recorded as "paid in …".
    const entryCcy = partialCcy ?? currency;
    let amountMinor = toMinor(entered, entryCcy);
    let paid: { amountMinor: number; currency: CurrencyCode } | undefined;
    if (entryCcy !== currency) {
      if (!rates) {
        setPartialError(`Курсы недоступны — оплатите в ${currency}`);
        return;
      }
      const converted = toMinor(
        fromMinor(amountMinor, entryCcy) * crossRate(rates, entryCcy, currency),
        currency,
      );
      if (converted <= 0) {
        setPartialError('Слишком маленькая сумма для этой валюты');
        return;
      }
      paid = { amountMinor, currency: entryCcy };
      amountMinor = converted;
    }
    setPartialError(null);
    try {
      // Overpayment is allowed (e.g. no change available): the excess
      // automatically becomes a reverse debt via payment netting.
      await onMarkSettled(from.memberIds[0], to.memberIds[0], amountMinor, currency, paid);
      setPartialKey(null);
      setPartialAmount('');
      setPartialCcy(null);
    } catch (err) {
      setPartialError(err instanceof Error ? err.message : String(err));
    }
  }

  // "Перевести в…": re-denominate the debt into another currency — ONE
  // debt_transfers record (no money moves; single record = single undo). The
  // debt closes in the source ledger and opens in the target ledger.
  async function confirmTransfer(
    ledger: Ledger,
    settlement: Settlement,
    targetCurrency: CurrencyCode,
    targetAmountMinor: number,
  ) {
    const from = ledger.wallets.find((w) => w.key === settlement.fromMemberId);
    const to = ledger.wallets.find((w) => w.key === settlement.toMemberId);
    if (!from || !to) return;
    setPayAs(null);
    await onAddTransfer(
      from.memberIds[0],
      to.memberIds[0],
      ledger.currency,
      settlement.amountMinor,
      targetCurrency,
      targetAmountMinor,
    );
  }

  const partialPreview = (settlement: Settlement, currency: CurrencyCode): string => {
    const entered = parseAmount(partialAmount);
    if (!Number.isFinite(entered) || entered <= 0) return '';
    const entryCcy = partialCcy ?? currency;
    const amountMinor = toMinor(entered, entryCcy);
    let ledgerAmount = amountMinor;
    let paidNote = '';
    if (entryCcy !== currency) {
      if (!rates) return '';
      ledgerAmount = toMinor(
        fromMinor(amountMinor, entryCcy) * crossRate(rates, entryCcy, currency),
        currency,
      );
      if (ledgerAmount <= 0) return '';
      paidNote = ` (${formatMinor(amountMinor, entryCcy)})`;
    }
    const diff = settlement.amountMinor - ledgerAmount;
    if (diff === 0) return 'Долг будет закрыт полностью';
    if (diff > 0) {
      return `Внесено ${formatMinor(ledgerAmount, currency)}${paidNote}, останется: ${formatMinor(
        diff,
        currency,
      )}`;
    }
    const over = formatMinor(ledgerAmount - settlement.amountMinor, currency);
    return `Переплата ${over} — теперь ${labelOf(currency, settlement.toMemberId)} должен ${labelOf(
      currency,
      settlement.fromMemberId,
    )}`;
  };

  // Placeholder: the whole debt in the currency being typed; when it differs
  // from the ledger currency — an informational "≈" conversion at today's rate.
  const partialPlaceholder = (
    settlement: Settlement,
    currency: CurrencyCode,
  ): string | undefined => {
    const entryCcy = partialCcy ?? currency;
    if (entryCcy === currency) return String(fromMinor(settlement.amountMinor, currency));
    if (!rates?.[currency] || !rates?.[entryCcy]) return undefined;
    const equivalent =
      fromMinor(settlement.amountMinor, currency) * crossRate(rates, currency, entryCcy);
    return `≈ ${equivalent.toFixed(CURRENCIES[entryCcy].decimals)}`;
  };

  return (
    <div className="space-y-4">
      {meId && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400 dark:text-slate-500">Фильтр:</span>
          <button
            type="button"
            onClick={() => setMineOnly((value) => !value)}
            className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
              mineOnly ? 'bg-teal-600 text-white' : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 shadow-sm'
            }`}
          >
            Только мои
          </button>
        </div>
      )}

      <section className="rounded-2xl bg-white dark:bg-slate-900 p-4 shadow-sm">
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Всего потрачено
          </h2>
          <div className="space-y-0.5 text-right">
            {ledgers.some((ledger) => ledger.totalMinor !== 0) ? (
              ledgers.map((ledger) =>
                ledger.totalMinor === 0 ? null : (
                  <p key={ledger.currency} className="text-base font-bold text-slate-900 dark:text-slate-100">
                    {formatMinor(ledger.totalMinor, ledger.currency)}
                  </p>
                ),
              )
            ) : (
              <p className="text-base font-bold text-slate-900 dark:text-slate-100">0</p>
            )}
          </div>
        </div>
      </section>

      <section className="rounded-2xl bg-white dark:bg-slate-900 p-4 shadow-sm">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Балансы
        </h2>
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {(mineOnly
            ? ledgers[0].wallets.filter((wallet) => wallet.memberIds.includes(meId ?? ''))
            : ledgers[0].wallets
          ).map((wallet) => {
            const label = wallet.memberIds.includes(meId ?? '')
              ? `${wallet.label} (вы)`
              : wallet.label;
            return (
              <li key={wallet.key} className="flex items-start justify-between py-2.5">
                <span className="text-base text-slate-800 dark:text-slate-200">{label}</span>
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
                            net > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400'
                          }`}
                        >
                          {`${net > 0 ? '+' : ''}${formatMinor(net, ledger.currency)}`}
                        </p>
                      );
                    })
                  ) : (
                    <p className="text-sm font-semibold text-slate-400 dark:text-slate-500">Не заржавело</p>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="rounded-2xl bg-white dark:bg-slate-900 p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Предлагаемые расчёты
        </h2>
        {ledgers.every(
          (ledger) =>
            ledger.settlements.filter(
              (settlement) => !mineOnly || settlementInvolvesMe(ledger, settlement),
            ).length === 0,
        ) ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {expenses.length === 0
              ? 'Расходов пока нет.'
              : mineOnly
                ? 'Расчётов с вашим участием нет.'
                : 'Все в расчёте 🎉'}
          </p>
        ) : (
          <div className="space-y-4">
            {ledgers.map((ledger) => {
              const visible = mineOnly
                ? ledger.settlements.filter((settlement) =>
                    settlementInvolvesMe(ledger, settlement),
                  )
                : ledger.settlements;
              if (visible.length === 0) return null;
              return (
                <div key={ledger.currency}>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                    {CURRENCIES[ledger.currency].symbol} {ledger.currency}
                  </p>
                  <ul className="space-y-2">
                    {visible.map((settlement, index) => {
                      const alt = altAmounts(settlement.amountMinor, ledger.currency);
                      const settlementKey = `${ledger.currency}-${settlement.fromMemberId}-${settlement.toMemberId}-${index}`;
                      const isPartialOpen = partialKey === settlementKey;
                      const preview = partialPreview(settlement, ledger.currency);
                      const involvesMe = settlementInvolvesMe(ledger, settlement);
                      const entryCcy = partialCcy ?? ledger.currency;
                      return (
                        <li key={settlementKey} className="rounded-lg bg-slate-50 dark:bg-slate-800/60 px-3 py-2.5">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="min-w-0 text-sm text-slate-700 dark:text-slate-300">
                              <strong>{labelOf(ledger.currency, settlement.fromMemberId)}</strong>
                              {' → '}
                              <strong>{labelOf(ledger.currency, settlement.toMemberId)}</strong>
                            </span>
                            <span className="shrink-0 text-right">
                              {involvesMe && rates ? (
                                <button
                                  type="button"
                                  onClick={() => setPayAs({ ledger, settlement })}
                                  title="Хочу оплатить в другой валюте"
                                  className="block text-sm font-semibold text-slate-900 dark:text-slate-100 underline decoration-dotted underline-offset-2"
                                >
                                  {formatMinor(settlement.amountMinor, ledger.currency)}
                                </button>
                              ) : (
                                <span className="block text-sm font-semibold text-slate-900 dark:text-slate-100">
                                  {formatMinor(settlement.amountMinor, ledger.currency)}
                                </span>
                              )}
                              {alt && (
                                <span className="block text-[10px] leading-tight text-slate-400 dark:text-slate-500">
                                  {alt}
                                </span>
                              )}
                            </span>
                          </div>
                          {involvesMe && (
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
                                  setPartialCcy(null);
                                }}
                                className="rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-3 py-2.5 text-sm font-medium text-slate-600 dark:text-slate-400 active:bg-slate-100 dark:active:bg-slate-700"
                              >
                                Погасить частично
                              </button>
                            </div>
                          )}

                          {isPartialOpen && (
                            <form
                              onSubmit={(e) => {
                                e.preventDefault();
                                void submitPartial(ledger.currency, settlement);
                              }}
                              className="mt-2 border-t border-slate-200 dark:border-slate-700 pt-2"
                            >
                              <div className="flex flex-wrap items-center gap-1.5">
                                {CURRENCY_CODES.map((c) =>
                                  !rates && c !== ledger.currency ? null : (
                                    <button
                                      key={c}
                                      type="button"
                                      onClick={() => setPartialCcy(c)}
                                      className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                                        entryCcy === c
                                          ? 'bg-teal-600 text-white'
                                          : 'border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400'
                                      }`}
                                    >
                                      {CURRENCIES[c].symbol} {c}
                                    </button>
                                  ),
                                )}
                              </div>
                              <div className="mt-1.5 flex items-center gap-2">
                                <input
                                  value={partialAmount}
                                  onChange={(e) => setPartialAmount(e.target.value)}
                                  inputMode="decimal"
                                  autoFocus
                                  placeholder={partialPlaceholder(settlement, ledger.currency)}
                                  className="min-w-0 flex-1 rounded-lg border border-slate-300 dark:border-slate-600 px-3 py-1.5 text-sm focus:border-teal-500 dark:focus:border-teal-400 focus:outline-none"
                                />
                                <span className="text-xs text-slate-400 dark:text-slate-500">{entryCcy}</span>
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
                                  className="text-xs font-medium text-slate-500 dark:text-slate-400"
                                >
                                  Отмена
                                </button>
                              </div>
                              {preview && (
                                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{preview}</p>
                              )}
                              {partialError && (
                                <p className="mt-1 text-xs text-red-500 dark:text-red-400">{partialError}</p>
                              )}
                            </form>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
        <p className="mt-3 text-xs text-slate-400 dark:text-slate-500">
          Расчёты ведутся отдельно по каждой валюте. Из общего кошелька деньги может принять
          любой из его участников. Переплата разрешена — излишек станет обратным долгом.
        </p>
      </section>

      {mineOnly && visiblePayments.length === 0 ? (
        <p className="rounded-2xl bg-white dark:bg-slate-900 px-4 py-3 text-xs text-slate-400 dark:text-slate-500 shadow-sm">
          Платежей с вашим участием нет.
        </p>
      ) : (
        visiblePayments.length > 0 && (
          <section className="rounded-2xl bg-white dark:bg-slate-900 p-4 shadow-sm">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Отмеченные расчёты
            </h2>
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {visiblePayments.map((payment) => {
                const ccy = paymentCcy(payment);
                const alt = altAmounts(payment.amountMinor, ccy);
                const paidIn =
                  payment.paidCurrency &&
                  isCurrencyCode(payment.paidCurrency) &&
                  payment.paidAmountMinor
                    ? { currency: payment.paidCurrency, amountMinor: payment.paidAmountMinor }
                    : null;
                return (
                  <li key={payment.id} className="flex items-center justify-between py-2">
                    <span className="min-w-0 text-sm text-slate-700 dark:text-slate-300">
                      <strong>{memberName(payment.payerId)}</strong>
                      {' → '}
                      <strong>{memberName(payment.receiverId)}</strong>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="text-right">
                        <span className="block text-sm text-emerald-600 dark:text-emerald-400">
                          ✓ {formatMinor(payment.amountMinor, ccy)}
                          {paidIn && paidIn.currency !== ccy && (
                            <span className="text-xs font-normal text-slate-400 dark:text-slate-500">
                              {' '}
                              · оплачено {formatMinor(paidIn.amountMinor, paidIn.currency)}
                            </span>
                          )}
                        </span>
                        {alt && (
                          <span className="block text-[10px] leading-tight text-slate-400 dark:text-slate-500">
                            {alt}
                          </span>
                        )}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          if (
                            !window.confirm(
                              `Отменить платёж ${memberName(payment.payerId)} → ${memberName(
                                payment.receiverId,
                              )} на ${formatMinor(payment.amountMinor, ccy)}? Долг вернётся в балансы.`,
                            )
                          )
                            return;
                          void onUndoPayment(payment.id);
                        }}
                        className="text-xs font-medium text-red-500 dark:text-red-400"
                      >
                        отменить
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
              «Отменить» убирает платёж — задолженность вернётся в балансы.
            </p>
          </section>
        )
      )}

      {payAs && rates && (
        <div
          className="safe-sheet-overlay fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40"
          onClick={() => setPayAs(null)}
        >
          <div
            className="safe-sheet w-full max-w-md rounded-t-2xl bg-white dark:bg-slate-900 p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">Перевести в…</h3>
            <p className="mb-3 mt-1 text-xs text-slate-400 dark:text-slate-500">
              {labelOf(payAs.ledger.currency, payAs.settlement.fromMemberId)} →{' '}
              {labelOf(payAs.ledger.currency, payAs.settlement.toMemberId)} ·{' '}
              {formatMinor(payAs.settlement.amountMinor, payAs.ledger.currency)} по сегодняшнему
              курсу
            </p>
            <div className="space-y-2">
              {CURRENCY_CODES.filter((c) => c !== payAs.ledger.currency).map((c) => {
                const converted = toMinor(
                  fromMinor(payAs.settlement.amountMinor, payAs.ledger.currency) *
                    crossRate(rates, payAs.ledger.currency, c),
                  c,
                );
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() =>
                      void confirmTransfer(payAs.ledger, payAs.settlement, c, converted)
                    }
                    className="flex w-full items-center justify-between rounded-xl border border-slate-200 dark:border-slate-700 px-3 py-2.5 text-sm active:bg-slate-50 dark:active:bg-slate-800"
                  >
                    <span className="font-semibold text-slate-700 dark:text-slate-300">
                      {CURRENCIES[c].symbol} {c}
                    </span>
                    <span className="font-semibold text-slate-900 dark:text-slate-100">
                      ≈ {formatMinor(converted, c)}
                    </span>
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              onClick={() => setPayAs(null)}
              className="mt-3 w-full rounded-xl bg-slate-100 dark:bg-slate-800 py-2.5 text-sm font-medium text-slate-600 dark:text-slate-400"
            >
              Отмена
            </button>
          </div>
        </div>
      )}
      <section className="rounded-2xl bg-white dark:bg-slate-900 p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Переносы долгов
        </h2>
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {transfersSorted.map((transfer) => (
            <li key={transfer.id} className="flex items-center justify-between py-2">
              <span className="min-w-0 text-sm text-slate-700 dark:text-slate-300">
                <strong>{memberName(transfer.payerId)}</strong>
                {' должен '}
                <strong>{memberName(transfer.receiverId)}</strong>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="text-right text-sm text-amber-600 dark:text-amber-400">
                  {formatMinor(transfer.sourceAmountMinor, transfer.sourceCurrency)} →{' '}
                  {formatMinor(transfer.targetAmountMinor, transfer.targetCurrency)}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    if (
                      !window.confirm(
                        `Отменить перенос долга ${memberName(transfer.payerId)} → ${memberName(
                          transfer.receiverId,
                        )} (${formatMinor(
                          transfer.sourceAmountMinor,
                          transfer.sourceCurrency,
                        )} → ${formatMinor(
                          transfer.targetAmountMinor,
                          transfer.targetCurrency,
                        )})?`,
                      )
                    )
                      return;
                    void onUndoTransfer(transfer.id);
                  }}
                  className="text-xs font-medium text-red-500 dark:text-red-400"
                >
                  отменить
                </button>
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
          Перенос объявляет, в какой валюте вы погасите долг. «Отменить» вернёт долг в исходную
          валюту.
        </p>
      </section>
    </div>
  );
}
