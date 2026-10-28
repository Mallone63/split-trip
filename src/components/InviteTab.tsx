import { useEffect, useState, type FormEvent } from 'react';
import { toDataURL } from 'qrcode';
import type { Member } from '../lib/types';

interface Props {
  tripId: string;
  members: Member[];
  meId: string | null;
  onSetMe: (memberId: string | null) => void;
  onAddMember: (name: string) => Promise<Member>;
}

export default function InviteTab({ tripId, members, meId, onSetMe, onAddMember }: Props) {
  const shareUrl = `${window.location.origin}${window.location.pathname}?trip=${tripId}`;
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      window.prompt('Copy this link:', shareUrl);
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

  return (
    <div className="space-y-4">
      <section className="rounded-2xl bg-white p-4 text-center shadow-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Invite the group
        </h2>
        <p className="mt-1 text-xs text-slate-400">
          Anyone with this link can view and add expenses.
        </p>
        {qrUrl && (
          <img
            src={qrUrl}
            alt="Trip invite QR code"
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
          {copied ? 'Copied!' : 'Copy link'}
        </button>
      </section>

      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Trip members
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
                  {meId === member.id ? 'you' : 'tap to set as you'}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <form onSubmit={handleAdd} className="mt-3 flex gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Add someone…"
            className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={!newName.trim() || adding}
            className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
          >
            {adding ? '…' : 'Add'}
          </button>
        </form>
        {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
        <p className="mt-2 text-xs text-slate-400">
          Setting “you” makes new expenses default to your name.
        </p>
      </section>
    </div>
  );
}
