import { Fragment, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react'
import { PriceCell } from './PriceCell'
import { ForecastBands } from './ForecastBands'
import { MIN_RETURNS_FOR_FORECAST } from '../lib/forecast'
import { RangeMeter } from './RangeMeter'
import { SegmentPicker } from './SegmentPicker'
import { UploadZone } from './UploadZone'
import { VerdictBadge } from './VerdictBadge'
import { classify } from '../lib/classify'
import { money, plainPct, shortDate } from '../lib/format'
import { itemKey } from '../lib/key'
import { GRADED_QUOTE_NOTE } from '../lib/analytics'
import { SelectionBar, TickBox } from './SelectionBar'
import { useSelection } from '../hooks/useSelection'
import { rankWatchlist, type RankedItem } from '../lib/ranking'
import type {
  ForecastResult, ItemAnalysis, PriceSeries, RangeResult, Segment, WatchItem,
} from '../lib/types'

interface Props {
  watchlist: WatchItem[]
  analyses: Map<string, ItemAnalysis>
  series: Map<string, PriceSeries>
  onAdd: (item: Omit<WatchItem, 'id' | 'segment' | 'segmentReason'>) => void
  onRemove: (id: string) => void
  onOverride: (id: string, segment: Segment | null) => void
  onUpdate: (id: string, patch: Partial<WatchItem>) => void
  onImport: (file: File) => Promise<void>
  onRemoveMany: (ids: string[]) => void
}

const EMPTY_FORM = { name: '', set: '', number: '', condition: '', cert: '', askingPrice: '', targetPrice: '' }

export function WatchlistPanel({
  watchlist, analyses, series, onAdd, onRemove, onRemoveMany, onOverride, onUpdate, onImport,
}: Props) {
  const [form, setForm] = useState(EMPTY_FORM)
  const [expanded, setExpanded] = useState<string | null>(null)

  // Ordered by the buy ranking rather than the entry score alone, so the list
  // itself answers "which of these first?".
  const rows = useMemo(() => {
    const ranked = rankWatchlist(watchlist, itemKey, analyses, series)
    return ranked.map((r, i) => ({
      w: r.item,
      a: r.analysis,
      rank: r,
      place: r.verdict === 'no data' ? null : i + 1,
    }))
  }, [watchlist, analyses, series])

  const visibleIds = useMemo(() => rows.map((r) => r.w.id), [rows])
  const selection = useSelection(visibleIds)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim()) return
    onAdd({
      name: form.name.trim(),
      set: form.set.trim() || undefined,
      number: form.number.trim() || undefined,
      condition: form.condition.trim() || undefined,
      cert: form.cert.trim() || undefined,
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
        <form onSubmit={submit} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-8">
          <input className="input lg:col-span-2" placeholder="Card or product name *" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-label="Name" />
          <input className="input" placeholder="Set" value={form.set} onChange={(e) => setForm({ ...form, set: e.target.value })} aria-label="Set" />
          <input className="input" placeholder="Number" value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} aria-label="Card number" />
          <input className="input" placeholder="Condition / grade" value={form.condition} onChange={(e) => setForm({ ...form, condition: e.target.value })} aria-label="Condition" />
          {/* A cert is what matches a slab to its own sold comps. */}
          <input className="input" placeholder="Cert number" value={form.cert} onChange={(e) => setForm({ ...form, cert: e.target.value })} aria-label="Cert number" />
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
        <>
        <SelectionBar
          selected={selection.selected} noun="watch item"
          onDelete={() => { onRemoveMany(selection.selected); selection.clear() }}
          onClear={selection.clear}
        />

        <section className="card overflow-auto">
          <table className="data w-full">
            <thead>
              <tr>
                <th style={{ width: 28 }}>
                  <TickBox
                    checked={selection.allSelected} indeterminate={selection.someSelected}
                    onChange={selection.toggleAll}
                    label={selection.allSelected ? 'Clear the selection' : 'Select every card shown'}
                  />
                </th>
                <th style={{ width: 28 }} aria-label="Expand" />
                <th className="num" style={{ width: 44 }}>#</th>
                <th>Item</th>
                <th>Segment</th>
                <th className="num">Asking</th>
                <th className="num">FMV</th>
                <th>52-week range</th>
                <th className="num">Yearly high</th>
                <th className="num">Good entry</th>
                <th>Call</th>
                <th>Buy case</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ w, a, rank, place }) => {
                const open = expanded === w.id
                const inferred = classify({ ...w, override: null }).segment
                return (
                  <Fragment key={w.id}>
                    <tr style={selection.isSelected(w.id) ? { background: 'var(--surface-2)' } : undefined}>
                      <td>
                        <TickBox
                          checked={selection.isSelected(w.id)}
                          onChange={() => selection.toggle(w.id)}
                          label={`Select ${w.name}`}
                        />
                      </td>
                      <td>
                        <button
                          type="button" className="btn px-1 py-1" onClick={() => setExpanded(open ? null : w.id)}
                          aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} reasoning for ${w.name}`}
                        >
                          {open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
                        </button>
                      </td>
                      <td className="num tabular muted">{place ?? '—'}</td>
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
                      <td><BuyCase rank={rank} /></td>
                      <td>
                        <button type="button" className="btn px-2 py-1" onClick={() => onRemove(w.id)} aria-label={`Remove ${w.name}`}>
                          <Trash2 className="size-3.5" aria-hidden />
                        </button>
                      </td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={13} style={{ background: 'var(--surface-2)' }}>
                          <Reasoning item={w} analysis={a} rank={rank} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </section>
        </>
      )}
    </div>
  )
}

/** The ranking's verdict, with its score and the loudest caveat against it. */
function BuyCase({ rank }: { rank: RankedItem }) {
  if (rank.verdict === 'no data') return <span className="text-xs muted">no data</span>
  const tone = rank.verdict === 'strong'
    ? 'var(--good)'
    : rank.verdict === 'worth a look'
      ? 'var(--seq-450)'
      : rank.verdict === 'thin case'
        ? 'var(--warning)'
        : 'var(--text-muted)'
  return (
    <div className="flex items-center gap-1.5 whitespace-nowrap" title={rank.warnings.join(' ')}>
      <span className="size-2 rounded-full shrink-0" style={{ background: tone }} aria-hidden />
      <span className="text-xs tabular font-medium">{rank.score}</span>
      <span className="text-xs muted">{rank.verdict}</span>
      {rank.warnings.length > 0 && (
        <span
          className="text-xs font-semibold"
          style={{ color: 'var(--warning)' }}
          aria-label={`${rank.warnings.length} caveat${rank.warnings.length > 1 ? 's' : ''}`}
        >
          !
        </span>
      )}
    </div>
  )
}

function Reasoning({ item, analysis, rank }: { item: WatchItem; analysis?: ItemAnalysis; rank: RankedItem }) {
  if (!analysis) return <p className="text-sm muted p-2">No analysis yet — refresh prices or import comps.</p>
  const { fmv, range, entry, forecast } = analysis

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
        <h3 className="text-xs font-semibold uppercase tracking-wide secondary mb-2">Where it has traded</h3>
        <table className="w-full text-sm mb-2">
          <thead>
            <tr><th>Window</th><th className="num">Low</th><th className="num">High</th></tr>
          </thead>
          <tbody>
            <BandRow label="6 months" r={analysis.sixMonthRange} />
            <BandRow label="1 year" r={range} />
            <BandRow label="2 years" r={analysis.twoYearRange} />
            <BandRow label="All time" r={analysis.allTimeRange} />
          </tbody>
        </table>
        <dl className="text-sm space-y-1.5">
          <Row label="Position in the year's band" value={range.position == null ? '—' : plainPct(range.position, 0)} />
          <Row label="History covered" value={`${Math.round(analysis.allTimeRange.coverageDays)} days · ${analysis.allTimeRange.sampleSize} points`} />
          <Row label="Reliability" value={range.estimated ? 'Estimated — thin history' : 'Measured'} />
        </dl>
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide secondary mb-2">The entry call</h3>
        <dl className="text-sm space-y-1.5 mb-3">
          <Row label="Good entry at or below" value={money(entry.entryPrice)} />
          <Row label="Stretch bid" value={money(entry.stretchEntry)} />
          <Row label="Discount required" value={plainPct(entry.requiredDiscount, 0)} />
          <Row label="Volatility (last year)" value={entry.volatility == null ? '—' : plainPct(entry.volatility, 0)} />
          <Row label="90-day trend" value={entry.momentum90d == null ? '—' : plainPct(entry.momentum90d, 1)} />
        </dl>
        <ul className="text-sm space-y-1.5 leading-relaxed">
          {entry.rationale.map((r) => <li key={r}>· {r}</li>)}
        </ul>
      </div>

      <div className="lg:col-span-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide secondary mb-2">Where it could be years out</h3>
        {forecast
          ? <Projections forecast={forecast} />
          : <p className="text-sm secondary">Not enough sales on record to project anything.</p>}
      </div>

      <div className="lg:col-span-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide secondary mb-2">Why it ranks where it does</h3>
        <WhyRanked rank={rank} />
      </div>

      <div className="lg:col-span-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide secondary mb-2">What it might do</h3>
        {forecast
          ? <ForecastBands forecast={forecast} />
          : (
            <p className="text-sm secondary leading-relaxed">
              Not enough price moves on record to model this one. It needs at least
              {' '}{MIN_RETURNS_FOR_FORECAST + 1} sales at different dates; anything less would be arithmetic on
              noise dressed up as a forecast.
            </p>
          )}
      </div>
    </div>
  )
}

function BandRow({ label, r }: { label: string; r: RangeResult }) {
  return (
    <tr>
      <td className="secondary">{label}</td>
      <td className="num tabular">{r.low == null ? '—' : money(r.low)}</td>
      <td className="num tabular">{r.high == null ? '—' : money(r.high)}</td>
    </tr>
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

/**
 * One, five and ten years out, and what each would return on today's price.
 *
 * The bands are written out rather than drawn, because at ten years the range
 * is so wide that any bar would be a picture of the uncertainty rather than of
 * the value, and the number is the honest way to say that.
 */
function Projections({ forecast }: { forecast: ForecastResult }) {
  return (
    <div>
      <p className="text-xs secondary leading-relaxed mb-2">
        Returns are against {money(forecast.basis)}, what a buyer would pay today. The range is where the
        price lands in 8 of 10 simulated futures.
      </p>
      <table className="data w-full">
        <thead>
          <tr>
            <th>Horizon</th>
            <th className="num">Low</th>
            <th className="num">Mid</th>
            <th className="num">High</th>
            <th className="num">Return a year</th>
            <th className="num">Chance ahead</th>
          </tr>
        </thead>
        <tbody>
          {forecast.projections.map((p) => (
            <tr key={p.years}>
              <td className="secondary">{p.years === 1 ? '1 year' : `${p.years} years`}</td>
              <td className="num tabular">{money(p.low)}</td>
              <td className="num tabular font-medium">{money(p.mid)}</td>
              <td className="num tabular">{money(p.high)}</td>
              <td className="num tabular" style={{ color: p.roiMid >= 0 ? 'var(--delta-up)' : 'var(--delta-down)' }}>
                {plainPct(p.roiMid, 1)}
                <span className="muted"> ({plainPct(p.roiLow, 0)} to {plainPct(p.roiHigh, 0)})</span>
              </td>
              <td className="num tabular">{plainPct(p.chanceAboveBasis, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs secondary leading-relaxed mt-2">
        The trend is faded as the horizon lengthens, so it cannot compound forever — no card sustains a
        measured rate for a decade, and two years of sales cannot say which rare one will. The ten-year
        range is wide enough to be nearly uninformative, and that width is the finding rather than a flaw
        in it.
      </p>
    </div>
  )
}

/** The ranking's components, what each contributed, and what argues against. */
function WhyRanked({ rank }: { rank: RankedItem }) {
  if (rank.components.length === 0) {
    return <p className="text-sm secondary">{rank.warnings[0] ?? 'Nothing to rank this on yet.'}</p>
  }
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <table className="data w-full">
        <thead>
          <tr><th>What was weighed</th><th className="num">Score</th><th>What it was</th></tr>
        </thead>
        <tbody>
          {rank.components.map((c) => (
            <tr key={c.key}>
              <td className="secondary">{c.label}</td>
              <td className="num tabular">{Math.round(c.score * 100)}</td>
              <td className="text-xs">{c.detail}</td>
            </tr>
          ))}
          <tr>
            <td className="font-medium">Overall</td>
            <td className="num tabular font-medium">{rank.score}</td>
            <td className="text-xs">{rank.verdict}</td>
          </tr>
        </tbody>
      </table>
      <div>
        {rank.warnings.length > 0 && (
          <ul className="text-sm space-y-1.5 leading-relaxed mb-3">
            {rank.warnings.map((w) => (
              <li key={w} style={{ color: 'var(--warning)' }}>· {w}</li>
            ))}
          </ul>
        )}
        {rank.warnings.length === 0 && (
          <p className="text-sm secondary leading-relaxed mb-3">
            Nothing in the sales record specifically argues against this one.
          </p>
        )}
        <p className="text-xs secondary leading-relaxed">
          A score is not a recommendation. This weighs four things it can measure from the sales record and
          nothing it cannot: not a reprint, not a grading population about to double, not a set going in or
          out of fashion, and not whether you already own three.
        </p>
      </div>
    </div>
  )
}
