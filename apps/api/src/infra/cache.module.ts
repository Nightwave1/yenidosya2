import { Global, Injectable, Logger, Module, type OnModuleDestroy } from '@nestjs/common'
import Redis from 'ioredis'
import { env } from '@oleum/db'

/**
 * Availability-cache + realtime backend.
 * Uses Redis when REDIS_URL is set; otherwise an in-memory fallback for local dev.
 */
@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name)
  private redis: Redis | null
  private memory = new Map<string, { value: string; expiresAt: number }>()

  constructor() {
    const url = env.REDIS_URL
    if (url) {
      this.redis = new Redis(url)
      this.redis.on('error', (e: Error) => this.logger.warn(`redis: ${e.message}`))
    } else {
      this.redis = null
    }
  }

  async get(key: string): Promise<string | null> {
    if (this.redis) return this.redis.get(key)
    const hit = this.memory.get(key)
    if (!hit) return null
    if (hit.expiresAt < Date.now()) {
      this.memory.delete(key)
      return null
    }
    return hit.value
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (this.redis) {
      await this.redis.set(key, value, 'EX', ttlSeconds)
      return
    }
    this.memory.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 })
  }

  async dropPrefix(prefix: string): Promise<void> {
    if (this.redis) {
      const keys = await this.redis.keys(`${prefix}*`)
      if (keys.length > 0) await this.redis.del(...keys)
      return
    }
    for (const key of [...this.memory.keys()]) {
      if (key.startsWith(prefix)) this.memory.delete(key)
    }
  }

  async wrap<T>(key: string, ttlSeconds: number, producer: () => Promise<T>): Promise<T> {
    const hit = await this.get(key)
    if (hit !== null) {
      try {
        return JSON.parse(hit) as T
      } catch {
        /* corrupt entry falls through to producer */
      }
    }
    const value = await producer()
    await this.set(key, JSON.stringify(value), ttlSeconds)
    return value
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis) await this.redis.quit()
  }
}

@Global()
@Module({
  providers: [CacheService],
  exports: [CacheService],
})
export class CacheModule {}
