import { HttpStatus, Injectable, Logger, Module, type OnModuleDestroy } from '@nestjs/common'
import { Queue, Worker, type Job } from 'bullmq'
import { env } from '@oleum/db'
import { DbService } from '../infra/db.module'
import type { TenantRow } from '../tenancy/tenancy.module'

export interface CustomerForNotify {
  id: string
  full_name: string
  phone: string | null
  sms_opt_in: boolean
  whatsapp_opt_in: boolean
}

export interface ReminderPlan {
  trigger24h: boolean
  trigger1h: boolean
}

const CHANNEL_PRIORITY = ['push', 'whatsapp', 'sms'] as const

function redisConnection(url: string): { host: string; port: number; password?: string } {
  const u = new URL(url)
  return {
    host: u.hostname || 'localhost',
    port: Number(u.port || 6379),
    password: u.password || undefined,
  }
}

function render(body: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce(
    (acc, [k, v]) => acc.replaceAll(`{${k}}`, v),
    body,
  )
}

interface EnqueueOptions {
  tenant: TenantRow
  appointmentId: string
  customer: CustomerForNotify
  trigger: 'booking_created' | 'reminder_24h' | 'reminder_1h' | 'block_affected'
  scheduledAt: Date
  vars: Record<string, string>
}

/**
 * Notification outbox scheduling (ARCHITECTURE §5.5).
 * Rows are written to `notifications`; BullMQ delivers delayed jobs that a
 * stub provider "sends" (swap with SMS/WhatsApp/WebPush adapters in Phase 1).
 * Every step downgrades to a log when REDIS_URL is unset.
 */
@Injectable()
export class NotificationsService implements OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name)
  private queue?: Queue
  private worker?: Worker

  constructor(private readonly db: DbService) {}

  private conn(): { host: string; port: number; password?: string } | null {
    const url = env.REDIS_URL
    return url ? redisConnection(url) : null
  }

  private getQueue(): Queue | null {
    const conn = this.conn()
    if (!conn) return null
    if (!this.queue) {
      this.queue = new Queue('notifications', { connection: conn })
      this.ensureWorker()
    }
    return this.queue
  }

  private ensureWorker(): void {
    const conn = this.conn()
    if (!conn || this.worker) return
    this.worker = new Worker(
      'notifications',
      async (job: Job<{ notificationId: string; tenantId: string; channel: string; to: string; rendered: string }>) => {
        // TODO(Phase 1.1): swap this stub for real providers (SMS/WhatsApp/WebPush).
        this.logger.log(`👉 [${job.data.channel}-stub] → ${job.data.to}: "${job.data.rendered}"`)
        await this.db.tenant(job.data.tenantId, (sql) =>
          sql.query(
            `UPDATE notifications
             SET status = 'sent', sent_at = now(), provider = $2, provider_message_id = $3
             WHERE id = $1 AND status = 'scheduled'`,
            [job.data.notificationId, `${job.data.channel}-stub`, `stub-${job.data.notificationId}`],
          ),
        )
      },
      { connection: conn },
    )
    this.worker.on('failed', (job, err) => {
      this.logger.error(`notification ${job?.id} failed: ${err.message}`)
    })
  }

  /** Schedules booking_created + reminder_24h + reminder_1h for a new booking. */
  async scheduleBookingReminders(
    tenant: TenantRow,
    appointmentId: string,
    startsAt: Date,
    customer: CustomerForNotify,
    serviceName: string,
    staffName: string,
    checkToken: string,
  ): Promise<void> {
    const baseVars = {
      shop: tenant.name,
      customer: customer.full_name,
      service: serviceName,
      staff: staffName,
      time: startsAt.toISOString(),
      manage_url: `${env.APP_BASE_URL}/${tenant.slug}/appointment/${checkToken}`,
    }
    await this.enqueue(tenant.id, appointmentId, customer, 'booking_created', new Date(), baseVars)
    if (startsAt.getTime() - Date.now() > 24 * 3600_000) {
      await this.enqueue(
        tenant.id,
        appointmentId,
        customer,
        'reminder_24h',
        new Date(startsAt.getTime() - 24 * 3600_000),
        baseVars,
      )
    }
    if (startsAt.getTime() - Date.now() > 3600_000) {
      await this.enqueue(
        tenant.id,
        appointmentId,
        customer,
        'reminder_1h',
        new Date(startsAt.getTime() - 3600_000),
        baseVars,
      )
    }
  }

  /** "Randevunuz maalesef iptal edildi" messages for customers hit by a block. */
  async notifyBlockAffected(
    tenant: TenantRow,
    appointmentId: string,
    startsAt: Date,
    customer: CustomerForNotify,
    reason: string,
  ): Promise<void> {
    await this.enqueue(
      tenant.id,
      appointmentId,
      customer,
      'block_affected',
      new Date(),
      {
        shop: tenant.name,
        customer: customer.full_name,
        time: startsAt.toISOString(),
        reason: reason || 'mağaza kapanışı',
        manage_url: `${env.APP_BASE_URL}/${tenant.slug}`,
      },
    )
  }

  private async enqueue(
    tenantId: string,
    appointmentId: string,
    customer: CustomerForNotify,
    trigger: EnqueueOptions['trigger'],
    scheduledAt: Date,
    vars: Record<string, string>,
  ): Promise<void> {
    try {
      if (scheduledAt.getTime() < Date.now() - 60_000) return // stale reminder
      await this.db.tenant(tenantId, async (sql) => {
        // pick highest-priority consented channel with an approved template
        for (const channel of CHANNEL_PRIORITY) {
          const eligible =
            channel === 'sms'
              ? customer.sms_opt_in
              : channel === 'whatsapp'
                ? customer.whatsapp_opt_in
                : await this.hasPushSubscription(sql, customer.id)
          if (!eligible) continue
          const tpl = await sql.query<{ body: string }>(
            `SELECT body FROM notification_templates
             WHERE trigger = $2 AND channel = $1 AND is_active
               AND (tenant_id = $3 OR tenant_id IS NULL)
             ORDER BY (tenant_id = $3) DESC NULLS LAST
             LIMIT 1`,
            [channel, trigger, tenantId],
          )
          if (tpl.length === 0) continue
          const rendered = render(tpl[0]!.body, vars)
          const [row] = await sql.query<{ id: string }>(
            `INSERT INTO notifications
               (tenant_id, appointment_id, customer_id, channel, trigger, status, scheduled_at, request_payload)
             VALUES ($1, $2, $3, $4, $5, 'scheduled', $6, $7)
             RETURNING id`,
            [
              tenantId,
              appointmentId,
              customer.id,
              channel,
              trigger,
              scheduledAt,
              JSON.stringify({ rendered, to: customer.phone ?? 'push' }),
            ],
          )
          const queue = this.getQueue()
          if (queue && row) {
            const delay = Math.max(0, scheduledAt.getTime() - Date.now())
            await queue.add(
              'send',
              {
                notificationId: row.id,
                tenantId,
                channel,
                to: customer.phone ?? 'push',
                rendered,
              },
              { delay, jobId: `n:${row.id}` },
            )
          } else {
            this.logger.warn(`(no-redis) would send [${trigger}/${channel}] at ${scheduledAt.toISOString()}: "${rendered}"`)
          }
          return // first eligible channel wins
        }
        this.logger.warn(`No consented channel+template for trigger=${trigger}; skipped`)
      })
    } catch (e) {
      this.logger.error(`enqueue failed (non-fatal): ${(e as Error).message}`)
    }
  }

  private async hasPushSubscription(
    sql: Parameters<Parameters<DbService['tenant']>[1]>[0],
    customerId: string,
  ): Promise<boolean> {
    const rows = await sql.query<{ ok: number }>(
      `SELECT 1 AS ok FROM push_subscriptions WHERE customer_id = $1 LIMIT 1`,
      [customerId],
    )
    return rows.length > 0
  }

  /** Best-effort cancellation of reminder jobs/rows when a booking is cancelled upstream. */
  async cancelScheduledForAppointment(tenantId: string, appointmentId: string): Promise<void> {
    try {
      const rows = await this.db.tenant(tenantId, (sql) =>
        sql.query<{ id: string; trigger: string }>(
          `UPDATE notifications
           SET status = 'cancelled', error = COALESCE(error, 'randevu müşteri tarafından iptal edildi')
           WHERE appointment_id = $1 AND status IN ('scheduled', 'queued')
           RETURNING id, trigger`,
          [appointmentId],
        ),
      )
      if (rows.length > 0) {
        this.logger.log(
          `cancelled ${rows.length} scheduled notification(s) [${rows.map((r) => r.trigger).join(', ')}]`,
        )
        const queue = this.queue
        if (queue) {
          await Promise.allSettled(
            rows.map(async (r) => {
              const job = await queue.getJob(`n:${r.id}`)
              if (job) await job.remove().catch(() => undefined)
            }),
          )
        }
      }
    } catch (e) {
      this.logger.warn(`cancelScheduledForAppointment failed (non-fatal): ${(e as Error).message}`)
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.worker?.close(), this.queue?.close()])
  }
}

/** Courier module — global so scheduling/booking/queue can inject it. */
@Module({
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
