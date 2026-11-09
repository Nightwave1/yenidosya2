import { DateTime } from 'luxon'
import { subtractIntervals, type Interval } from './interval'

/**
 * Availability engine — the pure core of the booking system.
 *
 * Given a business day (tenant-local), staff schedules, existing busy time
 * (appointments *including buffer*, instant blocks) it emits the bookable slot
 * grid. Everything here is deterministic; the caller injects `nowMs`.
 *
 * Wall-clock rules (open/close/break) are interpreted in the tenant timezone;
 * the slot grid is anchored at local midnight so day-level UIs stay stable.
 */
export interface BusinessDayInput {
  isClosed: boolean
  openTime?: string | null // 'HH:mm' tenant-local
  closeTime?: string | null
  breakStart?: string | null
  breakEnd?: string | null
}

export interface StaffWorkingDay {
  startTime: string
  endTime: string
  breakStart?: string | null
  breakEnd?: string | null
}

export interface StaffInput {
  staffId: string
  /** null => off duty that weekday */
  working: StaffWorkingDay | null
  /** staff-scoped busy time: active appointments (ends_at already includes buffer) + staff blocks */
  busy: Interval[]
}

export interface ComputeInput {
  timezone: string // IANA
  date: string // yyyy-MM-dd in tenant-local calendar
  businessHours: BusinessDayInput
  staff: StaffInput[]
  /** tenant-wide blocks (schedule_blocks.staff_id IS NULL) */
  busyTenantWide: Interval[]
  service: { durationMin: number; bufferAfterMin: number }
  rules: { slotGranularityMin: number; minNoticeMinutes: number }
  nowMs?: number // injectable clock for tests
}

export interface StaffSlots {
  staffId: string
  slotsMs: number[]
}

export interface ComputeResult {
  isClosed: boolean
  staff: StaffSlots[]
  anyStaffSlotsMs: number[]
  openMs: number | null
  closeMs: number | null
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** Local wall-clock → epoch ms; null when invalid/nonexistent (e.g. DST gaps). */
export function localToMs(tz: string, date: string, time: string): number | null {
  const [h, m] = time.split(':').map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || h > 23 || m < 0 || m > 59) return null
  const dt = DateTime.fromISO(`${date}T${pad2(h)}:${pad2(m)}`, { zone: tz })
  return dt.isValid ? dt.toMillis() : null
}

function cutInterval(
  tz: string,
  date: string,
  start?: string | null,
  end?: string | null,
): Interval | null {
  if (!start || !end) return null
  const s = localToMs(tz, date, start)
  const e = localToMs(tz, date, end)
  if (s == null || e == null || e <= s) return null
  return { start: s, end: e }
}

export function computeDaySlots(input: ComputeInput): ComputeResult {
  const nowMs = input.nowMs ?? Date.now()

  if (input.businessHours.isClosed) {
    return {
      isClosed: true,
      staff: input.staff.map((s) => ({ staffId: s.staffId, slotsMs: [] })),
      anyStaffSlotsMs: [],
      openMs: null,
      closeMs: null,
    }
  }

  const openMs = input.businessHours.openTime
    ? localToMs(input.timezone, input.date, input.businessHours.openTime)
    : null
  const closeMs = input.businessHours.closeTime
    ? localToMs(input.timezone, input.date, input.businessHours.closeTime)
    : null

  if (openMs == null || closeMs == null || closeMs <= openMs) {
    // configured closed / misconfigured hours -> no slots but not "closed day" semantics
    return {
      isClosed: false,
      staff: input.staff.map((s) => ({ staffId: s.staffId, slotsMs: [] })),
      anyStaffSlotsMs: [],
      openMs,
      closeMs,
    }
  }

  const tenantBreakCut = cutInterval(
    input.timezone,
    input.date,
    input.businessHours.breakStart,
    input.businessHours.breakEnd,
  )

  const stepMs = Math.max(1, input.rules.slotGranularityMin) * 60_000
  const serviceBusyMs = (input.service.durationMin + input.service.bufferAfterMin) * 60_000
  const minStartMs = nowMs + Math.max(0, input.rules.minNoticeMinutes) * 60_000
  // Grid is anchored at local midnight for stable day UIs:
  const gridAnchor = DateTime.fromISO(`${input.date}T00:00`, { zone: input.timezone }).toMillis()

  const union = new Set<number>()
  const staffOut: StaffSlots[] = []

  for (const member of input.staff) {
    const slots: number[] = []
    if (member.working) {
      const sOpen = localToMs(input.timezone, input.date, member.working.startTime)
      const sClose = localToMs(input.timezone, input.date, member.working.endTime)

      if (sOpen != null && sClose != null && sClose > sOpen) {
        // staff window cannot escape tenant window
        const windowStart = Math.max(openMs, sOpen)
        const windowEnd = Math.min(closeMs, sClose)

        if (windowEnd > windowStart) {
          const cuts: Interval[] = []
          if (tenantBreakCut) cuts.push(tenantBreakCut)
          const staffBreakCut = cutInterval(
            input.timezone,
            input.date,
            member.working.breakStart,
            member.working.breakEnd,
          )
          if (staffBreakCut) cuts.push(staffBreakCut)
          cuts.push(...member.busy)
          cuts.push(...input.busyTenantWide)

          const free = subtractIntervals({ start: windowStart, end: windowEnd }, cuts)
          for (const freeRange of free) {
            let candidate = gridAnchor + Math.ceil((freeRange.start - gridAnchor) / stepMs) * stepMs
            while (candidate + serviceBusyMs <= freeRange.end) {
              if (candidate >= minStartMs) {
                slots.push(candidate)
                union.add(candidate)
              }
              candidate += stepMs
            }
          }
        }
      }
    }
    staffOut.push({ staffId: member.staffId, slotsMs: slots })
  }

  return {
    isClosed: false,
    staff: staffOut,
    anyStaffSlotsMs: [...union].sort((a, b) => a - b),
    openMs,
    closeMs,
  }
}
