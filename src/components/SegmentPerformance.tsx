import { Bar, BarChart, LabelList, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ChartFrame, TooltipCard } from './ChartFrame'
import { money, pct } from '../lib/format'
import { SEGMENT_LABELS } from '../lib/types'
import type { PortfolioStats } from '../lib/types'

/** Return against cost is a polarity question, so the color job is diverging. */
export function SegmentPerformance({ stats }: { stats: PortfolioStats }) {
  const data = stats.segments
    .filter((s) => s.costBasis > 0)
    .map((s) => ({
      name: SEGMENT_LABELS[s.segment],
      roi: s.roi ?? 0,
      // Split by sign so each bar's rounded end sits away from the baseline.
      pos: (s.roi ?? 0) >= 0 ? (s.roi ?? 0) : null,
      neg: (s.roi ?? 0) < 0 ? (s.roi ?? 0) : null,
      unrealized: s.unrealized,
      cost: s.costBasis,
      value: s.marketValue,
    }))

  const table = {
    columns: ['Segment', 'Cost basis', 'Market value', 'Unrealized', 'Return'],
    rows: data.map((d) => [d.name, money(d.cost), money(d.value), money(d.unrealized), pct(d.roi)]) as (string | number)[][],
  }

  return (
    <ChartFrame
      title="Return by segment"
      subtitle="Unrealized gain against cost basis"
      table={table}
      footnote="Segments holding positions we could not value will understate their return."
    >
      {data.length === 0 ? (
        <div className="h-64 grid place-items-center text-sm muted text-center px-6">
          Add a cost basis column to your sheet to see returns.
        </div>
      ) : (
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout="vertical" margin={{ top: 4, right: 56, bottom: 4, left: 4 }}>
              <XAxis type="number" hide domain={['dataMin', 'dataMax']} />
              <YAxis
                type="category" dataKey="name" width={112} tickLine={false} axisLine={false}
                tick={{ fill: 'var(--text-secondary)', fontSize: 12 }}
              />
              <ReferenceLine x={0} stroke="var(--axis)" />
              <Tooltip
                cursor={{ fill: 'var(--surface-2)' }}
                content={({ active, payload }) =>
                  active && payload?.length ? (
                    <TooltipCard
                      title={payload[0].payload.name}
                      rows={[
                        { label: 'Return', value: pct(payload[0].payload.roi) },
                        { label: 'Unrealized', value: money(payload[0].payload.unrealized) },
                        { label: 'Cost basis', value: money(payload[0].payload.cost) },
                        { label: 'Market value', value: money(payload[0].payload.value) },
                      ]}
                    />
                  ) : null
                }
              />
              <Bar dataKey="pos" stackId="roi" barSize={22} radius={[0, 4, 4, 0]} fill="var(--diverging-pos)" isAnimationActive={false}>
                <LabelList
                  dataKey="pos" position="right" offset={8}
                  formatter={(v: unknown) => (v == null ? '' : pct(Number(v)))}
                  style={{ fill: 'var(--text-secondary)', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}
                />
              </Bar>
              <Bar dataKey="neg" stackId="roi" barSize={22} radius={[4, 0, 0, 4]} fill="var(--diverging-neg)" isAnimationActive={false}>
                <LabelList
                  dataKey="neg" position="left" offset={8}
                  formatter={(v: unknown) => (v == null ? '' : pct(Number(v)))}
                  style={{ fill: 'var(--text-secondary)', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </ChartFrame>
  )
}
