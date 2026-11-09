import type {
  AppointmentDTO,
  AvailabilityDTO,
  ManageAppointmentDTO,
  PublicBookingDTO,
} from '@oleum/schemas'

/** Empty when served from the same origin as the API (dev proxy / prod gateway). */
export const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? ''

export class ApiError extends Error {
  readonly code: string
  readonly payload: unknown

  constructor(code: string, message: string, payload: unknown) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.payload = payload
  }
}

// ---------------------------------------------------------------------------
// read models (kept aligned with the API's public payloads)
// ---------------------------------------------------------------------------

export interface ShopProfile {
  slug: string
  name: string
  logo_url: string | null
  address: string | null
  phone: string | null
  currency: string
  timezone: string
}

export interface ServiceLite {
  id: string
  name: string
  description: string | null
  price: number
  duration_min: number
  buffer_after_min: number
  image_url: string | null
  category: string | null
}

export interface StaffLite {
  id: string
  display_name: string
  color: string
  role_title: string | null
  service_ids: string[]
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(API_BASE + path, init)
  } catch {
    throw new ApiError('NETWORK', 'Bağlantı kurulamadı — internetini kontrol et', null)
  }
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const parsed = body as { code?: string; message?: string } | null
    throw new ApiError(parsed?.code ?? `HTTP_${res.status}`, parsed?.message ?? 'Bir şeyler ters gitti', body)
  }
  return body as T
}

const enc = encodeURIComponent

export const api = {
  profile: (slug: string) => request<ShopProfile>(`/v1/public/tenants/${enc(slug)}`),

  services: (slug: string) =>
    request<ServiceLite[]>(`/v1/public/tenants/${enc(slug)}/services`),

  staff: (slug: string) => request<StaffLite[]>(`/v1/public/tenants/${enc(slug)}/staff`),

  availability: (
    slug: string,
    q: { service_id: string; staff_id: string; date: string },
  ) =>
    request<AvailabilityDTO>(
      `/v1/public/tenants/${enc(slug)}/availability?service_id=${enc(q.service_id)}&staff_id=${enc(q.staff_id)}&date=${enc(q.date)}`,
    ),

  createBooking: (
    slug: string,
    payload: PublicBookingDTO,
    idempotencyKey: string,
  ) =>
    request<{ appointment: AppointmentDTO; replayed: boolean }>(
      `/v1/public/tenants/${enc(slug)}/appointments`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify(payload),
      },
    ),

  manage: (slug: string, checkToken: string) =>
    request<ManageAppointmentDTO>(`/v1/public/tenants/${enc(slug)}/appointments/${enc(checkToken)}`),

  cancel: (slug: string, checkToken: string) =>
    request<ManageAppointmentDTO>(`/v1/public/tenants/${enc(slug)}/appointments/${enc(checkToken)}/cancel`, {
      method: 'POST',
    }),
}
