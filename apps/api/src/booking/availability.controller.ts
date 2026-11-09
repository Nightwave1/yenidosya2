import { Controller, Get, Param, Query, UsePipes } from '@nestjs/common'
import { availabilityQuerySchema, type AvailabilityDTO } from '@oleum/schemas'
import { Public, CurrentUser, Roles, type Claims } from '../common/decorators'
import { ZodValidationPipe } from '../common/zod-pipe'
import { TenancyService } from '../tenancy/tenancy.module'
import { AvailabilityService } from './availability.service'

@Controller('public/tenants/:slug')
export class PublicAvailabilityController {
  constructor(
    private readonly tenants: TenancyService,
    private readonly availability: AvailabilityService,
  ) {}

  @Public()
  @Get('availability')
  @UsePipes(new ZodValidationPipe(availabilityQuerySchema))
  async get(
    @Param('slug') slug: string,
    @Query() q: { service_id: string; staff_id: 'any' | string; date: string },
  ): Promise<AvailabilityDTO> {
    const tenant = await this.tenants.resolveBySlug(slug)
    return this.availability.getDayAvailability(tenant, q.service_id, q.staff_id ?? 'any', q.date)
  }
}

@Controller('availability')
export class PanelAvailabilityController {
  constructor(
    private readonly tenants: TenancyService,
    private readonly availability: AvailabilityService,
  ) {}

  @Roles('tenant_admin', 'staff')
  @Get()
  @UsePipes(new ZodValidationPipe(availabilityQuerySchema))
  async get(
    @CurrentUser() claims: Claims,
    @Query() q: { service_id: string; staff_id: 'any' | string; date: string },
  ): Promise<AvailabilityDTO> {
    const tenant = await this.tenants.getTenant(claims.tenant_id!)
    return this.availability.getDayAvailability(tenant, q.service_id, q.staff_id ?? 'any', q.date)
  }
}
