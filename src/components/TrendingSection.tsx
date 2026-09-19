import { TrendingDown, TrendingUp, Minus } from 'lucide-react'
import { money, pct } from '../lib/format'
import type { TrendResult } from '../lib/analytics'

export interface TrendRow {
  key: string
  name: string
  detail: string
  value: number | null
  trend: TrendResult
}

function Column({
  title, rows, tone, empty,
}: {
  title: string
  rows: TrendRow[]
  tone: 'up' | 'down'
  empty: string
}) {
  const color = tone === 'up' ? 'var(--delta-up)' : 'var(--delta-down)'
  const Icon = tone === 'up' ? TrendingUp : TrendingDown
  return (
    <div>
      <h3 className="text-sm font-semibold flex items-center gap-2 mb-2" style={{ color }}>
        <Icon className="size-4" aria-hidden /> {title}
        <span className="muted font-normal tabular">{rows.length}</span>
      </h3>
      {rows.length === 0 ? (
        <p className="text-xs muted leading-relaxed">{empty}</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.slice(0, 8).map((r) => (
            <li key={r.key} className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0">
                <span className="truncate block font-medium">{r.name}</span>
                <span className="text-xs muted">{r.detail}</span>
              </span>
              <span className="tabular whitespace-nowrap text-right">
                {/* pct() already carries the sign; adding one gives "++37.9%". */}
                <span className="font-medium" style={{ color }} title={r.trend.rationale}>
                  {pct(r.trend.changePct)}
                </span>
                <span className="block text-xs muted">{r.value == null ? '—' : money(r.value)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * Which cards are moving, from the same five sales the valuation uses.
 *
 * Split by direction rather than ranked in one list: "what is falling" is a
 * different question from "what is rising", and burying the falling ones at
 * the bottom of a sorted list is how they get missed.
 */
export function TrendingSection({ rows }: { rows: TrendRow[] }) {
  const byMove = (a: TrendRow, b: TrendRow) => Math.abs(b.trend.changePct!) - Math.abs(a.trend.changePct!)
  const up = rows.filter((r) => r.trend.direction === 'up').sort(byMove)
  const down = rows.filter((r) => r.trend.direction === 'down').sort(byMove)
  const flat = rows.filter((r) => r.trend.direction === 'flat').length
  const unknown = rows.filter((r) => r.trend.direction === 'unknown').length

  return (
    <section className="card p-4">
      <h2 className="text-sm font-semibold mb-1">Trending</h2>
      <p className="text-xs secondary leading-relaxed mb-3">
        Direction of the last {5} sales of each card, fitted through all of them so one odd sale does not
        decide it. Movement under 5% counts as flat.
      </p>
      <div className="grid gap-5 sm:grid-cols-2">
        <Column
          title="Trending up" tone="up" rows={up}
          empty="Nothing is rising by more than 5% on its recent sales."
        />
        <Column
          title="Trending down" tone="down" rows={down}
          empty="Nothing is falling by more than 5% on its recent sales."
        />
      </div>
      {(flat > 0 || unknown > 0) && (
        <p className="text-xs muted mt-4 pt-3 flex items-center gap-2" style={{ borderTop: '1px solid var(--border)' }}>
          <Minus className="size-3.5" aria-hidden />
          {flat > 0 && `${flat} holding${flat === 1 ? '' : 's'} flat`}
          {flat > 0 && unknown > 0 && ' · '}
          {unknown > 0 && `${unknown} with too few recent sales to read`}
        </p>
      )}
    </section>
  )
}
