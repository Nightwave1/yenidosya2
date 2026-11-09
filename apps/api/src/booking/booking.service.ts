import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { uuidSchema } from '@oleum/schemas'
import type { AppointmentDTO, ManageAppointmentDTO, PanelBookingDTO, PublicBookingDTO } from '@oleum/schemas'
import { DomainError } from '../common/domain-error'
import { CacheService } from '../infra/cache.module'
import { DbService } from '../infra/db.module'
import { RealtimeService } from '../infra/realtime.module'
import { NotificationsService } from '../notifications/notifications.module'
import type { TenantRow } from '../tenancy/tenancy.module'
import {
  BookingRepository,
  type AppointmentJoinedRow,
  type AppointmentRow,
  type CustomerRow,
} from './booking.repository'
import { AvailabilityService, rulesOf } from './availability.service'

const PG_EXCLUSION_CONFLICT = '23P01' // appointment_no_overlap fired
const PG_UNIQUE_CONFLICT = '23505'

function pgCode(e: unknown): string | null {
  return (e as { code?: string } | null)?.code ?? null
}

function statusTr(status: AppointmentRow['status']): string {
  const labels: Record<AppointmentRow['status'], string> = {
    booked: 'onaylandı',
    in_progress: 'koltukta',
    completed: 'tamamlandı',
    no_show: 'gelmedi olarak işaretlendi',
    cancelled: 'iptal edildi',
  }
  return labels[status]
}

/**
 * Booking write paths.
 * - Public ordering: slot must exist on the freshly computed engine grid; the
 *   insert is protected by the GiST exclusion constraint (double-booking-proof).
 * - Panel ordering: free-form time (retro/walk-in), overlap constraint still enforced.
 */
@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name)

  constructor(
    private readonly repo: BookingRepository,
    private readonly availability: AvailabilityService,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
    private readonly cache: CacheService,
    private readonly db: DbService,
  ) {}

  // -------------------------------------------------------------------------
  // Public booking page order
  // -------------------------------------------------------------------------
  async createPublicBooking(
    tenant: TenantRow,
    dto: PublicBookingDTO,
    idempotencyKeyRaw?: string,
  ): Promise<{ appointment: AppointmentDTO; replayed: boolean }> {
    const parsedKey = idempotencyKeyRaw ? uuidSchema.safeParse(idempotencyKeyRaw) : null
    const idempotencyKey = parsedKey?.success ? parsedKey.data : randomUUID()

    // Idempotency replay (same round trip results in the same appointment).
    const existing = await this.repo.findByIdempotencyKey(tenant.id, idempotencyKey)
    if (existing) return { appointment: toAppointmentDTO(existing), replayed: true }

    const service = await this.repo.loadService(tenant.id, dto.service_id)
    if (!service) throw new DomainError('SERVICE_NOT_FOUND', 'Hizmet bulunamadı', HttpStatus.NOT_FOUND)

    await this.assertPublicRules(tenant, dto.date)

    const startsAt = this.localInstant(tenant, dto.date, dto.time)
    const targetIso = new Date(startsAt.toMillis()).toISOString()

    // Fresh availability (bypasses the 60s cache) — the source of truth.
    const day = await this.availability.getDayAvailability(tenant, service.id, 'any', dto.date, {
      fresh: true,
    })

    const staffId = await this.pickStaff(tenant, dto.staff_id ?? null, day, targetIso)

    const customer = await this.repo.upsertCustomer(tenant.id, dto.full_name, dto.phone, {
      smsOptIn: dto.sms_opt_in,
      whatsappOptIn: dto.whatsapp_opt_in,
    })

    const row = await this.insertGuarded(tenant, {
      tenantId: tenant.id,
      customer_id: customer.id,
      staff_id: staffId,
      service_id: service.id,
      service_name_snap: service.name,
      duration_min_snap: service.duration_min,
      price_snap: service.price,
      starts_at: new Date(startsAt.toMillis()),
      ends_at: new Date(startsAt.toMillis() + (service.duration_min + service.buffer_after_min) * 60_000),
      status: 'booked',
      source: 'booking_page',
      customer_note: dto.note ?? null,
      idempotency_key: idempotencyKey,
    })

    await this.kickoffSideEffects(tenant, row, customer)
    return { appointment: toAppointmentDTO(row), replayed: false }
  }

  // -------------------------------------------------------------------------
  // Panel / walk-in order (free-form start, grid check intentionally skipped)
  // -------------------------------------------------------------------------
  async createPanelBooking(
    tenant: TenantRow,
    actorId: string,
    dto: PanelBookingDTO,
  ): Promise<{ appointment: AppointmentDTO; replayed: boolean }> {
    const service = await this.repo.loadService(tenant.id, dto.service_id)
    if (!service) throw new DomainError('SERVICE_NOT_FOUND', 'Hizmet bulunamadı', HttpStatus.NOT_FOUND)

    let customer: CustomerRow
    if (dto.customer_id) {
      const found = await this.repo.getCustomer(tenant.id, dto.customer_id)
      if (!found) throw new DomainError('CUSTOMER_NOT_FOUND', 'Müşteri bulunamadı', HttpStatus.NOT_FOUND)
      customer = found
    } else {
      const c = dto.customer!
      // shop-staffed entry: the barber answers for consent in person
      customer = await this.repo.upsertCustomer(tenant.id, c.full_name, c.phone, {
        smsOptIn: true,
        whatsappOptIn: true,
      })
    }

    let startsAt: DateTime
    if (dto.start) {
      startsAt = this.localInstant(tenant, dto.start.date, dto.start.time)
    } else {
      // immediate walk-in: start on the current minute
      const nowLocal = DateTime.now().setZone(tenant.timezone)
      startsAt = nowLocal.set({ second: 0, millisecond: 0 })
      if (nowLocal.second > 0 || nowLocal.millisecond > 0) startsAt = startsAt.plus({ minutes: 1 })
    }

    const staffId = dto.staff_id ?? (await this.pickLeastLoadedStaff(tenant, startsAt.toJSDate()))
    const status = dto.start_in_progress || !dto.start ? ('in_progress' as const) : ('booked' as const)
    const source = dto.start ? ('panel' as const) : ('walk_in' as const)

    const row = await this.insertGuarded(tenant, {
      tenantId: tenant.id,
      customer_id: customer.id,
      staff_id: staffId,
      service_id: service.id,
      service_name_snap: service.name,
      duration_min_snap: service.duration_min,
      price_snap: service.price,
      starts_at: startsAt.toJSDate(),
      ends_at: startsAt.plus({ minutes: service.duration_min + service.buffer_after_min }).toJSDate(),
      status,
      source,
      customer_note: dto.note ?? null,
      idempotency_key: randomUUID(),
    })

    await this.kickoffSideEffects(tenant, row, customer)
    return { appointment: toAppointmentDTO(row), replayed: false }
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------
  async listForDay(
    tenant: TenantRow,
    dateISO: string | undefined,
    opts: { staffId?: string | null; status?: string | null } = {},
  ): Promise<(AppointmentDTO & { customer_name: string; customer_phone: string | null })[]> {
    const date = dateISO
      ? DateTime.fromISO(dateISO, { zone: tenant.timezone })
      : DateTime.now().setZone(tenant.timezone).startOf('day')
    if (!date.isValid) throw new DomainError('BAD_DATE', 'Invalid date')
    const rows = await this.repo.listForDay(
      tenant.id,
      date.startOf('day').toJSDate(),
      date.plus({ days: 1 }).startOf('day').toJSDate(),
      opts,
    )
    return rows.map(joinedToDTO)
  }

  // -------------------------------------------------------------------------
  // Public "manage my appointment" (check-token links from reminders)
  // -------------------------------------------------------------------------

  async getByToken(tenant: TenantRow, checkToken: string): Promise<ManageAppointmentDTO> {
    const dto = await this.loadManageByToken(tenant, checkToken)
    if (!dto) throw new DomainError('APPOINTMENT_NOT_FOUND', 'Randevu bulunamadı', HttpStatus.NOT_FOUND)
    return dto
  }

  async cancelByCustomer(tenant: TenantRow, checkToken: string): Promise<ManageAppointmentDTO> {
    const dto = await this.loadManageByToken(tenant, checkToken)
    if (!dto) throw new DomainError('APPOINTMENT_NOT_FOUND', 'Randevu bulunamadı', HttpStatus.NOT_FOUND)

    const updated = await this.db.tenant(tenant.id, async (sql) => {
      const rows = await sql.query<{ id: string; status: AppointmentRow['status']; starts_at: Date; customer_id: string }>(
        `SELECT id, status, starts_at, customer_id FROM appointments
         WHERE check_token = $1
         FOR UPDATE`,
        [checkToken],
      )
      const current = rows[0]
      if (!current) throw new DomainError('APPOINTMENT_NOT_FOUND', 'Randevu bulunamadı', HttpStatus.NOT_FOUND)
      if (current.status !== 'booked') {
        throw new DomainError('NOT_CANCELLABLE', `Bu randevu zaten ${statusTr(current.status)}`, HttpStatus.CONFLICT)
      }
      if (current.starts_at.getTime() <= Date.now()) {
        throw new DomainError('CANCEL_WINDOW_PASSED', 'Randevu saati geçtiği için iptal edilemez', HttpStatus.CONFLICT)
      }
      await sql.query(
        `UPDATE appointments
         SET status = 'cancelled', cancelled_at = now(), cancelled_via = 'customer', updated_at = now()
         WHERE id = $1`,
        [current.id],
      )
      await sql.query(
        `INSERT INTO appointment_status_history
           (appointment_id, from_status, to_status, changed_by, via)
         VALUES ($1, 'booked', 'cancelled', NULL, 'public')`,
        [current.id],
      )
      return current
    })

    // side effects: reminders off, cache invalidation, realtime broadcast
    try {
      await this.notifications.cancelScheduledForAppointment(tenant.id, updated.id)
    } catch (e) {
      this.logger.warn(`reminder cancellation failed (non-fatal): ${(e as Error).message}`)
    }
    await this.cache.dropPrefix(`avail:${tenant.id}`)
    this.realtime.publish(this.realtime.tenantRooms(tenant), 'appointment.status', {
      id: updated.id,
      status: 'cancelled',
      via: 'customer',
    })

    return this.getByToken(tenant, checkToken)
  }

  private async loadManageByToken(
    tenant: TenantRow,
    checkToken: string,
  ): Promise<ManageAppointmentDTO | null> {
    const rows = await this.db.tenant(tenant.id, (sql) =>
      sql.query<{
        id: string
        status: AppointmentRow['status']
        service_name_snap: string
        starts_at: Date
        ends_at: Date
        staff_name: string | null
        customer_name: string
      }>(
        `SELECT a.id, a.status, a.service_name_snap, a.starts_at, a.ends_at,
                st.display_name AS staff_name, c.full_name AS customer_name
         FROM appointments a
         JOIN customers c ON c.id = a.customer_id
         LEFT JOIN staff st ON st.id = a.staff_id
         WHERE a.check_token = $1
         LIMIT 1`,
        [checkToken],
      ),
    )
    const row = rows[0]
    if (!row) return null
    return {
      id: row.id,
      status: row.status,
      service_name: row.service_name_snap,
      staff_name: row.staff_name,
      customer_name: row.customer_name,
      starts_at: row.starts_at.toISOString(),
      ends_at: row.ends_at.toISOString(),
      timezone: tenant.timezone,
      can_cancel: row.status === 'booked' && row.starts_at.getTime() > Date.now(),
    }
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------
  private localInstant(tenant: TenantRow, dateISO: string, timeHHmm: string): DateTime {
    const dt = DateTime.fromISO(`${dateISO}T${timeHHmm}`, { zone: tenant.timezone })
    if (!dt.isValid) throw new DomainError('BAD_TIME', 'Geçersiz tarih/saat')
    return dt
  }

  private async assertPublicRules(tenant: TenantRow, dateISO: string): Promise<void> {
    const rules = rulesOf(tenant.settings)
    const today = DateTime.now().setZone(tenant.timezone).startOf('day')
    const requested = DateTime.fromISO(dateISO, { zone: tenant.timezone }).startOf('day')
    if (!requested.isValid) throw new DomainError('BAD_DATE', 'Geçersiz tarih')
    if (requested < today) throw new DomainError('DATE_IN_PAST', 'Geçmiş tarihli randevu online alınmaz')
    if (requested > today.plus({ days: rules.max_advance_days })) {
      throw new DomainError('DATE_TOO_FAR', `En fazla ${rules.max_advance_days} gün sonrasına kadar alınır`)
    }
  }

  private async pickStaff(
    tenant: TenantRow,
    dtoStaffId: string | null,
    day: Awaited<ReturnType<AvailabilityService['getDayAvailability']>>,
    targetIso: string,
  ): Promise<string> {
    if (dtoStaffId) {
      const staff = day.staff.find((s) => s.staff_id === dtoStaffId)
      if (!staff) throw new DomainError('STAFF_NOT_FOUND', 'Personel bulunamadı', HttpStatus.NOT_FOUND)
      if (!staff.slots.includes(targetIso)) {
        throw new DomainError('SLOT_UNAVAILABLE', 'Bu saat artık müsait değil', HttpStatus.CONFLICT, {
          availability: day,
        })
      }
      return dtoStaffId
    }
    if (!day.any_staff_slots.includes(targetIso)) {
      throw new DomainError('SLOT_UNAVAILABLE', 'Bu saat artık müsait değil', HttpStatus.CONFLICT, {
        availability: day,
      })
    }
    // least-loaded, then panel order (sort_order shape preserved in the DTO order)
    const [dayStart, dayEnd] = this.tenantDayRange(tenant, day.date)
    const candidates = day.staff.filter((s) => s.slots.includes(targetIso)).map((s) => s.staff_id)
    const counts = await this.repo.countBookingsPerStaff(tenant.id, dayStart, dayEnd, candidates)
    const order = new Map(day.staff.map((s, i) => [s.staff_id, i]))
    candidates.sort((a, b) => (counts.get(a) ?? 0) - (counts.get(b) ?? 0) || (order.get(a)! - order.get(b)!))
    return candidates[0]!
  }

  private async pickLeastLoadedStaff(tenant: TenantRow, startsAt: Date): Promise<string> {
    const staff = await this.repo.listStaff(tenant.id)
    if (staff.length === 0) throw new DomainError('STAFF_REQUIRED', 'Kayıtlı personel yok', HttpStatus.CONFLICT)
    const counts = await this.repo.countBookingsPerStaff(tenant.id, startsAt, new Date(startsAt.getTime() + 86_400_000), staff.map((s) => s.id))
    const sorted = [...staff].sort(
      (a, b) => (counts.get(a.id) ?? 0) - (counts.get(b.id) ?? 0) || a.sort_order - b.sort_order,
    )
    return sorted[0]!.id
  }

  private tenantDayRange(tenant: TenantRow, dateISO: string): [Date, Date] {
    const day = DateTime.fromISO(dateISO, { zone: tenant.timezone })
    return [day.startOf('day').toJSDate(), day.plus({ days: 1 }).startOf('day').toJSDate()]
  }

  /** INSERT with exclusion-conflict → 409 (with a fresh availability) and idempotency replay. */
  private async insertGuarded(tenant: TenantRow, params: Parameters<BookingRepository['insertAppointment']>[0]): Promise<AppointmentRow> {
    try {
      return await this.repo.insertAppointment(params)
    } catch (e) {
      const code = pgCode(e)
      if (code === PG_EXCLUSION_CONFLICT) {
        const day = await this.availability.getDayAvailability(
          tenant,
          params.service_id,
          'any',
          DateTime.fromJSDate(params.starts_at).setZone(tenant.timezone).toISODate()!,
          { fresh: true },
        )
        throw new DomainError('SLOT_UNAVAILABLE', 'Bu saat az önce doldu', HttpStatus.CONFLICT, {
          availability: day,
        })
      }
      if (code === PG_UNIQUE_CONFLICT) {
        const replayed = await this.repo.findByIdempotencyKey(tenant.id, params.idempotency_key)
        if (replayed) return replayed
      }
      throw e
    }
  }

  /** Post-commit side effects: reminders, cache invalidation, WS broadcast. Non-fatal. */
  private async kickoffSideEffects(tenant: TenantRow, row: AppointmentRow, customer: CustomerRow): Promise<void> {
    try {
      const staffName = (await this.repo.getStaffName(tenant.id, row.staff_id)) ?? ''
      await this.notifications.scheduleBookingReminders(
        tenant,
        row.id,
        row.starts_at,
        customer,
        row.service_name_snap,
        staffName,
        row.check_token,
      )
      await this.cache.dropPrefix(`avail:${tenant.id}`)
      this.realtime.publish(this.realtime.tenantRooms(tenant), 'appointment.created', {
        id: row.id,
        starts_at: row.starts_at.toISOString(),
        staff_id: row.staff_id,
      })
    } catch (e) {
      this.logger.warn(`post-booking side effects failed: ${(e as Error).message}`)
    }
  }
}

export function toAppointmentDTO(row: AppointmentRow): AppointmentDTO {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    customer_id: row.customer_id,
    staff_id: row.staff_id,
    service_id: row.service_id,
    service_name: row.service_name_snap,
    starts_at: row.starts_at.toISOString(),
    ends_at: row.ends_at.toISOString(),
    status: row.status,
    source: row.source,
    check_token: row.check_token,
    created_at: row.created_at.toISOString(),
  }
}

function joinedToDTO(row: AppointmentJoinedRow): AppointmentDTO & { customer_name: string; customer_phone: string | null } {
  return {
    ...toAppointmentDTO(row),
    customer_name: row.customer_name,
    customer_phone: row.customer_phone,
  }
}
