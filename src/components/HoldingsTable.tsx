import { useMemo, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { PriceCell } from './PriceCell'
import { SegmentPicker } from './SegmentPicker'
import { money, pct } from '../lib/format'
import { classify } from '../lib/classify'
import { holdingKey } from '../lib/portfolio'
import { SEGMENTS, SEGMENT_LABELS } from '../lib/types'
import type { Holding, ItemAnalysis, Segment } from '../lib/types'

type SortKey = 'name' | 'value' | 'unrealized' | 'roi' | 'segment'

interface Props {
  holdings: Holding[]
  analyses: Map<string, ItemAnalysis>
  onOverride: (id: string, segment: Segment | null) => void
  onRemove: (id: string) => void
}

export function HoldingsTable({ holdings, analyses, onOverride, onRemove }: Props) {
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
        const value = fmv == null ? null : fmv * h.quantity
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
              <th className="num">Qty</th>
              <th className="num">Cost / unit</th>
              <th className="num">Investment</th>
              <th className="num">FMV / unit</th>
              <th className="num">Market value</th>
              <th className="num">Unrealized</th>
              <th className="num">Return</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map(({ h, a, cost, value, unrealized, roi }) => {
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
                  <td className="num tabular">{h.quantity}</td>
                  <td className="num tabular">{money(h.costBasis)}</td>
                  <td className="num tabular">{money(cost)}</td>
                  <td className="num"><PriceCell analysis={a} /></td>
                  <td className="num tabular font-medium">{money(value)}</td>
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
    </section>
  )
}
