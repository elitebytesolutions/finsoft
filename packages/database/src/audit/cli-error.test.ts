import { describe, expect, it } from 'vitest'
import { describeCliError } from './cli-error.ts'

describe('describeCliError', () => {
  it('strips a connection string embedded in the message', () => {
    const error = new Error(
      'connection to server failed: postgresql://readonly_support:hunter2@db.internal:5432/finsoft',
    )
    const described = describeCliError(error)
    expect(described).not.toContain('hunter2')
    expect(described).not.toContain('db.internal')
    expect(described).toContain('(url redacted)')
  })

  it('appends the SQLSTATE/error code when present', () => {
    const error = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' })
    expect(describeCliError(error)).toBe('connection refused (ECONNREFUSED)')
  })

  it('omits the code suffix when there is none', () => {
    expect(describeCliError(new Error('plain failure'))).toBe('plain failure')
  })

  it('does not print a stack trace', () => {
    const error = new Error('boom')
    expect(describeCliError(error)).not.toContain('at ')
    expect(describeCliError(error)).not.toContain(import.meta.url)
  })

  it('handles a non-Error throw without crashing, and still redacts a URL', () => {
    expect(describeCliError('postgresql://user:pw@host/db failed')).toContain('(url redacted)')
  })
})
