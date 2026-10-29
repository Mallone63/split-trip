export type Tab = 'balances' | 'expenses' | 'invite';

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'balances', label: 'Балансы', icon: '⚖️' },
  { id: 'expenses', label: 'Расходы', icon: '🧾' },
  { id: 'invite', label: 'Управление', icon: '⚙️' },
];

interface Props {
  active: Tab;
  onChange: (tab: Tab) => void;
}

export default function TabBar({ active, onChange }: Props) {
  return (
    <nav className="pb-safe fixed inset-x-0 bottom-0 border-t border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/95 backdrop-blur">
      <div className="mx-auto flex max-w-md">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-xs ${
              active === tab.id ? 'font-semibold text-teal-700 dark:text-teal-300' : 'text-slate-500 dark:text-slate-400'
            }`}
          >
            <span aria-hidden className="text-lg leading-none">
              {tab.icon}
            </span>
            {tab.label}
          </button>
        ))}
      </div>
    </nav>
  );
}
