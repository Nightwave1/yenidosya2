import { z } from 'zod'
import { hhmmSchema, isoDateSchema, uuidSchema, weekdaySchema } from './common'

// ---------------------------------------------------------------------------
// Working hours (tenant weekly pattern)
// ---------------------------------------------------------------------------
export const businessHoursDaySchema = z.object({
  weekday: weekdaySchema,
  is_closed: z.boolean(),
  open_time: hhmmSchema.nullable().optional(),
  close_time: hhmmSchema.nullable().optional(),
  break_start: hhmmSchema.nullable().optional(),
  break_end: hhmmSchema.nullable().optional(),
  note: z.string().max(200).nullable().optional(),
})
export const businessHoursPutSchema = z.object({
  week: z.array(businessHoursDaySchema).length(7),
})
export type BusinessHoursDay = z.infer<typeof businessHoursDaySchema>
export type BusinessHoursPut = z.infer<typeof businessHoursPutSchema>

// ---------------------------------------------------------------------------
// Staff hours
// ---------------------------------------------------------------------------
export const staffHoursDaySchema = z.object({
  weekday: weekdaySchema,
  is_working: z.boolean(),
  start_time: hhmmSchema.nullable().optional(),
  end_time: hhmmSchema.nullable().optional(),
  break_start: hhmmSchema.nullable().optional(),
  break_end: hhmmSchema.nullable().optional(),
})
export const staffHoursPutSchema = z.object({
  week: z.array(staffHoursDaySchema).length(7),
})
export type StaffHoursDay = z.infer<typeof staffHoursDaySchema>
export type StaffHoursPut = z.infer<typeof staffHoursPutSchema>

// ---------------------------------------------------------------------------
// Instant blocks
// ---------------------------------------------------------------------------
export const blockKindSchema = z.enum(['public_holiday', 'holiday', 'emergency', 'illness', 'private', 'other'])

export const blockCreateSchema = z
  .object({
    staff_ids: z.array(uuidSchema).max(50).optional(), // [] or omitted => whole shop
    date_from: isoDateSchema,
    date_to: isoDateSchema.optional(),
    all_day: z.boolean().default(true),
    start_time: hhmmSchema.nullable().optional(), // when all_day=false
    end_time: hhmmSchema.nullable().optional(),
    kind: blockKindSchema.default('other'),
    reason: z.string().max(200).optional(),
    notify_affected: z.boolean().default(false),
  })
  .refine((b) => b.all_day || (b.start_time != null && b.end_time != null), {
    message: 'start_time and end_time are required when all_day = false',
  })
export type BlockCreate = z.infer<typeof blockCreateSchema>

// ---------------------------------------------------------------------------
// Availability (public read model)
// ---------------------------------------------------------------------------
export const availabilityQuerySchema = z.object({
  service_id: uuidSchema,
  staff_id: z.union([z.literal('any'), uuidSchema]).default('any'),
  date: isoDateSchema,
})
export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>

export interface AvailabilityStaffDTO {
  staff_id: string
  slots: string[] // ISO-8601 UTC instants, sorted ascending
}

export interface AvailabilityDTO {
  tenant_id: string
  slug: string
  date: string
  is_closed: boolean
  service: { id: string; duration_min: number; buffer_after_min: number }
  staff: AvailabilityStaffDTO[]
  any_staff_slots: string[]
  computed_at: string
}
