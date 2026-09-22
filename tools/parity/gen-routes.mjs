// Generates tools/parity/routes.json from the apps/web/app directory tree.
// Route (directory) structure defines the 77 routes. Dynamic segments are
// substituted with concrete ids/codes that exist in apps/web/src/mocks/data.ts
// so both the prototype (react-router) and the Next.js app resolve the same
// record. See tools/parity/report.md "Route id choices" for why each value
// was picked.
import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const APP_DIR = join(process.cwd(), 'apps/web/app')

// Concrete substitutions for dynamic route segments, keyed by the full
// bracketed route pattern (not just the segment name) because [id] means a
// different entity on every route it appears on.
const DYNAMIC_ROUTE_VALUES = {
  '/admin/users/[id]': 'USR-001',
  '/customers/[code]': 'CUS-2201',
  '/finance/accounts/[code]': '1110-01',
  '/hr/employees/[id]': 'BT-001',
  '/masters/[code]': '1110-01',
  '/products/[id]': 'MED-1001',
  '/purchases/[id]': 'PUR-2026-0184',
  '/reports/[id]': 'trial-balance',
  '/sales/[id]': 'INV-26814',
  '/vendors/[code]': 'SUP-1004',
  '/vouchers/[id]': 'JV-2026-0409',
}

function walk(dir, base = '') {
  const routes = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (!statSync(full).isDirectory()) continue
    // Route groups like (marketing) don't contribute a URL segment; none
    // exist today but this keeps the generator correct if one is added.
    const segment = entry.startsWith('(') && entry.endsWith(')') ? '' : entry
    const routeBase = segment ? `${base}/${segment}` : base
    routes.push(...walk(full, routeBase))
  }
  try {
    statSync(join(dir, 'page.tsx'))
    routes.push(base === '' ? '/' : base)
  } catch {
    /* no page.tsx at this level */
  }
  return routes
}

const patterns = walk(APP_DIR).sort()

const routes = patterns.map((pattern) => {
  const dynamic = pattern in DYNAMIC_ROUTE_VALUES
  let resolved = pattern
  if (dynamic) {
    const value = DYNAMIC_ROUTE_VALUES[pattern]
    resolved = pattern.replace(/\[[^\]]+\]/, encodeURIComponent(value))
  } else if (/\[[^\]]+\]/.test(pattern)) {
    throw new Error(`No substitution registered for dynamic route: ${pattern}`)
  }
  return { pattern, path: resolved, dynamic }
})

writeFileSync(
  join(process.cwd(), 'tools/parity/routes.json'),
  JSON.stringify(routes, null, 2) + '\n',
)

console.log(`Wrote ${routes.length} routes to tools/parity/routes.json`)
