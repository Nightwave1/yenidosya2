import { BadRequestException, type ArgumentMetadata, type PipeTransform } from '@nestjs/common'
import type { ZodSchema } from 'zod'

/** Validates a handler input against a Zod schema and returns parsed data. */
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown, _metadata: ArgumentMetadata): unknown {
    const result = this.schema.safeParse(value)
    if (!result.success) {
      throw new BadRequestException({
        code: 'VALIDATION',
        message: 'Validation failed',
        issues: result.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      })
    }
    return result.data
  }
}
