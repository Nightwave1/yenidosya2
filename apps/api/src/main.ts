import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { env } from '@oleum/db'
import { AppModule } from './app.module'
import { AllExceptionsFilter } from './common/filters'

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: ['log', 'warn', 'error'] })
  app.setGlobalPrefix('v1')
  app.enableCors()
  app.useGlobalFilters(new AllExceptionsFilter())
  app.enableShutdownHooks()
  await app.listen(env.PORT)
  console.log(`oleumsrandevu API ready on http://localhost:${env.PORT}/v1 (WS at /ws)`)
}

void bootstrap()
