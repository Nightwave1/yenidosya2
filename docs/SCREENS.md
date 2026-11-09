# Barbershop SaaS — Screen Maps & User Flows
Companion to `ARCHITECTURE.md` · v1.0

Conventions: routes are stable slugs; **UI language Turkish-first via i18n (tr/en)**, labels below shown in EN/TR as appropriate.

---

## 1. Super Admin Panel  (`admin.{domain}` — React SPA)

### Routes

| Route | Screen | Key content |
|---|---|---|
| `/superadmin/login` | Login + TOTP 2FA | Email, password, 6-digit code; lockout messaging |
| `/superadmin` | Dashboard | MRR/ARR, ARPU, Tenant counts by **Active/Passive/Trial**, platform bookings today, failure rates, churn-risk list |
| `/superadmin/businesses` | Businesses list | Search + filters (status, plan, country, activity), columns: name·plan·status chip·MRR·trial end·last activity; row actions: view, **impersonate**, suspend/activate |
| `/superadmin/businesses/:id` | Business detail (tabs) | **Profile** (contact, slug, category, settings JSON-ed) · **Subscription** (plan switch, extend trial, force status, cancel) · **Payments** (table, refund, invoice PDF) · **Team** (users list) · **Usage** (bookings, notifications, funnel) · **Audit** |
| `/superadmin/payments` | All payments | Filters (status, provider, date), CSV export, refund flow with reason |
| `/superadmin/plans` | Plans & pricing | Plan CRUD, feature JSON, price/currency, trial days, active toggle |
| `/superadmin/analytics` | System-wide analytics | Growth (tenants, MRR), trial→paid conversion cohorts, churn, bookings heatmap, notification success by provider |
| `/superadmin/audit` | Audit log | Actor, impersonator, action, entity, diff, IP |
| `/superadmin/settings` | System settings | VAPID keys status, PSP credentials, SMS/WA providers, feature flags, reserved slugs |

### Key flows
**Suspend a business:** business row → Suspend (reason) → `tenants.status='suspended'` → booking pages show "closed" banner + queue/panels read-only → audit logged → reactivation reverses.
**Impersonate:** row action → 1-time ticket link → opens Barber panel with red banner "Impersonation – all actions are logged" → tenant deletion blocked.
**Refund:** payment row → Refund → PSP adapter call → status refunded → subscription unaffected unless overpayment rule.

---

## 2. Barber Panel  (`panel.{domain}` — React SPA, **tablet-first**)

Responsive: layouts optimize at **≥ 1280 (desktop/tv), ≥ 900 (tablet-primary), ≥ 600, < 600 (phone-readable)**; min touch target 48 px; persistent left rail on tablet, bottom tab bar on phones; dark surfaces for "always-on" screens (live queue, QR display).

### Routes

| Route | Screen | Key content |
|---|---|---|
| `/barber/login` | Login | Email/password (+2FA optional for owners) |
| `/barber/onboarding` | Wizard (first login, trial) | **1** Shop info (name, logo, address, phone) → **2** Services (quick list + durations/prices) → **3** Working hours (weekly grid + staff) → done → dashboard w/ "share your QR" CTA |
| `/barber/dashboard` | Dashboard | Cards: **Bugünün Randevuları**, Dünün Randevuları, Gelecek 3 Gün; quick actions: New appointment · **Live screen** · **Show QR**; upsell banner when trial |
| `/barber/calendar` | Calendar | Day/week/month; per-staff color columns; click hour → quick-create (service, staff, customer search by phone); "Lock/Unlock working outside hours" flow: can set custom hours for that day; "Walk-in (immediate now)" button; can log past appointments retroactively |
| `/barber/business-hours` | Working Calendar & Holiday Settings | Weekly grid Mon–Sun: open/close + break per day, **one-click "closed day" toggle**; "copy day to others"; per-staff hours sub-tab; below: upcoming **blocks** list |
| `/barber/blocks` (modal from business-hours) | **Instant interruption manager** | New block modal: scope (Whole shop / staff multi-select) · date or date-range · full-day or time-range · reason (Public holiday, Emergency, Illness, Private, Other) · note · ☑ Notify affected customers → create → instant propagation; list w/ edit/delete past & future |
| `/barber/services` | Services | CRUD cards: name, duration, buffer, price, active; assignment matrix (who can do what) with custom price override |
| `/barber/staff` | Staff | List: name, phone, working hours, services, calendar color; invite (email/SMS) as staff role |
| `/barber/appointments` | Appointments | Filters (date/status/staff), status chips, actions (reschedule modal, cancel, no-show), walk-in creator |
| `/barber/customers` | Customers | Search by phone, history timeline, no-show counter, notes, blocked flag, consent status |
| `/barber/live` | **Live Queue Screen** | hospital-style (see §4); open-and-leave mode; fullscreen button |
| `/barber/qr` | QR & Sharing | Primary link `oleumsrandevu.app/{slug}`, **dynamic QR preview**, download SVG/PNG, copy, **"Show on TV" fullscreen package mode**, funnel stats (scans→installs→bookings) |
| `/barber/billing` | Subscription | Plan, renewal date, usage vs limits (SMS credits), invoices, upgrade checkout |
| `/barber/settings` | Settings | Profile, booking rules (min notice, advance days, slot granularity), notifications log + send-test, team, data export |

### Flows (sequence highlights)
- **One-click close Sunday:** business-hours grid → toggle `Sun` closed → save → confirm toast "Sunday closed; X appointments affected (notify?)" → availability excludes Sundays from now on.
- **Emergency block:** dashboard "New block" quick button → preset "Emergency – today 1–5 pm, whole shop" → create → booking page users instantly see slots vanish (WS); existing 3 customers pushed a note if ☑.
- **Walk-in:** Fast-Add customer info (name+phone, optional) + service + staff → "Start now" → status `in_progress` immediately; queue screen reflects right away. (Past entry: set actual times backdated.)

---

## 3. Customer PWA  (`{booking-domain}/{slug}` — Next.js, installable)

### Routes & install UX

| Route | Screen | Key content |
|---|---|---|
| `/{slug}` | Landing | Cover, shop name, rating-all-address, "open now" chip, services preview, **sticky CTA "Appointment"**, phone/map links, **A2HS install banner** (Android: native prompt; iOS: "Share → Add to Home Screen" instructions modal) |
| `/{slug}/services` | Step 1 | Service cards (name, duration, price) |
| `/{slug}/staff` | Step 2 | **"Whoever is available" (recommended)** default + staff cards; skipped when 1 staff |
| `/{slug}/book` | Step 3 | 14-day scrollable date strip + **slot chip grid (live)**; legend for closed/day-off; disabled chips on block conflicts, auto re-render on WS |
| `/{slug}/confirm` | Step 4 | Summary (service · staff · date · time) + name + phone + notes + **consent toggles (SMS/WhatsApp/push)** (KVKK checkbox) → Booking |
| `/{slug}/done/:token` | Success | Details card, **Add to Calendar (ICS)**, push-permission prompt, "Add to home screen" nudge, **Appointment status tracking** link (live status via token), cancel/reschedule policy note |
| `/{slug}/appointment/:token` | Tracker | Current status (Booked / In chair / Completed), staff, live-updated; cancel option up to policy |

PWA: `manifest.json` (name, short_name, maskable icons 192/512, theme≈brand, standalone) · Service Worker (Workbox): precache app shell, cache-first static, network-only for API (availability is live data) · offline fallback page.

### The invalidation moment (what the customer sees)
```
Before booking                  Barber creates a block 14:00-15:00     < 1s later
┌──────────────────────────┐    ┌──────────────────┐            ┌──────────────────────────┐
│ 14:00  14:15  14:30  14:45│    │ New block        │            │ 14:00  14:15 ─grey─ ─grey─│
│ 15:00  15:15  15:30      │    │ range, saved ✔   │            │ 15:00  15:15  15:30      │
└──────────────────────────┘    └──────────────────┘            │ ⚠ Slots for 14:00-15:00  │
                                                                │   have just been taken   │
                                                                │ → next free slot shown   │
                                                                └──────────────────────────┘
```
If the user already picked a now-blocked time and taps Confirm → server re-validates → **409** → choice sheet: keep same day next free slot / change staff / pick another day.

---

## 4. Live Queue Screen (hospital-style) — `/barber/live`

### Layout (tablet/TV, 16:9)

```
┌────────────────────────────────────────────────────────────────────────────┐
│ ● BERBER AHMET — LIVE QUEUE                      Fri, 12:42  · connected ● │
├──────────────────────────────────────────┬─────────────────────────────────┤
│  ON THE CHAIR (currently)                │  NEXT IN QUEUE (chronological)  │
│ ┌──────────────────────────────────────┐ │ ┌───────────────────────────────┐
│ │  Fatih K.                            │ │ │ 13:00  Mert D.    Waiting     │
│ │  Hair + Beard · 45-minute appointment│ │ │        Hair + Beard · staff   │
│ │  12:30 → 13:15 · staff: Ahmet         │ │ │        [  Take to chair  ]      │
│ │                                      │ │ └───────────────────────────────┘│
│ │  [ ✅ Completed ]    [ 🚫 No-show ]    │ │ ┌───────────────────────────────┐
│ └──────────────────────────────────────┘ │ │ 13:15  Canan S.   Waiting     │
│  Recently completed: 12:00 Ali V. ✓      │ │ 13:30  Efe T.     Waiting     │
│                                          │ │ … (scrolls, auto-focus)       │
└──────────────────────────────────────────┴─────────────────────────────────┘
```

- **States/labels:** `booked → "Waiting"`, `in_progress → "In chair"`, `completed → ✓", `no_show → "No-show"`; color-coded chips.
- One-touch buttons large (≥ 64 px) + **5-second undo** via status history (`restore` action).
- Multi-staff mode: one "on the chair" card per staff (stacked top row).
- Device ops: TV gets a **device token pair** (display code + confirm in panel) → token can *only* call status endpoints — nothing else; keeps tablets safe in-store.
- Heartbeat/offline: red "reconnecting" pill after 3 s without WS; 30 s polling fallback; auto-resync on reconnect.

### Status-change event fan-out
`button → POST status → tx(status+history) → Redis publish → Socket.IO → [TV, panel calendars, PWA trackers of the affected customer]` — the customer's tracker (`/{slug}/appointment/{token}`) flips from "Booked" to "In chair" in real time the same way blocked slots disappear.

---

## 5. Cross-cutting UX specs

- **Empty/failed states** everywhere are typed (`NO_DATA`, `OFFLINE`, `SUSPENDED`, `WAB_TEMPLATE_MISSING`) with actionable copy; booking page never shows raw errors.
- **Skeletons** on all async tiles; availability refetch keeps previous chips visible (no layout flash).
- **i18n:** tr default; all copy in `apps/*/locales/{tr,en}.json`; server-rendered landing pages set `lang` correctly.
- **Accessibility:** WCAG AA contrast on dark screens, aria-live for queue changes on TV, focus outlines on panel forms.
