import { useEffect, useMemo, useState } from 'react';
import { formatMinor, type CurrencyCode } from '../lib/currencies';
import { formatRate } from '../lib/fx';
import { expensePayers } from '../lib/split';
import { readExpenseFilterPref, writeExpenseFilterPref } from '../lib/prefs';
import { expenseDayTotals, expenseInvolvesWallet, isWalletOnlyExpense, walletExpenseShare } from '../lib/expenseView';
import type { ExpenseFilter } from '../lib/expenseView';
import type { Expense, Member } from '../lib/types';

interface Props {
  expenses: Expense[];
  members: Member[];
  baseCurrency: CurrencyCode;
  /** A valid "me" enables wallet filters and share summaries. */
  meId: string | null;
  onAdd: () => void;
  onDelete: (expenseId: string) => Promise<void>;
}

function groupLabel(dateStr: string): string {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (dateStr === today) return 'Сегодня';
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString('ru-RU', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

export default function ExpenseList({
  expenses,
  members,
  baseCurrency,
  meId,
  onAdd,
  onDelete,
}: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [filter, setFilter] = useState(readExpenseFilterPref);
  useEffect(() => {
    writeExpenseFilterPref(filter);
  }, [filter]);

  // Wallet-aware membership: me + everyone sharing my unit (e.g. a partner).
  const myMembers = useMemo(() => {
    const me = members.find((m) => m.id === meId);
    return me ? members.filter((m) => m.id === me.id || (me.unit != null && m.unit === me.unit)) : [];
  }, [members, meId]);
  const myMemberIds = useMemo(() => new Set(myMembers.map((member) => member.id)), [myMembers]);
  const hasMe = myMembers.length > 0;
  const isCouple = myMembers.length > 1;
  const shareLabel = isCouple ? 'Наша доля' : 'Моя доля';
  const activeFilter = hasMe ? filter : 'all';
  const filters: { value: ExpenseFilter; label: string }[] = [
    { value: 'all', label: 'Все' },
    { value: 'involved', label: isCouple ? 'С нами' : 'Со мной' },
    { value: 'personal', label: 'Личные' },
  ];

  const sorted = useMemo(
    () =>
      [...expenses].sort((a, b) =>
        a.spentAt === b.spentAt
          ? (b.createdAt ?? b.id).localeCompare(a.createdAt ?? a.id)
          : b.spentAt.localeCompare(a.spentAt),
      ),
    [expenses],
  );

  const visible = useMemo(
    () =>
      activeFilter === 'all' ? sorted : sorted.filter((expense) =>
        activeFilter === 'personal'
          ? isWalletOnlyExpense(expense, myMemberIds)
          : expenseInvolvesWallet(expense, myMemberIds),
      ),
    [sorted, activeFilter, myMemberIds],
  );

  const groups = useMemo(() => {
    const map = new Map<string, Expense[]>();
    for (const expense of visible) {
      const list = map.get(expense.spentAt);
      if (list) list.push(expense);
      else map.set(expense.spentAt, [expense]);
    }
    return [...map.entries()];
  }, [visible]);

  const nameOf = (memberId: string) => members.find((m) => m.id === memberId)?.name ?? '???';

  async function handleDelete(expense: Expense) {
    if (!window.confirm(`Удалить «${expense.title}»?`)) return;
    await onDelete(expense.id);
  }

  return (
    <div className="space-y-4 pb-14">
      <button
        type="button"
        onClick={onAdd}
        className="expense-add fixed z-10 rounded-full bg-teal-600 px-4 py-2 text-sm font-semibold text-white shadow"
      >
        + Добавить
      </button>

      {hasMe && (
        <div className="space-y-2">
          <div role="group" aria-label="Фильтр расходов" className="flex rounded-lg bg-slate-100 dark:bg-slate-800 p-1 text-sm font-medium">
            {filters.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={activeFilter === option.value}
                onClick={() => setFilter(option.value)}
                className={`min-w-0 flex-1 rounded-md px-2 py-2 focus-visible:outline-2 focus-visible:outline-teal-500 dark:focus-visible:outline-teal-400 ${
                  activeFilter === option.value
                    ? 'bg-white dark:bg-slate-900 text-teal-700 dark:text-teal-300 shadow'
                    : 'text-slate-500 dark:text-slate-400'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {isCouple ? 'Доля пары' : 'Доля'}: {myMembers.map((member) => member.name).join(' + ')}
          </p>
        </div>
      )}

      {expenses.length === 0 && (
        <div className="rounded-2xl bg-white dark:bg-slate-900 p-8 text-center shadow-sm">
          <p className="text-sm text-slate-500 dark:text-slate-400">Пока нет расходов.</p>
          <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">Нажмите «+ Добавить», чтобы записать первый.</p>
        </div>
      )}

      {expenses.length > 0 && visible.length === 0 && (
        <p className="rounded-2xl bg-white dark:bg-slate-900 px-4 py-3 text-xs text-slate-400 dark:text-slate-500 shadow-sm">
          {activeFilter === 'personal' ? 'Личных расходов пока нет.' : 'Расходов с вашим участием нет.'}
        </p>
      )}

      {groups.map(([date, dayExpenses]) => {
        const totals = expenseDayTotals(dayExpenses, myMemberIds, baseCurrency);
        return (
          <section key={date} className="expense-day overflow-hidden rounded-2xl bg-white dark:bg-slate-900 shadow-sm">
            <h3 className="expense-day-heading flex items-center justify-between gap-1 border-b border-slate-100 dark:border-slate-800 px-3 py-2 font-normal leading-4 text-slate-400 dark:text-slate-500 tabular-nums">
              <span className="whitespace-nowrap uppercase">{groupLabel(date)}</span>
              <span className="whitespace-nowrap" title={`Всего за день в ${baseCurrency}`}>
                Σ {formatMinor(totals.totalMinor, baseCurrency)}
              </span>
              {hasMe && (
                <span className="whitespace-nowrap" title={`${shareLabel} за день в ${baseCurrency}`}>
                  {shareLabel}: {formatMinor(totals.shareMinor, baseCurrency)}
                </span>
              )}
            </h3>
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {dayExpenses.map((expense) => {
                const expanded = expandedId === expense.id;
                const participantCount = expense.splits.length;
                const payers = expensePayers(expense);
                const share = walletExpenseShare(expense, myMemberIds);
                const personal = isWalletOnlyExpense(expense, myMemberIds);
                const paidForOthers = share === 0 && payers.some((payer) => myMemberIds.has(payer.memberId));
                const paidBy =
                  payers.length === 1
                    ? `Оплатил(а) ${nameOf(payers[0].memberId)}`
                    : `Оплатили ${payers.map((p) => nameOf(p.memberId)).join(', ')}`;
                return (
                  <li key={expense.id}>
                    <button
                      type="button"
                      onClick={() => setExpandedId(expanded ? null : expense.id)}
                      className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-base text-slate-800 dark:text-slate-200">
                          {expense.title}
                        </span>
                        <span className="block text-xs text-slate-400 dark:text-slate-500">
                          {paidBy} · {participantCount} чел.
                        </span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span className="block text-base font-semibold text-slate-900 dark:text-slate-100">
                          {formatMinor(expense.amountMinor, expense.currency)}
                        </span>
                        {hasMe && !paidForOthers && (
                          <span className="block text-xs text-teal-700 dark:text-teal-300">
                            {personal ? 'Личная' : `${shareLabel}: ${formatMinor(share, expense.currency)}`}
                          </span>
                        )}
                        {paidForOthers && (
                          <span className="block text-xs text-slate-400 dark:text-slate-500">Оплачено за другого</span>
                        )}
                        {expense.currency !== baseCurrency && (
                          <span className="block text-xs text-slate-400 dark:text-slate-500">
                            ≈ {formatMinor(expense.baseAmountMinor, baseCurrency)}
                          </span>
                        )}
                      </span>
                    </button>

                    {expanded && (
                      <div className="border-t border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/60 px-4 py-3">
                        {expense.currency !== baseCurrency && (
                          <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
                            1 {expense.currency} = {formatRate(expense.fxRate)} {baseCurrency}
                          </p>
                        )}
                        <table className="w-full text-sm">
                          <caption className="sr-only">Участники расхода «{expense.title}»</caption>
                          <thead className="text-xs font-normal text-slate-400 dark:text-slate-500">
                            <tr>
                              <th scope="col" className="pb-1 text-left font-normal">Участник</th>
                              <th scope="col" className="pb-1 pl-3 text-right font-normal">Доля</th>
                              <th scope="col" className="pb-1 pl-3 text-right font-normal">Оплачено</th>
                            </tr>
                          </thead>
                          <tbody>
                            {expense.splits.map((split) => {
                              const paid = payers.find((payer) => payer.memberId === split.memberId)?.amountMinor ?? 0;
                              return (
                                <tr key={split.memberId}>
                                  <th scope="row" className="w-full max-w-0 break-words py-0.5 text-left align-top font-normal text-slate-600 dark:text-slate-400">
                                    {nameOf(split.memberId)}
                                  </th>
                                  <td className="whitespace-nowrap py-0.5 pl-3 text-right align-top tabular-nums text-slate-800 dark:text-slate-200">
                                    {formatMinor(split.amountMinor, expense.currency)}
                                  </td>
                                  <td className="whitespace-nowrap py-0.5 pl-3 text-right align-top tabular-nums text-slate-400 dark:text-slate-500">
                                    {paid > 0 ? formatMinor(paid, expense.currency) : '—'}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                        <button
                          type="button"
                          onClick={() => void handleDelete(expense)}
                          className="mt-3 text-xs font-medium text-red-500 dark:text-red-400"
                        >
                          Удалить расход
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
