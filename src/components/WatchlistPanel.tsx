import { Fragment, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react'
import { PriceCell } from './PriceCell'
import { RangeMeter } from './RangeMeter'
import { SegmentPicker } from './SegmentPicker'
import { UploadZone } from './UploadZone'
import { VerdictBadge } from './VerdictBadge'
import { classify } from '../lib/classify'
import { money, plainPct, shortDate } from '../lib/format'
import { itemKey } from '../lib/key'
import { GRADED_QUOTE_NOTE } from '../lib/analytics'
import type { ItemAnalysis, Segment, WatchItem } from '../lib/types'

interface Props {
  watchlist: WatchItem[]
  analyses: Map<string, ItemAnalysis>
  onAdd: (item: Omit<WatchItem, 'id' | 'segment' | 'segmentReason'>) => void
  onRemove: (id: string) => void
  onOverride: (id: string, segment: Segment | null) => void
  onUpdate: (id: string, patch: Partial<WatchItem>) => void
  onImport: (file: File) => Promise<void>
}

const EMPTY_FORM = { name: '', set: '', number: '', condition: '', askingPrice: '', targetPrice: '' }

export function WatchlistPanel({ watchlist, analyses, onAdd, onRemove, onOverride, onUpdate, onImport }: Props) {
  const [form, setForm] = useState(EMPTY_FORM)
  const [expanded, setExpanded] = useState<string | null>(null)

  const rows = useMemo(
    () =>
      watchlist
        .map((w) => ({ w, a: analyses.get(itemKey(w)) }))
        .sort((x, y) => (y.a?.entry.score ?? -1) - (x.a?.entry.score ?? -1)),
    [watchlist, analyses],
  )

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim()) return
    onAdd({
      name: form.name.trim(),
      set: form.set.trim() || undefined,
      number: form.number.trim() || undefined,
      condition: form.condition.trim() || undefined,
      askingPrice: form.askingPrice ? Number(form.askingPrice) : undefined,
      targetPrice: form.targetPrice ? Number(form.targetPrice) : undefined,
      quantity: 1,
      segmentOverride: null,
    })
    setForm(EMPTY_FORM)
  }

  return (
    <div className="space-y-4">
      <section className="card p-4">
        <h2 className="text-sm font-semibold mb-3">Add something you are looking at</h2>
        <form onSubmit={submit} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-7">
          <input className="input lg:col-span-2" placeholder="Card or product name *" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-label="Name" />
          <input className="input" placeholder="Set" value={form.set} onChange={(e) => setForm({ ...form, set: e.target.value })} aria-label="Set" />
          <input className="input" placeholder="Number" value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} aria-label="Card number" />
          <input className="input" placeholder="Condition / grade" value={form.condition} onChange={(e) => setForm({ ...form, condition: e.target.value })} aria-label="Condition" />
          <input className="input" type="number" step="0.01" min="0" placeholder="Asking $" value={form.askingPrice} onChange={(e) => setForm({ ...form, askingPrice: e.target.value })} aria-label="Asking price" />
          <button type="submit" className="btn btn-primary justify-center">
            <Plus className="size-4" aria-hidden /> Add
          </button>
        </form>
        <div className="mt-4">
          <UploadZone compact label="Upload a watchlist" hint="An .xlsx or .csv of what you are considering. Name a sheet “Watchlist” and it is routed automatically." onFile={onImport} />
        </div>
      </section>

      {rows.length > 0 && (
        <section className="card overflow-auto">
          <table className="data w-full">
            <thead>
              <tr>
                <th style={{ width: 28 }} aria-label="Expand" />
                <th>Item</th>
                <th>Segment</th>
                <th className="num">Asking</th>
                <th className="num">FMV</th>
                <th>52-week range</th>
                <th className="num">Yearly high</th>
                <th className="num">Good entry</th>
                <th>Call</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ w, a }) => {
                const open = expanded === w.id
                const inferred = classify({ ...w, override: null }).segment
                return (
                  <Fragment key={w.id}>
                    <tr>
                      <td>
                        <button
                          type="button" className="btn px-1 py-1" onClick={() => setExpanded(open ? null : w.id)}
                          aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} reasoning for ${w.name}`}
                        >
                          {open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
                        </button>
                      </td>
                      <td>
                        <div className="font-medium">{w.name}</div>
                        <div className="text-xs muted">{[w.set, w.number && `#${w.number}`, w.condition, w.cert && `cert ${w.cert}`].filter(Boolean).join(' · ') || '—'}</div>
                      </td>
                      <td><SegmentPicker value={w.segmentOverride ?? null} inferred={inferred} onChange={(s) => onOverride(w.id, s)} /></td>
                      <td className="num">
                        <input
                          className="input py-1 w-24 text-right tabular" type="number" step="0.01" min="0"
                          value={w.askingPrice ?? ''} aria-label={`Asking price for ${w.name}`}
                          onChange={(e) => onUpdate(w.id, { askingPrice: e.target.value ? Number(e.target.value) : undefined })}
                        />
                      </td>
                      <td className="num"><PriceCell analysis={a} /></td>
                      <td>
                        <RangeMeter
                          low={a?.range.low ?? null} high={a?.range.high ?? null}
                          fmv={a?.fmv.fmv ?? null} entry={a?.entry.entryPrice ?? null}
                          asking={w.askingPrice ?? null} estimated={a?.range.estimated}
                        />
                      </td>
                      <td className="num tabular">
                        {money(a?.range.high)}
                        {a?.range.estimated && a.range.sampleSize > 0 && <div className="text-[11px] muted">estimated</div>}
                      </td>
                      <td className="num tabular font-medium" style={{ color: 'var(--delta-up)' }}>
                        {money(a?.entry.entryPrice)}
                        {a?.entry.stretchEntry != null && (
                          <div className="text-[11px] muted">stretch {money(a.entry.stretchEntry)}</div>
                        )}
                      </td>
                      <td><VerdictBadge verdict={a?.entry.verdict ?? 'unknown'} score={a?.entry.score} /></td>
                      <td>
                        <button type="button" className="btn px-2 py-1" onClick={() => onRemove(w.id)} aria-label={`Remove ${w.name}`}>
                          <Trash2 className="size-3.5" aria-hidden />
                        </button>
                      </td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={10} style={{ background: 'var(--surface-2)' }}>
                          <Reasoning item={w} analysis={a} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}

function Reasoning({ item, analysis }: { item: WatchItem; analysis?: ItemAnalysis }) {
  if (!analysis) return <p className="text-sm muted p-2">No analysis yet — refresh prices or import comps.</p>
  const { fmv, range, entry } = analysis

  return (
    <div className="grid gap-5 lg:grid-cols-3 p-2">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide secondary mb-2">How the FMV was built</h3>
        <ul className="text-sm space-y-1.5 leading-relaxed">
          {fmv.rationale.map((r) => <li key={r}>· {r}</li>)}
          {item.grade != null && <li style={{ color: 'var(--serious)' }}>· {GRADED_QUOTE_NOTE}</li>}
        </ul>
        {fmv.contributors.length > 0 && (
          <table className="data w-full mt-3">
            <thead>
              <tr><th>Source</th><th className="num">Price</th><th className="num">Weight</th><th className="num">Date</th></tr>
            </thead>
            <tbody>
              {[...fmv.contributors].sort((a, b) => b.weight - a.weight).slice(0, 8).map((c, i) => (
                <tr key={`${c.source}-${c.date}-${i}`}>
                  <td>{c.source}</td>
                  <td className="num tabular">{money(c.value)}</td>
                  <td className="num tabular">{plainPct(c.weight / fmv.contributors.reduce((a, x) => a + x.weight, 0), 0)}</td>
                  <td className="num tabular">{shortDate(c.date)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide secondary mb-2">The 52-week band</h3>
        <dl className="text-sm space-y-1.5">
          <Row label="Yearly high" value={money(range.high)} />
          <Row label="Yearly low" value={money(range.low)} />
          <Row label="Position in band" value={range.position == null ? '—' : plainPct(range.position, 0)} />
          <Row label="History covered" value={`${Math.round(range.coverageDays)} days · ${range.sampleSize} points`} />
          <Row label="Reliability" value={range.estimated ? 'Estimated — thin history' : 'Measured'} />
        </dl>
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide secondary mb-2">The entry call</h3>
        <dl className="text-sm space-y-1.5 mb-3">
          <Row label="Good entry at or below" value={money(entry.entryPrice)} />
          <Row label="Stretch bid" value={money(entry.stretchEntry)} />
          <Row label="Discount required" value={plainPct(entry.requiredDiscount, 0)} />
          <Row label="Volatility (annualized)" value={entry.volatility == null ? '—' : plainPct(entry.volatility, 0)} />
          <Row label="90-day trend" value={entry.momentum90d == null ? '—' : plainPct(entry.momentum90d, 1)} />
        </dl>
        <ul className="text-sm space-y-1.5 leading-relaxed">
          {entry.rationale.map((r) => <li key={r}>· {r}</li>)}
        </ul>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="secondary">{label}</dt>
      <dd className="tabular font-medium">{value}</dd>
    </div>
  )
}
