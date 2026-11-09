import { Injectable } from '@nestjs/common'
import type { AvailabilityDTO, AvailabilityStaffDTO } from '@oleum/schemas'
import { computeDaySlots, type StaffInput, type ComputeResult } from './availability/domain/engine'
import { BookingRepository, hhmm, type BusyRow } from './booking.repository'
import { CacheService } from '../infra/cache.module'
import type { TenantRow } from '../tenancy/tenancy.module'

export interface BookingRules {
  slot_granularity: number
  min_notice_minutes: number
  max_advance_days: number
}

export function rulesOf(settings: Record<string, unknown> | null): BookingRules {
  const num = (key: string, def: number, min: number, max: number): number => {
    const raw = settings?.[key]
    const n = Number(raw)
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def
  }
  return {
    slot_granularity: num('slot_granularity', 15, 5, 60),
    min_notice_minutes: num('min_notice_minutes', 30, 0, 24 * 60),
    max_advance_days: num('max_advance_days', 30, 1, 365),
  }
}

/**
 * Availability read model. 60s cache keyed per tenant/service/staff/date and
 * invalidated aggressively by every booking/block/hours mutation (ARCH §5.1);
 * booking write paths always recompute with `fresh: true`.
 */
@Injectable()
export class AvailabilityService {
  constructor(
    private readonly repo: BookingRepository,
    private readonly cache: CacheService,
  ) {}

  async getDayAvailability(
    tenant: TenantRow,
    serviceId: string,
    staffParam: string, // 'any' | staff uuid
    dateISO: string,
    opts: { fresh?: boolean } = {},
  ): Promise<AvailabilityDTO> {
    const rules = rulesOf(tenant.settings)
    const cacheKey = `avail:${tenant.id}:${serviceId}:${staffParam}:${dateISO}:g${rules.slot_granularity}`
    const producer = () => this.compute(tenant, serviceId, dateISO, staffParam, rules)
    return opts.fresh ? producer() : this.cache.wrap(cacheKey, 60, producer)
  }

  private async compute(
    tenant: TenantRow,
    serviceId: string,
    dateISO: string,
    staffParam: string,
    rules: BookingRules,
  ): Promise<AvailabilityDTO> {
    const loaded = await this.repo.loadDayAvailability(tenant.id, tenant.timezone, dateISO, serviceId)
    const service = await this.repo.loadService(tenant.id, serviceId)

    const businessHours = loaded.businessHours
      ? {
          isClosed: loaded.businessHours.is_closed,
          openTime: hhmm(loaded.businessHours.open_time),
          closeTime: hhmm(loaded.businessHours.close_time),
          breakStart: hhmm(loaded.businessHours.break_start),
          breakEnd: hhmm(loaded.businessHours.break_end),
        }
      : { isClosed: true, openTime: null, closeTime: null, breakStart: null, breakEnd: null }

    const staffInputs: StaffInput[] = loaded.staff.map((member) => {
      const hoursRow = loaded.staffHours.get(member.id) ?? undefined
      const busy = [
        ...(loaded.appointmentsByStaff.get(member.id) ?? []),
        ...(loaded.blocksByStaff.get(member.id) ?? []),
      ].map(toInterval)
      return {
        staffId: member.id,
        working:
          hoursRow && hoursRow.is_working && hoursRow.start_time && hoursRow.end_time
            ? {
                startTime: hhmm(hoursRow.start_time)!,
                endTime: hhmm(hoursRow.end_time)!,
                breakStart: hhmm(hoursRow.break_start),
                breakEnd: hhmm(hoursRow.break_end),
              }
            : null,
        busy,
      }
    })

    const result: ComputeResult = computeDaySlots({
      timezone: tenant.timezone,
      date: dateISO,
      businessHours,
      staff: staffInputs,
      busyTenantWide: loaded.tenantWideBlocks.map(toInterval),
      service: {
        durationMin: service?.duration_min ?? 30,
        bufferAfterMin: service?.buffer_after_min ?? 0,
      },
      rules: { slotGranularityMin: rules.slot_granularity, minNoticeMinutes: rules.min_notice_minutes },
    })

    const staffDtos: AvailabilityStaffDTO[] = result.staff
      .filter((s) => staffParam === 'any' || s.staffId === staffParam)
      .map((s) => ({ staff_id: s.staffId, slots: s.slotsMs.map(msToIso) }))

    return {
      tenant_id: tenant.id,
      slug: tenant.slug,
      date: dateISO,
      is_closed: result.isClosed,
      service: {
        id: serviceId,
        duration_min: service?.duration_min ?? 30,
        buffer_after_min: service?.buffer_after_min ?? 0,
      },
      staff: staffDtos,
      any_staff_slots: result.anyStaffSlotsMs.map(msToIso),
      computed_at: new Date().toISOString(),
    }
  }
}

function toInterval(row: BusyRow): { start: number; end: number } {
  return { start: row.starts_at.getTime(), end: row.ends_at.getTime() }
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString()
}
