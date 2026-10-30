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
import { materializeEqualSplit, materializePaidSplit } from '../lib/split';
import type { Member, Split } from '../lib/types';

interface Props {
  members: Member[];
  baseCurrency: CurrencyCode;
  defaultPayerId: string;
  onSubmit: (input: NewExpenseInput) => Promise<void>;
  onCancel: () => void;
}

type SplitMode = 'equal' | 'paid';
type RateStatus = 'loading' | 'ready' | 'unavailable';

export default function ExpenseForm({
  members,
  baseCurrency,
  defaultPayerId,
  onSubmit,
  onCancel,
}: Props) {
  const [title, setTitle] = useState('');
  const [amountStr, setAmountStr] = useState('');
  const [currency, setCurrency] = useState<CurrencyCode>(baseCurrency);
  const [payerId, setPayerId] = useState(defaultPayerId);
  const [spentAt, setSpentAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [mode, setMode] = useState<SplitMode>('equal');
  const [selected, setSelected] = useState<Set<string>>(() => new Set(members.map((m) => m.id)));
  const [paidAmounts, setPaidAmounts] = useState<Record<string, string>>({});
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

  const typedAmount = parseAmount(amountStr);
  const typedAmountMinor =
    Number.isFinite(typedAmount) && typedAmount > 0 ? toMinor(typedAmount, currency) : 0;
  const rate = parseAmount(rateStr);
  const rateValid = Number.isFinite(rate) && rate > 0;

  const equalSplits = useMemo(() => {
    if (mode !== 'equal' || typedAmountMinor <= 0 || selected.size === 0) return [];
    const participants = memberOrder.filter((id) => selected.has(id));
    return materializeEqualSplit(typedAmountMinor, participants, payerId);
  }, [mode, typedAmountMinor, selected, memberOrder, payerId]);

  // Совместная оплата: сколько каждый участник передал (наличные/карта).
  const paidEntries = useMemo(() => {
    if (mode !== 'paid') return [];
    return memberOrder.flatMap((id) => {
      const value = parseAmount(paidAmounts[id] ?? '');
      return Number.isFinite(value) && value > 0
        ? [{ memberId: id, amountMinor: toMinor(value, currency) }]
        : [];
    });
  }, [mode, memberOrder, paidAmounts, currency]);

  const paidSplit = useMemo(() => {
    if (mode !== 'paid' || paidEntries.length === 0 || selected.size === 0) return null;
    const participants = memberOrder.filter((id) => selected.has(id));
    try {
      return materializePaidSplit(paidEntries, participants, memberOrder);
    } catch {
      return null; // invalid input keeps the form unsaveable
    }
  }, [mode, paidEntries, selected, memberOrder]);

  // In 'paid' mode the total is derived — it is the sum of the handed-over amounts.
  const amountMinor =
    mode === 'equal' ? typedAmountMinor : paidEntries.reduce((sum, entry) => sum + entry.amountMinor, 0);
  const splits: Split[] = mode === 'equal' ? equalSplits : (paidSplit?.splits ?? []);
  const splitValid = mode === 'equal' ? splits.length > 0 : paidSplit !== null;
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
      // A deselected participant is no longer a payer; drop their entered amount.
      setPaidAmounts((prev) => {
        const next = { ...prev };
        delete next[memberId];
        return next;
      });
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSave || !rateValid) return;
    setSubmitting(true);
    setError(null);
    try {
      const baseAmountMinor = splits.reduce(
        (sum, split) => sum + toBaseMinor(split.amountMinor, rate, currency, baseCurrency),
        0,
      );
      await onSubmit({
        // 'paid' mode has several payers; the DB column keeps the primary one.
        payerId: mode === 'paid' ? (paidSplit?.primaryPayerId ?? payerId) : payerId,
        title: title.trim(),
        currency,
        amountMinor,
        fxRate: rate,
        baseAmountMinor,
        splits,
        spentAt,
      });
    } catch (err) {
      setError(errorMessage(err));
      setSubmitting(false);
    }
  }

  const inputClass =
    'mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-600 px-3 py-2 text-base focus:border-teal-500 dark:focus:border-teal-400 focus:outline-none';

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
          {mode === 'equal' ? (
            <label className="block min-w-0 flex-1">
              <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Сумма</span>
              <input
                value={amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
                inputMode="decimal"
                placeholder={CURRENCIES[currency].symbol}
                className={inputClass}
              />
            </label>
          ) : (
            <div className="block min-w-0 flex-1">
              <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Сумма</span>
              <div className={`${inputClass} bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400`}>
                {amountMinor > 0 ? formatMinor(amountMinor, currency) : 'из оплат ниже'}
              </div>
            </div>
          )}
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
          {mode === 'equal' && (
            <label className="block min-w-0 flex-1">
              <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Кто платил</span>
              <select
                value={payerId}
                onChange={(e) => setPayerId(e.target.value)}
                className={`${inputClass} bg-white dark:bg-slate-900`}
              >
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </select>
            </label>
          )}
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
          {(['equal', 'paid'] as SplitMode[]).map((modeOption) => (
            <button
              key={modeOption}
              type="button"
              onClick={() => setMode(modeOption)}
              className={`flex-1 rounded-md py-1.5 ${
                mode === modeOption ? 'bg-white dark:bg-slate-900 text-teal-700 dark:text-teal-300 shadow' : 'text-slate-500 dark:text-slate-400'
              }`}
            >
              {modeOption === 'equal' ? 'Поровну' : 'Совместная оплата'}
            </button>
          ))}
        </div>

        {mode === 'equal' && (
          <ul className="space-y-1">
            {members.map((member) => {
              const isSelected = selected.has(member.id);
              const share = equalSplits.find((s) => s.memberId === member.id)?.amountMinor ?? 0;
              return (
                <li key={member.id}>
                  <button
                    type="button"
                    onClick={() => toggleMember(member.id)}
                    className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left ${
                      isSelected
                        ? 'border-teal-300 dark:border-teal-700 bg-teal-50 dark:bg-teal-900/30'
                        : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 opacity-50'
                    }`}
                  >
                    <span className="text-sm text-slate-800 dark:text-slate-200">
                      {member.name}
                      {member.id === payerId ? ' (плательщик)' : ''}
                    </span>
                    <span className="text-sm font-medium text-slate-600 dark:text-slate-400">
                      {isSelected && amountMinor > 0 ? formatMinor(share, currency) : '—'}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {mode === 'paid' && (
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
                ? `Итого ${formatMinor(amountMinor, currency)} на ${selected.size} чел.`
                : 'Отметьте участников и введите, кто сколько заплатил'}
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
