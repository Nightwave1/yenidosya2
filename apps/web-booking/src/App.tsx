import { useState, type FormEvent } from 'react'
import { Link, Route, Routes, useNavigate } from 'react-router-dom'
import BookingPage from './pages/BookingPage'
import ManagePage from './pages/ManagePage'
import { PrimaryButton } from './components/ui'

/**
 * Route map:
 *  /:slug                          booking wizard (QR/short-link landing)
 *  /:slug/appointment/:checkToken  public appointment management (reminder links)
 *  /                               generic brand page with slug entry (dev/demo)
 */
export default function App() {
  return (
    <Routes>
      <Route path="/:slug" element={<BookingPage />} />
      <Route path="/:slug/appointment/:checkToken" element={<ManagePage />} />
      <Route path="/" element={<HomePage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  )
}

function HomePage() {
  const [slug, setSlug] = useState('')
  const navigate = useNavigate()
  const go = (e: FormEvent) => {
    e.preventDefault()
    const clean = slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '')
    if (clean) navigate(`/${clean}`)
  }
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-6 px-6 text-center">
      <img src="/icon.svg" alt="" className="h-16 w-16 rounded-2xl" />
      <div>
        <h1 className="text-3xl font-extrabold tracking-tight">Randevu</h1>
        <p className="mt-2 text-sm text-slate-400">
          Sıraya girme, bekleme yok. Dükkanınıza özel randevu linki üzerinden
          devam edin.
        </p>
      </div>
      <div className="w-full rounded-2xl border border-slate-800 bg-slate-900/60 p-4 text-left">
        <form onSubmit={go} className="flex gap-2">
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            inputMode="url"
            autoCapitalize="none"
            placeholder="berber-ahmet"
            aria-label="Dükkan adresi"
            className="min-w-0 flex-1"
          />
          <button
            type="submit"
            className="rounded-xl bg-amber-400 px-5 font-bold text-slate-950 active:scale-[0.98]"
          >
            Git
          </button>
        </form>
        <p className="mt-3 text-xs text-slate-500">
          Demo dükkan: <span className="font-mono text-slate-400">berber-ahmet</span>
        </p>
      </div>
    </main>
  )
}

function NotFoundPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="text-5xl">💈</p>
      <h1 className="text-xl font-bold">Sayfa bulunamadı</h1>
      <p className="text-sm text-slate-400">
        Aradığınız sayfa taşınmış ya da hiç var olmamış olabilir.
      </p>
      <div className="w-48">
        <PrimaryButton onClick={() => window.location.assign('/')}>
          Ana sayfaya dön
        </PrimaryButton>
      </div>
      <Link to="/" className="text-xs text-slate-500 underline">
        Randevu
      </Link>
    </main>
  )
}
