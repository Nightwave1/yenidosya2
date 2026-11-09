import type { ReactNode } from 'react'

// ---------------------------------------------------------------------------
// Tiny shared UI primitives for the booking PWA (dark, amber-accent theme)
// ---------------------------------------------------------------------------

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl bg-slate-900/60 border border-slate-800 ${className}`}>
      {children}
    </div>
  )
}

export function Spinner({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <span
      className={`inline-block animate-spin rounded-full border-2 border-slate-600 border-t-amber-400 ${className}`}
      role="status"
      aria-label="Yükleniyor"
    />
  )
}

export function Banner({
  kind,
  children,
}: {
  kind: 'error' | 'warn' | 'info'
  children: ReactNode
}) {
  const styles = {
    error: 'bg-rose-950/80 border-rose-800 text-rose-200',
    warn: 'bg-amber-950/80 border-amber-700 text-amber-200',
    info: 'bg-slate-900/80 border-slate-700 text-slate-200',
  }[kind]
  return (
    <div className={`mb-3 rounded-xl border px-3 py-2.5 text-sm leading-snug ${styles}`} role="alert">
      {children}
    </div>
  )
}

/** Small avatar bubble for a staff member (initial over their calendar color). */
export function StaffAvatar({ color, initial, size = 'md' }: { color: string; initial: string; size?: 'md' | 'lg' }) {
  const cls = size === 'lg' ? 'h-11 w-11 text-lg' : 'h-9 w-9 text-sm'
  return (
    <span
      className={`inline-flex ${cls} shrink-0 items-center justify-center rounded-full font-bold text-slate-950`}
      style={{ backgroundColor: color }}
    >
      {initial.slice(0, 1).toLocaleUpperCase('tr-TR')}
    </span>
  )
}

const STATUS_LABEL: Record<string, string> = {
  booked: 'Onaylandı',
  in_progress: 'Koltukta',
  completed: 'Tamamlandı',
  no_show: 'Gelmedi',
  cancelled: 'İptal edildi',
}

const STATUS_STYLE: Record<string, string> = {
  booked: 'bg-emerald-500/15 text-emerald-300 border-emerald-700',
  in_progress: 'bg-amber-500/15 text-amber-300 border-amber-700',
  completed: 'bg-slate-500/15 text-slate-300 border-slate-600',
  no_show: 'bg-rose-500/15 text-rose-300 border-rose-700',
  cancelled: 'bg-rose-500/15 text-rose-300 border-rose-700',
}

export function StatusPill({ status }: { status: string }) {
  return (
    <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${STATUS_STYLE[status] ?? STATUS_STYLE.completed}`}>
      {STATUS_LABEL[status] ?? status}
    </span>
  )
}

export function PrimaryButton({
  children,
  onClick,
  disabled,
  className = '',
}: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`w-full rounded-xl bg-amber-400 px-4 py-3 font-bold text-slate-950 transition
        enabled:active:scale-[0.98] disabled:opacity-40 disabled:shadow-none ${className}`}
    >
      {children}
    </button>
  )
}

export function GhostButton({
  children,
  onClick,
  className = '',
}: {
  children: ReactNode
  onClick?: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-xl border border-slate-700 bg-slate-900/60 px-4 py-3 font-semibold text-slate-200
        active:scale-[0.98] ${className}`}
    >
      {children}
    </button>
  )
}
