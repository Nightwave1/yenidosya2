import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import { IS_PUBLIC, ROLES_KEY, type Claims, type Role } from './decorators'
import { TokenService } from './token.module'

/**
 * Global JWT auth guard.
 * - Routes decorated with @Public() are open.
 * - @Roles('tenant_admin') etc. restrict; super_admin always passes.
 * - Attaches verified Claims to req.user.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ])
    if (isPublic) return true

    const req = context.switchToHttp().getRequest<Request & { user?: Claims }>()
    const header = req.headers.authorization
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null
    if (!token) throw new UnauthorizedException('Missing bearer token')

    const claims = this.tokens.verify(token)
    if (!claims) throw new UnauthorizedException('Invalid or expired token')
    req.user = claims

    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    if (roles && roles.length > 0) {
      const allowed = claims.role === 'super_admin' || roles.includes(claims.role)
      if (!allowed) throw new ForbiddenException('Insufficient role')
      if (claims.role !== 'super_admin' && !claims.tenant_id) {
        throw new ForbiddenException('Tenant context missing')
      }
    }
    return true
  }
}
