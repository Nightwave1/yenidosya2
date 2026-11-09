import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'
import { closePool } from './pool'
import { withSystem } from './sql'

const DEMO_SLUG = 'berber-ahmet'

/** Tomorrow's date in the tenant timezone (Istanbul, UTC+3 fixed). */
function tomorrowISO(): string {
  const ist = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10)
  return new Date(Date.parse(`${ist}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
}

async function seed(): Promise<void> {
  const existing = await withSystem(async (q) =>
    q.query<{ id: string }>('SELECT id FROM tenants WHERE slug = $1', [DEMO_SLUG]),
  )
  if (existing.length > 0) {
    console.log('Demo tenant already seeded — nothing to do.')
    return
  }

  await withSystem(async (q) => {
    const [tenant] = await q.query<{ id: string }>(
      `INSERT INTO tenants (name, slug, settings, phone, email, address_text, city, district)
       VALUES ('Berber Ahmet', $1, $2, '+905321234567', 'ahmet@demo.barber',
               'Atatürk Cd. No:42', 'İstanbul', 'Kadıköy')
       RETURNING id`,
      [DEMO_SLUG, JSON.stringify({ min_notice_minutes: 30, max_advance_days: 30, slot_granularity: 15 })],
    )

    const passwordHash = await bcrypt.hash('Owner#1234', 10)
    await q.query(
      `INSERT INTO users (tenant_id, role, full_name, email, password_hash)
       VALUES ($1, 'tenant_admin', 'Ahmet Yılmaz', 'owner@demo.barber', $2)`,
      [tenant!.id, passwordHash],
    )

    const staffIds: string[] = []
    for (const [name, color] of [
      ['Ahmet', '#2563eb'],
      ['Emre', '#f59e0b'],
    ] as const) {
      const [s] = await q.query<{ id: string }>(
        `INSERT INTO staff (tenant_id, display_name, color, role_title)
         VALUES ($1, $2, $3, 'Master Barber') RETURNING id`,
        [tenant!.id, name, color],
      )
      staffIds.push(s!.id)
      for (let wd = 1; wd <= 6; wd++) {
        await q.query(
          `INSERT INTO staff_hours (staff_id, weekday, is_working, start_time, end_time)
           VALUES ($1, $2, true, '09:00', '21:00')`,
          [s!.id, wd],
        )
      }
    }

    for (let wd = 1; wd <= 7; wd++) {
      await q.query(
        `INSERT INTO business_hours (tenant_id, weekday, is_closed, open_time, close_time)
         VALUES ($1, $2, $3, '09:00', '21:00')`,
        [tenant!.id, wd, wd === 7],
      )
    }

    const serviceIds: string[] = []
    for (const [name, price, duration, buffer] of [
      ['Saç kesimi', '250.00', 30, 10],
      ['Saç + Sakal', '350.00', 45, 10],
      ['Sakal tasarımı', '200.00', 20, 5],
    ] as const) {
      const [s] = await q.query<{ id: string }>(
        `INSERT INTO services (tenant_id, name, price, duration_min, buffer_after_min)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [tenant!.id, name, price, duration, buffer],
      )
      serviceIds.push(s!.id)
      for (const staffId of staffIds) {
        await q.query(`INSERT INTO staff_services (staff_id, service_id) VALUES ($1, $2)`, [
          staffId,
          s!.id,
        ])
      }
    }

    const [pro] = await q.query<{ id: string }>(`SELECT id FROM plans WHERE code = 'pro'`)
    await q.query(
      `INSERT INTO subscriptions (tenant_id, plan_id, status, trial_ends_at, current_period_start)
       VALUES ($1, $2, 'trial', now() + interval '14 days', now())`,
      [tenant!.id, pro!.id],
    )
    await q.query(
      `INSERT INTO short_links (tenant_id, kind, code, label)
       VALUES ($1, 'qr', $2, 'Tezgah posteri')`,
      [tenant!.id, `q_${randomUUID().slice(0, 8)}`],
    )

    // One demo appointment (tomorrow 12:00 İST) so the live queue has data.
    const tomorrow = tomorrowISO()
    const startsAt = new Date(Date.parse(`${tomorrow}T09:00:00Z`)) // 12:00 İST
    const endsAt = new Date(startsAt.getTime() + (45 + 10) * 60_000)
    const [customer] = await q.query<{ id: string }>(
      `INSERT INTO customers (tenant_id, full_name, phone, sms_opt_in, whatsapp_opt_in)
       VALUES ($1, 'Ali Veli', '+905321111111', true, true) RETURNING id`,
      [tenant!.id],
    )
    await q.query(
      `INSERT INTO appointments (tenant_id, customer_id, staff_id, service_id,
         service_name_snap, duration_min_snap, price_snap, starts_at, ends_at,
         status, source, idempotency_key, link_event_id)
       VALUES ($1, $2, $3, $4, 'Saç + Sakal', 45, 350.00, $5, $6, 'booked', 'panel', $7, NULL)`,
      [tenant!.id, customer!.id, staffIds[0]!, serviceIds[1]!, startsAt, endsAt, randomUUID()],
    )

    console.log('─────────────────────────────────────────────────────')
    console.log(' DEMO READY')
    console.log(' Booking page slug: berber-ahmet')
    console.log(' Panel login      : owner@demo.barber / Owner#1234')
    console.log(` Services         : ${serviceIds.join(', ')}`)
    console.log('─────────────────────────────────────────────────────')
    console.log(' Try availability:')
    console.log(
      ` curl "http://localhost:4000/v1/public/tenants/${DEMO_SLUG}/availability?service_id=${serviceIds[1]}&date=${tomorrow}"`,
    )
  })
}

seed()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(closePool)
