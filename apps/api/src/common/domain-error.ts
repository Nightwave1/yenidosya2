import { HttpException, HttpStatus } from '@nestjs/common'

/**
 * Domain-level error surfaced as a versionable JSON envelope:
 * { code, message, ...extra } — e.g. SLOT_UNAVAILABLE carries fresh availability.
 */
export class DomainError extends HttpException {
  constructor(
    readonly code: string,
    message: string,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
    readonly extra?: Record<string, unknown>,
  ) {
    super({ code, message, ...(extra ?? {}) }, status)
  }
}
