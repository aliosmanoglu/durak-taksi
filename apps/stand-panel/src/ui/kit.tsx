import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { useStore } from '../store';

type Variant = 'primary' | 'secondary' | 'danger' | 'success' | 'ghost';
type Size = 'md' | 'lg';

const variants: Record<Variant, string> = {
  primary: 'bg-blue-700 text-white hover:bg-blue-800 disabled:bg-slate-400 dark:disabled:bg-slate-600',
  success: 'bg-emerald-700 text-white hover:bg-emerald-800 disabled:bg-slate-400 dark:disabled:bg-slate-600',
  secondary:
    'bg-white text-slate-900 border-2 border-slate-400 hover:bg-slate-100 disabled:opacity-50 dark:bg-slate-800 dark:text-slate-100 dark:border-slate-500 dark:hover:bg-slate-700',
  danger:
    'bg-white text-red-800 border-2 border-red-700 hover:bg-red-50 disabled:opacity-50 dark:bg-slate-800 dark:text-red-300 dark:border-red-500 dark:hover:bg-slate-700',
  ghost: 'bg-transparent text-blue-800 underline hover:bg-slate-200 disabled:opacity-50 dark:text-blue-300 dark:hover:bg-slate-700',
};

/** Dokunma hedefleri: md >= 56 px, lg (birincil) >= 72 px. */
export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      type="button"
      {...rest}
      className={`rounded-xl px-5 font-bold ${size === 'lg' ? 'min-h-[72px] text-xl' : 'min-h-[56px] text-lg'} disabled:cursor-not-allowed ${variants[variant]} ${className}`}
    />
  );
}

export function Chip({
  active,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      {...rest}
      className={`min-h-[56px] rounded-full border-2 px-4 text-lg font-semibold ${
        active
          ? 'border-blue-700 bg-blue-700 text-white'
          : 'border-slate-400 bg-white text-slate-900 dark:border-slate-500 dark:bg-slate-800 dark:text-slate-100'
      } disabled:opacity-50`}
    >
      {children}
    </button>
  );
}

export function Banner({
  tone,
  children,
  role,
}: {
  tone: 'info' | 'warn' | 'error' | 'alert';
  children: ReactNode;
  role?: 'alert' | 'status';
}) {
  const cls = {
    info: 'bg-blue-100 text-blue-950 border-blue-700',
    warn: 'bg-yellow-100 text-yellow-950 border-yellow-700',
    alert: 'bg-orange-100 text-orange-950 border-orange-700',
    error: 'bg-red-100 text-red-950 border-red-700',
  }[tone];
  return (
    <div role={role} className={`rounded-lg border-l-8 px-4 py-3 font-semibold ${cls}`}>
      {children}
    </div>
  );
}

/** Odak tuzaklı, Esc ile kapanan, dışına dokunmayla kapanan diyalog. `data-autofocus` öğesi (VAZGEÇ) ilk odağı alır. */
export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const prev = document.activeElement as HTMLElement | null;
    const first = el.querySelector<HTMLElement>('[data-autofocus]') ?? el;
    first.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = [...el.querySelectorAll<HTMLElement>('button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])')].filter(
        (n) => !n.hasAttribute('disabled'),
      );
      if (items.length === 0) return;
      const a = document.activeElement;
      if (e.shiftKey && (a === items[0] || a === el)) {
        e.preventDefault();
        items[items.length - 1]?.focus();
      } else if (!e.shiftKey && a === items[items.length - 1]) {
        e.preventDefault();
        items[0]?.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/60 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="w-full max-w-lg rounded-2xl bg-white p-6 text-slate-900 shadow-2xl dark:bg-slate-800 dark:text-slate-100"
      >
        <h2 className="mb-3 text-2xl font-extrabold">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const announcement = useStore((s) => s.announcement);
  return (
    <>
      <div aria-live="polite" className="pointer-events-none fixed bottom-4 left-1/2 z-[3000] flex -translate-x-1/2 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`rounded-xl px-5 py-3 text-lg font-semibold shadow-lg ${
              t.tone === 'error' ? 'bg-red-700 text-white' : t.tone === 'warn' ? 'bg-yellow-300 text-yellow-950' : 'bg-slate-900 text-white'
            }`}
          >
            {t.text}
          </div>
        ))}
      </div>
      {/* Yalnızca eşleşme / şoför vazgeçti / hatırlatma duyurulur (Bölüm 3.8). */}
      <div aria-live="assertive" className="sr-only" key={announcement?.id}>
        {announcement?.text}
      </div>
    </>
  );
}
