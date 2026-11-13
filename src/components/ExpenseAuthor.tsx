import { useEffect, useId, useRef, useState } from 'react';

/** Only mounted for the author in an expanded expense. */
export default function ExpenseAuthor({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const tooltipId = useId();

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => setOpen(false), 2000);
    const outside = (event: PointerEvent) => {
      if (!anchor.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <span ref={anchor} className="relative inline-block max-w-full align-top">
      <button
        type="button"
        aria-label={`${name} — автор расхода`}
        aria-describedby={open ? tooltipId : undefined}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex max-w-full items-center gap-1.5 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-teal-600 dark:focus-visible:outline-teal-300"
      >
        <span className="min-w-0 break-words">{name}</span>
        <span aria-hidden="true" className="h-[5px] w-[5px] shrink-0 rounded-full bg-teal-600 dark:bg-teal-300" />
      </button>
      {open && (
        <span
          id={tooltipId}
          role="tooltip"
          className="absolute bottom-full left-0 z-20 mb-1 whitespace-nowrap rounded-lg bg-slate-800 px-2 py-1 text-xs font-normal text-white shadow-md dark:bg-slate-200 dark:text-slate-900"
        >
          Добавил расход
        </span>
      )}
    </span>
  );
}
