import { Global, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common'
import { closePool, withSystem, withTenant, type SqlQueryClient } from '@oleum/db'

@Injectable()
export class DbService implements OnApplicationShutdown {
  tenant<T>(tenantId: string, fn: (sql: SqlQueryClient) => Promise<T>): Promise<T> {
    return withTenant(tenantId, fn)
  }

  system<T>(fn: (sql: SqlQueryClient) => Promise<T>): Promise<T> {
    return withSystem(fn)
  }

  async onApplicationShutdown(): Promise<void> {
    await closePool()
  }
}

@Global()
@Module({
  providers: [DbService],
  exports: [DbService],
})
export class DbModule {}
