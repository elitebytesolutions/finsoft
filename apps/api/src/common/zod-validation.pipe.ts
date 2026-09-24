import { BadRequestException, PipeTransform } from '@nestjs/common'
import type { ZodSchema } from 'zod'

/**
 * Validates a request payload against a zod schema.
 *
 * `packages/validation` owns the schemas (ARCHITECTURE §2); this is only the
 * adapter that runs one at the HTTP boundary and turns a failure into a 400.
 *
 * Two properties matter more than the plumbing:
 *
 * **It strips.** Whatever the schema does not declare does not reach the
 * application. A request that supplies `tenant_id` therefore cannot smuggle
 * it into a handler, which is the mechanical half of ADR-0004:76 — "a request
 * that tries to supply a tenant is not honoured and not negotiated with".
 *
 * **It reports without echoing.** The response names the failing paths and
 * the reason, never the submitted values. Rule 20 forbids secrets in logs and
 * error messages, and a validation error on a login or token payload is
 * exactly where a submitted value would leak.
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value)

    if (!result.success) {
      throw new BadRequestException({
        error: 'validation_failed',
        message: 'The request body did not match the expected shape.',
        details: result.error.issues.map((issue) => ({
          path: issue.path.join('.') || '(root)',
          code: issue.code,
          message: issue.message,
        })),
      })
    }

    return result.data
  }
}
