#!/usr/bin/env node
import { verifyAuditChain } from './verify.ts'

/*
 * `npm run audit:verify [-- --tenant <id>]` — ADR-0020 §6.
 *
 * A separate CLI entrypoint, like packages/database/src/migrate/cli.ts:
 * never imported by application code, connects as its own role
 * (readonly_support, not finsoft_app), and exits non-zero on a broken chain
 * so it composes into a scheduled job or a release gate.
 */

interface Args {
  tenantId?: string
}

function parseArgs(argv: readonly string[]): Args {
  const index = argv.indexOf('--tenant')
  if (index === -1) return {}
  const tenantId = argv[index + 1]
  if (!tenantId) {
    throw new Error('--tenant requires a value')
  }
  return { tenantId }
}

async function main(): Promise<number> {
  const { tenantId } = parseArgs(process.argv.slice(2))
  const result = await verifyAuditChain(tenantId)

  if (result.ok) {
    console.log(
      `audit chain OK — ${result.tenantsChecked} tenant(s), ${result.rowsChecked} row(s) verified.`,
    )
    return 0
  }

  const brokenAt = result.firstBreak
  if (brokenAt) {
    console.error(
      `audit chain BROKEN — tenant ${brokenAt.tenantId}, seq ${brokenAt.seq}` +
        `${brokenAt.id ? ` (id ${brokenAt.id})` : ''}: ${brokenAt.reason}`,
    )
  }
  console.error(
    `Checked ${result.tenantsChecked} tenant(s), ${result.rowsChecked} row(s) before the break.`,
  )
  return 1
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
