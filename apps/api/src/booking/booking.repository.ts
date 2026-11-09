import { DateTime } from 'luxon'
import { DbService } from '../infra/db.module'
import { DomainError } from '../common/domain-error'

// ---------------------------------------------------------------------------
// Row types (snake_case mirrors the schema)
// ---------------------------------------------------------------------------

export interface ServiceRow {
  id: string
  name: string
  price: string
  duration_min: number
  buffer_after_min: number
}

export interface StaffLiteRow {
  id: string
  display_name: string
  color: string
  sort_order: number
}

export interface BusinessHoursRow {
  weekday: number
  is_closed: boolean
  open_time: string | null
  close_time: string | null
  break_start: string | null
  break_end: string | null
}

export interface StaffHoursRow {
  staff_id: string
  weekday: number
  is_working: boolean
  start_time: string | null
  end_time: string | null
  break_start: string | null
  break_end: string | null
}

export interface BusyRow {
  staff_id: string | null
  starts_at: Date
  ends_at: Date
}

/** appointments.staff_id is NOT NULL — a dedicated widening-friendly shape */
export interface AppointmentBusyRow {
  staff_id: string
  starts_at: Date
  ends_at: Date
}

export interface CustomerRow {
  id: string
  full_name: string
  phone: string
  sms_opt_in: boolean
  whatsapp_opt_in: boolean
  no_show_count: number
  completed_count: number
}

export interface AppointmentRow {
  id: string
  tenant_id: string
  customer_id: string
  staff_id: string
  service_id: string
  service_name_snap: string
  duration_min_snap: number
  price_snap: string
  starts_at: Date
  ends_at: Date
  actual_start_at: Date | null
  actual_end_at: Date | null
  status: 'booked' | 'in_progress' | 'completed' | 'no_show' | 'cancelled'
  source: 'booking_page' | 'qr_shortlink' | 'panel' | 'walk_in' | 'phone' | 'import'
  customer_note: string | null
  check_token: string
  idempotency_key: string
  created_at: Date
}

export interface AppointmentJoinedRow extends AppointmentRow {
  customer_name: string
  customer_phone: string | null
  staff_name: string
}

/** pg TIME columns arrive as "HH:mm:ss" — normalize to "HH:mm". */
export function hhmm(value: string | null | undefined): string | null {
  return value ? String(value).slice(0, 5) : null
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export interface InsertAppointmentParams {
  tenantId: string
  customer_id: string
  staff_id: string
  service_id: string
  service_name_snap: string
  duration_min_snap: number
  price_snap: string
  starts_at: Date
  ends_at: Date
  status: 'booked' | 'in_progress'
  source: 'booking_page' | 'panel' | 'walk_in'
  customer_note: string | null
  idempotency_key: string
}

export class BookingRepository {
  constructor(private readonly db: DbService) {}

  async loadService(tenantId: string, serviceId: string): Promise<ServiceRow | null> {
    const rows = await this.db.tenant(tenantId, (sql) =>
      sql.query<ServiceRow>(
        `SELECT id, name, price, duration_min, buffer_after_min
         FROM services WHERE id = $1 AND is_active LIMIT 1`,
        [serviceId],
      ),
    )
    return rows[0] ?? null
  }

  /**
   * Loads everything the engine needs for one tenant-local business day.
   * NOTE: tenant scoping relies on RLS (withTenant sets app.tenant_id) —
   * tenant_id predicates are intentionally omitted from these queries.
   */
  async loadDayAvailability(
    tenantId: string,
    timezone: string,
    dateISO: string,
    serviceId?: string,
  ): Promise<{
    weekday: number
    businessHours: BusinessHoursRow | null
    staff: StaffLiteRow[]
    staffHours: Map<string, StaffHoursRow | undefined>
    appointmentsByStaff: Map<string, BusyRow[]>
    blocksByStaff: Map<string, BusyRow[]>
    tenantWideBlocks: BusyRow[]
  }> {
    const day = DateTime.fromISO(dateISO, { zone: timezone })
    if (!day.isValid) throw new DomainError('BAD_DATE', 'Invalid date')

    const weekday = day.weekday
    const dayStart = day.startOf('day').toJSDate()
    const dayEnd = day.plus({ days: 1 }).startOf('day').toJSDate()

    return this.db.tenant(tenantId, async (sql) => {
      const businessHoursRows = await sql.query<BusinessHoursRow>(
        `SELECT weekday, is_closed, open_time, close_time, break_start, break_end
         FROM business_hours WHERE weekday = $1`,
        [weekday],
      )
      // Staff roster scoped to the requested service: only barbers mapped in
      // staff_services offer it; if nobody is mapped at all, everyone does.
      const staffRows = serviceId
        ? await sql.query<StaffLiteRow>(
            `SELECT s.id, s.display_name, s.color, s.sort_order
             FROM staff s
             WHERE s.is_active AND (
               EXISTS (SELECT 1 FROM staff_services ss
                       WHERE ss.staff_id = s.id AND ss.service_id = $2)
               OR NOT EXISTS (SELECT 1 FROM staff_services ss WHERE ss.service_id = $2)
             )
             ORDER BY s.sort_order ASC, s.display_name ASC`,
            [tenantId, serviceId],
          )
        : await sql.query<StaffLiteRow>(
            `SELECT id, display_name, color, sort_order FROM staff
             WHERE is_active ORDER BY sort_order ASC, display_name ASC`,
          )
      const staffIds = staffRows.map((s) => s.id)

      const staffHours = staffIds.length
        ? await sql.query<StaffHoursRow>(
            `SELECT staff_id, weekday, is_working, start_time, end_time, break_start, break_end
             FROM staff_hours WHERE staff_id = ANY($1::uuid[])`,
            [staffIds],
          )
        : []

      const appointments = staffIds.length
        ? await sql.query<AppointmentBusyRow>(
            `SELECT staff_id, starts_at, ends_at FROM appointments
             WHERE status IN ('booked', 'in_progress')
               AND tstzrange(starts_at, ends_at) && tstzrange($2, $3)
               AND staff_id = ANY($1::uuid[])`,
            [staffIds, dayStart, dayEnd],
          )
        : []

      const blocks = staffIds.length
        ? await sql.query<BusyRow>(
            `SELECT staff_id, starts_at, ends_at FROM schedule_blocks
             WHERE deleted_at IS NULL
               AND tstzrange(starts_at, ends_at) && tstzrange($2, $3)
               AND (staff_id IS NULL OR staff_id = ANY($1::uuid[]))`,
            [staffIds, dayStart, dayEnd],
          )
        : []

      const staffHoursMap = new Map<string, StaffHoursRow | undefined>()
      for (const id of staffIds) {
        staffHoursMap.set(id, staffHours.find((h) => h.staff_id === id && h.weekday === weekday))
      }
      const appointmentsMap = new Map<string, BusyRow[]>()
      const blocksMap = new Map<string, BusyRow[]>()
      const tenantWideBlocks: BusyRow[] = []
      for (const id of staffIds) {
        appointmentsMap.set(id, [])
        blocksMap.set(id, [])
      }
      for (const row of appointments) {
        appointmentsMap.get(row.staff_id)?.push(row)
      }
      for (const row of blocks) {
        if (row.staff_id === null) tenantWideBlocks.push(row)
        else blocksMap.get(row.staff_id)?.push(row)
      }

      return {
        weekday,
        businessHours: businessHoursRows[0] ?? null,
        staff: staffRows,
        staffHours: staffHoursMap,
        appointmentsByStaff: appointmentsMap,
        blocksByStaff: blocksMap,
        tenantWideBlocks,
      }
    })
  }

  async countBookingsPerStaff(
    tenantId: string,
    dayStart: Date,
    dayEnd: Date,
    staffIds: string[],
  ): Promise<Map<string, number>> {
    if (staffIds.length === 0) return new Map()
    const rows = await this.db.tenant(tenantId, (sql) =>
      sql.query<{ staff_id: string; n: number }>(
        `SELECT staff_id, count(*)::int AS n FROM appointments
         WHERE status <> 'cancelled' AND starts_at >= $2 AND starts_at < $3
           AND staff_id = ANY($1::uuid[])
         GROUP BY staff_id`,
        [staffIds, dayStart, dayEnd],
      ),
    )
    return new Map(rows.map((r) => [r.staff_id, r.n]))
  }

  async upsertCustomer(
    tenantId: string,
    fullName: string,
    phone: string,
    opts: { smsOptIn?: boolean; whatsappOptIn?: boolean } = {},
  ): Promise<CustomerRow> {
    const rows = await this.db.tenant(tenantId, (sql) =>
      sql.query<CustomerRow>(
        `INSERT INTO customers (tenant_id, full_name, phone, sms_opt_in, whatsapp_opt_in)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, phone_hash)
         DO UPDATE SET
           full_name = EXCLUDED.full_name,
           updated_at = now(),
           -- consent is sticky: never silently downgrade true → false
           sms_opt_in = customers.sms_opt_in OR EXCLUDED.sms_opt_in,
           whatsapp_opt_in = customers.whatsapp_opt_in OR EXCLUDED.whatsapp_opt_in
         RETURNING id, full_name, phone, sms_opt_in, whatsapp_opt_in, no_show_count, completed_count`,
        [tenantId, fullName.trim(), phone.trim(), opts.smsOptIn ?? false, opts.whatsappOptIn ?? false],
      ),
    )
    return rows[0]!
  }

  async getCustomer(tenantId: string, customerId: string): Promise<CustomerRow | null> {
    const rows = await this.db.tenant(tenantId, (sql) =>
      sql.query<CustomerRow>(
        `SELECT id, full_name, phone, sms_opt_in, whatsapp_opt_in, no_show_count, completed_count
         FROM customers WHERE id = $1 LIMIT 1`,
        [customerId],
      ),
    )
    return rows[0] ?? null
  }

  async searchCustomers(tenantId: string, search: string): Promise<CustomerRow[]> {
    return this.db.tenant(tenantId, (sql) =>
      search.trim() === ''
        ? sql.query<CustomerRow>(
            `SELECT id, full_name, phone, sms_opt_in, whatsapp_opt_in, no_show_count, completed_count
             FROM customers ORDER BY created_at DESC LIMIT 20`,
          )
        : sql.query<CustomerRow>(
            `SELECT id, full_name, phone, sms_opt_in, whatsapp_opt_in, no_show_count, completed_count
             FROM customers
             WHERE full_name ILIKE $1 OR phone ILIKE $1
             ORDER BY created_at DESC LIMIT 20`,
            [`%${search.trim()}%`],
          ),
    )
  }

  async listStaff(
    tenantId: string,
  ): Promise<(StaffLiteRow & { service_ids: string[] })[]> {
    return this.db.tenant(tenantId, (sql) =>
      sql.query<StaffLiteRow & { service_ids: string[] }>(
        `SELECT s.id, s.display_name, s.color, s.sort_order,
                COALESCE(
                  json_agg(ss.service_id) FILTER (WHERE ss.service_id IS NOT NULL),
                  '[]'::json
                ) AS service_ids
         FROM staff s
         LEFT JOIN staff_services ss ON ss.staff_id = s.id
         WHERE s.is_active
         GROUP BY s.id, s.display_name, s.color, s.sort_order
         ORDER BY s.sort_order ASC, s.display_name ASC`,
      ),
    )
  }

  async listServices(tenantId: string): Promise<ServiceRow[]> {
    return this.db.tenant(tenantId, (sql) =>
      sql.query<ServiceRow>(
        `SELECT id, name, price, duration_min, buffer_after_min
         FROM services WHERE is_active
         ORDER BY sort_order ASC, created_at ASC`,
      ),
    )
  }

  async getStaffName(tenantId: string, staffId: string): Promise<string | null> {
    const rows = await this.db.tenant(tenantId, (sql) =>
      sql.query<{ display_name: string }>(`SELECT display_name FROM staff WHERE id = $1`, [staffId]),
    )
    return rows[0]?.display_name ?? null
  }

  async insertAppointment(params: InsertAppointmentParams): Promise<AppointmentRow> {
    const rows = await this.db.tenant(params.tenantId, (sql) =>
      sql.query<AppointmentRow>(
        `INSERT INTO appointments
           (tenant_id, customer_id, staff_id, service_id, service_name_snap,
            duration_min_snap, price_snap, starts_at, ends_at, status, source,
            customer_note, idempotency_key, actual_start_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING
           id, tenant_id, customer_id, staff_id, service_id, service_name_snap,
           duration_min_snap, price_snap, starts_at, ends_at, actual_start_at,
           actual_end_at, status, source, customer_note, check_token,
           idempotency_key, created_at`,
        [
          params.tenantId,
          params.customer_id,
          params.staff_id,
          params.service_id,
          params.service_name_snap,
          params.duration_min_snap,
          params.price_snap,
          params.starts_at,
          params.ends_at,
          params.status,
          params.source,
          params.customer_note,
          params.idempotency_key,
          params.status === 'in_progress' ? params.starts_at : null,
        ],
      ),
    )
    return rows[0]!
  }

  async findByIdempotencyKey(tenantId: string, key: string): Promise<AppointmentRow | null> {
    const rows = await this.db.tenant(tenantId, (sql) =>
      sql.query<AppointmentRow>(
        `SELECT id, tenant_id, customer_id, staff_id, service_id, service_name_snap,
                duration_min_snap, price_snap, starts_at, ends_at, actual_start_at,
                actual_end_at, status, source, customer_note, check_token,
                idempotency_key, created_at
         FROM appointments WHERE idempotency_key = $1 LIMIT 1`,
        [key],
      ),
    )
    return rows[0] ?? null
  }

  async listForDay(
    tenantId: string,
    dayStart: Date,
    dayEnd: Date,
    opts: { staffId?: string | null; status?: string | null } = {},
  ): Promise<AppointmentJoinedRow[]> {
    const clauses = ['a.starts_at >= $2', 'a.starts_at < $3']
    const values: unknown[] = [tenantId, dayStart, dayEnd]
    if (opts.staffId) {
      values.push(opts.staffId)
      clauses.push(`a.staff_id = $${values.length}`)
    }
    if (opts.status) {
      values.push(opts.status)
      clauses.push(`a.status = $${values.length}`)
    }
    return this.db.tenant(tenantId, (sql) =>
      sql.query<AppointmentJoinedRow>(
        `SELECT a.id, a.tenant_id, a.customer_id, a.staff_id, a.service_id,
                a.service_name_snap, a.duration_min_snap, a.price_snap,
                a.starts_at, a.ends_at, a.actual_start_at, a.actual_end_at,
                a.status, a.source, a.customer_note, a.check_token,
                a.idempotency_key, a.created_at,
                c.full_name AS customer_name, c.phone AS customer_phone,
                st.display_name AS staff_name
         FROM appointments a
         JOIN customers c ON c.id = a.customer_id
         JOIN staff st ON st.id = a.staff_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY a.starts_at ASC`,
        values,
      ),
    )
  }
}

