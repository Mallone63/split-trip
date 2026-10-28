import { useMemo } from 'react';
import { aggregateByUnit, computeBalances, suggestSettlements } from '../lib/balances';
import { formatMinor, type CurrencyCode } from '../lib/currencies';
import type { Expense, Member } from '../lib/types';

interface Props {
  members: Member[];
  expenses: Expense[];
  baseCurrency: CurrencyCode;
  meId: string | null;
}

export default function BalanceTab({ members, expenses, baseCurrency, meId }: Props) {
  const balances = useMemo(
    () => computeBalances(members, expenses, baseCurrency),
    [members, expenses, baseCurrency],
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

  const labelOf = (unitKey: string): string => {
    const wallet = wallets.find((w) => w.key === unitKey);
    if (!wallet) return '—';
    return wallet.memberIds.includes(meId ?? '') ? `${wallet.label} (вы)` : wallet.label;
  };

  const amountOf = (netMinor: number): string =>
    netMinor === 0 ? 'ок' : `${netMinor > 0 ? '+' : ''}${formatMinor(netMinor, baseCurrency)}`;

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
            {settlements.map((settlement, index) => (
              <li
                key={`${settlement.fromMemberId}-${settlement.toMemberId}-${index}`}
                className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2"
              >
                <span className="text-sm text-slate-700">
                  <strong>{labelOf(settlement.fromMemberId)}</strong>
                  {' → '}
                  <strong>{labelOf(settlement.toMemberId)}</strong>
                </span>
                <span className="text-sm font-semibold text-slate-900">
                  {formatMinor(settlement.amountMinor, baseCurrency)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-slate-400">
          Рассчитывайтесь как удобно — суммы в {baseCurrency}. Из общего кошелька деньги может
          принять любой из его участников.
        </p>
      </section>
    </div>
  );
}
