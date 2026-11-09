import { Global, Injectable, Module, type OnModuleDestroy } from '@nestjs/common'
import {
  WebSocketGateway,
  WebSocketServer,
  type OnGatewayInit,
  type OnGatewayConnection,
} from '@nestjs/websockets'
import { createAdapter } from '@socket.io/redis-adapter'
import Redis from 'ioredis'
import type { Server, Socket } from 'socket.io'
import { env } from '@oleum/db'
import { TokenService } from '../common/token.module'

/**
 * Rooms:
 *  - tenant:{tenantId}  panel users + in-store devices (JWT)
 *  - public:{slug}      booking pages + customer trackers (open, slug-scoped)
 */
@WebSocketGateway({ path: '/ws', cors: { origin: '*' } })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnModuleDestroy {
  @WebSocketServer() server: Server | undefined

  private publisher?: Redis
  private subscriber?: Redis

  constructor(private readonly tokens: TokenService) {}

  afterInit(server: Server): void {
    const url = env.REDIS_URL
    if (url) {
      this.publisher = new Redis(url)
      this.subscriber = this.publisher.duplicate()
      server.adapter(createAdapter(this.publisher, this.subscriber))
    }
  }

  handleConnection(client: Socket): void {
    const auth = (client.handshake.auth ?? {}) as { slug?: string; token?: string }
    if (auth.slug) void client.join(`public:${auth.slug.toLowerCase()}`)
    if (auth.token) {
      const claims = this.tokens.verify(auth.token)
      if (claims?.tenant_id) void client.join(`tenant:${claims.tenant_id}`)
    }
  }

  emitTo(rooms: string[], event: string, payload?: unknown): void {
    if (!this.server) return
    for (const room of rooms) {
      this.server.to(room).emit(event, payload ?? null)
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.publisher?.quit(), this.subscriber?.quit()])
  }
}

@Injectable()
export class RealtimeService {
  constructor(private readonly gateway: RealtimeGateway) {}

  publish(rooms: string[], event: string, payload?: unknown): void {
    this.gateway.emitTo(rooms, event, payload)
  }

  tenantRooms(tenant: { id: string; slug: string }): string[] {
    return [`tenant:${tenant.id}`, `public:${tenant.slug.toLowerCase()}`]
  }
}

@Global()
@Module({
  providers: [RealtimeGateway, RealtimeService],
  exports: [RealtimeService],
})
export class RealtimeModule {}
