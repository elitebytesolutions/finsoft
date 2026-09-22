import { BadRequestException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ZodValidationPipe } from './zod-validation.pipe'

describe('ZodValidationPipe', () => {
  const schema = z.object({
    name: z.string().min(1),
    amount: z.string(),
  })
  const pipe = new ZodValidationPipe(schema)

  it('passes a valid payload through', () => {
    expect(pipe.transform({ name: 'Bhatti', amount: '10.00' })).toEqual({
      name: 'Bhatti',
      amount: '10.00',
    })
  })

  it('strips a property the schema does not declare', () => {
    // The mechanical half of ADR-0004:76 — a request cannot smuggle a tenant.
    const result = pipe.transform({
      name: 'Bhatti',
      amount: '10.00',
      tenant_id: '00000000-0000-0000-0000-000000000001',
    })
    expect(result).not.toHaveProperty('tenant_id')
  })

  it('rejects a malformed payload with 400, not 500', () => {
    expect(() => pipe.transform({ name: '' })).toThrow(BadRequestException)
  })

  it('names the failing paths', () => {
    try {
      pipe.transform({ name: '', amount: 42 })
      expect.unreachable('should have thrown')
    } catch (error) {
      const body = (error as BadRequestException).getResponse() as {
        details: Array<{ path: string }>
      }
      expect(body.details.map((d) => d.path).sort()).toEqual(['amount', 'name'])
    }
  })

  it('never echoes the submitted value back', () => {
    // A validation failure on a login or token payload is exactly where a
    // secret would leak into a response or a log (rule 20).
    try {
      pipe.transform({ name: '', amount: 'hunter2-should-not-appear' })
      expect.unreachable('should have thrown')
    } catch (error) {
      const serialised = JSON.stringify((error as BadRequestException).getResponse())
      expect(serialised).not.toContain('hunter2-should-not-appear')
    }
  })
})
