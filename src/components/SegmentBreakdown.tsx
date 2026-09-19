import { money, pct, plainPct } from '../lib/format'
import { segmentColor } from '../lib/segment-colors'
import { SEGMENT_LABELS } from '../lib/types'
import type { PortfolioStats } from '../lib/types'

function Delta({ value, roi }: { value: number; roi: number | null }) {
  const color = value > 0 ? 'var(--delta-up)' : value < 0 ? 'var(--delta-down)' : undefined
  return (
    <>
      <td className="num tabular" style={{ color }}>{money(value)}</td>
      <td className="num tabular font-medium" style={{ color }}>{roi == null ? '—' : pct(roi)}</td>
    </>
  )
}

/**
 * Every segment's return, and the whole book underneath it.
 *
 * A table rather than another chart: these are figures to read off and
 * reconcile against a spreadsheet, and eight numbers per row is more than a
 * bar can carry. Return is measured against the cost of positions that could
 * actually be valued, so an unpriced holding never reads as a total loss.
 */
export function SegmentBreakdown({ stats }: { stats: PortfolioStats }) {
  const rows = stats.segments.filter((s) => s.items > 0)
  const anyUnvalued = stats.segments.some((s) => s.costBasis !== s.valuedCostBasis)

  return (
    <section className="card p-4">
      <h2 className="text-sm font-semibold mb-1">Portfolio by segment</h2>
      <p className="text-xs secondary leading-relaxed mb-3">
        What you put in, what it is worth now, and the return on each part of the book. The two share
        columns differ whenever a segment has run ahead of or behind the rest: one is the split of today's
        value, the other the split of the money you committed.
      </p>

      {rows.length === 0 ? (
        <p className="text-xs muted">Nothing imported yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th>Segment</th>
                <th className="num">Positions</th>
                <th className="num">Units</th>
                <th className="num">Invested</th>
                <th className="num">Market value</th>
                <th className="num">Unrealized</th>
                <th className="num">Return</th>
                <th className="num" title="Share of current market value">% of value</th>
                <th className="num" title="Share of what you put in">% of cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.segment}>
                  <td>
                    <span className="inline-flex items-center gap-2">
                      <span
                        className="inline-block size-2.5 rounded-sm shrink-0"
                        style={{ background: segmentColor(s.segment) }}
                        aria-hidden
                      />
                      {SEGMENT_LABELS[s.segment]}
                    </span>
                  </td>
                  <td className="num tabular">{s.items}</td>
                  <td className="num tabular">{s.units}</td>
                  <td className="num tabular">{money(s.costBasis)}</td>
                  <td className="num tabular">{money(s.marketValue)}</td>
                  <Delta value={s.unrealized} roi={s.roi} />
                  <td className="num tabular">{plainPct(s.weight, 1)}</td>
                  <td className="num tabular">
                    {plainPct(stats.costBasis > 0 ? s.costBasis / stats.costBasis : 0, 1)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '2px solid var(--border-strong)' }}>
                <td className="font-semibold">Whole portfolio</td>
                <td className="num tabular font-semibold">{stats.items}</td>
                <td className="num tabular font-semibold">{stats.units}</td>
                <td className="num tabular font-semibold">{money(stats.costBasis)}</td>
                <td className="num tabular font-semibold">{money(stats.marketValue)}</td>
                <Delta value={stats.unrealized} roi={stats.roi} />
                <td className="num tabular font-semibold">100%</td>
                <td className="num tabular font-semibold">100%</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {anyUnvalued && stats.unvalued > 0 && (
        <p className="text-xs muted mt-3 leading-relaxed">
          {stats.unvalued} position{stats.unvalued === 1 ? '' : 's'} could not be valued. Their cost is
          included in Invested but their return is not measured, so a missing price never reads as a loss.
        </p>
      )}
    </section>
  )
}
