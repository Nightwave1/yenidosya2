# oleumsrandevu

Multi-tenant **Appointment & Subscription Management SaaS** for barbershops —
Super Admin panel, tablet Barber panel (live queue + TV mode), and an installable
Customer PWA that customers reach via a custom link / QR code (`/berber-ahmet`).

> Full system design: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) ·
> Screen maps & wireframes: [`docs/SCREENS.md`](docs/SCREENS.md) ·
> Reference schema: [`docs/schema.sql`](docs/schema.sql)

## Monorepo layout

```
apps/
  api/             NestJS modular monolith (auth, tenancy, scheduling, booking, queue, notifications, realtime WS)
  web-booking/     Customer PWA (Vite + React + Tailwind): booking wizard, appointment manage, offline shell
packages/
  db/              SQL migrations + runner, provisioning, demo seed (PostgreSQL 16)
  schemas/         Shared Zod DTOs / TypeScript types used by API and web apps
```

Stack: **NestJS + Socket.IO** on **PostgreSQL 16** (shared-schema multi-tenancy with
RLS) and **Redis 7 / BullMQ** for availability caching, WS fan-out and reminder
jobs. Redis is *optional in dev* — everything degrades gracefully to in-memory /
no-op when `REDIS_URL` is unset.

## Quickstart

```powershell
# 1. Infrastructure (Postgres 16 + Redis 7)
docker compose up -d

# 2. Install workspace deps (from repo root)
npm install

# 3. Schema migrations
npm run db:migrate

# 4. Provision runtime roles (app_user = RLS-bound role for production)
npm run db:provision

# 5. Seed the demo shop
npm run db:seed

# 6. Boot the API
npm run dev:api
# → oleumsrandevu API ready on http://localhost:4000/v1 (WS at /ws)

# 7. (separate terminal) Boot the customer booking PWA
npm run dev:web
# → Vite dev server on http://localhost:5173 (proxies /v1 and /ws to :4000)
```

Open `http://localhost:5173/berber-ahmet` → the booking wizard for the demo
shop. `/` shows a slug-entry page for convenience.

`.env` is loaded automatically (walking up from CWD); see `.env.example`.
Defaults match `docker-compose.yml`:
`postgres:postgres@localhost:5432/oleum` and `redis://localhost:6379`.

### Demo data (`npm run db:seed`)

| What | Value |
| --- | --- |
| Booking slug | `berber-ahmet` |
| Panel login | `owner@demo.barber` / `Owner#1234` |
| Staff | Ahmet, Emre (Mon–Sat 09:00–21:00, Sun closed) |
| Services | Saç kesimi 30', Saç + Sakal 45', Sakal tasarımı 20' |
| Demo appointment | "Ali Veli", Saç + Sakal, **tomorrow 12:00 İST**, Ahmet |

The seed script prints the exact availability URL to try (with a real
`service_id` and tomorrow's date).

## Smoke test (PowerShell)

Everything below assumes the API is running on `:4000`.

```powershell
# 1) Panel login → token
$login = Invoke-RestMethod -Method Post -Uri http://localhost:4000/v1/auth/login `
  -ContentType 'application/json' `
  -Body '{"email":"owner@demo.barber","password":"Owner#1234"}'
$login      # → { token, user }
$tok = "Bearer " + $login.token

# 2) Public shop profile + services
$svc = Invoke-RestMethod http://localhost:4000/v1/public/tenants/berber-ahmet/services
$svc
$serviceId = $svc[0].id   # e.g. Saç kesimi

# 3) Availability (pick a slot ISO from any_staff_slots / staff[].slots)
$date  = (Get-Date).AddDays(1).ToString('yyyy-MM-dd')
$avail = Invoke-RestMethod `
  "http://localhost:4000/v1/public/tenants/berber-ahmet/availability?service_id=$serviceId&staff_id=any&date=$date"
$avail.any_staff_slots[0]

# 4) Book with Idempotency-Key (retries return the same appointment)
$slot = $avail.any_staff_slots[0]
$key  = [guid]::NewGuid().ToString()
$booking = Invoke-RestMethod -Method Post `
  -Uri http://localhost:4000/v1/public/tenants/berber-ahmet/appointments `
  -ContentType 'application/json' -Headers @{ 'Idempotency-Key' = $key } `
  -Body (@{ service_id = $serviceId; date = $date;
            time = ([datetime]$slot).ToString('HH:mm');
            full_name = 'Test Müşteri'; phone = '+905329999999' } | ConvertTo-Json)
$booking.appointment.status   # → booked

# 5) Double-booking race → 409 SLOT_UNAVAILABLE with a fresh availability payload
try {
  Invoke-RestMethod -Method Post `
    -Uri http://localhost:4000/v1/public/tenants/berber-ahmet/appointments `
    -ContentType 'application/json' -Headers @{ 'Idempotency-Key' = [guid]::NewGuid().ToString() } `
    -Body (@{ service_id = $serviceId; date = $date;
              time = ([datetime]$slot).ToString('HH:mm');
              full_name = 'Rakip Müşteri'; phone = '+905328888888' } | ConvertTo-Json)
} catch { $_.ErrorDetails.Message }   # → {"code":"SLOT_UNAVAILABLE",...,"availability":{...}}

# 6) Live queue: snapshot + one-touch transitions
$q = Invoke-RestMethod -Uri http://localhost:4000/v1/queue/today -Headers @{ Authorization = $tok }
$q.current; $q.upcoming

$aid = ($q.upcoming | Select-Object -First 1).appointment_id
Invoke-RestMethod -Method Post -Uri "http://localhost:4000/v1/appointments/$aid/status" `
  -ContentType 'application/json' -Headers @{ Authorization = $tok } `
  -Body '{"action":"take_chair"}'      # → in_progress (queue.updated broadcast on /ws)
Invoke-RestMethod -Method Post -Uri "http://localhost:4000/v1/appointments/$aid/status" `
  -ContentType 'application/json' -Headers @{ Authorization = $tok } `
  -Body '{"action":"complete"}'        # → completed
```

Also worth a manual check once:
`POST /v1/business-hours/close-day {"weekday":7,"closed":true}` (auth'd) —
instantly drops the day's slots on the booking screen via the
`availability.invalidated` event.

## Customer PWA (`apps/web-booking`)

Installable (Vite `vite-plugin-pwa`, manifest + auto-update SW), Turkish-first,
mobile-only-minded but responsive. Served per-tenant at `/{slug}`:

| Screen | What it does |
| --- | --- |
| `/:slug` | 4-step wizard: service → staff (or "Herhangi biri") → date strip (14 days) + live slot grid → details + consent |
| `/:slug/appointment/:checkToken` | Manage screen from reminder links: status, `.ics` add-to-calendar, share/copy, one-tap self-cancel |

Realtime slot freshness: Socket.IO join `public:{slug}` — instant blocks,
weekly-hour edits, competitor bookings and cancellations trigger a debounced
fresh re-fetch of the grid (25 s polling fallback). A `409 SLOT_UNAVAILABLE`
response carries the recomputed availability and the UI applies it directly.

Booking submit uses an `Idempotency-Key` (UUID) so network retries never
create duplicates; reminders consent is explicit (SMS/WhatsApp checkboxes,
KVKK note included). The successful booking shows a manage link, ICS calendar
file, and "add to home screen" (Android via `beforeinstallprompt`, iOS hint).

## Key endpoints

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `POST /v1/auth/login` | — | Panel login (JWT 15 m) |
| `GET /v1/auth/me` | JWT | Current user + tenant + subscription |
| `GET /v1/public/tenants/:slug` | — | Booking page landing data |
| `GET /v1/public/tenants/:slug/services` | — | Active services catalog |
| `GET /v1/public/tenants/:slug/staff` | — | Active staff (+ per-staff service ids) |
| `GET /v1/public/tenants/:slug/availability` | — | Slot grid (staff_id=`any` or uuid) |
| `POST /v1/public/tenants/:slug/appointments` | — | Public booking (`Idempotency-Key` header) |
| `GET /v1/public/tenants/:slug/appointments/:checkToken` | — | Public appointment summary (reminder links) |
| `POST /v1/public/tenants/:slug/appointments/:checkToken/cancel` | — | Customer self-cancel |
| `GET/PUT /v1/business-hours` · `POST /v1/business-hours/close-day` | JWT | Weekly hours + one-click closing day |
| `GET/PUT /v1/staff-hours/:staffId` | JWT | Per-staff weekly hours |
| `GET/POST /v1/blocks` · `DELETE /v1/blocks/:id` | JWT | Instant date/time blocks (+notify affected) |
| `GET /v1/availability` · `GET/POST /v1/appointments` · `GET /v1/customers` | JWT | Panel scheduling & booking |
| `GET /v1/queue/today` · `POST /v1/appointments/:id/status` | JWT | Live queue snapshot + one-touch FSM |

WebSocket gateway (`/ws`): rooms `tenant:{id}` (JWT) and `public:{slug}`
(open). Events: `appointment.created`, `appointment.status`, `queue.updated`,
`availability.invalidated`, `blocks.updated`.

## How double-booking is impossible

1. The availability engine recomputes the fresh slot grid on every booking
   (60 s cache, bypassed with `fresh: true` on writes) — pure TS in
   `apps/api/src/booking/availability/domain/engine.ts` (9 deterministic tests).
2. The INSERT is guarded by a **GiST exclusion constraint**
   (`appointment_no_overlap`) in Postgres — two workers can never both commit
   overlapping active bookings for the same staff member, even under a race.
3. A constraint violation surfaces as `409 SLOT_UNAVAILABLE` with a fresh
   availability payload so the client can immediately re-render.
4. Retries are idempotent via `(tenant_id, idempotency_key)` + the
   `Idempotency-Key` header.

## Production notes

- Run the API with the **RLS-bound `app_user`** role
  (`DATABASE_URL=postgresql://app_user:.../oleum` after `npm run db:provision`).
  The dev superuser bypasses RLS silently — fine locally, wrong in prod.
- Reminders are scheduled per booking (−24 h / −1 h, consent-aware channel
  priority push → WhatsApp → SMS) into `notifications` + BullMQ; the sender is
  currently a **stub**. Real Netgsm/Twilio/WABA/WebPush adapters are Phase 1.1.
- Billing PSP (Stripe vs Iyzico/PayTR) and SMS/WA provider choice are still open
  decisions — see `docs/ARCHITECTURE.md` §8.

## Development

```powershell
npm run build          # build all workspaces (schemas → db → api → web)
npm run test           # run unit tests (availability engine suite)
npm run type-check     # tsc --noEmit across workspaces
npm run dev:web        # PWA dev server on :5173 (proxies to the API)
```
