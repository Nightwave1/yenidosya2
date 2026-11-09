import { Module } from '@nestjs/common'
import { TokenModule } from './common/token.module'
import { DbModule } from './infra/db.module'
import { CacheModule } from './infra/cache.module'
import { RealtimeModule } from './infra/realtime.module'
import { TenancyModule } from './tenancy/tenancy.module'
import { AuthModule } from './auth/auth.module'
import { NotificationsModule } from './notifications/notifications.module'
import { SchedulingModule } from './scheduling/scheduling.module'
import { BookingModule } from './booking/booking.module'
import { QueueModule } from './queue/queue.module'

/**
 * Modular monolith (ARCHITECTURE §2): auth/tenancy/scheduling/booking/queue/
 * notifications are self-contained modules sharing the global DB/cache/
 * realtime providers — each is a future microservice extraction candidate.
 */
@Module({
  imports: [
    TokenModule,
    DbModule,
    CacheModule,
    RealtimeModule,
    TenancyModule,
    AuthModule,
    NotificationsModule,
    SchedulingModule,
    BookingModule,
    QueueModule,
  ],
})
export class AppModule {}
