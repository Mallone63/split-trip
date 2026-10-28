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
import { materializeEqualSplit, sumSplits, validateExactSplit } from '../lib/split';
import type { Member, Split } from '../lib/types';

interface Props {
  members: Member[];
  baseCurrency: CurrencyCode;
  defaultPayerId: string;
  onSubmit: (input: NewExpenseInput) => Promise<void>;
  onCancel: () => void;
}

type SplitMode = 'equal' | 'exact';
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
  const [exactAmounts, setExactAmounts] = useState<Record<string, string>>({});
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

  const amount = parseAmount(amountStr);
  const amountMinor = Number.isFinite(amount) && amount > 0 ? toMinor(amount, currency) : 0;
  const rate = parseAmount(rateStr);
  const rateValid = Number.isFinite(rate) && rate > 0;

  const equalSplits = useMemo(() => {
    if (mode !== 'equal' || amountMinor <= 0 || selected.size === 0) return [];
    const participants = memberOrder.filter((id) => selected.has(id));
    return materializeEqualSplit(amountMinor, participants, payerId);
  }, [mode, amountMinor, selected, memberOrder, payerId]);

  const exactSplits = useMemo(() => {
    if (mode !== 'exact') return [];
    return memberOrder.flatMap((id) => {
      const value = parseAmount(exactAmounts[id] ?? '');
      return Number.isFinite(value) && value > 0
        ? [{ memberId: id, amountMinor: toMinor(value, currency) }]
        : [];
    });
  }, [mode, memberOrder, exactAmounts, currency]);

  const splits: Split[] = mode === 'equal' ? equalSplits : exactSplits;
  const exactCheck = mode === 'exact' ? validateExactSplit(splits, amountMinor) : null;
  const splitValid = mode === 'equal' ? splits.length > 0 : exactCheck?.ok === true;
  const canSave =
    title.trim().length > 0 && amountMinor > 0 && rateValid && splitValid && !submitting;

  function toggleMember(memberId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(memberId)) next.delete(memberId);
      else next.add(memberId);
      return next;
    });
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
        payerId,
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
    'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-base focus:border-teal-500 focus:outline-none';

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          New expense
        </h2>
        <button type="button" onClick={onCancel} className="text-sm font-medium text-slate-500">
          Cancel
        </button>
      </div>

      <div className="space-y-4 rounded-2xl bg-white p-4 shadow-sm">
        <label className="block">
          <span className="text-sm font-medium text-slate-700">What was it for?</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Ramen dinner"
            className={inputClass}
          />
        </label>

        <div className="flex gap-2">
          <label className="block min-w-0 flex-1">
            <span className="text-sm font-medium text-slate-700">Amount</span>
            <input
              value={amountStr}
              onChange={(e) => setAmountStr(e.target.value)}
              inputMode="decimal"
              placeholder={CURRENCIES[currency].symbol}
              className={inputClass}
            />
          </label>
          <label className="block w-32 shrink-0">
            <span className="text-sm font-medium text-slate-700">Currency</span>
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value as CurrencyCode)}
              className={`${inputClass} bg-white`}
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
            <span className="text-sm font-medium text-slate-700">Paid by</span>
            <select
              value={payerId}
              onChange={(e) => setPayerId(e.target.value)}
              className={`${inputClass} bg-white`}
            >
              {members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block min-w-0 flex-1">
            <span className="text-sm font-medium text-slate-700">Date</span>
            <input
              type="date"
              value={spentAt}
              onChange={(e) => setSpentAt(e.target.value)}
              className={inputClass}
            />
          </label>
        </div>

        <label className="block">
          <span className="text-sm font-medium text-slate-700">Rate to {baseCurrency}</span>
          {currency === baseCurrency ? (
            <input value="1" disabled className={`${inputClass} bg-slate-100 text-slate-400`} />
          ) : (
            <>
              <input
                value={rateStr}
                onChange={(e) => setRateStr(e.target.value)}
                inputMode="decimal"
                placeholder={`1 ${currency} = ? ${baseCurrency}`}
                className={inputClass}
              />
              <span className="mt-1 block text-xs text-slate-400">
                {rateStatus === 'loading' && 'Fetching today’s rate…'}
                {rateStatus === 'ready' &&
                  `Today’s market rate: 1 ${currency} = ${rateStr} ${baseCurrency}. Enter your bank’s real rate if it differs.`}
                {rateStatus === 'unavailable' && 'No internet — enter the rate manually.'}
              </span>
            </>
          )}
        </label>
      </div>

      <div className="rounded-2xl bg-white p-4 shadow-sm">
        <div className="mb-3 flex rounded-lg bg-slate-100 p-1 text-sm font-medium">
          {(['equal', 'exact'] as SplitMode[]).map((modeOption) => (
            <button
              key={modeOption}
              type="button"
              onClick={() => setMode(modeOption)}
              className={`flex-1 rounded-md py-1.5 ${
                mode === modeOption ? 'bg-white text-teal-700 shadow' : 'text-slate-500'
              }`}
            >
              {modeOption === 'equal' ? 'Split equally' : 'Exact amounts'}
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
                        ? 'border-teal-300 bg-teal-50'
                        : 'border-slate-200 bg-white opacity-50'
                    }`}
                  >
                    <span className="text-sm text-slate-800">
                      {member.name}
                      {member.id === payerId ? ' (payer)' : ''}
                    </span>
                    <span className="text-sm font-medium text-slate-600">
                      {isSelected && amountMinor > 0 ? formatMinor(share, currency) : '—'}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {mode === 'exact' && (
          <div className="space-y-2">
            {members.map((member) => (
              <label key={member.id} className="flex items-center gap-3">
                <span className="w-24 shrink-0 truncate text-sm text-slate-800">{member.name}</span>
                <input
                  value={exactAmounts[member.id] ?? ''}
                  onChange={(e) =>
                    setExactAmounts((prev) => ({ ...prev, [member.id]: e.target.value }))
                  }
                  inputMode="decimal"
                  placeholder="0"
                  className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-right text-sm focus:border-teal-500 focus:outline-none"
                />
              </label>
            ))}
            <p
              className={`text-right text-xs font-medium ${
                amountMinor > 0 && sumSplits(exactSplits) === amountMinor
                  ? 'text-emerald-600'
                  : 'text-red-500'
              }`}
            >
              {formatMinor(sumSplits(exactSplits), currency)} of {formatMinor(amountMinor, currency)}
            </p>
            {exactCheck && !exactCheck.ok && amountMinor > 0 && (
              <p className="text-xs text-red-500">{exactCheck.error}</p>
            )}
          </div>
        )}
      </div>

      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      <button
        type="submit"
        disabled={!canSave}
        className="w-full rounded-xl bg-teal-600 py-3 text-base font-semibold text-white shadow disabled:opacity-40"
      >
        {submitting ? 'Saving…' : 'Save expense'}
      </button>
    </form>
  );
}

