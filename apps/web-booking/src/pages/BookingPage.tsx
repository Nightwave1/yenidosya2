import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import type { AppointmentDTO, AvailabilityDTO, PublicBookingDTO } from '@oleum/schemas'
import { api, ApiError, type ServiceLite, type ShopProfile, type StaffLite } from '../lib/api'
import { useAvailabilityEvents } from '../lib/rt'
import {
  icsHref,
  appointmentWhen,
  dateChip,
  datesRange,
  durationLabel,
  GROUP_ORDER,
  money,
  slotGroupOf,
  slotTime,
  todayISO,
  uuidKey,
  type SlotGroup,
} from '../lib/format'
import {
  Banner,
  Card,
  GhostButton,
  PrimaryButton,
  Spinner,
  StaffAvatar,
} from '../components/ui'

type Step = 'service' | 'staff' | 'time' | 'form' | 'success'

interface BannerMsg {
  kind: 'error' | 'warn' | 'info'
  text: string
}

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const STEP_LABEL: Record<Exclude<Step, 'success'>, string> = {
  service: 'Hizmet',
  staff: 'Usta',
  time: 'Saat',
  form: 'Onay',
}

const NEXT_DAY_COUNT = 14

export default function BookingPage() {
  const { slug = '' } = useParams()

  // shop data
  const [shop, setShop] = useState<{
    profile: ShopProfile
    services: ServiceLite[]
    staff: StaffLite[]
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<ApiError | null>(null)

  // wizard state
  const [step, setStep] = useState<Step>('service')
  const [serviceId, setServiceId] = useState<string | null>(null)
  const [staffId, setStaffId] = useState<'any' | string>('any')
  const [dateISO, setDateISO] = useState<string | null>(null)
  const [timeISO, setTimeISO] = useState<string | null>(null)

  // details form
  const [fullName, setFullName] = useState('')
  const [phone, setPhone] = useState('')
  const [note, setNote] = useState('')
  const [smsConsent, setSmsConsent] = useState(true)
  const [waConsent, setWaConsent] = useState(true)

  // availability read model
  const [avail, setAvail] = useState<AvailabilityDTO | null>(null)
  const [availLoading, setAvailLoading] = useState(false)
  const [banner, setBanner] = useState<BannerMsg | null>(null)

  // submit
  const [submitting, setSubmitting] = useState(false)
  const [appointment, setAppointment] = useState<AppointmentDTO | null>(null)
  const [copied, setCopied] = useState(false)

  // install prompt (Android/desktop; iOS shows manual instructions)
  const [installable, setInstallable] = useState(false)
  const installEvtRef = useRef<InstallPromptEvent | null>(null)

  const idemKeyRef = useRef<string | null>(null)
  const availReqRef = useRef(0)

  const tz = shop?.profile.timezone ?? 'Europe/Istanbul'
  const currency = shop?.profile.currency ?? 'TRY'
  const chosenService = shop?.services.find((s) => s.id === serviceId) ?? null
  const selectedStaff = staffId === 'any' ? null : shop?.staff.find((s) => s.id === staffId) ?? null

  // ------------------------------------------------------------------ load
  const loadShop = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const [profile, services, staff] = await Promise.all([
        api.profile(slug),
        api.services(slug),
        api.staff(slug),
      ])
      setShop({ profile, services, staff })
      setDateISO(todayISO(profile.timezone))
      document.title = `${profile.name} · Randevu`
    } catch (e) {
      setLoadError(e instanceof ApiError ? e : new ApiError('UNKNOWN', 'Bir şeyler ters gitti', null))
    } finally {
      setLoading(false)
    }
  }, [slug])

  useEffect(() => {
    void loadShop()
  }, [loadShop])

  // ------------------------------------------------------------ availability
  const loadAvailability = useCallback(
    async (fresh: boolean) => {
      if (!slug || !serviceId || !dateISO) return
      const req = ++availReqRef.current
      setAvailLoading(true)
      try {
        const data = await api.availability(slug, {
          service_id: serviceId,
          staff_id: staffId,
          date: dateISO,
        })
        if (req !== availReqRef.current) return // superseded by a newer fetch
        setAvail(data)

        // keep the user's slot honest — drop it when it vanished mid-flight
        const pool = data.is_closed
          ? []
          : staffId === 'any'
            ? data.any_staff_slots
            : data.staff.find((s) => s.staff_id === staffId)?.slots ?? []
        setTimeISO((cur) => (cur && !pool.includes(cur) ? null : cur))
      } catch (e) {
        if (req === availReqRef.current) {
          setAvail(null)
          setBanner({
            kind: 'error',
            text: e instanceof ApiError ? e.message : 'Boş saatler yüklenemedi',
          })
        }
      } finally {
        if (req === availReqRef.current) setAvailLoading(false)
      }
    },
    [slug, serviceId, dateISO, staffId],
  )

  // realtime slot invalidation (instant blocks, competitor bookings, …)
  useAvailabilityEvents(slug || undefined, () => {
    if (step === 'time') void loadAvailability(true)
  })

  // enter-time / change-selection fetch
  useEffect(() => {
    if (step === 'time' && serviceId && dateISO) void loadAvailability(false)
  }, [step, serviceId, dateISO, staffId, loadAvailability])

  // light polling fallback when realtime is unavailable
  useEffect(() => {
    if (step !== 'time') return
    const timer = window.setInterval(() => {
      if (!document.hidden) void loadAvailability(false)
    }, 25_000)
    return () => window.clearInterval(timer)
  }, [step, loadAvailability])

  // ------------------------------------------------------------ derived data
  const eligibleStaff = useMemo(() => {
    if (!shop || !serviceId) return []
    return shop.staff.filter(
      (m) => m.service_ids.length === 0 || m.service_ids.includes(serviceId),
    )
  }, [shop, serviceId])

  const slots = useMemo(() => {
    if (avail === null || avail.is_closed) return []
    if (staffId === 'any') return avail.any_staff_slots
    return avail.staff.find((s) => s.staff_id === staffId)?.slots ?? []
  }, [avail, staffId])

  const grouped = useMemo(() => {
    const out: Record<SlotGroup, string[]> = { Sabah: [], 'Öğleden sonra': [], Akşam: [] }
    for (const iso of slots) out[slotGroupOf(slotTime(iso, tz))].push(iso)
    return out
  }, [slots, tz])

  const manageUrl = appointment
    ? `${window.location.origin}/${slug}/appointment/${appointment.check_token}`
    : ''

  const icsUri = useMemo(() => {
    if (!appointment) return ''
    return icsHref({
      uid: appointment.id,
      title: `${appointment.service_name} — ${shop?.profile.name ?? 'Randevu'}`,
      startsAt: appointment.starts_at,
      endsAt: appointment.ends_at,
      descriptionUrl: manageUrl,
    })
  }, [appointment, shop, manageUrl])

  // ------------------------------------------------------------- interactions
  const pickService = (s: ServiceLite) => {
    setServiceId(s.id)
    setStaffId('any')
    setTimeISO(null)
    setAvail(null)
    setBanner(null)
    setStep('staff')
  }

  const pickStaff = (id: 'any' | string) => {
    setStaffId(id)
    setTimeISO(null)
    setStep('time')
  }

  const pickDate = (d: string) => {
    if (d === dateISO) return
    setDateISO(d)
    setTimeISO(null)
    setAvail(null)
  }

  const pickSlot = (iso: string) => {
    setTimeISO(iso)
    setBanner(null)
    setStep('form')
  }

  const goBack = () => {
    if (step === 'staff') setStep('service')
    else if (step === 'time') setStep('staff')
    else if (step === 'form') setStep('time')
  }

  const submitBooking = useCallback(async () => {
    if (!shop || !serviceId || !dateISO || !timeISO) return
    const name = fullName.trim()
    const phoneTrim = phone.trim()
    if (name.length < 2 || name.length > 80) {
      setBanner({ kind: 'error', text: 'Adını yazar mısın? (En az 2 harf)' })
      return
    }
    if (!/^[0-9\s()+-]{7,20}$/.test(phoneTrim)) {
      setBanner({ kind: 'error', text: 'Telefon numarasını kontrol eder misin?' })
      return
    }

    const payload: PublicBookingDTO = {
      service_id: serviceId,
      staff_id: staffId === 'any' ? undefined : staffId,
      date: dateISO,
      time: slotTime(timeISO, tz),
      full_name: name,
      phone: phoneTrim,
      note: note.trim() ? note.trim() : undefined,
      sms_opt_in: smsConsent,
      whatsapp_opt_in: waConsent,
    }

    setBanner(null)
    setSubmitting(true)
    idemKeyRef.current ??= uuidKey()
    try {
      const res = await api.createBooking(shop.profile.slug, payload, idemKeyRef.current)
      idemKeyRef.current = null
      setAppointment(res.appointment)
      setStep('success')
      window.scrollTo({ top: 0 })
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SLOT_UNAVAILABLE') {
        // server returns the fresh availability — apply it directly
        const fresh = (e.payload as { availability?: AvailabilityDTO } | null)?.availability ?? null
        if (fresh) setAvail(fresh)
        setTimeISO(null)
        setStep('time')
        setBanner({ kind: 'warn', text: 'Bu saat az önce doldu. Güncel boş saatler aşağıda 👇' })
      } else {
        setBanner({
          kind: 'error',
          text: e instanceof ApiError ? e.message : 'Beklenmeyen bir hata oldu',
        })
      }
    } finally {
      setSubmitting(false)
    }
  }, [shop, serviceId, dateISO, timeISO, staffId, tz, fullName, phone, note, smsConsent, waConsent])

  const resetAll = () => {
    setStep('service')
    setServiceId(null)
    setStaffId('any')
    setDateISO(todayISO(tz))
    setTimeISO(null)
    setAvail(null)
    setAppointment(null)
    setNote('')
    setBanner(null)
    window.scrollTo({ top: 0 })
  }

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault()
      installEvtRef.current = e as InstallPromptEvent
      setInstallable(true)
    }
    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  const isIOS = useMemo(
    () => /iphone|ipad|ipod/i.test(navigator.userAgent) && !('MSStream' in window),
    [],
  )

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(manageUrl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard denied — keep quiet */
    }
  }

  // ----------------------------------------------------------------- render
  if (loading) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-slate-400">
          <Spinner className="h-8 w-8" />
          <p className="text-sm">Dükkan hazırlanıyor…</p>
        </div>
      </main>
    )
  }

  if (loadError || !shop) {
    const notFound = loadError?.code === 'SHOP_NOT_FOUND'
    const unavailable = loadError?.code === 'SHOP_UNAVAILABLE'
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-5xl">{notFound ? '🔍' : '💈'}</p>
        <h1 className="text-xl font-bold">
          {notFound
            ? 'Dükkan bulunamadı'
            : unavailable
              ? 'Randevu şu anda kapalı'
              : 'Bir sorun oldu'}
        </h1>
        <p className="text-sm text-slate-400">
          {loadError?.message ?? 'Tekrar denemek için aşağıya dokun.'}
        </p>
        <div className="w-40">
          <PrimaryButton onClick={() => void loadShop()}>Tekrar dene</PrimaryButton>
        </div>
      </main>
    )
  }

  const { profile, services } = shop
  const nowStepIndex = ['service', 'staff', 'time', 'form'].indexOf(step)

  return (
    <div className="min-h-dvh">
      {/* ------------------------------------------------------------ header */}
      <header className="sticky top-0 z-10 border-b border-slate-800 bg-slate-950/85 backdrop-blur">
        <div className="mx-auto flex max-w-md items-center gap-3 px-4 pb-2 pt-3">
          {step !== 'service' && step !== 'success' && (
            <button
              onClick={goBack}
              aria-label="Geri"
              className="-ml-2 rounded-full px-2 py-1 text-2xl leading-none text-slate-300 active:scale-90"
            >
              ‹
            </button>
          )}
          {profile.logo_url ? (
            <img src={profile.logo_url} alt="" className="h-10 w-10 rounded-xl object-cover" />
          ) : (
            <StaffAvatar color="#fbbf24" initial={profile.name} size="lg" />
          )}
          <div className="min-w-0">
            <h1 className="truncate text-lg font-extrabold leading-tight">{profile.name}</h1>
            {profile.address && (
              <p className="truncate text-xs text-slate-400">{profile.address}</p>
            )}
          </div>
        </div>
        {step !== 'success' && (
          <div className="mx-auto flex max-w-md gap-1.5 px-4 pb-2">
            {(['service', 'staff', 'time', 'form'] as const).map((key, i) => (
              <button
                key={key}
                disabled={i > nowStepIndex}
                onClick={() => {
                  if (i < nowStepIndex) {
                    setStep(key)
                    setBanner(null)
                  }
                }}
                className={`flex-1 rounded-lg px-2 py-1 text-[11px] font-semibold transition ${
                  key === step
                    ? 'bg-amber-400/15 text-amber-300'
                    : i < nowStepIndex
                      ? 'bg-slate-900 text-slate-400'
                      : 'bg-transparent text-slate-600'
                }`}
              >
                {STEP_LABEL[key]}
              </button>
            ))}
          </div>
        )}
      </header>

      {/* -------------------------------------------------------------- main */}
      <main className="mx-auto max-w-md px-4 pb-40 pt-4">
        {banner && (
          <Banner kind={banner.kind}>
            {banner.text}
          </Banner>
        )}

        {step === 'service' && (
          <>
            <SectionTitle>Hizmet seç</SectionTitle>
            {services.length === 0 && (
              <EmptyState emoji="✂️" title="Hizmet listesi boş" text="Dükkan henüz hizmet eklememiş." />
            )}
            <div className="space-y-2">
              {services.map((s) => (
                <button
                  key={s.id}
                  onClick={() => pickService(s)}
                  className={`flex w-full items-center gap-3 rounded-2xl border p-3.5 text-left transition active:scale-[0.99] ${
                    s.id === serviceId
                      ? 'border-amber-400 bg-amber-400/10'
                      : 'border-slate-800 bg-slate-900/60'
                  }`}
                >
                  {s.image_url ? (
                    <img src={s.image_url} alt="" className="h-12 w-12 shrink-0 rounded-xl object-cover" />
                  ) : (
                    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-slate-800 text-xl">
                      ✂️
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">{s.name}</span>
                    <span className="text-xs text-slate-400">{durationLabel(s.duration_min)}</span>
                    {s.description && (
                      <span className="mt-0.5 block truncate text-xs text-slate-500">{s.description}</span>
                    )}
                  </span>
                  <span className="shrink-0 font-bold text-amber-300">{money(s.price, currency)}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {step === 'staff' && (
          <>
            <SectionTitle>
              {chosenService ? `${chosenService.name} — kim yapacak?` : 'Kim yapacak?'}
            </SectionTitle>
            <div className="space-y-2">
              <ChoiceRow
                selected={staffId === 'any'}
                onClick={() => pickStaff('any')}
                title="Herhangi biri"
                subtitle="Uygun olan en müsait usta atanır"
                lead="⚡"
              />
              {eligibleStaff.map((m) => (
                <ChoiceRow
                  key={m.id}
                  selected={staffId === m.id}
                  onClick={() => pickStaff(m.id)}
                  title={m.display_name}
                  subtitle={m.role_title ?? 'Berber'}
                  lead={
                    <span className="h-9 w-9 text-sm font-bold">
                      <StaffAvatar color={m.color} initial={m.display_name} />
                    </span>
                  }
                />
              ))}
              {eligibleStaff.length === 0 && (
                <EmptyState
                  emoji="👥"
                  title="Usta listesi boş"
                  text="Yine de 'Herhangi biri' ile devam edebilirsin."
                />
              )}
            </div>
          </>
        )}

        {step === 'time' && (
          <>
            {/* date strip */}
            <div className="no-scrollbar mb-4 flex gap-2 overflow-x-auto pb-1">
              {datesRange(tz, NEXT_DAY_COUNT).map((d) => {
                const chip = dateChip(d, tz)
                const selected = d === dateISO
                return (
                  <button
                    key={d}
                    onClick={() => pickDate(d)}
                    className={`flex w-14 shrink-0 flex-col items-center rounded-xl border px-1 py-2 transition ${
                      selected
                        ? 'border-amber-400 bg-amber-400/10 text-amber-300'
                        : 'border-slate-800 bg-slate-900/60 text-slate-300'
                    }`}
                  >
                    <span className="text-[10px] uppercase leading-none">
                      {chip.isToday ? 'Bugün' : chip.weekday}
                    </span>
                    <span className="my-1 text-base font-extrabold leading-none">{chip.dayNumber}</span>
                    <span className="text-[10px] leading-none">
                      {chip.dayMonth.split(' ').slice(1).join(' ')}
                    </span>
                  </button>
                )
              })}
            </div>

            <SectionTitle
              trailing={
                <button
                  onClick={() => void loadAvailability(true)}
                  aria-label="Boş saatleri yenile"
                  className="rounded-lg px-2 py-1 text-xs text-slate-400 active:scale-90"
                >
                  Yenile↻
                </button>
              }
            >
              Saat seç · {selectedStaff?.display_name ?? 'Herhangi biri'}
            </SectionTitle>

            {availLoading && slots.length === 0 ? (
              <div className="grid grid-cols-4 gap-2">
                {Array.from({ length: 16 }, (_, i) => (
                  <div key={i} className="h-10 animate-pulse rounded-xl bg-slate-800/70" />
                ))}
              </div>
            ) : avail?.is_closed ? (
              <EmptyState
                emoji="🌙"
                title="Bu gün kapalı"
                text="Başka bir gün seçebilirsin."
              />
            ) : slots.length === 0 ? (
              <EmptyState
                emoji="📅"
                title="Boş saat yok"
                text="Hemen sonraki güne bak ya da günleri kaydır."
              />
            ) : (
              <div className="space-y-5">
                {availLoading && (
                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    <Spinner className="h-3.5 w-3.5" /> Saatler güncelleniyor…
                  </div>
                )}
                {GROUP_ORDER.map((group) => {
                  const list = grouped[group]
                  if (list.length === 0) return null
                  return (
                    <div key={group}>
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                        {group}
                      </p>
                      <div className="grid grid-cols-4 gap-2">
                        {list.map((iso) => (
                          <button
                            key={iso}
                            onClick={() => pickSlot(iso)}
                            className={`rounded-xl border py-2.5 text-sm font-bold transition active:scale-[0.95] ${
                              iso === timeISO
                                ? 'border-amber-400 bg-amber-400 text-slate-950'
                                : 'border-slate-800 bg-slate-900/60 text-slate-200'
                            }`}
                          >
                            {slotTime(iso, tz)}
                          </button>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}

        {step === 'form' && chosenService && timeISO && (
          <>
            <SectionTitle>Bilgilerini gir</SectionTitle>
            <Card className="mb-4 p-4">
              <SummaryRow label="Hizmet" value={`${chosenService.name} · ${durationLabel(chosenService.duration_min)}`} />
              <SummaryRow label="Usta" value={assistantLabel(selectedStaff)} />
              <SummaryRow label="Zaman" value={appointmentWhen(timeISO, tz)} />
              <div className="mt-1 flex items-center justify-between border-t border-slate-800 pt-2">
                <span className="text-sm text-slate-400">Toplam</span>
                <span className="text-lg font-extrabold text-amber-300">
                  {money(chosenService.price, currency)}
                </span>
              </div>
            </Card>

            <div className="space-y-3">
              <label className="block">
                <span className="mb-1 block text-xs font-semibold text-slate-400">Ad · soyad</span>
                <input
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  autoComplete="name"
                  placeholder="Örn: Ayşe Ay"
                  maxLength={80}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-semibold text-slate-400">Telefon</span>
                <input
                  type="tel"
                  inputMode="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  autoComplete="tel"
                  placeholder="0555 555 55 55"
                  maxLength={20}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-semibold text-slate-400">Not (opsiyonel)</span>
                <textarea
                  rows={2}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Örn: fade olsun"
                  maxLength={500}
                />
              </label>

              <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-900/40 p-3">
                <p className="text-xs font-semibold text-slate-400">Randevu hatırlatmaları (−24 s, −1 s)</p>
                <label className="flex items-center gap-3 text-sm">
                  <input
                    type="checkbox"
                    checked={smsConsent}
                    onChange={(e) => setSmsConsent(e.target.checked)}
                    className="h-4 w-4 accent-amber-400"
                  />
                  SMS ile
                </label>
                <label className="flex items-center gap-3 text-sm">
                  <input
                    type="checkbox"
                    checked={waConsent}
                    onChange={(e) => setWaConsent(e.target.checked)}
                    className="h-4 w-4 accent-amber-400"
                  />
                  WhatsApp ile
                </label>
                <p className="text-[11px] leading-snug text-slate-500">
                  KVKK: Bilgilerin yalnızca randevu yönetimi ve hatırlatma gönderimi için
                  kullanılır; istediğin an yönetim ekranından iptal edebilirsin.
                </p>
              </div>
            </div>
          </>
        )}

        {step === 'success' && appointment && (
          <section className="pt-4 text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full border border-emerald-600 bg-emerald-500/15">
              <svg viewBox="0 0 24 24" className="h-8 w-8 text-emerald-400" fill="none" stroke="currentColor" strokeWidth="3">
                <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <h2 className="text-2xl font-extrabold">Randevun onaylandı 🎉</h2>
            <p className="mt-1 text-sm text-slate-400">
              {appointmentWhen(appointment.starts_at, tz)}
              {appointment.service_name && <> · {appointment.service_name}</>}
            </p>

            <Card className="mt-5 p-4 text-left">
              <SummaryRow label="Hizmet" value={appointment.service_name} />
              <SummaryRow
                label="Usta"
                value={
                  shop.staff.find((s) => s.id === appointment.staff_id)?.display_name ?? '—'
                }
              />
              <SummaryRow label="Zaman" value={appointmentWhen(appointment.starts_at, tz)} />
              {chosenService && (
                <SummaryRow label="Ücret" value={money(chosenService.price, currency)} />
              )}
              <SummaryRow
                label="Referans"
                value={<span className="font-mono text-xs">{appointment.id.slice(0, 8)}</span>}
              />
            </Card>

            <div className="mt-4 space-y-2">
              <a
                href={icsUri}
                download="randevu.ics"
                className="block w-full rounded-xl border border-slate-700 bg-slate-900/60 px-4 py-3 text-center font-semibold text-slate-200 active:scale-[0.98]"
              >
                📅 Takvime ekle (.ics)
              </a>
              {installable && (
                <PrimaryButton
                  onClick={async () => {
                    const evt = installEvtRef.current
                    if (!evt) return
                    await evt.prompt()
                    await evt.userChoice.catch(() => undefined)
                    installEvtRef.current = null
                    setInstallable(false)
                  }}
                >
                  📲 Ana ekrana ekle
                </PrimaryButton>
              )}
              {isIOS && !installable && (
                <GhostButton>Safari'de: Paylaş → “Ana Ekrana Ekle”</GhostButton>
              )}
              <GhostButton onClick={() => void copyLink()}>
                {copied ? 'Kopyalandı ✓' : 'Randevu linkini kopyala'}
              </GhostButton>
              <GhostButton onClick={resetAll}>Yeni randevu al</GhostButton>
            </div>
            <p className="mt-3 text-xs text-slate-500">
              Randevu linki hatırlatma mesajlarında da gönderilir.
            </p>
          </section>
        )}
      </main>

      {/* sticky confirm CTA */}
      {step === 'form' && chosenService && (
        <div className="fixed inset-x-0 bottom-0 z-10 border-t border-slate-800 bg-slate-950/90 px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-3 backdrop-blur">
          <div className="mx-auto max-w-md">
            <PrimaryButton onClick={() => void submitBooking()} disabled={submitting}>
              <span className="inline-flex items-center justify-center gap-2">
                {submitting && <Spinner className="h-4 w-4 border-slate-900/30 border-t-slate-900" />}
                {submitting ? 'Onaylanıyor…' : `Randevuyu onayla · ${money(chosenService.price, currency)}`}
              </span>
            </PrimaryButton>
          </div>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ bits */

function SectionTitle({ children, trailing }: { children: React.ReactNode; trailing?: React.ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center justify-between">
      <h2 className="text-base font-bold">{children}</h2>
      {trailing}
    </div>
  )
}

function ChoiceRow({
  selected,
  onClick,
  title,
  subtitle,
  lead,
}: {
  selected: boolean
  onClick: () => void
  title: string
  subtitle: string
  lead: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-2xl border p-3.5 text-left transition active:scale-[0.99] ${
        selected ? 'border-amber-400 bg-amber-400/10' : 'border-slate-800 bg-slate-900/60'
      }`}
    >
      {lead}
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{title}</span>
        <span className="block text-xs text-slate-400">{subtitle}</span>
      </span>
      {selected && <span className="text-amber-400">✓</span>}
    </button>
  )
}

function EmptyState({ emoji, title, text }: { emoji: string; title: string; text: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-800 p-8 text-center">
      <p className="mb-2 text-3xl">{emoji}</p>
      <p className="font-bold">{title}</p>
      <p className="mt-1 text-sm text-slate-500">{text}</p>
    </div>
  )
}

function SummaryRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-sm text-slate-400">{label}</span>
      <span className="text-right text-sm font-semibold">{value}</span>
    </div>
  )
}

function assistantLabel(staff: StaffLite | null): string {
  return staff?.display_name ?? 'Herhangi biri (müsait usta)'
}
