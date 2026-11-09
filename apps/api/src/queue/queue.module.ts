import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  UsePipes,
} from '@nestjs/common'
import { DateTime } from 'luxon'
import { z } from 'zod'
import { queueActionSchema, type QueueAction, type QueueEntryDTO, type QueueTodayDTO } from '@oleum/schemas'
import { DbService } from '../infra/db.module'
import { CacheService } from '../infra/cache.module'
import { RealtimeService } from '../infra/realtime.module'
import { TenancyService, type TenantRow } from '../tenancy/tenancy.module'
import { BookingRepository, type AppointmentJoinedRow, type AppointmentRow } from '../booking/booking.repository'
import { BookingModule } from '../booking/booking.module'
import { DomainError } from '../common/domain-error'
import { CurrentUser, Roles, type Claims } from '../common/decorators'
import { ZodValidationPipe } from '../common/zod-pipe'

const statusBodySchema = z.object({ action: queueActionSchema })

/** One-touch state machine (ARCHITECTURE §5.4). */
const ALLOWED_FROM: Record<QueueAction, AppointmentRow['status'][]> = {
  take_chair: ['booked'],
  complete: ['in_progress'],
  no_show: ['booked'],
  cancel: ['booked'],
  restore: ['in_progress', 'no_show'],
}

const TARGET_STATUS: Record<QueueAction, AppointmentRow['status']> = {
  take_chair: 'in_progress',
  complete: 'completed',
  no_show: 'no_show',
  cancel: 'cancelled',
  restore: 'booked',
}

@Injectable()
export class QueueService {
  constructor(
    private readonly db: DbService,
    private readonly cache: CacheService,
    private readonly realtime: RealtimeService,
    private readonly tenants: TenancyService,
    private readonly repo: BookingRepository,
  ) {}

  /** Hospital-style snapshot: current-on-chair + chronological queue. */
  async snapshot(tenant: TenantRow): Promise<QueueTodayDTO> {
    const dayStart = DateTime.now().setZone(tenant.timezone).startOf('day')
    const rows = await this.repo.listForDay(
      tenant.id,
      dayStart.toJSDate(),
      dayStart.plus({ days: 1 }).toJSDate(),
    )
    const live = rows.filter((r) => r.status !== 'cancelled')
    const entry = (r: AppointmentJoinedRow): QueueEntryDTO => ({
      appointment_id: r.id,
      starts_at: r.starts_at.toISOString(),
      customer_name: r.customer_name,
      customer_phone: r.customer_phone,
      service_name: r.service_name_snap,
      staff_id: r.staff_id,
      staff_name: r.staff_name,
      status: r.status,
    })
    const current = live.find((r) => r.status === 'in_progress') ?? null
    return {
      business_day: dayStart.toISODate()!,
      current: current ? entry(current) : null,
      upcoming: live.filter((r) => r.status === 'booked').map(entry),
      completed: live.filter((r) => r.status === 'completed').reverse().map(entry),
      no_shows: live.filter((r) => r.status === 'no_show').map(entry),
      generated_at: new Date().toISOString(),
    }
  }

  async transition(
    tenantId: string,
    actorId: string | null,
    appointmentId: string,
    action: QueueAction,
  ): Promise<QueueTodayDTO> {
    const tenant = await this.tenants.getTenant(tenantId)

    const updated = await this.db.tenant(tenantId, async (sql) => {
      const rows = await sql.query<Pick<AppointmentRow, 'id' | 'status' | 'customer_id'>>(
        `SELECT id, status, customer_id FROM appointments WHERE id = $1 FOR UPDATE`,
        [appointmentId],
      )
      const current = rows[0]
      if (!current) throw new NotFoundException('Appointment not found')
      if (!ALLOWED_FROM[action].includes(current.status)) {
        throw new DomainError(
          'BAD_TRANSITION',
          `Cannot "${action}" an appointment that is ${current.status}`,
          HttpStatus.CONFLICT,
        )
      }
      const to = TARGET_STATUS[action]
      const now = new Date()
      const sets: string[] = ['status = $2', 'updated_at = now()']
      const values: unknown[] = [appointmentId, to]
      switch (action) {
        case 'take_chair':
          sets.push('actual_start_at = $3')
          values.push(now)
          break
        case 'complete':
          sets.push('actual_end_at = $3')
          values.push(now)
          break
        case 'cancel':
          sets.push('cancelled_at = $3', 'cancelled_via = $4', 'cancelled_by = $5')
          values.push(now, 'shop', actorId)
          break
        case 'restore':
          sets.push('actual_start_at = NULL', 'actual_end_at = NULL')
          break
        case 'no_show':
          break
      }
      const updatedRows = await sql.query<AppointmentRow & { customer_id: string }>(
        `UPDATE appointments SET ${sets.join(', ')} WHERE id = $1
         RETURNING id, tenant_id, customer_id, staff_id, service_id, service_name_snap,
                   duration_min_snap, price_snap, starts_at, ends_at, actual_start_at,
                   actual_end_at, status, source, customer_note, check_token,
                   idempotency_key, created_at`,
        values,
      )

      await sql.query(
        `INSERT INTO appointment_status_history
           (appointment_id, from_status, to_status, changed_by, via)
         VALUES ($1, $2, $3, $4, 'live_queue')`,
        [appointmentId, current.status, to, actorId],
      )
      if (to === 'completed' || to === 'no_show') {
        await sql.query(
          `UPDATE customers SET
             completed_count = completed_count + (CASE WHEN $2 = 'completed' THEN 1 ELSE 0 END),
             no_show_count   = no_show_count   + (CASE WHEN $2 = 'no_show'   THEN 1 ELSE 0 END)
           WHERE id = $1`,
          [current.customer_id, to],
        )
      }
      return updatedRows[0]!
    })

    // completing / no-show frees the slot — availability must drop stale caches
    await this.cache.dropPrefix(`avail:${tenantId}`)

    const snapshot = await this.snapshot(tenant)
    // queue payload contains customer PII — tenant devices only (never public)
    this.realtime.publish([`tenant:${tenant.id}`], 'queue.updated', snapshot)
    this.realtime.publish(this.realtime.tenantRooms(tenant), 'appointment.status', {
      id: appointmentId,
      status: updated.status,
      action,
    })
    return snapshot
  }
}

@Controller()
export class QueueController {
  constructor(
    private readonly queue: QueueService,
    private readonly tenants: TenancyService,
  ) {}

  @Roles('tenant_admin', 'staff')
  @Get('queue/today')
  async today(@CurrentUser() claims: Claims): Promise<QueueTodayDTO> {
    const tenant = await this.tenants.getTenant(claims.tenant_id!)
    return this.queue.snapshot(tenant)
  }

  @Roles('tenant_admin', 'staff')
  @Post('appointments/:id/status')
  @UsePipes(new ZodValidationPipe(statusBodySchema))
  status(
    @CurrentUser() claims: Claims,
    @Param('id') id: string,
    @Body() body: { action: QueueAction },
  ): Promise<QueueTodayDTO> {
    return this.queue.transition(claims.tenant_id!, claims.sub, id, body.action)
  }
}

@Module({
  imports: [BookingModule],
  controllers: [QueueController],
  providers: [QueueService],
})
export class QueueModule {}
