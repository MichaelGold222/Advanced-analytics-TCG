import { ChartFrame } from './ChartFrame'
import { money, plainPct } from '../lib/format'
import { segmentColor } from '../lib/segment-colors'
import { SEGMENT_LABELS } from '../lib/types'
import type { PortfolioStats } from '../lib/types'

/**
 * Part-to-whole across four segments: one horizontal stacked bar.
 *
 * Built in plain HTML rather than a chart library so the 2px surface gaps
 * between segments and the direct labels are exact. Direct labels are
 * mandatory here - the palette's light-mode contrast relief depends on them.
 */
export function SegmentAllocation({ stats }: { stats: PortfolioStats }) {
  const segments = stats.segments.filter((s) => s.marketValue > 0)
  const total = segments.reduce((a, s) => a + s.marketValue, 0)

  const table = {
    columns: ['Segment', 'Positions', 'Units', 'Market value', 'Share'],
    rows: stats.segments.map((s) => [
      SEGMENT_LABELS[s.segment],
      s.items,
      s.units,
      money(s.marketValue),
      plainPct(s.weight, 1),
    ]) as (string | number)[][],
  }

  return (
    <ChartFrame
      title="Allocation by segment"
      subtitle="Share of valued market value"
      table={table}
      footnote={
        stats.unvalued > 0
          ? `${stats.unvalued} position${stats.unvalued === 1 ? '' : 's'} could not be valued and are excluded from these shares.`
          : undefined
      }
    >
      {total === 0 ? (
        <Empty />
      ) : (
        <div>
          <div className="flex w-full h-10 rounded-md overflow-hidden" style={{ gap: 2 }} role="img"
            aria-label={segments.map((s) => `${SEGMENT_LABELS[s.segment]} ${plainPct(s.weight, 0)}`).join(', ')}>
            {segments.map((s) => {
              const share = s.marketValue / total
              return (
                <div
                  key={s.segment}
                  className="grid place-items-center overflow-hidden"
                  style={{
                    width: `${share * 100}%`,
                    background: segmentColor(s.segment),
                  }}
                  title={`${SEGMENT_LABELS[s.segment]}: ${money(s.marketValue)}`}
                >
                  {/* Direct label, which four series make mandatory. Below ~7%
                      there is no room, and the row beneath carries the number.
                      Near-black holds 4.46:1 or better on all eight segment
                      fills across both themes; white fails on three of four. */}
                  {share >= 0.07 && (
                    <span className="text-xs font-semibold tabular" style={{ color: '#0b0b0b' }}>
                      {plainPct(share, 0)}
                    </span>
                  )}
                </div>
              )
            })}
          </div>

          <ul className="mt-4 space-y-2.5">
            {stats.segments.map((s) => (
              <li key={s.segment} className="flex items-center gap-2.5 text-sm">
                <span className="inline-block size-3 rounded-sm shrink-0" style={{ background: segmentColor(s.segment) }} aria-hidden />
                <span className="flex-1 min-w-0 truncate">{SEGMENT_LABELS[s.segment]}</span>
                <span className="tabular secondary text-xs">{s.items} pos</span>
                <span className="tabular font-medium w-20 text-right">{money(s.marketValue, { compact: true })}</span>
                <span className="tabular font-semibold w-12 text-right">{plainPct(s.weight, 0)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </ChartFrame>
  )
}

function Empty() {
  return (
    <div className="h-40 grid place-items-center text-sm muted text-center px-4">
      Nothing valued yet. Import a portfolio, then refresh prices or add your own comps.
    </div>
  )
}
