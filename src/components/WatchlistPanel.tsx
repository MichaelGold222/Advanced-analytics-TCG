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
import { gradedPricingNote } from '../lib/analytics'
import { CardThumb } from './CardThumb'
import { PasteHistory } from './PasteHistory'
import { thumbFor } from '../lib/images'
import { SelectionBar, TickBox } from './SelectionBar'
import { useFrozenOrder } from '../hooks/useFrozenOrder'
import { useSelection } from '../hooks/useSelection'
import { rankWatchlist, type RankedItem } from '../lib/ranking'
import type {
  ForecastResult, ItemAnalysis, PricePoint, PriceSeries, RangeResult, Segment, WatchItem,
} from '../lib/types'

interface Props {
  watchlist: WatchItem[]
  analyses: Map<string, ItemAnalysis>
  series: Map<string, PriceSeries>
  /** Slab pictures by cert, fetched alongside the sold comps. */
  images: Record<string, { image: string | null; thumbnail: string | null }>
  onAdd: (item: Omit<WatchItem, 'id' | 'segment' | 'segmentReason'>) => void
  onRemove: (id: string) => void
  onOverride: (id: string, segment: Segment | null) => void
  onUpdate: (id: string, patch: Partial<WatchItem>) => void
  /** Price history pasted in for a card the API cannot reach. */
  onPasteHistory: (item: WatchItem, points: PricePoint[]) => void
  /** Bind a Card Ladder card id to this card's cert and fetch its history. */
  onLinkCardId: (item: WatchItem, cardId: string) => Promise<'fetched' | 'refused' | 'no-key'>
  onImport: (file: File) => Promise<void>
  onRemoveMany: (ids: string[]) => void
}

const EMPTY_FORM = { name: '', set: '', number: '', condition: '', cert: '', askingPrice: '', targetPrice: '' }

export function WatchlistPanel({
  watchlist, analyses, series, images, onAdd, onRemove, onRemoveMany, onOverride, onUpdate, onImport,
  onPasteHistory, onLinkCardId,
}: Props) {
  const [form, setForm] = useState(EMPTY_FORM)
  const [expanded, setExpanded] = useState<string | null>(null)

  // Ordered by the buy ranking rather than the entry score alone, so the list
  // itself answers "which of these first?".
  const ranked = useMemo(
    () => rankWatchlist(watchlist, itemKey, analyses, series),
    [watchlist, analyses, series],
  )
  // The rank is what orders this table, and the asking price is one of the
  // things the rank is made of — so the order has to hold still while one is
  // being typed. The number shown keeps updating; only the row stays put.
  const held = useFrozenOrder(ranked, (r) => r.item.id)
  const placeOf = useMemo(
    () => new Map(ranked.map((r, i) => [r.item.id, r.verdict === 'no data' ? null : i + 1])),
    [ranked],
  )
  const rows = useMemo(
    () => held.order.map((r) => ({
      w: r.item,
      a: r.analysis,
      rank: r,
      place: placeOf.get(r.item.id) ?? null,
    })),
    [held.order, placeOf],
  )

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
      {/* Folded away once there is a list to look at. Six fields and an upload
          box are what you want on the first visit and clutter on every one
          after, so the list gets the top of the page instead. */}
      <details className="card p-4" open={rows.length === 0}>
        <summary className="text-sm font-semibold cursor-pointer select-none">
          Add something you are looking at
          <span className="muted font-normal"> — type one in, or upload a sheet</span>
        </summary>
        <form onSubmit={submit} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-8 mt-3">
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
          <UploadZone
            compact label="Upload a watchlist"
            hint="An .xlsx or .csv of what you are considering. Everything in it goes to the watchlist — nothing is counted as owned."
            onFile={onImport}
          />
        </div>
      </details>

      {rows.length > 0 && (
        <>
        <section className="card overflow-auto" {...held.holdProps}>
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
                <th>Item</th>
                <th>Segment</th>
                <th className="num">Asking</th>
                <th className="num">FMV</th>
                <th>52-week range</th>
                <th className="num">Good entry</th>
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
                      <td>
                        <div className="flex items-start gap-3">
                          <CardThumb src={thumbFor(images, w.cert)} name={w.name} />
                          <div className="min-w-0">
                        <div className="font-medium">{w.name}</div>
                        <div className="text-xs muted">{[
                          w.set, w.number && `#${w.number}`, w.variation, w.condition,
                          w.population != null ? `pop ${w.population}` : null,
                          w.cert && `cert ${w.cert}`,
                        ].filter(Boolean).join(' · ') || '—'}</div>
                          </div>
                        </div>
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
                      <td className="num tabular font-medium" style={{ color: 'var(--delta-up)' }}>
                        {money(a?.entry.entryPrice)}
                        {a?.entry.stretchEntry != null && (
                          <div className="text-[11px] muted">stretch {money(a.entry.stretchEntry)}</div>
                        )}
                      </td>
                      <td><BuyCase rank={rank} place={place} /></td>
                      <td>
                        <button type="button" className="btn px-2 py-1" onClick={() => onRemove(w.id)} aria-label={`Remove ${w.name}`}>
                          <Trash2 className="size-3.5" aria-hidden />
                        </button>
                      </td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={10} style={{ background: 'var(--surface-2)' }}>
                          {/* Width zero with a full-width minimum: a cell
                              spanning every column otherwise joins in deciding
                              how wide each one is, so opening a row resized
                              the whole table and rewrapped every line in it. */}
                          <div style={{ width: 0, minWidth: '100%' }}>
                            <Reasoning
                              item={w} analysis={a} rank={rank} images={images}
                              onPasteHistory={(pts) => onPasteHistory(w, pts)}
                              onLinkCardId={w.cert ? ((id) => onLinkCardId(w, id)) : undefined}
                            />
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </section>

        {/* Below the table and stuck to the bottom of the view. Above it, the
            bar appeared the moment a box was ticked and shoved everything
            down by its own height — including the row that had just been
            clicked, and the next box someone was reaching for. */}
        <div className="sticky bottom-4 z-10">
          <SelectionBar
            selected={selection.selected} noun="watch item"
            onDelete={() => { onRemoveMany(selection.selected); selection.clear() }}
            onClear={selection.clear}
          />
        </div>
        </>
      )}
    </div>
  )
}

/** The ranking's verdict, with its score and the loudest caveat against it. */
function BuyCase({ rank, place }: { rank: RankedItem; place: number | null }) {
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
      {place != null && <span className="text-xs tabular muted">#{place}</span>}
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

function Reasoning({
  item, analysis, rank, images, onPasteHistory, onLinkCardId,
}: {
  item: WatchItem
  analysis?: ItemAnalysis
  rank: RankedItem
  images: Record<string, { image: string | null; thumbnail: string | null }>
  onPasteHistory: (points: PricePoint[]) => void
  onLinkCardId?: (cardId: string) => Promise<'fetched' | 'refused' | 'no-key'>
}) {
  if (!analysis) return <p className="text-sm muted p-2">No analysis yet — refresh prices or import comps.</p>
  const { fmv, range, entry, forecast } = analysis
  // Said only when something is actually wrong with how this one is priced.
  const gradedNote = gradedPricingNote(item, analysis)

  return (
    <div className="grid gap-5 lg:grid-cols-3 p-2">
      <div>
        <div className="flex items-start gap-3 mb-3">
          <CardThumb src={images[item.cert ?? '']?.image ?? thumbFor(images, item.cert)} name={item.name} size="lg" />
          <div className="min-w-0">
            <div className="font-medium">{item.name}</div>
            <div className="text-xs muted leading-relaxed">
              {[
                item.set, item.number && `#${item.number}`, item.variation, item.condition,
                item.population != null ? `pop ${item.population}` : null,
                item.cert && `cert ${item.cert}`,
              ].filter(Boolean).join(' · ') || '—'}
            </div>
          </div>
        </div>
        <h3 className="text-xs font-semibold uppercase tracking-wide secondary mb-2">How the FMV was built</h3>
        <ul className="text-sm space-y-1.5 leading-relaxed">
          {fmv.rationale.map((r) => <li key={r}>· {r}</li>)}
          {gradedNote && <li style={{ color: 'var(--serious)' }}>· {gradedNote}</li>}
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
            {bandRows(analysis).map((b) => <BandRow key={b.label} label={b.label} note={b.note} r={b.r} />)}
          </tbody>
        </table>
        {!range.coversWindow && range.sampleSize > 0 && (
          <>
          <p className="text-xs muted mb-2">
            <strong>This app has {range.sampleSize} sale{range.sampleSize === 1 ? '' : 's'} for
            this card</strong>, the oldest from {range.oldest} — {Math.round(range.coverageDays)}{' '}
            days. That is a limit of how the prices are fetched, not of what the card has
            done: the bulk endpoint returns only the newest few sales per slab, and Card
            Ladder itself holds far more. So every window above rests on those same{' '}
            {range.sampleSize}, and none of them is a real 52-week high.
          </p>
          <p className="text-xs muted mb-2">
            To get the true high, put the fuller history into a sheet — any card with a
            dated price column — and upload it. Dated prices from your own sheet now build
            the band for the months these sales do not reach. Refreshing also deepens the
            record over time, but only as fast as the card trades.
          </p>
          </>
        )}
        {!range.coversWindow && (
          <div className="mb-3 pb-3" style={{ borderBottom: '1px solid var(--border)' }}>
            <PasteHistory name={item.name} onAdd={onPasteHistory} onLink={onLinkCardId} />
          </div>
        )}
        <dl className="text-sm space-y-1.5">
          <Row label="Position in the year's band" value={range.position == null ? '—' : plainPct(range.position, 0)} />
          <Row label="History covered" value={`${Math.round(analysis.allTimeRange.coverageDays)} days · ${analysis.allTimeRange.sampleSize} points`} />
          <Row
            label="Built from"
            value={
              range.fromTrades
                ? `${range.sampleSize} completed sales`
                : range.sampleSize > 0
                  ? `${range.sampleSize} prices — completed sales and dated figures from your sheet`
                  : 'asking prices and stored figures'
            }
          />
          <Row label="Reliability" value={range.estimated ? 'Estimated — thin history' : 'Measured'} />
        </dl>
      </div>

      <div>
        <div className="flex items-center justify-between gap-2 mb-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide secondary">The entry call</h3>
          <VerdictBadge verdict={entry.verdict} score={entry.score} />
        </div>
        <dl className="text-sm space-y-1.5 mb-3">
          <Row label="Good entry at or below" value={money(entry.entryPrice)} />
          <Row
            label="Target, off this year's high"
            value={entry.entryDownFromHigh == null ? '—' : plainPct(entry.entryDownFromHigh, 0)}
          />
          <Row label="Floor — lowest it has traded" value={money(entry.stretchEntry)} />
          <Row
            label="Asking, off this year's high"
            value={entry.askingDownFromHigh == null ? '—' : plainPct(entry.askingDownFromHigh, 0)}
          />
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

function BandRow({ label, note, r }: { label: string; note: string | null; r: RangeResult }) {
  return (
    <tr>
      <td className="secondary">
        {label}
        {note && <span className="muted"> · {note}</span>}
      </td>
      <td className="num tabular">{r.low == null ? '—' : money(r.low)}</td>
      <td className="num tabular">{r.high == null ? '—' : money(r.high)}</td>
    </tr>
  )
}

/**
 * The windows worth showing, which is fewer than four.
 *
 * Six months, a year, two years and all time over the same five sales are four
 * identical rows, and four identical rows read as four separate measurements
 * agreeing rather than as one measurement repeated. A window is kept only when
 * it widens the band; the shortest one that produced it keeps the label, since
 * that is the shortest period the numbers are true of.
 */
function bandRows(analysis: ItemAnalysis) {
  const windows = [
    { label: '6 months', r: analysis.sixMonthRange },
    { label: '1 year', r: analysis.range },
    { label: '2 years', r: analysis.twoYearRange },
    { label: 'All time', r: analysis.allTimeRange },
  ].filter((w) => w.r.sampleSize > 0)

  return windows
    .filter((w, i) => i === 0 || w.r.low !== windows[i - 1].r.low || w.r.high !== windows[i - 1].r.high)
    .map((w) => ({
      ...w,
      note: w.r.coversWindow ? null : `${Math.round(w.r.coverageDays)} days of sales`,
    }))
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
          {forecast.projections.map((p) => {
            // Past roughly twentyfold the band is arithmetically right and
            // useless as a number: it says the horizon is beyond what this
            // record can speak to, which is worth saying on the row rather
            // than in a footnote under the table.
            const span = p.low > 0 ? p.high / p.low : Infinity
            const tooWide = span > 20
            return (
            <tr key={p.years}>
              <td className="secondary">
                {p.years === 1 ? '1 year' : `${p.years} years`}
                {tooWide && <div className="text-[11px] muted">too wide to read</div>}
              </td>
              <td className="num tabular">{money(p.low)}</td>
              <td className={`num tabular ${tooWide ? 'muted' : 'font-medium'}`}>{money(p.mid)}</td>
              <td className="num tabular">{money(p.high)}</td>
              <td className="num tabular" style={{ color: p.roiMid >= 0 ? 'var(--delta-up)' : 'var(--delta-down)' }}>
                {plainPct(p.roiMid, 1)}
                <span className="muted"> ({plainPct(p.roiLow, 0)} to {plainPct(p.roiHigh, 0)})</span>
              </td>
              <td className="num tabular">{plainPct(p.chanceAboveBasis, 0)}</td>
            </tr>
            )
          })}
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
