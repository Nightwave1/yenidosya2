import { z } from 'zod'

export const queueActionSchema = z.enum(['take_chair', 'complete', 'no_show', 'cancel', 'restore'])
export type QueueAction = z.infer<typeof queueActionSchema>

export interface QueueEntryDTO {
  appointment_id: string
  starts_at: string
  customer_name: string
  customer_phone: string | null
  service_name: string
  staff_id: string
  staff_name: string | null
  status: 'booked' | 'in_progress' | 'completed' | 'no_show' | 'cancelled'
}

export interface QueueTodayDTO {
  business_day: string
  current: QueueEntryDTO | null
  upcoming: QueueEntryDTO[]
  completed: QueueEntryDTO[]
  no_shows: QueueEntryDTO[]
  generated_at: string
}
