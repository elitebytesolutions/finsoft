// Renders tools/parity/results.json (written by run.mjs) as the sorted
// markdown table used in report.md. Run after run.mjs; prints to stdout so
// the prose defect analysis in report.md can be maintained by hand around it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const results = JSON.parse(readFileSync(join(process.cwd(), 'tools/parity/results.json'), 'utf8'))

const rank = { DEFECT: 0, 'SIZE MISMATCH': 1, ERROR: 2, 'MINOR DIFF': 3, NEGLIGIBLE: 4, IDENTICAL: 5 }
const sorted = [...results].sort((a, b) => {
  const r = (rank[a.verdict] ?? 9) - (rank[b.verdict] ?? 9)
  if (r !== 0) return r
  return (b.pct ?? -1) - (a.pct ?? -1)
})

console.log('| Route | Pixels differing | % of page | Verdict |')
console.log('|---|---|---|---|')
for (const r of sorted) {
  const px = r.diffPixels == null ? '—' : r.diffPixels.toLocaleString('en-US')
  const pct = r.pct == null ? '—' : `${r.pct.toFixed(4)}%`
  console.log(`| \`${r.path}\` | ${px} | ${pct} | ${r.verdict} |`)
}

const counts = {}
for (const r of results) counts[r.verdict] = (counts[r.verdict] || 0) + 1
console.error('\nSummary:', JSON.stringify(counts))
