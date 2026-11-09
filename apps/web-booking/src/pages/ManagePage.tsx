import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import type { ManageAppointmentDTO } from '@oleum/schemas'
import { api, ApiError } from '../lib/api'
import { appointmentWhen } from '../lib/format'
import { Banner, Card, GhostButton, PrimaryButton, Spinner, StatusPill } from '../components/ui'

/**
 * Public appointment management — opened via the check-token link embedded
 * in reminder messages: /{slug}/appointment/{check_token}
 * Lets the customer cancel while the appointment is still upcoming.
 */
export default function ManagePage() {
  const { slug = '', checkToken = '' } = useParams()

  const [dto, setDto] = useState<ManageAppointmentDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<ApiError | null>(null)
  const [banner, setBanner] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      setDto(await api.manage(slug, checkToken))
      document.title = 'Randevun · Randevu'
    } catch (e) {
      setErr(e instanceof ApiError ? e : new ApiError('UNKNOWN', 'Bir şeyler ters gitti', null))
    } finally {
      setLoading(false)
    }
  }, [slug, checkToken])

  useEffect(() => {
    if (slug && checkToken) void load()
  }, [slug, checkToken, load])

  const cancelAppointment = async () => {
    if (!dto) return
    setConfirming(false)
    setCancelling(true)
    try {
      setDto(await api.cancel(slug, checkToken))
      setBanner({ kind: 'success', text: 'Randevun iptal edildi. Başka bir zaman görüşmek üzere 👋' })
    } catch (e) {
      setBanner({
        kind: 'error',
        text:
          e instanceof ApiError
            ? e.message
            : 'İptal başarısız oldu — lütfen dükkanı arayın.',
      })
      // refresh in case the state changed meanwhile (e.g. took place already)
      void load()
    } finally {
      setCancelling(false)
    }
  }

  if (loading) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-slate-400">
          <Spinner className="h-8 w-8" />
          <p className="text-sm">Randevun kontrol ediliyor…</p>
        </div>
      </main>
    )
  }

  if (err || !dto) {
    const notFound = err?.code === 'APPOINTMENT_NOT_FOUND' || err?.code === 'SHOP_NOT_FOUND'
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-5xl">{notFound ? '🧐' : '⚠️'}</p>
        <h1 className="text-xl font-bold">{notFound ? 'Randevu bulunamadı' : 'Bir sorun oldu'}</h1>
        <p className="text-sm text-slate-400">
          {notFound
            ? 'Bağlantı geçersiz olabilir. Hemen son randevularını dükkanla konuşarak kontrol edebilirsin.'
            : err?.message}
        </p>
        <div className="w-40">
          {notFound ? (
            <PrimaryButton onClick={() => window.location.assign('/')}>Ana sayfa</PrimaryButton>
          ) : (
            <PrimaryButton onClick={() => void load()}>Tekrar dene</PrimaryButton>
          )}
        </div>
      </main>
    )
  }

  const canCancel = dto.can_cancel

  return (
    <main className="mx-auto min-h-dvh max-w-md px-4 pb-24 pt-8">
      {banner && (
        <Banner kind={banner.kind === 'success' ? 'info' : 'error'}>{banner.text}</Banner>
      )}

      <div className="mb-6 text-center">
        <p className="mb-2 text-4xl">{dto.status === 'cancelled' ? '🌙' : '💈'}</p>
        <h1 className="text-2xl font-extrabold">
          {dto.status === 'cancelled' ? 'Randevu iptal edildi' : needsChair(dto.status) ? 'Randevun aktif' : 'Randevun hazır'}
        </h1>
        <div className="mt-2 flex justify-center">
          <StatusPill status={dto.status} />
        </div>
      </div>

      <Card className="p-4">
        <Row label="Hizmet" value={dto.service_name} />
        <Row label="Usta" value={dto.staff_name ?? '—'} />
        <Row label="Müşteri" value={dto.customer_name} />
        <Row label="Zaman" value={appointmentWhen(dto.starts_at, dto.timezone ?? 'Europe/Istanbul')} />
      </Card>

      <div className="mt-5 space-y-2">
        {canCancel && (confirming ? (
          <>
            <PrimaryButton onClick={() => void cancelAppointment()} disabled={cancelling}>
              {cancelling ? 'İptal ediliyor…' : 'Evet, randevumu iptal et'}
            </PrimaryButton>
            <GhostButton onClick={() => setConfirming(false)}>Vazgeç</GhostButton>
          </>
        ) : (
          <GhostButton onClick={() => setConfirming(true)}>Randevuyu iptal et</GhostButton>
        ))}
        <GhostButton
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(window.location.href)
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1600)
            } catch {
              /* clipboard denied */
            }
          }}
        >
          {copied ? 'Kopyalandı ✓' : 'Bu sayfanın linkini kopyala'}
        </GhostButton>
        {typeof navigator.share === 'function' && (
          <GhostButton
            onClick={() =>
              void navigator
                .share({ title: 'Randevum', url: window.location.href })
                .catch(() => undefined)
            }
          >
            Randevu kartını paylaş
          </GhostButton>
        )}
      </div>

      {canCancel && (
        <p className="mt-4 text-center text-xs text-slate-500">
          İptal ettiğin saat anında diğer müşterilere açılır.
        </p>
      )}
      <p className="mt-8 text-center text-xs text-slate-600">Randevu App</p>
    </main>
  )
}

function needsChair(status: ManageAppointmentDTO['status']): boolean {
  return status === 'in_progress'
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="text-sm text-slate-400">{label}</span>
      <span className="text-right text-sm font-semibold">{value}</span>
    </div>
  )
}
