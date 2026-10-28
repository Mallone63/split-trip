import { useEffect, useState, type FormEvent } from 'react';
import { toDataURL } from 'qrcode';
import type { Member } from '../lib/types';

interface Props {
  tripId: string;
  members: Member[];
  meId: string | null;
  onSetMe: (memberId: string | null) => void;
  onAddMember: (name: string) => Promise<Member>;
  onLinkWallet: (memberIds: string[]) => Promise<void>;
  onUnlinkWallet: (unit: string) => Promise<void>;
}

export default function InviteTab({
  tripId,
  members,
  meId,
  onSetMe,
  onAddMember,
  onLinkWallet,
  onUnlinkWallet,
}: Props) {
  const shareUrl = `${window.location.origin}${window.location.pathname}?trip=${tripId}`;
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    let active = true;
    toDataURL(shareUrl, { width: 240, margin: 1 })
      .then((url) => {
        if (active) setQrUrl(url);
      })
      .catch(() => {
        if (active) setQrUrl(null);
      });
    return () => {
      active = false;
    };
  }, [shareUrl]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt('Скопируйте ссылку:', shareUrl);
    }
  }

  async function handleAdd(event: FormEvent) {
    event.preventDefault();
    const name = newName.trim();
    if (!name || adding) return;
    setAdding(true);
    setError(null);
    try {
      await onAddMember(name);
      setNewName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  }

  function toggleSelected(memberId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(memberId)) next.delete(memberId);
      else next.add(memberId);
      return next;
    });
  }

  async function handleLink() {
    if (selected.size < 2) return;
    try {
      await onLinkWallet([...selected]);
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleUnlink(unit: string) {
    try {
      await onUnlinkWallet(unit);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const units = [...new Set(members.filter((m) => m.unit).map((m) => m.unit as string))];
  const singles = members.filter((m) => !m.unit);

  return (
    <div className="space-y-4">
      <section className="rounded-2xl bg-white p-4 text-center shadow-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Пригласить компанию
        </h2>
        <p className="mt-1 text-xs text-slate-400">
          Любой, кто откроет ссылку, может смотреть и добавлять расходы.
        </p>
        {qrUrl && (
          <img
            src={qrUrl}
            alt="QR-код приглашения"
            width={200}
            height={200}
            className="mx-auto mt-3 rounded-lg"
          />
        )}
        <p className="mt-3 break-all rounded-lg bg-slate-50 p-2 text-xs text-slate-500">
          {shareUrl}
        </p>
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="mt-3 w-full rounded-lg bg-teal-600 py-2.5 text-sm font-semibold text-white"
        >
          {copied ? 'Скопировано!' : 'Скопировать ссылку'}
        </button>
      </section>

      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Участники
        </h2>
        <ul className="divide-y divide-slate-100">
          {members.map((member) => (
            <li key={member.id}>
              <button
                type="button"
                onClick={() => onSetMe(meId === member.id ? null : member.id)}
                className="flex w-full items-center justify-between py-2.5 text-left"
              >
                <span className="text-base text-slate-800">{member.name}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                    meId === member.id ? 'bg-teal-100 text-teal-700' : 'bg-slate-100 text-slate-400'
                  }`}
                >
                  {meId === member.id ? 'это вы' : 'нажмите — это вы'}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <form onSubmit={handleAdd} className="mt-3 flex gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Добавить человека…"
            className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={!newName.trim() || adding}
            className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
          >
            {adding ? '…' : 'Добавить'}
          </button>
        </form>
        <p className="mt-2 text-xs text-slate-400">
          «Это вы» — новые расходы по умолчанию будут от вашего имени.
        </p>
      </section>

      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Общий бюджет
        </h2>
        <p className="text-xs text-slate-400">
          Для пары или компании с общими деньгами: траты делятся по людям, но баланс и расчёты
          считаются на весь кошелёк.
        </p>

        {units.length > 0 && (
          <ul className="mt-3 space-y-2">
            {units.map((unit) => {
              const names = members
                .filter((m) => m.unit === unit)
                .map((m) => m.name)
                .join(' + ');
              return (
                <li
                  key={unit}
                  className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2"
                >
                  <span className="text-sm font-medium text-slate-800">{names}</span>
                  <button
                    type="button"
                    onClick={() => {
                      if (!window.confirm(`Разъединить кошелёк «${names}»?`)) return;
                      void handleUnlink(unit);
                    }}
                    className="text-xs font-medium text-red-500"
                  >
                    Разъединить
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {singles.length >= 2 && (
          <div className="mt-3">
            <p className="mb-1 text-xs text-slate-500">Отметьте, кто делит один кошелёк:</p>
            <ul className="space-y-1">
              {singles.map((member) => {
                const isSelected = selected.has(member.id);
                return (
                  <li key={member.id}>
                    <button
                      type="button"
                      onClick={() => toggleSelected(member.id)}
                      className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left ${
                        isSelected ? 'border-teal-300 bg-teal-50' : 'border-slate-200 bg-white'
                      }`}
                    >
                      <span className="text-sm text-slate-800">{member.name}</span>
                      <span
                        className={`text-xs font-semibold ${
                          isSelected ? 'text-teal-700' : 'text-slate-300'
                        }`}
                      >
                        {isSelected ? '✓' : '+'}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <button
              type="button"
              disabled={selected.size < 2}
              onClick={() => void handleLink()}
              className="mt-2 w-full rounded-lg bg-slate-800 py-2 text-sm font-semibold text-white disabled:opacity-40"
            >
              Общий кошелёк ({selected.size})
            </button>
          </div>
        )}
        {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
      </section>
    </div>
  );
}
