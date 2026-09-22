import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The series memo's dependency list must name every field `selectSeries`
 * reads.
 *
 * It did not name `certSales` — the field holding every fetched sale — so a
 * price fetch wrote its results into state and the page kept drawing the old
 * ones until something unrelated changed or it was reloaded. A whole evening
 * went on fetches that had worked: Alt stored 10,768 sales across 32 cards and
 * a card still showed the five it had that morning.
 *
 * React cannot check this, because the memo cannot depend on the store object
 * itself without recomputing on every keystroke. So it is checked here, by
 * reading both sides and comparing them.
 */
const store = readFileSync('src/lib/store.ts', 'utf8')
const app = readFileSync('src/App.tsx', 'utf8')

function fieldsSelectSeriesReads(): string[] {
  const body = store.slice(store.indexOf('export function selectSeries'))
  const end = body.indexOf('\n}\n')
  return [...new Set(
    [...body.slice(0, end).matchAll(/\bstate\.(\w+)/g)].map((m) => m[1]),
  )].sort()
}

function memoDependencies(): string[] {
  const at = app.indexOf('() => selectSeries(store)')
  const list = app.slice(at).match(/\[([^\]]*)\]/)![1]
  return list.split(',').map((s) => s.trim()).filter(Boolean).sort()
}

describe('the series memo and selectSeries agree about their inputs', () => {
  it('names every field the selector reads', () => {
    const reads = fieldsSelectSeriesReads()
    const deps = memoDependencies()
    const missing = reads.filter((f) => !deps.includes(f))
    expect(missing, `selectSeries reads ${missing.join(', ')} but the memo in App.tsx does not depend on it — a fetch will write results the page never draws`).toEqual([])
  })

  it('finds both sides, so a rename cannot make this pass vacuously', () => {
    expect(fieldsSelectSeriesReads()).toContain('certSales')
    expect(memoDependencies().length).toBeGreaterThan(3)
  })
})
