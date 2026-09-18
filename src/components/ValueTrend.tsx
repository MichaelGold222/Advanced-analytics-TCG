import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ChartFrame, TooltipCard } from './ChartFrame'
import { money, shortDate } from '../lib/format'
import type { ValueSnapshot } from '../lib/types'

/**
 * One series over time, so a single sequential hue rather than a categorical
 * slot. Cost basis is drawn as a baseline rule - it is chrome, not a series,
 * which keeps this a single-axis, single-series chart.
 */
export function ValueTrend({ data }: { data: ValueSnapshot[] }) {
  const table = {
    columns: ['Date', 'Market value', 'Cost basis', 'Unrealized'],
    rows: data.map((d) => [
      shortDate(d.date), money(d.marketValue), money(d.costBasis), money(d.marketValue - d.costBasis),
    ]) as (string | number)[][],
  }

  const costBasis = data[0]?.costBasis ?? 0

  return (
    <ChartFrame
      title="Portfolio value"
      subtitle="Reconstructed from every price observation on record"
      table={table}
      footnote="Positions are held at their earliest known price before that price was first observed, so the line tracks price movement rather than the growth of your data. It thickens as more history accumulates."
    >
      {data.length < 2 ? (
        <div className="h-64 grid place-items-center text-sm muted text-center px-6">
          Not enough price history yet. Refresh prices to start capturing daily snapshots, or import a Price History sheet to backfill.
        </div>
      ) : (
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="valueFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--seq-400)" stopOpacity={0.28} />
                  <stop offset="100%" stopColor="var(--seq-400)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date" tickFormatter={shortDate} minTickGap={48}
                tick={{ fill: 'var(--text-muted)', fontSize: 11 }} tickLine={false} axisLine={{ stroke: 'var(--axis)' }}
              />
              <YAxis
                tickFormatter={(v: number) => money(v, { compact: true })} width={62}
                tick={{ fill: 'var(--text-muted)', fontSize: 11 }} tickLine={false} axisLine={false}
              />
              {costBasis > 0 && (
                <ReferenceLine
                  y={costBasis} stroke="var(--axis)" strokeDasharray="4 4"
                  label={{ value: 'Cost basis', position: 'insideTopLeft', fill: 'var(--text-muted)', fontSize: 11 }}
                />
              )}
              <Tooltip
                cursor={{ stroke: 'var(--axis)', strokeWidth: 1 }}
                content={({ active, payload, label }) =>
                  active && payload?.length ? (
                    <TooltipCard
                      title={shortDate(String(label))}
                      rows={[
                        { label: 'Market value', value: money(payload[0].value as number), color: 'var(--seq-400)' },
                        { label: 'Cost basis', value: money(costBasis) },
                        { label: 'Unrealized', value: money((payload[0].value as number) - costBasis) },
                      ]}
                    />
                  ) : null
                }
              />
              <Area
                type="monotone" dataKey="marketValue" stroke="var(--seq-450)" strokeWidth={2}
                fill="url(#valueFill)" activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface-1)' }} dot={false}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </ChartFrame>
  )
}
