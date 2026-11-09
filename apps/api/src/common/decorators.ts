import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common'

export type Role = 'super_admin' | 'tenant_admin' | 'staff'

export interface Claims {
  sub: string
  role: Role
  tenant_id: string | null
  name?: string
}

export const IS_PUBLIC = 'isPublic'
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true)

export const ROLES_KEY = 'roles'
export const Roles = (...roles: Role[]): MethodDecorator => SetMetadata(ROLES_KEY, roles)

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): Claims => {
  return (ctx.switchToHttp().getRequest() as { user: Claims }).user
})
