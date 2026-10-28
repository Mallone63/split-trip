import { useState, type FormEvent } from 'react';
import { createTrip, type TripBundle } from '../lib/api';
import { CURRENCIES, CURRENCY_CODES, type CurrencyCode } from '../lib/currencies';
import { errorMessage } from '../lib/errors';

interface Props {
  onCreated: (bundle: TripBundle) => void;
}

export default function SetupScreen({ onCreated }: Props) {
  const [name, setName] = useState('');
  const [baseCurrency, setBaseCurrency] = useState<CurrencyCode>('USD');
  const [membersText, setMembersText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seen = new Set<string>();
  const memberNames: string[] = [];
  for (const raw of membersText.split(/\r?\n|,/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    memberNames.push(trimmed);
  }

  const valid = name.trim().length > 0 && memberNames.length >= 2;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!valid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      onCreated(await createTrip(name.trim(), baseCurrency, memberNames));
    } catch (err) {
      setError(errorMessage(err));
      setSubmitting(false);
    }
  }

  const inputClass =
    'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-base focus:border-teal-500 focus:outline-none';

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Start your trip</h1>
        <p className="mt-1 text-sm text-slate-500">
          You&rsquo;ll get a shareable link — anyone who opens it can add expenses.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4 rounded-2xl bg-white p-4 shadow-sm">
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Trip name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Japan 2026"
            className={inputClass}
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium text-slate-700">Settlement currency</span>
          <select
            value={baseCurrency}
            onChange={(e) => setBaseCurrency(e.target.value as CurrencyCode)}
            className={`${inputClass} bg-white`}
          >
            {CURRENCY_CODES.map((code) => (
              <option key={code} value={code}>
                {code} {CURRENCIES[code].symbol} — balances shown in {code}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-slate-500">
            Expenses can be paid in any currency; they are converted to this one for balances.
          </span>
        </label>

        <label className="block">
          <span className="text-sm font-medium text-slate-700">Who&rsquo;s on the trip?</span>
          <textarea
            value={membersText}
            onChange={(e) => setMembersText(e.target.value)}
            rows={4}
            placeholder={'Ana\nBen\nCarl'}
            className={inputClass}
          />
          <span className="mt-1 block text-xs text-slate-500">
            One name per line (or comma-separated). You can add more people later.
          </span>
        </label>

        {error && <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}

        <button
          type="submit"
          disabled={!valid || submitting}
          className="w-full rounded-lg bg-teal-600 py-3 text-base font-semibold text-white shadow disabled:opacity-40"
        >
          {submitting ? 'Creating…' : 'Create trip'}
        </button>
      </form>
    </div>
  );
}
