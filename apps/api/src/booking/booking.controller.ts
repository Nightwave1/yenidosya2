import { Body, Controller, Get, Headers, Param, Post, Query, UsePipes } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  panelBookingSchema,
  publicBookingSchema,
  type PanelBookingDTO,
  type PublicBookingDTO,
} from '@oleum/schemas'
import { Public, CurrentUser, Roles, type Claims } from '../common/decorators'
import { ZodValidationPipe } from '../common/zod-pipe'
import { TenancyService } from '../tenancy/tenancy.module'
import { BookingRepository } from './booking.repository'
import { BookingService } from './booking.service'

const customerSchema = z.object({
  full_name: z.string().min(2).max(80),
  phone: z
    .string()
    .min(7)
    .max(20)
    .regex(/^[0-9\s()+-]+$/, 'digits, spaces and + ( ) - only'),
  note: z.string().max(500).optional(),
})

// ---------------------------------------------------------------------------
// Public PWA booking endpoints (open, rate-limited at the edge later)
// ---------------------------------------------------------------------------
@Controller('public/tenants/:slug')
export class PublicBookingController {
  constructor(
    private readonly tenants: TenancyService,
    private readonly booking: BookingService,
  ) {}

  /** POST with an Idempotency-Key header: retries return the same appointment. */
  @Public()
  @Post('appointments')
  @UsePipes(new ZodValidationPipe(publicBookingSchema))
  async create(
    @Param('slug') slug: string,
    @Body() dto: PublicBookingDTO,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const tenant = await this.tenants.resolveBySlug(slug)
    return this.booking.createPublicBooking(tenant, dto, idempotencyKey ?? randomUUID())
  }
}

// ---------------------------------------------------------------------------
// Public "manage my appointment" — the links inside reminder messages
// ---------------------------------------------------------------------------
@Controller('public/tenants/:slug/appointments')
export class PublicAppointmentController {
  constructor(
    private readonly tenants: TenancyService,
    private readonly booking: BookingService,
  ) {}

  @Public()
  @Get(':checkToken')
  async get(@Param('slug') slug: string, @Param('checkToken') checkToken: string) {
    const tenant = await this.tenants.resolveBySlug(slug)
    return this.booking.getByToken(tenant, checkToken)
  }

  @Public()
  @Post(':checkToken/cancel')
  async cancel(@Param('slug') slug: string, @Param('checkToken') checkToken: string) {
    const tenant = await this.tenants.resolveBySlug(slug)
    return this.booking.cancelByCustomer(tenant, checkToken)
  }
}

// ---------------------------------------------------------------------------
// Panel catalog (JWT): services + staff for the panel dropdowns
// ---------------------------------------------------------------------------
@Controller('catalog')
export class CatalogController {
  constructor(
    private readonly repo: BookingRepository,
  ) {}

  @Roles('tenant_admin', 'staff')
  @Get('services')
  services(@CurrentUser() claims: Claims) {
    return this.repo.listServices(claims.tenant_id!)
  }

  @Roles('tenant_admin', 'staff')
  @Get('staff')
  staff(@CurrentUser() claims: Claims) {
    return this.repo.listStaff(claims.tenant_id!)
  }
}

// ---------------------------------------------------------------------------
// Panel endpoints (barber/spa staff app)
// ---------------------------------------------------------------------------
@Controller('appointments')
export class PanelAppointmentController {
  constructor(
    private readonly tenants: TenancyService,
    private readonly booking: BookingService,
  ) {}

  @Roles('tenant_admin', 'staff')
  @Post()
  @UsePipes(new ZodValidationPipe(panelBookingSchema))
  async create(@CurrentUser() claims: Claims, @Body() dto: PanelBookingDTO) {
    const tenant = await this.tenants.getTenant(claims.tenant_id!)
    return this.booking.createPanelBooking(tenant, claims.sub, dto)
  }

  @Roles('tenant_admin', 'staff')
  @Get()
  async list(
    @CurrentUser() claims: Claims,
    @Query() q: { date?: string; staff_id?: string; status?: string },
  ) {
    const tenant = await this.tenants.getTenant(claims.tenant_id!)
    return this.booking.listForDay(tenant, q.date, {
      staffId: q.staff_id ?? null,
      status: q.status ?? null,
    })
  }
}

@Controller('customers')
export class CustomerController {
  constructor(
    private readonly tenants: TenancyService,
    private readonly repo: BookingRepository,
  ) {}

  @Roles('tenant_admin', 'staff')
  @Get()
  async search(@CurrentUser() claims: Claims, @Query() q: { search?: string }) {
    const tenant = await this.tenants.getTenant(claims.tenant_id!)
    return this.repo.searchCustomers(tenant.id, q.search ?? '')
  }

  @Roles('tenant_admin')
  @Post()
  @UsePipes(new ZodValidationPipe(customerSchema))
  async upsert(@CurrentUser() claims: Claims, @Body() dto: { full_name: string; phone: string; note?: string }) {
    const tenant = await this.tenants.getTenant(claims.tenant_id!)
    const customer = await this.repo.upsertCustomer(tenant.id, dto.full_name, dto.phone)
    return customer
  }
}
