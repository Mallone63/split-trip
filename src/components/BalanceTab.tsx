import { useMemo } from 'react';
import { computeBalances, suggestSettlements } from '../lib/balances';
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
  const settlements = useMemo(() => suggestSettlements(balances), [balances]);
  const totalSpent = useMemo(
    () => expenses.reduce((sum, expense) => sum + expense.baseAmountMinor, 0),
    [expenses],
  );

  const nameOf = (memberId: string) => {
    const member = members.find((m) => m.id === memberId);
    const label = member ? member.name : 'Unknown';
    return memberId === meId ? `${label} (you)` : label;
  };

  return (
    <div className="space-y-4">
      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Total spent
          </h2>
          <p className="text-lg font-bold text-slate-900">
            {formatMinor(totalSpent, baseCurrency)}
          </p>
        </div>
      </section>

      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Balances
        </h2>
        <ul className="divide-y divide-slate-100">
          {balances.map((balance) => (
            <li key={balance.memberId} className="flex items-center justify-between py-2.5">
              <span className="text-base text-slate-800">{nameOf(balance.memberId)}</span>
              <span
                className={`text-base font-semibold ${
                  balance.netMinor > 0
                    ? 'text-emerald-600'
                    : balance.netMinor < 0
                      ? 'text-red-500'
                      : 'text-slate-400'
                }`}
              >
                {balance.netMinor === 0
                  ? 'settled'
                  : `${balance.netMinor > 0 ? 'gets' : 'owes'} ${formatMinor(Math.abs(balance.netMinor), baseCurrency)}`}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Suggested settlements
        </h2>
        {settlements.length === 0 ? (
          <p className="text-sm text-slate-500">Everyone is even. 🎉</p>
        ) : (
          <ul className="space-y-2">
            {settlements.map((settlement, index) => (
              <li
                key={`${settlement.fromMemberId}-${settlement.toMemberId}-${index}`}
                className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2"
              >
                <span className="text-sm text-slate-700">
                  <strong>{nameOf(settlement.fromMemberId)}</strong>
                  {' → '}
                  <strong>{nameOf(settlement.toMemberId)}</strong>
                </span>
                <span className="text-sm font-semibold text-slate-900">
                  {formatMinor(settlement.amountMinor, baseCurrency)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-slate-400">
          Settle in person however you like — amounts are shown in {baseCurrency}.
        </p>
      </section>
    </div>
  );
}
