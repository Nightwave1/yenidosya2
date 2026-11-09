-- ============================================================================
-- 0001_init.sql — Barbershop SaaS v1.0 (see docs/ARCHITECTURE.md)
-- Conventions:
--   * tenant-scoped tables carry tenant_id and are protected by RLS
--   * timestamps are timestamptz (UTC at rest); hour rules are TIME in
--     tenant-local timezone, converted at slot computation time
--   * weekdays: isodow — 1=Mon … 7=Sun
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;  -- GiST over scalar types for the exclusion constraint
CREATE EXTENSION IF NOT EXISTS citext;      -- case-insensitive slug/email
CREATE EXTENSION IF NOT EXISTS pgcrypto;    -- digest() for phone_hash / tokens

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE user_role           AS ENUM ('super_admin', 'tenant_admin', 'staff');
CREATE TYPE tenant_status       AS ENUM ('active', 'suspended', 'deleted');  -- platform switch
CREATE TYPE subscription_status AS ENUM ('trial', 'active', 'past_due', 'passive', 'canceled');
CREATE TYPE billing_cycle       AS ENUM ('monthly', 'yearly');
CREATE TYPE payment_status      AS ENUM ('pending', 'paid', 'failed', 'refunded');
CREATE TYPE block_type          AS ENUM ('public_holiday', 'holiday', 'emergency', 'illness', 'private', 'other');
CREATE TYPE appointment_status  AS ENUM ('booked', 'in_progress', 'completed', 'no_show', 'cancelled');
CREATE TYPE appointment_source  AS ENUM ('booking_page', 'qr_shortlink', 'panel', 'walk_in', 'phone', 'import');
CREATE TYPE notif_channel       AS ENUM ('sms', 'whatsapp', 'push');
CREATE TYPE notif_trigger       AS ENUM ('booking_created', 'booking_cancelled', 'booking_rescheduled',
                                         'reminder_24h', 'reminder_1h', 'block_affected');
CREATE TYPE notif_status        AS ENUM ('scheduled', 'queued', 'sending', 'sent', 'failed', 'cancelled');
CREATE TYPE cancel_via          AS ENUM ('customer', 'shop', 'system');
CREATE TYPE link_event_type     AS ENUM ('scan', 'view', 'booking_started', 'booking_completed', 'pwa_install');

-- ---------------------------------------------------------------------------
-- Tenancy & identity
-- ---------------------------------------------------------------------------
CREATE TABLE tenants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  slug           citext UNIQUE NOT NULL,                 -- https://{booking-domain}/{slug}
  status         tenant_status NOT NULL DEFAULT 'active',
  status_reason  text,                                   -- shown when suspended
  timezone       text    NOT NULL DEFAULT 'Europe/Istanbul',
  locale         text    NOT NULL DEFAULT 'tr',
  currency       char(3) NOT NULL DEFAULT 'TRY',
  country        char(2),
  phone          text,
  email          citext,
  address_text   text, city text, district text,
  lat numeric(9,6), lng numeric(9,6),
  logo_url       text, cover_url text,
  -- booking rules: {"min_notice_minutes":30,"max_advance_days":30,"slot_granularity":15,
  --                 "allow_any_staff":true}
  settings       jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz                             -- soft delete; purge job after 90 d
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid REFERENCES tenants(id) ON DELETE CASCADE,  -- NULL only for super_admin
  role          user_role NOT NULL,
  full_name     text NOT NULL,
  email         citext UNIQUE NOT NULL,
  phone         text,
  password_hash text NOT NULL,                           -- bcrypt (argon2id planned)
  totp_secret   text,                                    -- 2FA (mandatory for super_admin)
  avatar_url    text,
  is_active     boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (role = 'super_admin' OR tenant_id IS NOT NULL)
);

-- Barbers/employees; may optionally map to a users row for panel login
CREATE TABLE staff (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  display_name text NOT NULL,
  phone        text,
  role_title   text,                                     -- "Master barber", "Barber"
  bio          text,
  color        char(7) NOT NULL DEFAULT '#2563eb',       -- calendar color
  is_active    boolean NOT NULL DEFAULT true,
  sort_order   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);
CREATE INDEX staff_tenant_idx ON staff (tenant_id) WHERE is_active;

-- ---------------------------------------------------------------------------
-- Catalog
-- ---------------------------------------------------------------------------
CREATE TABLE services (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name             text NOT NULL,
  description      text,
  price            numeric(10,2) NOT NULL,
  duration_min     integer NOT NULL CHECK (duration_min > 0),
  buffer_after_min integer NOT NULL DEFAULT 0 CHECK (buffer_after_min >= 0),  -- cleaning/setup
  category         text,
  image_url        text,
  is_active        boolean NOT NULL DEFAULT true,
  sort_order       integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX services_tenant_idx ON services (tenant_id) WHERE is_active;

CREATE TABLE staff_services (
  staff_id            uuid NOT NULL REFERENCES staff(id)    ON DELETE CASCADE,
  service_id          uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  custom_price        numeric(10,2),
  custom_duration_min integer,                               -- overrides service defaults
  PRIMARY KEY (staff_id, service_id)
);

-- End-customers of a shop
CREATE TABLE customers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  full_name        text NOT NULL,
  phone            text NOT NULL,
  phone_hash       bytea GENERATED ALWAYS AS
                   (digest(upper(regexp_replace(phone, '[^0-9+]', '', 'g')), 'sha256')) STORED,
  email            citext,
  note             text,
  sms_opt_in       boolean NOT NULL DEFAULT false,        -- KVKK/GDPR consent
  whatsapp_opt_in  boolean NOT NULL DEFAULT false,
  no_show_count    integer NOT NULL DEFAULT 0,
  completed_count  integer NOT NULL DEFAULT 0,
  is_blocked       boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone_hash)
);
CREATE INDEX customers_name_idx ON customers (tenant_id, full_name);

CREATE TABLE push_subscriptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id  uuid REFERENCES customers(id) ON DELETE CASCADE,
  endpoint     text UNIQUE NOT NULL,
  p256dh       text NOT NULL,
  auth         text NOT NULL,
  platform     text NOT NULL DEFAULT 'web',
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);

-- ---------------------------------------------------------------------------
-- Billing (Super Admin domain)
-- ---------------------------------------------------------------------------
CREATE TABLE plans (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              text UNIQUE NOT NULL,                  -- 'starter' | 'pro' | 'studio'
  name              text NOT NULL,
  price_month       numeric(10,2) NOT NULL,
  price_year        numeric(10,2),
  currency          char(3) NOT NULL DEFAULT 'TRY',
  trial_days        integer NOT NULL DEFAULT 14,
  max_staff         integer,
  max_services      integer,
  max_sms_per_month integer,                               -- NULL = unlimited
  features          jsonb NOT NULL DEFAULT '{}',           -- {"whatsapp":true,"push":true,...}
  is_active         boolean NOT NULL DEFAULT true,
  sort_order        integer NOT NULL DEFAULT 0
);

CREATE TABLE subscriptions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid UNIQUE NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id                  uuid NOT NULL REFERENCES plans(id),
  status                   subscription_status NOT NULL DEFAULT 'trial',
  provider                 text,                           -- 'stripe' | 'iyzico' | 'paytr' | 'admin'
  provider_customer_id     text,
  provider_subscription_id text,
  current_period_start     timestamptz,
  current_period_end       timestamptz,
  trial_ends_at            timestamptz,
  cancel_at_period_end     boolean NOT NULL DEFAULT false,
  past_due_since           timestamptz,
  dunning_attempts         integer NOT NULL DEFAULT 0,     -- 3 retries / 72 h policy
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id     uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
  amount              numeric(10,2) NOT NULL,
  currency            char(3) NOT NULL,
  status              payment_status NOT NULL DEFAULT 'pending',
  method              text,
  provider            text NOT NULL,
  provider_payment_id text UNIQUE,
  invoice_number      text,
  invoice_url         text,
  failure_code        text, failure_message text,
  paid_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_tenant_idx ON payments (tenant_id, created_at DESC);

CREATE TABLE subscription_events (                         -- lifecycle audit trail
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
  from_status     subscription_status,
  to_status       subscription_status NOT NULL,
  reason          text,                                    -- 'trial_expired','dunning_exhausted',...
  actor           text NOT NULL,                           -- 'system' | user uuid
  payload         jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Calendar & availability
-- ---------------------------------------------------------------------------
-- Weekly pattern; is_closed = the one-click weekly closing-day toggle
CREATE TABLE business_hours (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),   -- 1=Mon … 7=Sun
  is_closed   boolean NOT NULL DEFAULT false,
  open_time   time,
  close_time  time,
  break_start time, break_end time,
  note        text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, weekday),
  CHECK (is_closed OR (open_time IS NOT NULL AND close_time > open_time))
);

CREATE TABLE staff_hours (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id    uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  is_working  boolean NOT NULL DEFAULT true,
  start_time  time, end_time time,
  break_start time, break_end  time,
  UNIQUE (staff_id, weekday),
  CHECK (is_working = false OR (start_time IS NOT NULL AND end_time > start_time))
);

-- The instant interruption manager. staff_id NULL => whole shop.
CREATE TABLE schedule_blocks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  staff_id        uuid REFERENCES staff(id) ON DELETE CASCADE,
  block_type      block_type NOT NULL DEFAULT 'other',
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  reason          text,
  notify_affected boolean NOT NULL DEFAULT false,          -- message booked customers
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  CHECK (ends_at > starts_at)
);
CREATE INDEX blocks_gist_idx ON schedule_blocks
  USING gist (tenant_id, tstzrange(starts_at, ends_at));    -- fast day-overlap scans
CREATE INDEX blocks_upcoming_idx ON schedule_blocks (tenant_id, starts_at)
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Marketing: dynamic QR + short links + funnel analytics
-- ---------------------------------------------------------------------------
CREATE TABLE short_links (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('qr', 'campaign')),  -- slug link = tenants.slug itself
  code         text UNIQUE NOT NULL,               -- stable QR token → /q/{code} → 302 → /{slug}
  label        text,
  target       text,                               -- defaults to /{slug}; re-pointable
  is_active    boolean NOT NULL DEFAULT true,
  scan_count   integer NOT NULL DEFAULT 0,
  last_scan_at timestamptz,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, label)
);

CREATE TABLE link_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  short_link_id uuid REFERENCES short_links(id) ON DELETE SET NULL,
  type          link_event_type NOT NULL,
  session_id    text,                              -- funnel correlation (scan → booking)
  ip_hash       text, user_agent text, referrer text,
  service_id    uuid,
  customer_id   uuid REFERENCES customers(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX link_events_funnel_idx ON link_events (tenant_id, type, created_at DESC);

-- ---------------------------------------------------------------------------
-- Appointments
-- ---------------------------------------------------------------------------
CREATE TABLE appointments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id        uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  staff_id           uuid NOT NULL REFERENCES staff(id)   ON DELETE RESTRICT, -- resolved at booking
  service_id         uuid NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  service_name_snap  text    NOT NULL,                    -- snapshot: survives renames
  duration_min_snap  integer NOT NULL,
  price_snap         numeric(10,2) NOT NULL,
  starts_at          timestamptz NOT NULL,
  ends_at            timestamptz NOT NULL,                 -- busy window = duration + buffer
  actual_start_at    timestamptz, actual_end_at timestamptz,
  status             appointment_status NOT NULL DEFAULT 'booked',
  source             appointment_source NOT NULL DEFAULT 'booking_page',
  customer_note      text,
  staff_note         text,
  cancelled_at       timestamptz,
  cancelled_by       uuid REFERENCES users(id) ON DELETE SET NULL,  -- NULL = customer
  cancelled_via      cancel_via,
  cancel_reason      text,
  idempotency_key    uuid NOT NULL,                        -- client-generated on booking page
  link_event_id      uuid REFERENCES link_events(id) ON DELETE SET NULL,  -- QR attribution
  check_token        text UNIQUE NOT NULL DEFAULT
                     encode(digest(gen_random_uuid()::text, 'sha256'), 'hex'),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

-- THE double-booking guard: one staff member can never hold two overlapping
-- active bookings. Violation on INSERT ⇒ HTTP 409 (ARCHITECTURE §5.2).
ALTER TABLE appointments ADD CONSTRAINT appointment_no_overlap
  EXCLUDE USING gist (
    staff_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status IN ('booked', 'in_progress'));

CREATE INDEX appt_tenant_date_idx ON appointments (tenant_id, starts_at DESC) INCLUDE (status);
CREATE INDEX appt_staff_date_idx  ON appointments (staff_id, starts_at DESC)
  WHERE status NOT IN ('cancelled');
CREATE UNIQUE INDEX appt_idempotency_idx ON appointments (tenant_id, idempotency_key);

CREATE TABLE appointment_status_history (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  from_status    appointment_status,
  to_status      appointment_status NOT NULL,
  changed_by     uuid REFERENCES users(id) ON DELETE SET NULL,   -- NULL = customer/system
  via            text NOT NULL,                                  -- 'live_queue' | 'panel' | 'public' | 'system'
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX appt_history_idx ON appointment_status_history (appointment_id, created_at);

-- ---------------------------------------------------------------------------
-- Notifications (outbox + scheduled reminders)
-- ---------------------------------------------------------------------------
CREATE TABLE notification_templates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid REFERENCES tenants(id) ON DELETE CASCADE,   -- NULL = platform default
  channel    notif_channel NOT NULL,
  trigger    notif_trigger NOT NULL,
  language   text NOT NULL DEFAULT 'tr',
  body       text NOT NULL,     -- variables: {shop} {customer} {service} {staff} {time} {manage_url}
  is_active  boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, channel, trigger, language)
);

CREATE TABLE notifications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  appointment_id      uuid REFERENCES appointments(id) ON DELETE SET NULL,
  customer_id         uuid REFERENCES customers(id) ON DELETE SET NULL,
  channel             notif_channel NOT NULL,
  trigger             notif_trigger NOT NULL,
  status              notif_status NOT NULL DEFAULT 'scheduled',
  scheduled_at        timestamptz NOT NULL,                  -- when the send should happen
  queued_at           timestamptz,
  sent_at             timestamptz,
  provider            text,                                  -- 'netgsm' | 'twilio' | 'waba' | 'webpush'
  provider_message_id text UNIQUE,
  request_payload     jsonb,
  error               text,
  attempts            integer NOT NULL DEFAULT 0,            -- retry 1m/5m/30m then DLQ
  last_attempt_at     timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notif_due_idx ON notifications (scheduled_at) WHERE status IN ('scheduled', 'queued');
CREATE INDEX notif_appt_idx ON notifications (appointment_id);

-- ---------------------------------------------------------------------------
-- Analytics rollups (Super Admin dashboards read only these)
-- ---------------------------------------------------------------------------
CREATE TABLE daily_tenant_stats (
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day                date   NOT NULL,
  bookings_created   integer NOT NULL DEFAULT 0,
  bookings_cancelled integer NOT NULL DEFAULT 0,
  no_shows           integer NOT NULL DEFAULT 0,
  completed          integer NOT NULL DEFAULT 0,
  new_customers      integer NOT NULL DEFAULT 0,
  active_customers   integer NOT NULL DEFAULT 0,
  sms_sent           integer NOT NULL DEFAULT 0,
  whatsapp_sent      integer NOT NULL DEFAULT 0,
  push_sent          integer NOT NULL DEFAULT 0,
  pwa_installs       integer NOT NULL DEFAULT 0,
  qr_scans           integer NOT NULL DEFAULT 0,
  revenue            numeric(12,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day)
);

-- ---------------------------------------------------------------------------
-- Platform audit & runtime config
-- ---------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id   uuid,                                     -- NULL = system
  actor_role      user_role NOT NULL,
  tenant_id       uuid REFERENCES tenants(id) ON DELETE SET NULL,  -- NULL = platform-level
  impersonated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  action          text NOT NULL,                            -- 'tenant.suspend','block.create',...
  entity          text NOT NULL,
  entity_id       text,
  diff            jsonb,
  ip_hash         text, user_agent text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_recent_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_tenant_idx ON audit_logs (tenant_id, created_at DESC);

CREATE TABLE system_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- Row-Level Security — the tenant backstop.
-- Runtime connects as app_user (NOBYPASSRLS) and every request runs inside
-- withTenant() which sets app.tenant_id for its transaction.
-- Platform/super-admin queries run as app_admin (BYPASSRLS).
-- ============================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','staff','services','staff_services','customers','push_subscriptions',
    'business_hours','staff_hours','schedule_blocks','appointments',
    'appointment_status_history','short_links','link_events','notifications',
    'notification_templates','daily_tenant_stats','payments','subscriptions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t);
  END LOOP;
END $$;

-- Platform-default templates (tenant_id NULL) must stay visible inside tenant
-- sessions while tenant-owned overrides stay isolated.
ALTER TABLE notification_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON notification_templates;
CREATE POLICY tenant_isolation ON notification_templates
  USING (tenant_id IS NULL
         OR tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ============================================================================
-- Seed: plans + default reminder templates (platform-level)
-- ============================================================================
INSERT INTO plans (code, name, price_month, price_year, trial_days, max_staff, max_services, max_sms_per_month, features) VALUES
('starter', 'Starter', 399.00, 3990.00, 14, 1, 10, NULL,  '{"push":true,"whatsapp":true,"analytics":false,"tv_mode":true}'),
('pro',     'Pro',     699.00, 6990.00, 14, 4, 30, 500, '{"push":true,"whatsapp":true,"analytics":true,"tv_mode":true,"campaign_links":true}'),
('studio',  'Studio', 1499.00,14990.00, 14, 20, 200, 2500,'{"push":true,"whatsapp":true,"analytics":true,"tv_mode":true,"campaign_links":true,"custom_domain":true}');

INSERT INTO notification_templates (tenant_id, channel, trigger, language, body) VALUES
(NULL,'sms',      'reminder_24h','tr','Merhaba {customer}, {shop} randevunuz yarın {time} ({service}). Değişiklik için: {manage_url}'),
(NULL,'whatsapp', 'reminder_24h','tr','Merhaba {customer} 👋 "{service}" randevunuz yarın {time} — {staff} sizinle ilgilenecek. Yönet: {manage_url}'),
(NULL,'sms',      'reminder_1h', 'tr','{customer}, {shop} randevunuza 1 saat kaldı: {time} ({service}).'),
(NULL,'whatsapp', 'reminder_1h', 'tr','{customer}, {shop} randevunuza 1 saat kaldı 🕒 {time} · {service}. Yolunuz açık olsun!'),
(NULL,'whatsapp', 'block_affected','tr','{shop}: {time} saatinizdeki randevunuz maalesef iptal edildi ({reason}). Yeniden planlamak için: {manage_url}'),
(NULL,'sms',      'block_affected','tr','{shop}: {time} randevunuz iptal edildi. Yeniden planlama: {manage_url}'),
(NULL,'push',     'reminder_24h','tr','Yarın {time} randevunuz var — {shop}'),
(NULL,'push',     'reminder_1h', 'tr','1 saatten az: {time} randevunuz — {shop}');
