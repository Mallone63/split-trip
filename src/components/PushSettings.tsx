import { useEffect, useState } from 'react';
import {
  DEFAULT_PUSH_PREFERENCES,
  disablePush,
  enablePush,
  preparePush,
  pushState,
  pushSupport,
  dismissPushPrompt,
  pushPromptDismissed,
  type PushPreferences,
} from '../lib/push';

export default function PushSettings({
  tripId,
  memberId,
  prompt = false,
  onSelectMe,
}: {
  tripId: string;
  memberId: string | null;
  prompt?: boolean;
  onSelectMe?: () => void;
}) {
  const [enabled, setEnabled] = useState(false),
    [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false);
  const [prefs, setPrefs] = useState<PushPreferences>({
    ...DEFAULT_PUSH_PREFERENCES,
  });
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [dismissed, setDismissed] = useState(() => pushPromptDismissed(tripId, memberId));
  const problem = pushSupport();
  useEffect(() => {
    let active = true;
    setReady(false);
    setError(null);
    if (prompt && pushPromptDismissed(tripId, memberId)) {
      setDismissed(true);
      return;
    }
    setChecked(Boolean(problem));
    if (!problem) {
      void pushState(tripId, memberId)
        .then((s) => {
          if (active) {
            setEnabled(s.enabled);
            setPrefs(s.preferences);
            setChecked(true);
          }
        })
        .catch(() => { if (active) setChecked(true); });
      void preparePush()
        .then(() => {
          if (active) setReady(true);
        })
        .catch(() => {
          if (active)
            setError('Сервис уведомлений пока недоступен. Попробуй позже.');
        });
    }
    return () => {
      active = false;
    };
  }, [tripId, memberId, problem, prompt]);
  async function toggle() {
    if (!memberId) return;
    setBusy(true);
    setError(null);
    try {
      if (enabled) await disablePush();
      else await enablePush(tripId, memberId, prefs);
      setEnabled(!enabled);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Не удалось изменить уведомления',
      );
    } finally {
      setBusy(false);
    }
  }
  async function change(key: keyof PushPreferences, value: boolean) {
    const next = { ...prefs, [key]: value };
    if (!enabled) {
      setPrefs(next);
      return;
    }
    if (!memberId) return;
    setBusy(true);
    setError(null);
    try {
      await enablePush(tripId, memberId, next);
      setPrefs(next);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Не удалось сохранить настройки',
      );
    } finally {
      setBusy(false);
    }
  }
  if (prompt) {
    if (dismissed || enabled || !checked) return null;
    return (
      <section aria-label="Включение уведомлений" className="mb-4 rounded-xl border border-teal-200 dark:border-teal-800 bg-teal-50 dark:bg-teal-950/40 p-3">
        <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">Включить уведомления?</p>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          {problem ?? (!memberId ? 'Выбери себя, чтобы получать уведомления о своих расходах и долгах.' : 'Расходы, погашения и напоминания о твоих долгах.')}
        </p>
        <div className="mt-2 flex gap-2">
          {!problem && (
            <button type="button" disabled={busy || (!!memberId && !ready)}
              onClick={() => memberId ? void toggle() : onSelectMe?.()}
              className="min-h-11 rounded-lg bg-teal-600 px-4 text-sm font-semibold text-white disabled:opacity-40">
              {busy ? 'Включаю…' : memberId ? 'Включить' : 'Выбрать себя'}
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => {
            dismissPushPrompt(tripId, memberId);
            setDismissed(true);
          }} className="min-h-11 rounded-lg px-3 text-sm text-slate-600 dark:text-slate-400">Позже</button>
        </div>
        {error && <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
      </section>
    );
  }
  return (
    <section className="rounded-2xl bg-white dark:bg-slate-900 p-4 shadow-sm">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Уведомления
      </h2>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
        {problem ??
          (!memberId
            ? 'Сначала выбери себя среди участников.'
            : enabled
              ? 'Включены на этом устройстве'
              : 'Получай изменения по своим расходам и долгам.')}
      </p>
      {!problem && memberId && (
        <>
          <div className="mt-2 space-y-1">
            {(
              [
                ['expenses', 'Расходы'],
                ['settlements', 'Погашения и смена валюты долга'],
                ['reminders', 'Напоминания о долгах'],
              ] as const
            ).map(([key, label]) => (
              <label
                key={key}
                className="flex min-h-11 items-center gap-3 text-sm text-slate-700 dark:text-slate-300"
              >
                <input
                  type="checkbox"
                  checked={prefs[key]}
                  disabled={busy}
                  onChange={(e) => void change(key, e.target.checked)}
                  className="h-5 w-5 accent-teal-600"
                />
                {label}
              </label>
            ))}
          </div>
          <button
            type="button"
            disabled={busy || (!ready && !enabled)}
            onClick={() => void toggle()}
            className="mt-3 w-full rounded-lg bg-teal-600 py-2.5 text-sm font-semibold text-white disabled:opacity-40"
          >
            {busy
              ? 'Сохраняю…'
              : enabled
                ? 'Отключить на этом устройстве'
                : 'Включить уведомления'}
          </button>
        </>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </section>
  );
}
