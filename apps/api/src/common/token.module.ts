import { Global, Injectable, Module } from '@nestjs/common'
import type { SignOptions } from 'jsonwebtoken'
import jwt from 'jsonwebtoken'
import { env } from '@oleum/db'
import type { Claims } from './decorators'

@Injectable()
export class TokenService {
  sign(claims: Claims, expiresIn: SignOptions['expiresIn'] = '15m'): string {
    return jwt.sign({ ...claims }, env.JWT_SECRET, { expiresIn })
  }

  verify(token: string): Claims | null {
    try {
      return jwt.verify(token, env.JWT_SECRET) as Claims
    } catch {
      return null
    }
  }
}

@Global()
@Module({
  providers: [TokenService],
  exports: [TokenService],
})
export class TokenModule {}
