// ---------------------------------------------------------------------------
// Tenant-timezone-aware formatting + calendar-generation helpers (tr-TR).
// ---------------------------------------------------------------------------

function fmt(options: Intl.DateTimeFormatOptions, timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('tr-TR', { timeZone, ...options })
}

/** Today's date (yyyy-MM-dd) in the tenant timezone — the strip starts here. */
export function todayISO(timeZone: string): string {
  return Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

export function addDaysISO(dateISO: string, days: number): string {
  const d = new Date(`${dateISO}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export function datesRange(timeZone: string, count: number): string[] {
  const start = todayISO(timeZone)
  return Array.from({ length: count }, (_, i) => addDaysISO(start, i))
}

export interface DateChip {
  date: string
  weekday: string
  dayMonth: string
  dayNumber: string
  isToday: boolean
}

/** Chip data for the date strip; noon-UTC anchor keeps the local date stable. */
export function dateChip(dateISO: string, timeZone: string): DateChip {
  const anchor = new Date(`${dateISO}T12:00:00Z`)
  return {
    date: dateISO,
    weekday: Intl.DateTimeFormat('tr-TR', { weekday: 'short' }).format(anchor),
    dayMonth: fmt({ day: 'numeric', month: 'short' }, timeZone).format(anchor),
    dayNumber: fmt({ day: 'numeric' }, timeZone).format(anchor),
    isToday: dateISO === todayISO(timeZone),
  }
}

/** '2026-…T06:30:00.000Z' → '09:30' rendered in the tenant timezone. */
export function slotTime(iso: string, timeZone: string): string {
  return fmt({ hour: '2-digit', minute: '2-digit', hour12: false }, timeZone).format(new Date(iso))
}

/** Human appointment label: '10 Kasım Salı, 09:30' */
export function appointmentWhen(iso: string, timeZone: string): string {
  const value = new Date(iso)
  return fmt(
    { day: 'numeric', month: 'long', weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false },
    timeZone,
  ).format(value)
}

export type SlotGroup = 'Sabah' | 'Öğleden sonra' | 'Akşam'

export function slotGroupOf(labelHHmm: string): SlotGroup {
  const hour = Number(labelHHmm.slice(0, 2))
  if (hour < 12) return 'Sabah'
  if (hour < 17) return 'Öğleden sonra'
  return 'Akşam'
}

export const GROUP_ORDER: SlotGroup[] = ['Sabah', 'Öğleden sonra', 'Akşam']

export function money(amount: number, currency: string): string {
  return new Intl.NumberFormat('tr-TR', { style: 'currency', currency }).format(amount)
}

export function durationLabel(min: number): string {
  return `${min} dk`
}

/** UUID v4 with a Math.random fallback (secure contexts ship randomUUID). */
export function uuidKey(): string {
  const g = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID.bind(crypto)
    : () => {
        const hex = (n: number) =>
          Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('')
        return `${hex(8)}-${hex(4)}-4${hex(3)}-${hex(4)}-${hex(12)}`
      }
  return g()
}

// ---------------------------------------------------------------------------
// ICS (add-to-calendar) generation — runs fully client-side.
// ---------------------------------------------------------------------------

interface IcsInput {
  uid: string
  title: string
  startsAt: string
  endsAt: string
  descriptionUrl: string
}

const icsStamp = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')

export function icsHref(input: IcsInput): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//oleumsrandevu//Randevu//TR',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${input.uid}`,
    `DTSTAMP:${icsStamp(new Date().toISOString())}`,
    `DTSTART:${icsStamp(input.startsAt)}`,
    `DTEND:${icsStamp(input.endsAt)}`,
    `SUMMARY:${input.title}`,
    `DESCRIPTION:${input.descriptionUrl}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ]
  const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' })
  return URL.createObjectURL(blob)
}
