// Screenshot-diff parity harness.
//
// Loads every route in routes.json on both the Vite prototype
// (http://localhost:5174) and the ported Next.js app (http://localhost:3000),
// takes a full-page screenshot of each, and pixel-diffs them with pixelmatch.
// Writes tools/parity/out/<route>.{a,b,diff}.png only for routes that differ,
// and tools/parity/report.md summarising every route.
//
// Usage: npm run parity
// Env overrides: PARITY_PROTO_URL, PARITY_NEXT_URL (defaults below).
import { chromium } from 'playwright'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const ROUTES_FILE = join(ROOT, 'tools/parity/routes.json')
const OUT_DIR = join(ROOT, 'tools/parity/out')
const REPORT_FILE = join(ROOT, 'tools/parity/report.md')

const PROTO_BASE = process.env.PARITY_PROTO_URL || 'http://localhost:5174'
const NEXT_BASE = process.env.PARITY_NEXT_URL || 'http://localhost:3000'
const VIEWPORT = { width: 1600, height: 1000 }
const NAV_TIMEOUT_MS = 45_000
const SHELL_TIMEOUT_MS = 15_000
// recharts (Area/Pie/etc.) animates its own SVG attributes via JS (react-smooth),
// not CSS, so the animation-disabling stylesheet below cannot stop it. The only
// reliable way to reach the same final frame on both apps is to wait out the
// animation. recharts' default animation duration is 1500ms.
//
// Measured empirically: self-diffing the prototype's /dashboard against itself
// (same app, same code, two loads back to back) at a 1500ms settle produced
// 0, 11, 2, 116, 12 differing pixels across 5 trials — pure measurement noise
// from catching the chart animation at a slightly different frame each time,
// since navigation/paint timing jitters a few hundred ms run to run. The same
// self-diff at 4000ms was 0px on every trial. 4000ms is the value that earns
// a 0px result rather than getting one by luck.
const RECHARTS_SETTLE_MS = 4000
const PIXELMATCH_THRESHOLD = 0.1

// Applied on every navigation, before first paint, in both contexts.
const SEED_ROLE = 'Owner'

// Neutralises animation/transition jitter (shimmer skeletons, hover states,
// route-change fades) and hides Next.js's dev-mode indicator custom element,
// which has no prototype counterpart. Confirmed by inspection (see report.md)
// that Next 15's dev overlay mounts as <nextjs-portal> in <body>.
const NO_ANIMATION_CSS = `
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  scroll-behavior: auto !important;
  caret-color: transparent !important;
}
@media (prefers-reduced-motion: no-preference) {
  * { animation: none !important; transition: none !important; }
}
nextjs-portal { display: none !important; }
next-route-announcer { display: none !important; }
`

// Routes whose markup intentionally reads the live clock/date. We mask just
// the offending element (Playwright fills it with a solid colour on both
// screenshots) instead of excluding the whole route from the run.
// apps/web/src/screens/today-work.tsx:64 renders `{greeting(now.getHours())}, Sarah!`
// and `{longDate(now)}` from `now = useMemo(() => new Date(), [])` (line 39).
const ROUTE_MASKS = {
  '/today': ['.tw-greet', '.tw-hero strong'],
}

function readRoutes() {
  return JSON.parse(readFileSync(ROUTES_FILE, 'utf8'))
}

function slugify(routePath) {
  return routePath === '/' ? 'root' : routePath.replace(/^\//, '').replace(/\//g, '_')
}

async function seedContext(browser, baseURL) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    baseURL,
  })
  await context.addInitScript((role) => {
    try {
      window.localStorage.setItem('finsoft-role', role)
    } catch {
      /* storage can be unavailable (private mode etc.) — both apps degrade the same way */
    }
  }, SEED_ROLE)
  return context
}

async function captureRoute(context, path, maskSelectors) {
  const page = await context.newPage()
  try {
    await page.goto(path, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT_MS })
    await page.waitForSelector('.shell', { timeout: SHELL_TIMEOUT_MS })
    await page.addStyleTag({ content: NO_ANIMATION_CSS })
    try {
      await page.evaluate(() => document.fonts && document.fonts.ready)
    } catch {
      /* font loading API not available — proceed anyway */
    }
    await page.waitForTimeout(RECHARTS_SETTLE_MS)
    const dims = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      clientWidth: document.documentElement.clientWidth,
      innerWidth: window.innerWidth,
    }))
    const mask = (maskSelectors || []).map((sel) => page.locator(sel))
    const buffer = await page.screenshot({ fullPage: true, mask, maskColor: '#FF00FF' })
    return { ok: true, buffer, dims }
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) }
  } finally {
    await page.close()
  }
}

function padded(png, width, height) {
  if (png.width === width && png.height === height) return png
  const out = new PNG({ width, height })
  // Fill with white so padding is visually obvious in the diff artifact rather
  // than silently matching a transparent/black default.
  out.data.fill(255)
  PNG.bitblt(png, out, 0, 0, png.width, png.height, 0, 0)
  return out
}

function diffPngBuffers(bufA, bufB) {
  const a = PNG.sync.read(bufA)
  const b = PNG.sync.read(bufB)
  const sizeMismatch = a.width !== b.width || a.height !== b.height
  const width = Math.max(a.width, b.width)
  const height = Math.max(a.height, b.height)
  const canvasA = padded(a, width, height)
  const canvasB = padded(b, width, height)
  const diff = new PNG({ width, height })
  const diffPixels = pixelmatch(canvasA.data, canvasB.data, diff.data, width, height, {
    threshold: PIXELMATCH_THRESHOLD,
  })
  return {
    diffPixels,
    totalPixels: width * height,
    sizeMismatch,
    dimsA: { width: a.width, height: a.height },
    dimsB: { width: b.width, height: b.height },
    diffPngBuffer: PNG.sync.write(diff),
    canvasAPngBuffer: sizeMismatch ? PNG.sync.write(canvasA) : bufA,
    canvasBPngBuffer: sizeMismatch ? PNG.sync.write(canvasB) : bufB,
  }
}

function verdictFor(result) {
  if (!result.protoOk || !result.nextOk) return 'ERROR'
  if (result.sizeMismatch) return 'SIZE MISMATCH'
  if (result.diffPixels === 0) return 'IDENTICAL'
  const pct = (result.diffPixels / result.totalPixels) * 100
  if (pct < 0.01) return 'NEGLIGIBLE'
  if (pct < 0.5) return 'MINOR DIFF'
  return 'DEFECT'
}

async function main() {
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(OUT_DIR, { recursive: true })

  const routes = readRoutes()
  console.log(`Parity run: ${routes.length} routes · proto=${PROTO_BASE} next=${NEXT_BASE}`)

  const browser = await chromium.launch({ channel: 'chrome', args: ['--hide-scrollbars'] })
  const protoCtx = await seedContext(browser, PROTO_BASE)
  const nextCtx = await seedContext(browser, NEXT_BASE)

  const results = []
  let i = 0
  for (const route of routes) {
    i += 1
    const mask = ROUTE_MASKS[route.pattern]
    process.stdout.write(`[${i}/${routes.length}] ${route.path} ... `)
    const [proto, next] = await Promise.all([
      captureRoute(protoCtx, route.path, mask),
      captureRoute(nextCtx, route.path, mask),
    ])

    const entry = {
      pattern: route.pattern,
      path: route.path,
      dynamic: route.dynamic,
      protoOk: proto.ok,
      nextOk: next.ok,
      protoError: proto.ok ? null : proto.error,
      nextError: next.ok ? null : next.error,
      protoDims: proto.ok ? proto.dims : null,
      nextDims: next.ok ? next.dims : null,
    }

    if (proto.ok && next.ok) {
      const diff = diffPngBuffers(proto.buffer, next.buffer)
      Object.assign(entry, diff)
      entry.pct = (diff.diffPixels / diff.totalPixels) * 100
    } else {
      entry.diffPixels = null
      entry.totalPixels = null
      entry.pct = null
      entry.sizeMismatch = null
    }
    entry.verdict = verdictFor(entry)

    if (entry.verdict !== 'IDENTICAL') {
      const slug = slugify(route.path)
      if (proto.ok) writeFileSync(join(OUT_DIR, `${slug}.a.png`), entry.canvasAPngBuffer ?? proto.buffer)
      if (next.ok) writeFileSync(join(OUT_DIR, `${slug}.b.png`), entry.canvasBPngBuffer ?? next.buffer)
      if (entry.diffPngBuffer) writeFileSync(join(OUT_DIR, `${slug}.diff.png`), entry.diffPngBuffer)
    }

    console.log(entry.verdict + (entry.pct != null ? ` (${entry.pct.toFixed(4)}%)` : ''))
    results.push(entry)
  }

  await browser.close()

  // Buffers (diffPngBuffer / canvasA-B PngBuffer) are already written to
  // tools/parity/out/*.png above; keep them out of results.json or
  // JSON.stringify blows past V8's max string length on 77 full-page PNGs.
  const serialisable = results.map(({ diffPngBuffer, canvasAPngBuffer, canvasBPngBuffer, ...rest }) => rest)
  writeFileSync(join(ROOT, 'tools/parity/results.json'), JSON.stringify(serialisable, null, 2))
  console.log(`\nWrote tools/parity/results.json and screenshots for differing routes to tools/parity/out/`)
  console.log('Run `node tools/parity/report.mjs` to (re)generate report.md from results.json.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
