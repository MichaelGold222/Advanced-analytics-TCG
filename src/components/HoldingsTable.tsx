import { useMemo, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { PriceCell } from './PriceCell'
import { SegmentPicker } from './SegmentPicker'
import { money, pct, plainPct } from '../lib/format'
import { classify } from '../lib/classify'
import { holdingKey, unitValue } from '../lib/portfolio'
import { SEGMENTS, SEGMENT_LABELS } from '../lib/types'
import type { Holding, ItemAnalysis, RangeResult, Segment } from '../lib/types'

type SortKey = 'name' | 'value' | 'unrealized' | 'roi' | 'segment'

interface Props {
  holdings: Holding[]
  analyses: Map<string, ItemAnalysis>
  onOverride: (id: string, segment: Segment | null) => void
  onSetValue: (id: string, value: number | null) => void
  onRemove: (id: string) => void
}

export function HoldingsTable({ holdings, analyses, onOverride, onSetValue, onRemove }: Props) {
  const [query, setQuery] = useState('')
  const [segment, setSegment] = useState<Segment | 'all'>('all')
  const [sort, setSort] = useState<SortKey>('value')

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const mapped = holdings
      .filter((h) => segment === 'all' || h.segment === segment)
      .filter((h) => !q || `${h.name} ${h.set ?? ''} ${h.number ?? ''} ${h.condition ?? ''}`.toLowerCase().includes(q))
      .map((h) => {
        const a = analyses.get(holdingKey(h))
        const fmv = a?.fmv.fmv ?? null
        const uv = unitValue(a, h.userPrice)
        const value = uv == null ? null : uv * h.quantity
        const cost = h.costBasis * h.quantity
        return { h, a, fmv, value, cost, unrealized: value == null ? null : value - cost, roi: value == null || cost <= 0 ? null : (value - cost) / cost }
      })

    const nullsLast = (x: number | null) => (x == null ? Number.NEGATIVE_INFINITY : x)
    return mapped.sort((a, b) => {
      switch (sort) {
        case 'name': return a.h.name.localeCompare(b.h.name)
        case 'segment': return SEGMENTS.indexOf(a.h.segment) - SEGMENTS.indexOf(b.h.segment) || a.h.name.localeCompare(b.h.name)
        case 'unrealized': return nullsLast(b.unrealized) - nullsLast(a.unrealized)
        case 'roi': return nullsLast(b.roi) - nullsLast(a.roi)
        default: return nullsLast(b.value) - nullsLast(a.value)
      }
    })
  }, [holdings, analyses, query, segment, sort])

  return (
    <section className="card">
      <div className="flex flex-wrap items-center gap-2 p-3 border-b" style={{ borderColor: 'var(--border)' }}>
        <input
          className="input flex-1 min-w-48" placeholder="Search name, set, number or condition…"
          value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search holdings"
        />
        <select className="input w-44" value={segment} onChange={(e) => setSegment(e.target.value as Segment | 'all')} aria-label="Filter by segment">
          <option value="all">All segments</option>
          {SEGMENTS.map((s) => <option key={s} value={s}>{SEGMENT_LABELS[s]}</option>)}
        </select>
        <select className="input w-44" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort by">
          <option value="value">Sort: market value</option>
          <option value="unrealized">Sort: unrealized</option>
          <option value="roi">Sort: return</option>
          <option value="name">Sort: name</option>
          <option value="segment">Sort: segment</option>
        </select>
        <span className="text-xs muted tabular ml-auto">{rows.length} of {holdings.length}</span>
      </div>

      <div className="overflow-auto">
        <table className="data w-full">
          <thead>
            <tr>
              <th>Item</th>
              <th>Segment</th>
              <th className="num">Invested</th>
              <th className="num" title="Median of the last 5 completed comps across every venue. A steadier estimate than any one sale, shown for reference.">Median of 5</th>
              <th
                className="num"
                title="The most recent completed sale of this card. Click a figure to put your own number on it."
              >
                Last sold
              </th>
              <th className="num" title="Lowest this card has traded in the last 6 months">6-mo low</th>
              <th className="num" title="Highest this card has traded in the last 6 months">6-mo high</th>
              <th className="num" title="Highest this card has traded in the last 12 months">Yearly high</th>
              <th className="num" title="Last sold minus what you paid">Unrealized</th>
              <th className="num" title="Unrealized gain over what you paid">Return</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map(({ h, a, cost, fmv, unrealized, roi }) => {
              const inferred = classify({ ...h, override: null }).segment
              return (
                <tr key={h.id}>
                  <td>
                    <div className="font-medium">{h.name}</div>
                    <div className="text-xs muted">
                      {[h.set, h.number && `#${h.number}`, h.condition, h.year, h.cert && `cert ${h.cert}`].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </td>
                  <td>
                    <SegmentPicker value={h.segmentOverride ?? null} inferred={inferred} onChange={(s) => onOverride(h.id, s)} />
                    <div className="text-[11px] muted mt-1 max-w-52">{h.segmentReason}</div>
                  </td>
                  <td className="num tabular">{money(cost)}</td>
                  <td className="num"><PriceCell analysis={a} /></td>
                  <td className="num">
                    <LastSoldCell
                      analysis={a} override={h.userPrice ?? null}
                      onChange={(v) => onSetValue(h.id, v)}
                    />
                  </td>
                  <td className="num"><LowCell range={a?.sixMonthRange} fmv={fmv} /></td>
                  <td className="num"><HighCell range={a?.sixMonthRange} fmv={fmv} /></td>
                  <td className="num"><HighCell range={a?.range} fmv={fmv} /></td>

                  <td className="num tabular" style={{ color: unrealized == null ? undefined : unrealized >= 0 ? 'var(--delta-up)' : 'var(--delta-down)' }}>
                    {unrealized == null ? '—' : money(unrealized)}
                  </td>
                  <td className="num tabular" style={{ color: roi == null ? undefined : roi >= 0 ? 'var(--delta-up)' : 'var(--delta-down)' }}>
                    {pct(roi)}
                  </td>
                  <td>
                    <button type="button" className="btn px-2 py-1" onClick={() => onRemove(h.id)} aria-label={`Remove ${h.name}`} title="Remove">
                      <Trash2 className="size-3.5" aria-hidden />
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {rows.length === 0 && <p className="p-8 text-center text-sm muted">No positions match those filters.</p>}
      </div>
      {rows.length > 0 && (
        <p className="text-xs muted leading-relaxed px-4 pb-4">
          Unrealized and return are measured against <strong>Last sold</strong> — what the card actually went
          for — so they compare a price paid with a price achieved. <strong>Median of 5</strong> sits beside it
          as the steadier estimate; where nothing has sold inside the year, it stands in.
          Click any <strong>Last sold</strong> figure to put your own number on it, for when you know a sale
          was not representative. Clear the box to hand the card back to the fetched price.
        </p>
      )}
    </section>
  )
}

/**
 * A high-water mark, with how far under it the card currently sits.
 *
 * The gap is the point: a high on its own says nothing about whether now is
 * dear or cheap. A thin window is marked rather than dropped, since "the
 * highest of the three sales we have" is worth seeing as long as it does not
 * pass itself off as a real yearly high.
 */
function HighCell({ range, fmv }: { range?: RangeResult; fmv: number | null }) {
  const high = range?.high ?? null
  if (high == null) return <span className="muted">—</span>

  const below = fmv != null && high > 0 ? (high - fmv) / high : null
  return (
    <>
      <div className="tabular">{money(high)}</div>
      {below != null && below > 0.001 && (
        <div className="text-[11px] muted tabular">{plainPct(below, 1)} below</div>
      )}
      {below != null && below <= 0.001 && (
        <div className="text-[11px] tabular" style={{ color: 'var(--delta-up)' }}>at high</div>
      )}
      {range?.estimated && (
        <div className="text-[11px] muted" title={`Only ${range.sampleSize} observation${range.sampleSize === 1 ? '' : 's'} across ${range.coverageDays} days, so this is the highest seen rather than a full-window high.`}>
          thin data
        </div>
      )}
    </>
  )
}

/**
 * The floor of the six-month window, and how far above it the card sits.
 *
 * The mirror of the high: together they say where in its recent band the card
 * is trading, which a single number on its own cannot.
 */
function LowCell({ range, fmv }: { range?: RangeResult; fmv: number | null }) {
  const low = range?.low ?? null
  if (low == null) return <span className="muted">—</span>

  const above = fmv != null && low > 0 ? (fmv - low) / low : null
  return (
    <>
      <div className="tabular">{money(low)}</div>
      {above != null && above > 0.001 && (
        <div className="text-[11px] muted tabular">{plainPct(above, 1)} above</div>
      )}
      {above != null && above <= 0.001 && (
        <div className="text-[11px] tabular" style={{ color: 'var(--delta-down)' }}>at low</div>
      )}
    </>
  )
}

const VENUE_LABELS: Record<string, string> = {
  ebay: 'eBay', fanatics: 'Fanatics', goldin: 'Goldin', pwcc: 'PWCC', heritage: 'Heritage',
}

/**
 * What the card last went for, and the place to say otherwise.
 *
 * The figure everything else is measured against, so it is the figure worth
 * being able to correct — a lowball auction or a private sale you know about
 * should not have to be lived with. Clicking it turns it into a field; leaving
 * that field empty hands the card back to the fetched price.
 *
 * Kept as text while being edited so a half-typed number is not parsed and
 * bounced back, and committed on blur or Enter.
 */
function LastSoldCell({
  analysis, override, onChange,
}: {
  analysis?: ItemAnalysis
  override: number | null
  onChange: (v: number | null) => void
}) {
  const last = analysis?.lastSale
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')

  const commit = () => {
    setEditing(false)
    const n = Number(text.replace(/[^0-9.-]/g, ''))
    onChange(text.trim() === '' || !Number.isFinite(n) || n <= 0 ? null : n)
  }

  if (editing) {
    return (
      <input
        className="input tabular text-right w-24 px-2 py-1"
        inputMode="decimal"
        autoFocus
        placeholder="auto"
        aria-label="Set your own value for this card"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') { setEditing(false) }
        }}
      />
    )
  }

  const shown = override ?? last?.price ?? null
  const when = last && (last.ageDays === 0 ? 'today' : last.ageDays === 1 ? 'yesterday' : `${last.ageDays}d ago`)
  const where = last?.venue ? VENUE_LABELS[last.venue] ?? last.venue : null

  return (
    <button
      type="button"
      className="text-right w-full cursor-text"
      title={override != null ? 'Your own figure. Click to change it, or clear it to use the fetched price.' : 'Click to put your own number on this card.'}
      onClick={() => { setText(override == null ? '' : String(override)); setEditing(true) }}
    >
      {shown == null ? <span className="muted">—</span> : <div className="tabular">{money(shown)}</div>}
      <div className="text-[11px] muted">
        {override != null ? 'yours' : last ? [where, when].filter(Boolean).join(' · ') : 'no sales'}
      </div>
    </button>
  )
}

