import { describe, expect, it } from 'vitest'
import { computeDaySlots, type ComputeInput } from './engine'

/**
 * Deterministic tests on Europe/Istanbul (UTC+3, no DST) for 2026-11-10 (Tuesday).
 * local 09:00 = 06:00Z; busy intervals are given in UTC ms like the schema stores.
 */
const TZ = 'Europe/Istanbul'
const DATE = '2026-11-10'

/** local wall-clock (İST) → epoch ms on the test date */
const ist = (h: number, m = 0): number => Date.UTC(2026, 10, 10, h - 3, m)
const isoZ = (ms: number): string => new Date(ms).toISOString()

const SERVICE = { durationMin: 30, bufferAfterMin: 10 } // busy = 40 min per slot
const RULES = { slotGranularityMin: 15, minNoticeMinutes: 30 }
// "today 09:00 İST" => minNotice pushes first bookable slot to 09:30 İST
const NOW = ist(9)

function baseInput(overrides: Partial<ComputeInput> = {}): ComputeInput {
  return {
    timezone: TZ,
    date: DATE,
    businessHours: { isClosed: false, openTime: '09:00', closeTime: '21:00' },
    staff: [{ staffId: 's1', working: { startTime: '09:00', endTime: '21:00' }, busy: [] }],
    busyTenantWide: [],
    service: SERVICE,
    rules: RULES,
    nowMs: NOW,
    ...overrides,
  }
}

describe('computeDaySlots', () => {
  it('generates the full grid on a free day (44 slots, 09:30–20:15 İST)', () => {
    const result = computeDaySlots(baseInput())
    const slots = result.staff[0]!.slotsMs
    expect(slots.length).toBe(44)
    expect(isoZ(slots[0]!)).toBe('2026-11-10T06:30:00.000Z') // 09:30 İST (min_notice)
    expect(isoZ(slots.at(-1)!)).toBe('2026-11-10T17:15:00.000Z') // 20:15 İST (last fitting +buffer)
    expect(result.anyStaffSlotsMs).toEqual(slots)
    expect(result.openMs).toBe(ist(9))
    expect(result.closeMs).toBe(ist(21))
  })

  it('subtracts an appointment (busy window includes duration+buffer)', () => {
    // an existing 12:00–12:50 appointment stored with buffer as busy [12:00, 12:55)
    const result = computeDaySlots(
      baseInput({
        staff: [{ staffId: 's1', working: { startTime: '09:00', endTime: '21:00' }, busy: [{ start: ist(12), end: ist(12, 55) }] }],
      }),
    )
    const slots = result.staff[0]!.slotsMs
    expect(slots.length).toBe(38) // 44 − 6 overlapping candidates
    const mins = new Set(slots)
    expect(mins.has(ist(11, 15))).toBe(true) // 11:15–11:55 fits before the appointment
    expect(mins.has(ist(11, 30))).toBe(false) // crosses 12:00
    expect(mins.has(ist(12, 45))).toBe(false) // crosses busy edge 12:55
    expect(mins.has(ist(13, 0))).toBe(true) // first clean slot after
  })

  it('honors a tenant-wide block instantly (14:00–15:00 closed off)', () => {
    const result = computeDaySlots(
      baseInput({ busyTenantWide: [{ start: ist(14), end: ist(15) }] }),
    )
    const slots = new Set(result.staff[0]!.slotsMs)
    expect(result.staff[0]!.slotsMs.length).toBe(38)
    expect(slots.has(ist(13, 15))).toBe(true) // 13:15+40 = 13:55 ≤ 14:00
    expect(slots.has(ist(13, 30))).toBe(false) // crosses the block
    expect(slots.has(ist(14, 45))).toBe(false)
    expect(slots.has(ist(15, 0))).toBe(true) // clean after the block
  })

  it('respects the weekly closed-day toggle', () => {
    const result = computeDaySlots(
      baseInput({ businessHours: { isClosed: true } }),
    )
    expect(result.isClosed).toBe(true)
    expect(result.staff[0]!.slotsMs).toEqual([])
    expect(result.anyStaffSlotsMs).toEqual([])
  })

  it('unions slots across staff for "any staff" and excludes off-duty staff', () => {
    const result = computeDaySlots(
      baseInput({
        staff: [
          { staffId: 'a', working: { startTime: '09:00', endTime: '21:00' }, busy: [] },
          { staffId: 'b', working: null, busy: [] }, // off duty
        ],
      }),
    )
    expect(result.staff.find((s) => s.staffId === 'a')!.slotsMs.length).toBe(44)
    expect(result.staff.find((s) => s.staffId === 'b')!.slotsMs).toEqual([])
    expect(result.anyStaffSlotsMs.length).toBe(44)
  })

  it('merges partial-shift staff into the union and clamps to tenant hours', () => {
    const result = computeDaySlots(
      baseInput({
        staff: [
          { staffId: 'a', working: { startTime: '09:00', endTime: '21:00' }, busy: [] },
          { staffId: 'b', working: { startTime: '10:00', endTime: '14:00' }, busy: [] },
        ],
      }),
    )
    const b = result.staff.find((s) => s.staffId === 'b')!.slotsMs
    expect(b.length).toBe(14) // 10:00 .. 13:15 İST
    expect(isoZ(b[0]!)).toBe('2026-11-10T07:00:00.000Z')
    // union stays the full-day grid (b ⊂ a)
    expect(result.anyStaffSlotsMs).toEqual(result.staff.find((s) => s.staffId === 'a')!.slotsMs)

    // starts before opening => clamped
    const clamped = computeDaySlots(
      baseInput({
        staff: [{ staffId: 'c', working: { startTime: '08:00', endTime: '23:00' }, busy: [] }],
      }),
    )
    expect(clamped.staff[0]!.slotsMs.length).toBe(44)
  })

  it('moves the first slot with the minimum-notice rule as time advances', () => {
    const result = computeDaySlots(baseInput({ nowMs: ist(10) }))
    const slots = result.staff[0]!.slotsMs
    expect(slots.length).toBe(40)
    expect(isoZ(slots[0]!)).toBe('2026-11-10T07:30:00.000Z') // 10:30 İST
  })

  it('cuts the tenant-wide break window', () => {
    const result = computeDaySlots(
      baseInput({ businessHours: { isClosed: false, openTime: '09:00', closeTime: '21:00', breakStart: '13:00', breakEnd: '13:30' } }),
    )
    const slots = new Set(result.staff[0]!.slotsMs)
    expect(result.staff[0]!.slotsMs.length).toBe(40)
    expect(slots.has(ist(12, 15))).toBe(true)
    expect(slots.has(ist(12, 30))).toBe(false) // crosses 13:00
    expect(slots.has(ist(13, 30))).toBe(true) // clean after break
  })

  it('aligns the first candidate to the grid when staff shifts start off-grid', () => {
    // clock before the notice window so alignment isn't masked by min_notice
    const result = computeDaySlots(
      baseInput({
        staff: [{ staffId: 's1', working: { startTime: '09:10', endTime: '21:00' }, busy: [] }],
        nowMs: ist(8),
      }),
    )
    expect(isoZ(result.staff[0]!.slotsMs[0]!)).toBe('2026-11-10T06:15:00.000Z') // 09:15 İST
  })
})
