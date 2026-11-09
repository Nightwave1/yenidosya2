import { Body, Controller, Get, Injectable, Module, NotFoundException, Post, UsePipes } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { DbService } from '../infra/db.module'
import { CurrentUser, Public, type Claims } from '../common/decorators'
import { TokenService } from '../common/token.module'
import { JwtAuthGuard } from '../common/guards'
import { ZodValidationPipe } from '../common/zod-pipe'

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(100),
})
type LoginDTO = z.infer<typeof loginSchema>

interface UserRow {
  id: string
  role: Claims['role']
  tenant_id: string | null
  full_name: string
  password_hash: string
  is_active: boolean
}

export interface MeResponse {
  id: string
  full_name: string
  email: string
  role: string
  tenant: {
    name: string
    slug: string
    timezone: string
    currency: string
  } | null
  subscription: { status: string; plan: string | null } | null
}

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DbService,
    private readonly tokens: TokenService,
  ) {}

  async login(
    dto: LoginDTO,
  ): Promise<{ token: string; user: { id: string; role: string; tenant_id: string | null; full_name: string } }> {
    const rows = await this.db.system((sql) =>
      sql.query<UserRow>(
        `SELECT id, role, tenant_id, full_name, password_hash, is_active
         FROM users WHERE email = $1 LIMIT 1`,
        [dto.email.toLowerCase().trim()],
      ),
    )
    const user = rows[0]
    if (!user || !user.is_active) throw new NotFoundException('Invalid credentials')
    const ok = await bcrypt.compare(dto.password, user.password_hash)
    if (!ok) throw new NotFoundException('Invalid credentials')
    await this.db.system((sql) =>
      sql.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]),
    )
    const claims: Claims = {
      sub: user.id,
      role: user.role,
      tenant_id: user.tenant_id,
      name: user.full_name,
    }
    return {
      token: this.tokens.sign(claims, '15m'),
      user: {
        id: user.id,
        role: user.role,
        tenant_id: user.tenant_id,
        full_name: user.full_name,
      },
    }
  }

  async me(claims: Claims): Promise<MeResponse> {
    const rows = await this.db.system((sql) =>
      sql.query<{
        id: string
        full_name: string
        email: string
        role: string
        tenant_name: string | null
        tenant_slug: string | null
        tenant_timezone: string | null
        tenant_currency: string | null
        subscription_status: string | null
        plan_code: string | null
      }>(
        `SELECT u.id, u.full_name, u.email, u.role,
                t.name AS tenant_name, t.slug AS tenant_slug,
                t.timezone AS tenant_timezone, t.currency AS tenant_currency,
                s.status AS subscription_status, p.code AS plan_code
         FROM users u
         LEFT JOIN tenants t ON t.id = u.tenant_id
         LEFT JOIN subscriptions s ON s.tenant_id = u.tenant_id
         LEFT JOIN plans p ON p.id = s.plan_id
         WHERE u.id = $1 LIMIT 1`,
        [claims.sub],
      ),
    )
    const row = rows[0]
    if (!row) throw new NotFoundException('User not found')
    return {
      id: row.id,
      full_name: row.full_name,
      email: row.email,
      role: row.role,
      tenant: row.tenant_slug
        ? {
            name: row.tenant_name ?? '',
            slug: row.tenant_slug,
            timezone: row.tenant_timezone ?? 'Europe/Istanbul',
            currency: row.tenant_currency ?? 'TRY',
          }
        : null,
      subscription: row.subscription_status
        ? { status: row.subscription_status, plan: row.plan_code }
        : null,
    }
  }
}

@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('auth/login')
  @UsePipes(new ZodValidationPipe(loginSchema))
  login(@Body() dto: LoginDTO): Promise<{ token: string; user: unknown }> {
    return this.auth.login(dto)
  }

  @Get('auth/me')
  me(@CurrentUser() claims: Claims): Promise<MeResponse> {
    return this.auth.me(claims)
  }
}

@Module({
  controllers: [AuthController],
  providers: [AuthService, { provide: APP_GUARD, useClass: JwtAuthGuard }],
})
export class AuthModule {}
