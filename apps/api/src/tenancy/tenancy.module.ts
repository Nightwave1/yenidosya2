import { Controller, Get, Global, HttpStatus, Injectable, Module, Param } from '@nestjs/common'
import { DbService } from '../infra/db.module'
import { DomainError } from '../common/domain-error'
import { Public } from '../common/decorators'

export interface TenantRow {
  id: string
  name: string
  slug: string
  status: string
  status_reason: string | null
  timezone: string
  settings: Record<string, unknown> | null
  logo_url: string | null
  address_text: string | null
  city: string | null
  district: string | null
  phone: string | null
  currency: string
}

@Injectable()
export class TenancyService {
  constructor(private readonly db: DbService) {}

  async resolveBySlug(slug: string): Promise<TenantRow> {
    const rows = await this.db.system((sql) =>
      sql.query<TenantRow>(
        `SELECT id, name, slug, status, status_reason, timezone, settings,
                logo_url, address_text, city, district, phone, currency
         FROM tenants
         WHERE slug = $1 AND deleted_at IS NULL
         LIMIT 1`,
        [slug.toLowerCase()],
      ),
    )
    const tenant = rows[0]
    if (!tenant) {
      throw new DomainError('SHOP_NOT_FOUND', 'Berber bulunamadı', HttpStatus.NOT_FOUND)
    }
    if (tenant.status !== 'active') {
      throw new DomainError(
        'SHOP_UNAVAILABLE',
        tenant.status_reason ?? 'Bu dükkan şu anda online randevuya kapalı',
        HttpStatus.SERVICE_UNAVAILABLE,
      )
    }
    return tenant
  }

  async getTenant(tenantId: string): Promise<TenantRow> {
    const rows = await this.db.system((sql) =>
      sql.query<TenantRow>(
        `SELECT id, name, slug, status, status_reason, timezone, settings,
                logo_url, address_text, city, district, phone, currency
         FROM tenants WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
        [tenantId],
      ),
    )
    const tenant = rows[0]
    if (!tenant) {
      throw new DomainError('SHOP_NOT_FOUND', 'Barber bulunamadı', HttpStatus.NOT_FOUND)
    }
    return tenant
  }
}

@Controller('public/tenants/:slug')
export class PublicTenantController {
  constructor(
    private readonly tenants: TenancyService,
    private readonly db: DbService,
  ) {}

  /** Booking-page landing data (SSR'd by the PWA later). */
  @Public()
  @Get()
  async profile(@Param('slug') slug: string) {
    const t = await this.tenants.resolveBySlug(slug)
    return {
      slug: t.slug,
      name: t.name,
      logo_url: t.logo_url,
      address: [t.address_text, t.district, t.city].filter(Boolean).join(', ') || null,
      phone: t.phone,
      currency: t.currency,
      timezone: t.timezone,
    }
  }

  @Public()
  @Get('services')
  async services(@Param('slug') slug: string) {
    const t = await this.tenants.resolveBySlug(slug)
    const rows = await this.db.tenant(t.id, (sql) =>
      sql.query<{
        id: string
        name: string
        description: string | null
        price: string
        duration_min: number
        buffer_after_min: number
        image_url: string | null
        category: string | null
      }>(
        `SELECT id, name, description, price, duration_min, buffer_after_min, image_url, category
         FROM services WHERE is_active ORDER BY sort_order ASC, created_at ASC`,
      ),
    )
    return rows.map((r) => ({ ...r, price: Number(r.price) }))
  }

  /** Active staff roster with the service ids each performs (booking UI staff step). */
  @Public()
  @Get('staff')
  async staff(@Param('slug') slug: string) {
    const t = await this.tenants.resolveBySlug(slug)
    const rows = await this.db.tenant(t.id, (sql) =>
      sql.query<{
        id: string
        display_name: string
        color: string
        role_title: string | null
        service_ids: string[]
      }>(
        `SELECT st.id, st.display_name, st.color, st.role_title,
                COALESCE(
                  json_agg(ss.service_id) FILTER (WHERE ss.service_id IS NOT NULL),
                  '[]'::json
                ) AS service_ids
         FROM staff st
         LEFT JOIN staff_services ss ON ss.staff_id = st.id
         WHERE st.is_active
         GROUP BY st.id, st.display_name, st.color, st.role_title, st.sort_order
         ORDER BY st.sort_order ASC, st.display_name ASC`,
      ),
    )
    return rows
  }
}

@Global()
@Module({
  controllers: [PublicTenantController],
  providers: [TenancyService],
  exports: [TenancyService],
})
export class TenancyModule {}
