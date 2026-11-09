# Barbershop SaaS — System Architecture
**Product:** Multi-tenant Appointment & Subscription Management System for barbershops (working title: `oleumsrandevu.app`)
**Status:** Architecture proposal v1.0 · 2026-11-09

---

## 1. Goals & Non-Goals

### Goals
1. **Three surfaces:** Super Admin panel, Tablet-optimized Barber panel, installable Customer PWA (share link / QR → book).
2. **Multi-tenant billing:** plans, trial/active/passive lifecycle, payment history, platform analytics.
3. **Flexible calendar:** weekly closing-day toggle, instant date/time-range blocks with real-time propagation to every open booking page.
4. **Hospital-style live queue:** TV/tablet view with current-on-chair + chronological queue, one-touch status transitions.
5. **Marketing & retention:** dynamic QR + short links with scan→install→booking funnel, SMS/WhatsApp/Web-Push reminders at −24h and −1h.

### Non-Goals (v1)
- Walk-in ticketing (Phase 2), deposits/prepayments (Phase 2), loyalty/CRM (Phase 3), multi-branch/franchise (Phase 3), Google Reserve integration (Phase 3).

---

## 2. Recommended Stack (and why)

| Layer | Choice | Rationale |
|---|---|---|
| Monorepo | Turborepo + pnpm | Shared TS types/UI/API client across 4 apps |
| Super Admin SPA | Vite + React + TS | Fast, admin-only, non-SEO |
| Barber Panel SPA | Vite + React + TS + Tailwind | Tablet-first responsive; touch targets ≥ 48px |
| Customer PWA | Next.js (App Router) | SSR/ISR for SEO (`/{slug}` landing pages), manifest + SW (Workbox), JSON-LD `LocalBusiness` |
| API | NestJS (Node 20 + TS) **modular monolith** | Transactional booking logic in one DB; module boundaries clean enough to split later (booking / notification / billing are split candidates at scale) |
| DB | PostgreSQL 16 + Row-Level Security | Shared-schema multi-tenancy; `tstzrange` + `btree_gist` exclusion constraint = race-free double-booking prevention |
| ORM / Migrations | Drizzle ORM + SQL/Atlas migrations | Supports exclusion constraints & RLS cleanly |
| Cache / Queue | Redis 7 + BullMQ | Availability cache with invalidation; delayed reminder jobs |
| Realtime | Socket.IO + Redis adapter, polling fallback | Slot invalidation < 1s fan-out; survives restarts/multi-instance |
| Payments | Stripe (global) **or** Iyzico/PayTR (TR market) | Webhook-driven subscription lifecycle |
| Messaging | Twilio/Infobip (SMS), Meta WhatsApp Cloud API, Web Push (VAPID) | One adapter interface `NotificationProvider` |
| Storage | S3-compatible (Cloudflare R2) | Logos, covers, service images |
| Edge | Cloudflare | DNS, CDN, WAF, rate limiting |
| Hosting | Fly.io / Railway / Hetzner + Coolify; managed PG (Neon/RDS) | Small-team deployable; scale-out path documented below |

**Why a modular monolith first:** the booking path is highly transactional (slot lock + insert + job scheduling + events). Splitting into microservices v1 would add distributed-transaction complexity with zero customer-visible benefit. Each Nest module (`tenancy`, `auth`, `scheduling`, `booking`, `queue`, `notifications`, `billing`, `analytics`, `realtime`) maps 1:1 to a future service.

---

## 3. System Context

```
             ┌────────────────── Cloudflare (DNS · CDN · WAF · Rate limit) ──────────────┐
 Super Admin │                                    │                                     │
 SPA         │────────────────────────────────────▶│                                     │
 (admin.*)   │                                     ▼                                     │
             │            ┌────────────────────────────────────────┐                  │
 Tablet      │            │        API — NestJS Modular Monolith   │                  │
 Barber SPA  │───────────▶│  ┌──────────┐ ┌──────────────┐ ┌─────┐ │                  │
 (panel.*)   │  REST +WS  │  │ tenancy  │ │ scheduling   │ │real-│ │                  │
             │            │  │ auth/RBAC│ │ (hours,blocs,│ │time │ │                  │
 Customer    │───────────▶│  │ billing  │ │ availability)│ │Sock.│ │                  │
 PWA         │  REST +WS  │  │ queue    │ │ booking      │ │+Redis─────┐ │                  │
 ({domain}/  │            │  │ analytics│ │ notifications│ │adptr │ │ │                  │
  {slug})    │            │  └──────────┘ └──────────────┘ └─────┘ │ │ │                  │
             │            └───────┬──────────────────────────┬─────┘ │ │                  │
             │                    │                          │       │ │                  │
             │         ┌──────────▼─────────┐     ┌──────────▼─────┐ │ │                  │
             │         │  PostgreSQL 16     │     │   Redis 7      │◀┘ │                  │
             │         │  RLS · PITR · GiST │     │ BullMQ·pub/sub │   │                  │
             │         └────────────────────┘     └────────────────┘   │                  │
             │                                                          │                  │
             │        ┌──────────────── outbound adapters ─────────────▼───────────────┐  │
             │        │ SMS (Netgsm/Twilio) · WhatsApp Cloud API · Web Push · PSP/S3    │  │
             │        └─────────────────────────────────────────────────────────────────┘ │
             └────────────────────────────────────────────────────────────────────────────┘
```

**Subdomains:** `admin.` (super admin) · `panel.` (barber) · booking at `{booking-domain}/{slug}` (e.g. `oleumsrandevu.app/berber-ahmet`). Public pages are path-based so one Next.js app serves every tenant.

---

## 4. Multi-Tenancy Model

- **Strategy:** shared DB, shared schema, `tenant_id` on every tenant row + **PostgreSQL RLS** as a hard backstop (app sets `SET LOCAL app.tenant_id = '...'` per transaction; only the `app_admin` role, used by the Super Admin service, is granted `BYPASSRLS`).
- **Tenant resolution:**
  - Public PWA → slug in URL/QR (`/q/{code}` → 302 → `/{slug}`), cached tenant lookup; tenant context injected into request.
  - Panels → short-lived JWT (15 min) + rotating refresh token (14 d) carrying `tenant_id`; middleware rejects cross-tenant access (RLS underneath verifies).
- **Reserved slugs** (`admin`, `panel`, `api`, `app`, `support`, profanity list) enforced at slug create/rename. Slug changes allowed: old slug 301-redirects for 90 d, **QR keeps working** because QR encodes a stable `/q/{code}` token, not the slug.
- **Plan gating:** `plans.features` JSON gates features (WhatsApp, SMS credits/mo., advanced analytics, custom domain). Enforced in the service layer; UI shows locked feature with upgrade CTA.

### RBAC matrix

| Capability | super_admin | tenant_admin | staff | public (unauth) |
|---|---|---|---|---|
| Manage all tenants, plans, payments, platform analytics | ✅ | — | — | — |
| Impersonate a tenant admin (audited) | ✅ | — | — | — |
| Shop settings, services, staff, hours, blocks, customers, billing | — | ✅ | — | — |
| Live queue status changes, own calendar view, read customers | — | ✅ | ✅ | — |
| View booking page, availability, create appointment | — | — | — | ✅ (rate-limited) |

**Super-admin impersonation** issues a tenant-scoped JWT with `impersonated_by` claim; a fixed banner shows "You are impersonating …"; every write is audit-logged with the real actor; tenant deletion is blocked while impersonating.

---

## 5. Core Domain Flows

### 5.1 Availability engine (read path, target ≤ 120 ms cached)

Input: `slug + service_id + staff_id|any + date`. Output: slot list.

```
slots(date, service, staff) =
  intersect(business_hours[tenant, weekday].window                // tenant weekly hours, incl. is_closed toggle
            staff_hours[staff, weekday].window − breaks)          // per-staff hours
  − blocks(tenant-wide, date range)                               // schedule_blocks.scope = shop
  − blocks(staff, date range)
  − appointments(staff, date) where status ∈ {booked, in_progress} // each occupies [start−b0, end+buffer)
then slice into slot_granularity (default 15 min) steps where
  service.duration + service.buffer_after fits fully before window end,
  start ≥ now + min_notice_minutes (default 30),
  date ≤ max_advance_days (default 30),
per-staff "any" merge = union of slot starts (display one list).
```

- All wall-clock rules are stored in **tenant-local time** and converted with the tenant's IANA timezone (PG `AT TIME ZONE`); DST transitions computed per date (needed for non-TR expansion).
- **Cache key** `avail:{tenant}:{service}:{staff|any}:{date}` → JSON slot hash, TTL 60 s safety net; **explicit invalidation** published on: appointment create/cancel/status, block create/update/delete, staff-hours change, business-hours change, service duration change.
- The public endpoint is heavily KV/cached; a cold page load ~1 warm query using the GiST block index + B-tree appointment index.

### 5.2 Booking write path (idempotent, race-free)

```
POST /v1/public/tenants/{slug}/appointments   headers: Idempotency-Key: <uuid>
└ in one transaction:
   1. resolve tenant (active) + validate rules + Idempotency-Key replay check
   2. re-validate slot against availability (cheap recheck, not cache)
   3. resolve staff: explicit or "any" → least-loaded available staff (deterministic)
   4. INSERT appointment
      ⇒ guarded by GiST exclusion constraint (staff_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
        WHERE status IN ('booked','in_progress')  → conflict = HTTP 409 + fresh availability
   5. snapshot service price/duration; upsert customer by (tenant_id, phone_hash)
   6. BullMQ delayed jobs: reminder_24h (start−24h), reminder_1h (start−1h);
      plus immediate booking_created notification
   7. Redis publish → Socket.IO: "appointment.created" (tenant room, live screens)
   8. link_events: booking_completed (attributed to QR/link session)
→ 201 {appointment, token}   (token = private handle for the customer's "my appointment" deep link)
```
- **409 payload** includes re-computed availability so the PWA instantly re-renders around the taken slot.
- 50-parallel-bookings-same-slot test: exactly one 201.

### 5.3 Instant block & real-time invalidation (the flagship flow)

```
Barber tablet             API                               Redis            Every open booking page
    │ POST /blocks         │                                  │                        │
    │ (full day or range;  │  tx: INSERT schedule_blocks      │                        │
    │  scope: shop|staff;  │  invalidate avail cache keys     │  PUBLISH invalidated   │
    │  type: holiday/      │       for covered dates/staff    │  {tenant, ranges,      │
    │  public_holiday/     │  enqueue notify of affected      │   staffIds}            │
    │  emergency/illness/  │  appointments (per customer msg)─│▶ BullMQ                │
    │  private; notify?)   │                                  │                        │
    ◀── 201 ───────────────│                                  │──▶ Socket.IO rooms ───▶│ slots → disabled
    │ UI: block appears    │                                  │    public:{slug}       │ + refetch if today
    │ in upcoming blocks   │                                  │    "blocks.updated"    │ + toast if selected
```
- Weekly fixed closing day = **one boolean flip** on `business_hours.is_closed` per weekday — availability engine excludes the day; pages refresh. Specific dates/ranges = `schedule_blocks` rows as above.
- **Existing appointments in a blocked range:** barber sees them flagged "Yeniden planlanmalı" (needs re-booking); if `notify_affected = true`, each customer gets one message (WhatsApp/SMS/push) within ~5 s and the appointment stays bookable by staff for individual reschedule — v1 does not auto-cancel (safer for trust).
- Full retries/DLQ handled by the notification pipeline (5.6).

### 5.4 Live queue ("hospital-style", tablet/TV)

State machine per appointment (tenant-scoped, today only):

```
booked(Waiting) ──take_chair──▶ in_progress ──complete──▶ completed
      │                                               
      ├──no_show──▶ no_show                          
      └──cancel───▶ cancelled   (terminal states: completed, no_show, cancelled)
```
- `GET /v1/queue/today` → `{current, up_next[], completed_today[], stats}`; current = the single `in_progress` row (there may logically be one per staff in multi-staff mode).
- One-touch buttons write `POST /v1/appointments/{id}/status` → status history row (who/when/via) → `queue.updated` WS event → all devices (phone/tablet/TV) update < 1 s; 30 s polling heartbeat as fallback + offline banner.
- `Take to Chair` stamps `actual_start_at` and reorders ETA projections for the people behind; `Complete` stamps `actual_end_at`.
- TV devices authenticate with a **long-lived device token** (role `staff`, scope: queue actions only) — no full staff password on display tablets.

### 5.5 Notifications & reminders

| Trigger | When sent | Channel order (skip unconsented) |
|---|---|---|
| `booking_created` | immediately | push → WhatsApp → SMS |
| `reminder_24h` | start − 24 h | push → WhatsApp → SMS |
| `reminder_1h` | start − 1 h | push → WhatsApp → SMS |
| `booking_cancelled` / `booking_rescheduled` | immediately (opt-in per tenant) | same |
| `block_affected` | ≤ 5 s after block creation (notify_affected = true) | same |

- **Scheduling:** BullMQ delayed jobs (`jobId = reminder:{apptId}:24h` — deterministic ⇒ reschedule/cancel = rel/remove exactly). A **5-min cron sweep** re-enqueues any job that should have fired within the previous 10 minutes but didn't (crash safety); provider sends are deduped on `notifications.provider_message_id`.
- Templates live in `notification_templates` (global default + tenant override), variables: `{shop} {customer} {service} {staff} {time} {manage_url}`. WhatsApp requires approved WABA templates (lead time!); adapter falls back channel-by-channel per consent and per provider failure.
- **Consent (KVKK/GDPR):** `customers.sms_opt_in`, `whatsapp_opt_in`, browser-level push permission + in-app toggle; every message paths to a manage_url where opt-out is one tap.
- SMS credits per plan (`plans.max_sms_per_month`); counters in `daily_tenant_stats`, gate enforced at enqueue time → banner upsell, never silent drop.
- Web Push: single global VAPID keypair; `push_subscriptions` per customer device; subscription 410 → auto-prune.

### 5.6 Subscriptions & billing (Super Admin domain)

```
trial ──payment ok──▶ active ──webhook invoice paid──▶ active (period rolls)
  │                     │
  │ trial_ends_at ──────┼──▶ passive (grace ending: banner)
  ▼                     ▼
passive ◀──dunning exhausted── past_due (payment failed; retries 3×/72 h; panel warns)
  │
  └── owner pays / admin reactivates ──▶ active        canceled ─period end─▶ passive
```
- **Super Admin screen shows the three required groups:** Trial / Active (incl. past_due warning chip) / Passive, with per-tenant actions: change plan, extend trial, force status, refund, cancel.
- Data policy: `passive` → booking page closes ("online randevu şu anda kapalı") + panel read-only; soft-delete + **90-day retention** before purge.
- PSP webhooks (Stripe signature / Iyzico hash) → idempotent handlers → `payments` + `subscription_events` audit trail.

### 5.7 QR & short links (growth funnel)

- Each tenant gets: primary slug link `/{slug}` + N **dynamic QR links** (`/q/{code}` → 302 → current target). Dynamic semantics = reprint-safe (slug can change; target can be re-pointed to a campaign) + analytics.
- `link_events` tracks `scan → view → booking_started → booking_completed → pwa_install`; barber "QR" tab shows funnel conversion; Super Admin sees platform-wide acquisition.
- PWA install detection: `beforeinstallprompt` (Android/desktop) + `display-mode: standalone` media query (iOS install instructions modal) → `pwa_install` event.

---

## 6. API Surface (v1, REST `/v1` + WS)

```
Auth              POST /auth/login · /auth/refresh · /auth/logout · GET /auth/me
Super Admin       GET/POST/PATCH /admin/tenants · POST /admin/tenants/:id/{suspend|activate|impersonate}
                  GET /admin/payments · GET /admin/analytics/{overview,tenants,funnel} · CRUD /admin/plans
Barber (tenant)   CRUD /services /staff /customers · GET/PUT /business-hours · GET/PUT /staff-hours/:staffId
                  GET/POST/PATCH/DELETE /blocks · POST /appointments (manual walk-in) · GET /appointments?date
                  POST /appointments/:id/status {action: take_chair|complete|no_show|cancel|restore}
                  GET /queue/today · GET /qr/:linkId.svg|png · GET /links · GET /analytics/owner · GET /me/subscription
Public (cached)   GET /public/tenants/:slug · /services · /availability?service&staff&date
                  POST /public/tenants/:slug/appointments  (Idempotency-Key, rate-limited)
                  GET /public/tenants/:slug/appointments/:token (customer tracker) · POST /push/subscribe
Short link        GET /q/:code → 302 /{slug} (+ scan event)   ·  GET /{slug} → booking PWA
WS                rooms: tenant:{id} (panel+devices) · public:{slug} (booking pages)
                  server→client: appointment.{created,status} · blocks.updated · availability.invalidated
                                 queue.updated · tenant.updated (suspension)
Rate limits       POST booking 5/min/IP + Turnstile captcha after threshold + honeypot field
                  GET availability 60/min/IP (cache-backed) · auth endpoints 10/min/IP + lockout
```

---

## 7. Security & Compliance

- **AuthN:** argon2id password hashes; JWT access 15 min + rotating refresh (reuse = revoke family); TOTP 2FA **mandatory** for super admins; Redis session allowlist for instant revocation; login lockout.
- **AuthZ:** RBAC layer + **RLS beneath it** (defense in depth — a query bug can never leak tenant rows).
- **PII (KVKK/GDPR):** phone stored as text + searchable `phone_hash` (SHA-256 of normalized phone); consent flags with audit trail; tenant data export & hard-delete endpoints; 90-day soft-delete retention.
- **Fraud:** booking rate limits, honeypot, optional SMS-OTP on suspicious patterns; no-show count feeds a per-customer block flag.
- **Transport/headers:** TLS 1.2+, HSTS, CSP, SameSite=Lax cookies for panel refresh tokens.
- **Webhooks:** Stripe signature / Iyzico hash verification, idempotent processing, replay-safe.
- **Audit:** `audit_logs` for super-admin actions, impersonation, subscription transitions, status changes of appointments (who pressed "No-Show" — useful for disputes).

---

## 8. Operations

- **Observability:** pino structured logs → Loki; Sentry for errors; Prometheus metrics: booking p95, availability cache hit %, WS fan-out latency, BullMQ reminder lag, notification failure rate per provider, per-tenant funnel counters.
- **Failure modes / SLOs:** booking write p95 ≤ 300 ms · slot invalidation fan-out ≤ 1 s p95 · `block_affected` notification ≤ 5 s · queue WS reconnect ≤ 3 s with offline banner · DLQ for failed messages with an admin health widget.
- **Deploy:** Docker; staging auto-deploy, prod blue-green; migrations backward-compatible (expand→migrate→contract); Cloudflare in front (WAF + cached public availability).
- **Backups/DR:** managed PG PITR (7 d WAL) + weekly restore drill; Redis AOF; notification DLQ.
- **Testing:** Vitest unit (availability TZ/DST cases, FSM transitions); Supertest integration (50-parallel-booking race, idempotency replay); Playwright E2E ×3 apps (super admin lifecycle, booking-with-block-invalidation, queue ops); k6 load (booking storm + QR spike).

---

## 9. Scaling Path

1. **v1:** modular monolith + 2 app instances + managed PG/Redis. Public availability served from cache; WS via Redis adapter.
2. **Trigger points:** > ~200 tenants or WS fan-out p95 > 250 ms → extract `realtime` (Socket.IO cluster); notification volume surge → extract `notifications` worker app; analytics queries slow → dedicated `analytics` read replica.
3. Legal/geo split (EU vs TR data residency) → per-region PG; routing unchanged (Cloudflare).

---

## 10. Roadmap

| Phase | Scope |
|---|---|
| **1 — MVP (8–10 wks)** | Tenancy+RLS, booking PWA + availability + blocks + WS invalidation, super admin + barber panels, live queue TV, QR/short links + funnel, SMS/WA/push reminders (−24h/−1h), Stripe-or-Iyzico subscriptions w/ trial/past_due/passive, analytics rollups |
| **2** | Customer self-reschedule/cancel links, deposits/prepayments, walk-in tickets, staff rotating shifts, WhatsApp interactive buttons, no-show fee policies, multi-language EN/DE |
| **3** | Multi-branch/franchise, Google Reserve, loyalty/CRM, marketplace discoverability, custom domains per tenant |

## 11. Open Decisions (need confirmation)

1. **PSP:** Stripe vs Iyzico/PayTR (TR-local recurring support differs).
2. **SMS/WhatsApp providers:** Twilio/Infobip global vs Netgsm (TR) + WABA template approval timeline.
3. **Booking identity:** name+phone only (lowest friction) vs SMS-OTP verification (anti-fraud, costs per SMS).
4. **Customer-staff selection UX:** customer picks barber vs shop assigns "any".
5. **Trial length** (14 d proposed) and plan feature matrix / price points.
