import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { NewExpenseInput } from '../lib/api';
import {
  CURRENCIES,
  CURRENCY_CODES,
  formatMinor,
  parseAmount,
  toMinor,
  type CurrencyCode,
} from '../lib/currencies';
import { errorMessage } from '../lib/errors';
import { formatRate, suggestRate, toBaseMinor } from '../lib/fx';
import {
  materializeCustomSplit,
  materializePaidSplit,
  type PaidEntry,
} from '../lib/split';
import type { Member } from '../lib/types';

interface Props {
  members: Member[];
  baseCurrency: CurrencyCode;
  onSubmit: (input: NewExpenseInput) => Promise<void>;
  onCancel: () => void;
}

type SplitMode = 'equal' | 'custom';
type RateStatus = 'loading' | 'ready' | 'unavailable';

/** Parsed per-member inputs (bill shares / handed-over amounts), in member order. */
function collectEntries(
  values: Record<string, string>,
  memberOrder: string[],
  currency: CurrencyCode,
): PaidEntry[] {
  return memberOrder.flatMap((id) => {
    const value = parseAmount(values[id] ?? '');
    return Number.isFinite(value) && value > 0
      ? [{ memberId: id, amountMinor: toMinor(value, currency) }]
      : [];
  });
}

export default function ExpenseForm({
  members,
  baseCurrency,
  onSubmit,
  onCancel,
}: Props) {
  const [title, setTitle] = useState('');
  const [currency, setCurrency] = useState<CurrencyCode>(baseCurrency);
  const [spentAt, setSpentAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [mode, setMode] = useState<SplitMode>('equal');
  const [selected, setSelected] = useState<Set<string>>(() => new Set(members.map((m) => m.id)));
  const [paidAmounts, setPaidAmounts] = useState<Record<string, string>>({});
  const [shareAmounts, setShareAmounts] = useState<Record<string, string>>({});
  const [rateStr, setRateStr] = useState('');
  const [rateStatus, setRateStatus] = useState<RateStatus>('loading');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const memberOrder = useMemo(() => members.map((m) => m.id), [members]);

  useEffect(() => {
    let active = true;
    setRateStatus('loading');
    suggestRate(currency, baseCurrency)
      .then((suggested) => {
        if (active) {
          setRateStr(formatRate(suggested));
          setRateStatus('ready');
        }
      })
      .catch(() => {
        if (active) setRateStatus('unavailable');
      });
    return () => {
      active = false;
    };
  }, [currency, baseCurrency]);

  const rate = parseAmount(rateStr);
  const rateValid = Number.isFinite(rate) && rate > 0;

  const participants = useMemo(
    () => memberOrder.filter((id) => selected.has(id)),
    [memberOrder, selected],
  );

  // Сколько каждый участник передал (наличные/карта) — на обеих вкладках.
  const paidEntries = useMemo(
    () => collectEntries(paidAmounts, memberOrder, currency),
    [memberOrder, paidAmounts, currency],
  );
  // «Разделить счёт»: точная доля счёта на каждом участнике.
  const shareEntries = useMemo(
    () => collectEntries(shareAmounts, memberOrder, currency),
    [memberOrder, shareAmounts, currency],
  );

  // «Поровну»: итог выводится из оплат, доли равные; остаток копеек —
  // основному плательщику (крупнейший взнос, ничья → порядок участников).
  const paidSplit = useMemo(() => {
    if (mode !== 'equal' || paidEntries.length === 0 || participants.length === 0) return null;
    try {
      return materializePaidSplit(paidEntries, participants, memberOrder);
    } catch {
      return null; // invalid input keeps the form unsaveable
    }
  }, [mode, paidEntries, participants, memberOrder]);

  // «Разделить счёт»: точные доли + оплаты; суммы должны совпадать.
  const customSplit = useMemo(() => {
    if (mode !== 'custom' || shareEntries.length === 0 || participants.length === 0) return null;
    try {
      return materializeCustomSplit(shareEntries, paidEntries, participants, memberOrder);
    } catch {
      return null;
    }
  }, [mode, shareEntries, paidEntries, participants, memberOrder]);

  const paidTotal = paidEntries.reduce((sum, entry) => sum + entry.amountMinor, 0);
  const shareTotal = shareEntries.reduce((sum, entry) => sum + entry.amountMinor, 0);
  // In both modes the total is derived: from the payments («Поровну») or the
  // bill shares («Разделить счёт»).
  const amountMinor = mode === 'equal' ? paidTotal : shareTotal;
  const paidMismatch = mode === 'custom' && shareTotal > 0 && paidTotal !== shareTotal;
  const splitValid = (mode === 'equal' ? paidSplit : customSplit) !== null;
  const canSave =
    title.trim().length > 0 && amountMinor > 0 && rateValid && splitValid && !submitting;

  function toggleMember(memberId: string) {
    const wasSelected = selected.has(memberId);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(memberId)) next.delete(memberId);
      else next.add(memberId);
      return next;
    });
    if (wasSelected) {
      // A deselected participant is no longer a payer or a share holder; drop
      // their entered amounts.
      setPaidAmounts((prev) => {
        const next = { ...prev };
        delete next[memberId];
        return next;
      });
      setShareAmounts((prev) => {
        const next = { ...prev };
        delete next[memberId];
        return next;
      });
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const resolved = mode === 'equal' ? paidSplit : customSplit;
    if (!canSave || !rateValid || !resolved) return;
    setSubmitting(true);
    setError(null);
    try {
      const baseAmountMinor = resolved.splits.reduce(
        (sum, split) => sum + toBaseMinor(split.amountMinor, rate, currency, baseCurrency),
        0,
      );
      await onSubmit({
        // Several members may have paid; the DB column keeps the primary one
        // (largest contribution, ties broken by member order).
        payerId: resolved.primaryPayerId,
        title: title.trim(),
        currency,
        amountMinor,
        fxRate: rate,
        baseAmountMinor,
        splits: resolved.splits,
        spentAt,
      });
    } catch (err) {
      setError(errorMessage(err));
      setSubmitting(false);
    }
  }

  const inputClass =
    'mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-600 px-3 py-2 text-base focus:border-teal-500 dark:focus:border-teal-400 focus:outline-none';
  // Compact per-member cells on the «Разделить счёт» tab (share + handed over).
  const cellInputClass =
    'w-20 shrink-0 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-2 py-1 text-right text-base focus:border-teal-500 dark:focus:border-teal-400 focus:outline-none';

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Новый расход
        </h2>
        <button type="button" onClick={onCancel} className="text-sm font-medium text-slate-500 dark:text-slate-400">
          Отмена
        </button>
      </div>

      <div className="space-y-4 rounded-2xl bg-white dark:bg-slate-900 p-4 shadow-sm">
        <label className="block">
          <span className="text-sm font-medium text-slate-700 dark:text-slate-300">За что?</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Ужин в раменной"
            className={inputClass}
          />
        </label>

        <div className="flex gap-2">
          <div className="block min-w-0 flex-1">
            <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Сумма</span>
            <div className={`${inputClass} bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400`}>
              {amountMinor > 0
                ? formatMinor(amountMinor, currency)
                : mode === 'equal'
                  ? 'из оплат ниже'
                  : 'из долей ниже'}
            </div>
          </div>
          <label className="block w-32 shrink-0">
            <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Валюта</span>
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value as CurrencyCode)}
              className={`${inputClass} bg-white dark:bg-slate-900`}
            >
              {CURRENCY_CODES.map((code) => (
                <option key={code} value={code}>
                  {code} {CURRENCIES[code].symbol}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="flex gap-2">
          <label className="block min-w-0 flex-1">
            <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Дата</span>
            <input
              type="date"
              value={spentAt}
              onChange={(e) => setSpentAt(e.target.value)}
              className={inputClass}
            />
          </label>
        </div>

        {currency !== baseCurrency && (
          <label className="block">
            <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Курс к {baseCurrency}</span>
            <input
              value={rateStr}
              onChange={(e) => setRateStr(e.target.value)}
              inputMode="decimal"
              placeholder={`1 ${currency} = ? ${baseCurrency}`}
              className={inputClass}
            />
            <span className="mt-1 block text-xs text-slate-400 dark:text-slate-500">
              {rateStatus === 'loading' && 'Получаем сегодняшний курс…'}
              {rateStatus === 'ready' &&
                `Рыночный курс: 1 ${currency} = ${rateStr} ${baseCurrency}. Если карта платит по другому курсу — введите фактический.`}
              {rateStatus === 'unavailable' && 'Нет сети — введите курс вручную.'}
            </span>
          </label>
        )}
      </div>

      <div className="rounded-2xl bg-white dark:bg-slate-900 p-4 shadow-sm">
        <div className="mb-3 flex rounded-lg bg-slate-100 dark:bg-slate-800 p-1 text-sm font-medium">
          {(['equal', 'custom'] as SplitMode[]).map((modeOption) => (
            <button
              key={modeOption}
              type="button"
              onClick={() => setMode(modeOption)}
              className={`flex-1 rounded-md py-1.5 ${
                mode === modeOption ? 'bg-white dark:bg-slate-900 text-teal-700 dark:text-teal-300 shadow' : 'text-slate-500 dark:text-slate-400'
              }`}
            >
              {modeOption === 'equal' ? 'Поровну' : 'Разделить счёт'}
            </button>
          ))}
        </div>

        {mode === 'equal' && (
          <div className="space-y-1">
            {members.map((member) => {
              const isSelected = selected.has(member.id);
              const share = paidSplit?.splits.find((s) => s.memberId === member.id)?.amountMinor ?? 0;
              const paid = paidEntries.find((entry) => entry.memberId === member.id)?.amountMinor ?? 0;
              return (
                <div
                  key={member.id}
                  className={`rounded-lg border px-3 py-2 ${
                    isSelected
                      ? 'border-teal-300 dark:border-teal-700 bg-teal-50 dark:bg-teal-900/30'
                      : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 opacity-50'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => toggleMember(member.id)}
                      className="min-w-0 flex-1 text-left text-sm text-slate-800 dark:text-slate-200"
                    >
                      {member.name}
                      {member.id === paidSplit?.primaryPayerId ? ' (плательщик)' : ''}
                    </button>
                    {isSelected && (
                      <input
                        value={paidAmounts[member.id] ?? ''}
                        onChange={(e) =>
                          setPaidAmounts((prev) => ({ ...prev, [member.id]: e.target.value }))
                        }
                        inputMode="decimal"
                        placeholder="0"
                        aria-label={`Заплатил(а): ${member.name}`}
                        className="w-28 shrink-0 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-2 py-1 text-right text-base focus:border-teal-500 dark:focus:border-teal-400 focus:outline-none"
                      />
                    )}
                  </div>
                  <div className="mt-1 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                    <span>{paid > 0 ? `заплатил(а) ${formatMinor(paid, currency)}` : 'не платил(а)'}</span>
                    <span>доля {isSelected && amountMinor > 0 ? formatMinor(share, currency) : '—'}</span>
                  </div>
                </div>
              );
            })}
            <p
              className={`text-right text-xs font-medium ${
                amountMinor > 0
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-slate-400 dark:text-slate-500'
              }`}
            >
              {amountMinor > 0
                ? `Итого ${formatMinor(amountMinor, currency)} на ${selected.size} чел. — делится поровну`
                : 'Отметьте участников и введите, кто сколько заплатил'}
            </p>
          </div>
        )}

        {mode === 'custom' && (
          <div className="space-y-1">
            <div className="flex items-center gap-2 px-3 text-xs text-slate-400 dark:text-slate-500">
              <span className="min-w-0 flex-1">Участник</span>
              <span className="w-20 shrink-0 text-right">Доля</span>
              <span className="w-20 shrink-0 text-right">Внёс</span>
            </div>
            {members.map((member) => {
              const isSelected = selected.has(member.id);
              const share = shareEntries.find((entry) => entry.memberId === member.id)?.amountMinor ?? 0;
              const paid = paidEntries.find((entry) => entry.memberId === member.id)?.amountMinor ?? 0;
              return (
                <div
                  key={member.id}
                  className={`rounded-lg border px-3 py-2 ${
                    isSelected
                      ? 'border-teal-300 dark:border-teal-700 bg-teal-50 dark:bg-teal-900/30'
                      : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 opacity-50'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => toggleMember(member.id)}
                      className="min-w-0 flex-1 text-left text-sm text-slate-800 dark:text-slate-200"
                    >
                      {member.name}
                      {member.id === customSplit?.primaryPayerId ? ' (плательщик)' : ''}
                    </button>
                    {isSelected && (
                      <>
                        <input
                          value={shareAmounts[member.id] ?? ''}
                          onChange={(e) =>
                            setShareAmounts((prev) => ({ ...prev, [member.id]: e.target.value }))
                          }
                          inputMode="decimal"
                          placeholder="0"
                          aria-label={`Доля счёта: ${member.name}`}
                          className={cellInputClass}
                        />
                        <input
                          value={paidAmounts[member.id] ?? ''}
                          onChange={(e) =>
                            setPaidAmounts((prev) => ({ ...prev, [member.id]: e.target.value }))
                          }
                          inputMode="decimal"
                          placeholder="0"
                          aria-label={`Заплатил(а): ${member.name}`}
                          className={cellInputClass}
                        />
                      </>
                    )}
                  </div>
                  <div className="mt-1 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                    <span>{share > 0 ? `доля ${formatMinor(share, currency)}` : 'без доли'}</span>
                    <span>{paid > 0 ? `заплатил(а) ${formatMinor(paid, currency)}` : 'не платил(а)'}</span>
                  </div>
                </div>
              );
            })}
            <p
              className={`text-right text-xs font-medium ${
                paidMismatch
                  ? 'text-red-600 dark:text-red-400'
                  : amountMinor > 0
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-slate-400 dark:text-slate-500'
              }`}
            >
              {paidMismatch
                ? `Внесено ${formatMinor(paidTotal, currency)} из ${formatMinor(shareTotal, currency)} — суммы должны совпадать`
                : amountMinor > 0
                  ? `Счёт ${formatMinor(amountMinor, currency)} на ${selected.size} чел.`
                  : 'Отметьте участников и заполните доли счёта'}
            </p>
          </div>
        )}
      </div>

      {error && <p className="rounded-lg bg-red-50 dark:bg-red-950/40 p-3 text-sm text-red-700 dark:text-red-300">{error}</p>}

      <button
        type="submit"
        disabled={!canSave}
        className="w-full rounded-xl bg-teal-600 py-3 text-base font-semibold text-white shadow disabled:opacity-40"
      >
        {submitting ? 'Сохраняю…' : 'Сохранить расход'}
      </button>
    </form>
  );
}
