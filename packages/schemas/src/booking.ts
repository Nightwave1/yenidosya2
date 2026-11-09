import { z } from 'zod'
import { isoDateSchema, hhmmSchema, uuidSchema } from './common'

const phoneSchema = z
  .string()
  .min(7)
  .max(20)
  .regex(/^[0-9\s()+-]+$/, 'digits, spaces and + ( ) - only')

// Public booking-page order
export const publicBookingSchema = z.object({
  service_id: uuidSchema,
  staff_id: uuidSchema.optional(),
  date: isoDateSchema,
  time: hhmmSchema,
  full_name: z.string().min(2).max(80),
  phone: phoneSchema,
  note: z.string().max(500).optional(),
  /** reminder consent (KVKK): explicit false when unchecked */
  sms_opt_in: z.boolean().default(false),
  whatsapp_opt_in: z.boolean().default(false),
})
export type PublicBookingDTO = z.infer<typeof publicBookingSchema>

// Panel/manual order (retro entry or immediate walk-in)
export const panelBookingSchema = z
  .object({
    service_id: uuidSchema,
    staff_id: uuidSchema.optional(),
    start: z
      .object({
        date: isoDateSchema,
        time: hhmmSchema,
      })
      .optional(), // omitted => "right now" walk-in
    customer_id: uuidSchema.optional(),
    customer: z
      .object({
        full_name: z.string().min(2).max(80),
        phone: phoneSchema,
      })
      .optional(),
    note: z.string().max(500).optional(),
    start_in_progress: z.boolean().default(false), // walk-in: straight to the chair
  })
  .refine((b) => b.customer_id != null || b.customer != null, {
    message: 'customer_id or customer is required',
  })
export type PanelBookingDTO = z.infer<typeof panelBookingSchema>

export interface AppointmentDTO {
  id: string
  tenant_id: string
  customer_id: string
  staff_id: string
  service_id: string
  service_name: string
  starts_at: string
  ends_at: string
  status: 'booked' | 'in_progress' | 'completed' | 'no_show' | 'cancelled'
  source: 'booking_page' | 'qr_shortlink' | 'panel' | 'walk_in' | 'phone' | 'import'
  check_token: string
  created_at: string
}

/**
 * Public "manage my appointment" payload, resolved by check_token (the link
 * embedded in reminder messages). Safe to expose — no phone/PII beyond name.
 */
export interface ManageAppointmentDTO {
  id: string
  status: AppointmentDTO['status']
  service_name: string
  staff_name: string | null
  customer_name: string
  starts_at: string
  ends_at: string
  timezone: string | null
  can_cancel: boolean
}
