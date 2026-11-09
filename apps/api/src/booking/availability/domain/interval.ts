/**
 * Pure half-open interval math on epoch milliseconds.
 * Booking windows/business rules live here only — no I/O, no clock.
 */
export interface Interval {
  start: number // inclusive
  end: number // exclusive
}

/** Removes every cut from `base`, returning the remaining free intervals (sorted, non-overlapping). */
export function subtractIntervals(base: Interval, cuts: Interval[]): Interval[] {
  let out: Interval[] = [base]
  const sorted = [...cuts].sort((a, b) => a.start - b.start)
  for (const cut of sorted) {
    if (cut.end <= base.start || cut.start >= base.end) continue // cut outside base window
    const next: Interval[] = []
    for (const range of out) {
      if (cut.end <= range.start || cut.start >= range.end) {
        next.push(range)
        continue
      }
      if (cut.start > range.start) {
        next.push({ start: range.start, end: Math.min(cut.start, range.end) })
      }
      if (cut.end < range.end) {
        next.push({ start: Math.max(cut.end, range.start), end: range.end })
      }
    }
    out = next.filter((r) => r.end > r.start)
  }
  return out
}
