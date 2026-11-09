import { BadRequestException, Body, Controller, Delete, Get, HttpStatus, Injectable, Module, NotFoundException, Param, Post, Put, UsePipes } from '@nestjs/common'
import { DateTime } from 'luxon'
import {
  blockCreateSchema,
  businessHoursPutSchema,
  staffHoursPutSchema,
  type BlockCreate,
  type BusinessHoursDay,
  type StaffHoursDay,
} from '@oleum/schemas'
import { DbService } from '../infra/db.module'
import { CacheService } from '../infra/cache.module'
import { RealtimeService } from '../infra/realtime.module'
import { TenancyService } from '../tenancy/tenancy.module'
import { NotificationsService, NotificationsModule } from '../notifications/notifications.module'
import { DomainError } from '../common/domain-error'
import { Roles, CurrentUser, type Claims } from '../common/decorators'
import { ZodValidationPipe } from '../common/zod-pipe'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** pg returns TIME columns as "HH:mm:ss" — normalize to "HH:mm". */
function hhmm(value: string | null | undefined): string | null {
  return value ? String(value).slice(0, 5) : null
}

function localMs(tz: string, date: string, time: string): number {
  const dt = DateTime.fromISO(`${date}T${time}`, { zone: tz })
  if (!dt.isValid) throw new DomainError('BAD_TIME', `Invalid local time ${date} ${time}`)
  return dt.toMillis()
}

function nextDay(date: string): string {
  return DateTime.fromISO(`${date}T00:00:00Z`).plus({ days: 1 }).toISODate()!
}
interface BlockRow {
  id: string
  staff_id: string | null
  block_type: string
  starts_at: Date
  ends_at: Date
  reason: string | null
  notify_affected: boolean
  created_at: Date
}

interface AffectedBooking {
  appointment_id: string
  starts_at: Date
  customer_id: string
  full_name: string
  phone: string | null
  sms_opt_in: boolean
  whatsapp_opt_in: boolean
}

const KIND_TEXT: Record<BlockCreate['kind'], string> = {
  public_holiday: 'resmi tatil',
  holiday: 'izin',
  emergency: 'acil durum',
  illness: 'hastalık',
  private: 'özel',
  other: 'diğer',
}

// ---------------------------------------------------------------------------
// Working hours (tenant weekly pattern + one-click closing day)
// ---------------------------------------------------------------------------

@Injectable()
export class HoursService {
  constructor(
    private readonly db: DbService,
    private readonly cache: CacheService,
    private readonly realtime: RealtimeService,
    private readonly tenants: TenancyService,
  ) {}

  async getWeek(tenantId: string): Promise<BusinessHoursDay[]> {
    const rows = await this.db.tenant(tenantId, (sql) =>
      sql.query<{
        weekday: number
        is_closed: boolean
        open_time: string | null
        close_time: string | null
        break_start: string | null
        break_end: string | null
        note: string | null
      }>(`SELECT weekday, is_closed, open_time, close_time, break_start, break_end, note
          FROM business_hours ORDER BY weekday ASC`),
    )
    return Array.from({ length: 7 }, (_, i) => i + 1).map((weekday) => {
      const row = rows.find((r) => r.weekday === weekday)
      return row
        ? {
            weekday,
            is_closed: row.is_closed,
            open_time: hhmm(row.open_time),
            close_time: hhmm(row.close_time),
            break_start: hhmm(row.break_start),
            break_end: hhmm(row.break_end),
            note: row.note,
          }
        : { weekday, is_closed: true, open_time: null, close_time: null, break_start: null, break_end: null, note: null }
    })
  }

  async putWeek(tenantId: string, dto: { week: BusinessHoursDay[] }): Promise<BusinessHoursDay[]> {
    for (const day of dto.week) {
      if (!day.is_closed && (!day.open_time || !day.close_time)) {
        throw new BadRequestException({
          code: 'VALIDATION',
          message: `weekday ${day.weekday}: open_time/close_time required when not closed`,
        })
      }
      if (!day.is_closed && day.open_time && day.close_time && day.close_time <= day.open_time) {
        throw new BadRequestException({
          code: 'VALIDATION',
          message: `weekday ${day.weekday}: close_time must be after open_time`,
        })
      }
    }
    await this.db.tenant(tenantId, async (sql) => {
      for (const day of dto.week) {
        await sql.query(
          `INSERT INTO business_hours
             (tenant_id, weekday, is_closed, open_time, close_time, break_start, break_end, note, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
           ON CONFLICT (tenant_id, weekday) DO UPDATE SET
             is_closed = EXCLUDED.is_closed,
             open_time = EXCLUDED.open_time,
             close_time = EXCLUDED.close_time,
             break_start = EXCLUDED.break_start,
             break_end = EXCLUDED.break_end,
             note = EXCLUDED.note,
             updated_at = now()`,
          [
            tenantId,
            day.weekday,
            day.is_closed,
            day.is_closed ? null : day.open_time ?? null,
            day.is_closed ? null : day.close_time ?? null,
            day.is_closed ? null : (day.break_start ?? null),
            day.is_closed ? null : (day.break_end ?? null),
            day.note ?? null,
          ],
        )
      }
    })
    await this.afterAvailabilityMutation(tenantId)
    return this.getWeek(tenantId)
  }

  /** The one-click weekly closing-day toggle. */
  async setClosedDay(tenantId: string, weekday: number, closed: boolean): Promise<BusinessHoursDay[]> {
    await this.db.tenant(tenantId, async (sql) => {
      if (closed) {
        await sql.query(
          `INSERT INTO business_hours (tenant_id, weekday, is_closed, updated_at)
           VALUES ($1, $2, true, now())
           ON CONFLICT (tenant_id, weekday) DO UPDATE SET is_closed = true, updated_at = now()`,
          [tenantId, weekday],
        )
      } else {
        await sql.query(
          `INSERT INTO business_hours (tenant_id, weekday, is_closed, open_time, close_time, updated_at)
           VALUES ($1, $2, false, '09:00', '21:00', now())
           ON CONFLICT (tenant_id, weekday) DO UPDATE SET
             is_closed = false,
             open_time = COALESCE(business_hours.open_time, EXCLUDED.open_time),
             close_time = COALESCE(business_hours.close_time, EXCLUDED.close_time),
             updated_at = now()`,
          [tenantId, weekday],
        )
      }
    })
    await this.afterAvailabilityMutation(tenantId)
    return this.getWeek(tenantId)
  }

  private async afterAvailabilityMutation(tenantId: string): Promise<void> {
    await this.cache.dropPrefix(`avail:${tenantId}`)
    const tenant = await this.tenants.getTenant(tenantId)
    this.realtime.publish(this.realtime.tenantRooms(tenant), 'availability.invalidated', {
      reason: 'business_hours_changed',
    })
  }
}

// ---------------------------------------------------------------------------
// Staff hours
// ---------------------------------------------------------------------------

@Injectable()
export class StaffHoursService {
  constructor(
    private readonly db: DbService,
    private readonly cache: CacheService,
    private readonly realtime: RealtimeService,
    private readonly tenants: TenancyService,
  ) {}

  async getWeek(tenantId: string, staffId: string): Promise<StaffHoursDay[]> {
    await this.requireStaff(tenantId, staffId)
    const rows = await this.db.tenant(tenantId, (sql) =>
      sql.query<{
        weekday: number
        is_working: boolean
        start_time: string | null
        end_time: string | null
        break_start: string | null
        break_end: string | null
      }>(`SELECT weekday, is_working, start_time, end_time, break_start, break_end
          FROM staff_hours WHERE staff_id = $1 ORDER BY weekday ASC`, [staffId]),
    )
    return Array.from({ length: 7 }, (_, i) => i + 1).map((weekday) => {
      const row = rows.find((r) => r.weekday === weekday)
      return row
        ? {
            weekday,
            is_working: row.is_working,
            start_time: hhmm(row.start_time),
            end_time: hhmm(row.end_time),
            break_start: hhmm(row.break_start),
            break_end: hhmm(row.break_end),
          }
        : { weekday, is_working: false, start_time: null, end_time: null, break_start: null, break_end: null }
    })
  }

  async putWeek(tenantId: string, staffId: string, dto: { week: StaffHoursDay[] }): Promise<StaffHoursDay[]> {
    await this.requireStaff(tenantId, staffId)
    for (const day of dto.week) {
      if (day.is_working && (!day.start_time || !day.end_time)) {
        throw new BadRequestException({
          code: 'VALIDATION',
          message: `weekday ${day.weekday}: start_time/end_time required when working`,
        })
      }
      if (day.is_working && day.start_time && day.end_time && day.end_time <= day.start_time) {
        throw new BadRequestException({
          code: 'VALIDATION',
          message: `weekday ${day.weekday}: end_time must be after start_time`,
        })
      }
    }
    await this.db.tenant(tenantId, async (sql) => {
      await sql.query(`DELETE FROM staff_hours WHERE staff_id = $1`, [staffId])
      for (const day of dto.week) {
        if (!day.is_working) continue
        await sql.query(
          `INSERT INTO staff_hours (staff_id, weekday, is_working, start_time, end_time, break_start, break_end)
           VALUES ($1, $2, true, $3, $4, $5, $6)`,
          [
            staffId,
            day.weekday,
            day.start_time ?? null,
            day.end_time ?? null,
            day.break_start ?? null,
            day.break_end ?? null,
          ],
        )
      }
    })
    await this.cache.dropPrefix(`avail:${tenantId}`)
    const tenant = await this.tenants.getTenant(tenantId)
    this.realtime.publish(this.realtime.tenantRooms(tenant), 'availability.invalidated', {
      reason: 'staff_hours_changed',
    })
    return this.getWeek(tenantId, staffId)
  }

  private async requireStaff(tenantId: string, staffId: string): Promise<void> {
    const rows = await this.db.tenant(tenantId, (sql) =>
      sql.query<{ id: string }>(`SELECT id FROM staff WHERE id = $1 AND is_active`, [staffId]),
    )
    if (rows.length === 0) throw new NotFoundException('Staff not found')
  }
}

// ---------------------------------------------------------------------------
// Instant blocks (interruption manager)
// ---------------------------------------------------------------------------

@Injectable()
export class BlocksService {
  constructor(
    private readonly db: DbService,
    private readonly cache: CacheService,
    private readonly realtime: RealtimeService,
    private readonly tenants: TenancyService,
    private readonly notifications: NotificationsService,
  ) {}

  async create(tenantId: string, actorId: string | null, dto: BlockCreate): Promise<BlockRow[]> {
    const tenant = await this.tenants.getTenant(tenantId)
    const tz = tenant.timezone
    const from = dto.date_from
    const to = dto.date_to ?? dto.date_from
    if (to < from) throw new DomainError('BAD_RANGE', 'date_to must be on/after date_from')

    // resolve staff targets (empty => whole shop, staff_id NULL)
    let staffTargets: string[] = []
    if (dto.staff_ids && dto.staff_ids.length > 0) {
      const valid = await this.db.tenant(tenantId, (sql) =>
        sql.query<{ id: string }>(
          `SELECT id FROM staff WHERE id = ANY($1::uuid[]) AND is_active`,
          [dto.staff_ids ?? []],
        ),
      )
      staffTargets = valid.map((v) => v.id)
      if (staffTargets.length === 0) {
        throw new DomainError('STAFF_NOT_FOUND', 'Kapanacak personel bulunamadı', HttpStatus.NOT_FOUND)
      }
    }

    const created = await this.db.tenant(tenantId, async (sql) => {
      const out: BlockRow[] = []
      for (let cursor = from; ; ) {
        const startsAtMs = dto.all_day ? localMs(tz, cursor, '00:00') : localMs(tz, cursor, dto.start_time!)
        const endsAtMs = dto.all_day
          ? DateTime.fromMillis(localMs(tz, cursor, '00:00'), { zone: tz }).plus({ days: 1 }).toMillis()
          : localMs(tz, cursor, dto.end_time!)
        if (endsAtMs <= startsAtMs) {
          throw new DomainError('BAD_RANGE', `Range ends before it starts on ${cursor}`)
        }
        const targets = staffTargets.length > 0 ? staffTargets : [null]
        for (const staffId of targets) {
          const [row] = await sql.query<BlockRow>(
            `INSERT INTO schedule_blocks
               (tenant_id, staff_id, block_type, starts_at, ends_at, reason, notify_affected, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id, staff_id, block_type, starts_at, ends_at, reason, notify_affected, created_at`,
            [
              tenantId,
              staffId,
              dto.kind ?? 'other',
              new Date(startsAtMs),
              new Date(endsAtMs),
              dto.reason ?? null,
              dto.notify_affected,
              actorId,
            ],
          )
          out.push(row!)
        }
        if (cursor === to) break
        cursor = nextDay(cursor)
      }
      return out
    })

    // Find bookings swallowed by the block(s) — notify them (optionally).
    const affected = await this.findAffected(tenantId, created)
    if (dto.notify_affected) {
      for (const booking of affected) {
        await this.notifications.notifyBlockAffected(
          tenant,
          booking.appointment_id,
          booking.starts_at,
          {
            id: booking.customer_id,
            full_name: booking.full_name,
            phone: booking.phone,
            sms_opt_in: booking.sms_opt_in,
            whatsapp_opt_in: booking.whatsapp_opt_in,
          },
          dto.reason ?? KIND_TEXT[dto.kind ?? 'other'],
        )
      }
    }

    await this.cache.dropPrefix(`avail:${tenantId}`)
    this.realtime.publish(this.realtime.tenantRooms(tenant), 'availability.invalidated', {
      ranges: created.map((b) => ({ starts_at: b.starts_at, ends_at: b.ends_at })),
      staff_ids: staffTargets,
    })
    // internal management detail (reasons) — tenant devices only
    this.realtime.publish([`tenant:${tenant.id}`], 'blocks.updated', { created, deleted: [] })
    return created
  }

  async list(tenantId: string): Promise<BlockRow[]> {
    return this.db.tenant(tenantId, (sql) =>
      sql.query<BlockRow>(
        `SELECT id, staff_id, block_type, starts_at, ends_at, reason, notify_affected, created_at
         FROM schedule_blocks WHERE deleted_at IS NULL
         ORDER BY starts_at ASC LIMIT 200`,
      ),
    )
  }
  async remove(tenantId: string, id: string): Promise<void> {
    await this.db.tenant(tenantId, async (sql) => {
      const [row] = await sql.query<BlockRow & { deleted_at: Date | null }>(
        `UPDATE schedule_blocks SET deleted_at = now(), updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING id, staff_id, block_type, starts_at, ends_at, reason, notify_affected, created_at, deleted_at`,
        [id],
      )
      if (!row) throw new NotFoundException('Block not found')
      await this.cache.dropPrefix(`avail:${tenantId}`)
      const tenant = await this.tenants.getTenant(tenantId)
      this.realtime.publish([`tenant:${tenant.id}`], 'blocks.updated', { created: [], deleted: [row] })
      this.realtime.publish(this.realtime.tenantRooms(tenant), 'availability.invalidated', {
        ranges: [{ starts_at: row.starts_at, ends_at: row.ends_at }],
      })
    })
  }

  private async findAffected(tenantId: string, blocks: BlockRow[]): Promise<AffectedBooking[]> {
    if (blocks.length === 0) return []
    const minStart = blocks.reduce((m, b) => (b.starts_at < m ? b.starts_at : m), blocks[0]!.starts_at)
    const maxEnd = blocks.reduce((m, b) => (b.ends_at > m ? b.ends_at : m), blocks[0]!.ends_at)
    const staffIds = blocks.map((b) => b.staff_id).filter((s): s is string => s !== null)
    const shopWide = staffIds.length < blocks.length

    return this.db.tenant(tenantId, (sql) =>
      sql.query<AffectedBooking>(
        `SELECT a.id AS appointment_id, a.starts_at,
                c.id AS customer_id, c.full_name, c.phone, c.sms_opt_in, c.whatsapp_opt_in
         FROM appointments a
         JOIN customers c ON c.id = a.customer_id
         WHERE a.status = 'booked'
           AND tstzrange(a.starts_at, a.ends_at) && tstzrange($1, $2)
           ${shopWide ? '' : 'AND a.staff_id = ANY($3::uuid[])'}
         ORDER BY a.starts_at ASC`,
        shopWide ? [minStart, maxEnd] : [minStart, maxEnd, staffIds],
      ),
    )
  }
}

// ---------------------------------------------------------------------------
// Controllers & module
// ---------------------------------------------------------------------------

@Controller('business-hours')
export class BusinessHoursController {
  constructor(private readonly hours: HoursService) {}

  @Roles('tenant_admin')
  @Get()
  week(@CurrentUser() claims: Claims): Promise<BusinessHoursDay[]> {
    return this.hours.getWeek(claims.tenant_id!)
  }

  @Roles('tenant_admin')
  @Put()
  @UsePipes(new ZodValidationPipe(businessHoursPutSchema))
  putWeek(@CurrentUser() claims: Claims, @Body() dto: { week: BusinessHoursDay[] }): Promise<BusinessHoursDay[]> {
    return this.hours.putWeek(claims.tenant_id!, dto)
  }

  @Roles('tenant_admin')
  @Post('close-day')
  async closeDay(
    @CurrentUser() claims: Claims,
    @Body() body: { weekday: number; closed: boolean },
  ): Promise<BusinessHoursDay[]> {
    if (!Number.isInteger(body?.weekday) || body.weekday < 1 || body.weekday > 7 || typeof body.closed !== 'boolean') {
      throw new DomainError('VALIDATION', 'weekday (1-7) and closed (boolean) are required')
    }
    return this.hours.setClosedDay(claims.tenant_id!, body.weekday, body.closed)
  }
}

@Controller('staff-hours')
export class StaffHoursController {
  constructor(private readonly staffHours: StaffHoursService) {}

  @Roles('tenant_admin')
  @Get(':staffId')
  week(@CurrentUser() claims: Claims, @Param('staffId') staffId: string): Promise<StaffHoursDay[]> {
    return this.staffHours.getWeek(claims.tenant_id!, staffId)
  }

  @Roles('tenant_admin')
  @Put(':staffId')
  @UsePipes(new ZodValidationPipe(staffHoursPutSchema))
  putWeek(
    @CurrentUser() claims: Claims,
    @Param('staffId') staffId: string,
    @Body() dto: { week: StaffHoursDay[] },
  ): Promise<StaffHoursDay[]> {
    return this.staffHours.putWeek(claims.tenant_id!, staffId, dto)
  }
}

@Controller('blocks')
export class BlocksController {
  constructor(private readonly blocks: BlocksService) {}

  @Roles('tenant_admin')
  @Get()
  list(@CurrentUser() claims: Claims): Promise<unknown> {
    return this.blocks.list(claims.tenant_id!)
  }

  @Roles('tenant_admin')
  @Post()
  @UsePipes(new ZodValidationPipe(blockCreateSchema))
  create(
    @CurrentUser() claims: Claims,
    @Body() dto: BlockCreate,
  ): Promise<BlockRow[]> {
    return this.blocks.create(claims.tenant_id!, claims.sub, dto)
  }

  @Roles('tenant_admin')
  @Delete(':id')
  remove(@CurrentUser() claims: Claims, @Param('id') id: string): Promise<void> {
    return this.blocks.remove(claims.tenant_id!, id)
  }
}

@Module({
  imports: [NotificationsModule],
  controllers: [BusinessHoursController, StaffHoursController, BlocksController],
  providers: [HoursService, StaffHoursService, BlocksService],
})
export class SchedulingModule {}
