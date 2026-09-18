import { Bar, BarChart, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ChartFrame, TooltipCard } from './ChartFrame'
import { money, plainPct } from '../lib/format'
import { SEGMENT_LABELS } from '../lib/types'
import type { Segment } from '../lib/types'

export interface HoldingBar {
  name: string
  value: number
  weight: number
  segment: Segment
}

/** Magnitude, low to high: one hue, more-is-darker. */
const RAMP = ['var(--seq-550)', 'var(--seq-450)', 'var(--seq-400)', 'var(--seq-250)', 'var(--seq-250)']

export function TopHoldings({ rows, concentration }: { rows: HoldingBar[]; concentration: number }) {
  const data = rows.slice(0, 10)
  const table = {
    columns: ['Position', 'Segment', 'Market value', 'Share'],
    rows: data.map((d) => [d.name, SEGMENT_LABELS[d.segment], money(d.value), plainPct(d.weight, 1)]) as (string | number)[][],
  }

  return (
    <ChartFrame
      title="Largest positions"
      subtitle={`Top ${data.length} by market value`}
      table={table}
      footnote={
        concentration > 0
          ? `Concentration (Herfindahl) ${concentration.toFixed(3)} — roughly the same risk as holding ${Math.max(1, Math.round(1 / concentration))} equal-sized position${Math.round(1 / concentration) === 1 ? '' : 's'}.`
          : undefined
      }
    >
      {data.length === 0 ? (
        <div className="h-72 grid place-items-center text-sm muted">No valued positions yet.</div>
      ) : (
        <div style={{ height: Math.max(180, data.length * 30 + 24) }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout="vertical" margin={{ top: 0, right: 64, bottom: 0, left: 4 }}>
              <XAxis type="number" hide />
              <YAxis
                type="category" dataKey="name" width={168} tickLine={false} axisLine={false}
                tick={{ fill: 'var(--text-secondary)', fontSize: 12 }}
                tickFormatter={(v: string) => (v.length > 26 ? `${v.slice(0, 25)}…` : v)}
              />
              <Tooltip
                cursor={{ fill: 'var(--surface-2)' }}
                content={({ active, payload }) =>
                  active && payload?.length ? (
                    <TooltipCard
                      title={payload[0].payload.name}
                      rows={[
                        { label: 'Market value', value: money(payload[0].payload.value) },
                        { label: 'Share of portfolio', value: plainPct(payload[0].payload.weight, 1) },
                        { label: 'Segment', value: SEGMENT_LABELS[payload[0].payload.segment as Segment] },
                      ]}
                    />
                  ) : null
                }
              />
              <Bar dataKey="value" barSize={20} radius={[0, 4, 4, 0]} isAnimationActive={false}>
                {data.map((d, i) => (
                  <Cell key={d.name} fill={RAMP[Math.min(i, RAMP.length - 1)]} />
                ))}
                <LabelList
                  dataKey="value" position="right" offset={8}
                  formatter={(v: unknown) => money(Number(v), { compact: true })}
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
