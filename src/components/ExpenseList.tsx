import { useEffect, useMemo, useState } from 'react';
import { formatMinor, type CurrencyCode } from '../lib/currencies';
import { formatRate } from '../lib/fx';
import { readMineOnlyPref, writeMineOnlyPref } from '../lib/prefs';
import type { Expense, Member } from '../lib/types';

interface Props {
  expenses: Expense[];
  members: Member[];
  baseCurrency: CurrencyCode;
  /** "Me" member id — enables the "Только мои" filter; null hides the chip. */
  meId: string | null;
  onAdd: () => void;
  onDelete: (expenseId: string) => Promise<void>;
}

function groupLabel(dateStr: string): string {
  const today = new Date().toISOString().slice(0, 10);
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

  // "Только мои" filter — the same pref as on the balances tab (shared key),
  // so both tabs show the same value after switching.
  const [mineOnly, setMineOnly] = useState(readMineOnlyPref);
  useEffect(() => {
    writeMineOnlyPref(mineOnly);
  }, [mineOnly]);

  // Wallet-aware membership: me + everyone sharing my unit (e.g. a partner).
  const myMemberIds = useMemo(() => {
    const me = members.find((m) => m.id === meId);
    return new Set(
      members
        .filter((m) => m.id === meId || (me?.unit != null && m.unit === me.unit))
        .map((m) => m.id),
    );
  }, [members, meId]);

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
      mineOnly
        ? sorted.filter(
            (expense) =>
              myMemberIds.has(expense.payerId) ||
              expense.splits.some((split) => myMemberIds.has(split.memberId)),
          )
        : sorted,
    [sorted, mineOnly, myMemberIds],
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
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Расходы</h2>
        <button
          type="button"
          onClick={onAdd}
          className="expense-add fixed z-10 rounded-full bg-teal-600 px-4 py-2 text-sm font-semibold text-white shadow"
        >
          + Добавить
        </button>
      </div>

      {meId && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">Фильтр:</span>
          <button
            type="button"
            onClick={() => setMineOnly((value) => !value)}
            className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
              mineOnly ? 'bg-teal-600 text-white' : 'bg-white text-slate-600 shadow-sm'
            }`}
          >
            Только мои
          </button>
        </div>
      )}

      {expenses.length === 0 && (
        <div className="rounded-2xl bg-white p-8 text-center shadow-sm">
          <p className="text-sm text-slate-500">Пока нет расходов.</p>
          <p className="mt-1 text-xs text-slate-400">Нажмите «+ Добавить», чтобы записать первый.</p>
        </div>
      )}

      {expenses.length > 0 && visible.length === 0 && (
        <p className="rounded-2xl bg-white px-4 py-3 text-xs text-slate-400 shadow-sm">
          Расходов с вашим участием нет.
        </p>
      )}

      {groups.map(([date, dayExpenses]) => (
        <section key={date} className="overflow-hidden rounded-2xl bg-white shadow-sm">
          <h3 className="border-b border-slate-100 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
            {groupLabel(date)}
          </h3>
          <ul className="divide-y divide-slate-100">
            {dayExpenses.map((expense) => {
              const expanded = expandedId === expense.id;
              const participantCount = expense.splits.length;
              return (
                <li key={expense.id}>
                  <button
                    type="button"
                    onClick={() => setExpandedId(expanded ? null : expense.id)}
                    className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-base text-slate-800">
                        {expense.title}
                      </span>
                      <span className="block text-xs text-slate-400">
                        Оплатил(а) {nameOf(expense.payerId)} · {participantCount} чел.
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block text-base font-semibold text-slate-900">
                        {formatMinor(expense.amountMinor, expense.currency)}
                      </span>
                      {expense.currency !== baseCurrency && (
                        <span className="block text-xs text-slate-400">
                          ≈ {formatMinor(expense.baseAmountMinor, baseCurrency)}
                        </span>
                      )}
                    </span>
                  </button>

                  {expanded && (
                    <div className="border-t border-slate-100 bg-slate-50 px-4 py-3">
                      <p className="mb-2 text-xs text-slate-500">
                        1 {expense.currency} = {formatRate(expense.fxRate)} {baseCurrency}
                      </p>
                      <ul className="space-y-1">
                        {expense.splits.map((split) => (
                          <li key={split.memberId} className="flex justify-between text-sm">
                            <span className="text-slate-600">{nameOf(split.memberId)}</span>
                            <span className="text-slate-800">
                              {formatMinor(split.amountMinor, expense.currency)}
                            </span>
                          </li>
                        ))}
                      </ul>
                      <button
                        type="button"
                        onClick={() => void handleDelete(expense)}
                        className="mt-3 text-xs font-medium text-red-500"
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
      ))}
    </div>
  );
}
