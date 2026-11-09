import { useEffect, useRef } from 'react'
import { io, type Socket } from 'socket.io-client'
import { API_BASE } from './api'

/**
 * One shared Socket.IO connection per shop slug, joined to `public:{slug}`.
 * Sends availability-affecting events to the callback (debounced): instant
 * blocks, weekly-hour changes, competitor bookings, cancellations.
 */
export function useAvailabilityEvents(slug: string | undefined, onInvalidate: () => void) {
  const cbRef = useRef(onInvalidate)
  cbRef.current = onInvalidate

  useEffect(() => {
    if (!slug) return
    const socket: Socket = io(API_BASE || undefined, {
      path: '/ws',
      auth: { slug },
      transports: ['websocket', 'polling'],
      reconnectionDelay: 1500,
      withCredentials: false,
    })

    let timer: number | undefined
    const debounced = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => cbRef.current(), 350)
    }

    const events = ['availability.invalidated', 'appointment.created', 'appointment.status']
    for (const event of events) socket.on(event, debounced)

    return () => {
      window.clearTimeout(timer)
      for (const event of events) socket.off(event, debounced)
      void socket.disconnect()
    }
  }, [slug])
}
