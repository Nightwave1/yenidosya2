import { z } from 'zod'

export const uuidSchema = z.string().uuid()
export const slugSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'lowercase letters, digits and dashes')
export const hhmmSchema = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'HH:mm')
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'yyyy-MM-dd')

/**weekday 1=Mon … 7=Sun (isodow convention) */
export const weekdaySchema = z.number().int().min(1).max(7)
