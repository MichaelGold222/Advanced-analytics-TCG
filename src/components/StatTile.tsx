import type { ReactNode } from 'react'

interface Props {
  label: string
  value: string
  /** Signed change; drives the arrow and the delta color. */
  delta?: { value: string; direction: 'up' | 'down' | 'flat' }
  sub?: ReactNode
  hero?: boolean
}

/**
 * A single number reads better as a tile than as a one-bar chart.
 * Delta direction is carried by an arrow glyph as well as color, so it never
 * depends on hue alone.
 */
export function StatTile({ label, value, delta, sub, hero }: Props) {
  const color =
    delta?.direction === 'up' ? 'var(--delta-up)' : delta?.direction === 'down' ? 'var(--delta-down)' : 'var(--text-secondary)'
  const arrow = delta?.direction === 'up' ? '↑' : delta?.direction === 'down' ? '↓' : '→'

  return (
    <div className="card p-4">
      <div className="text-xs secondary font-medium">{label}</div>
      <div
        className={hero ? 'text-4xl font-semibold mt-1.5 leading-none' : 'text-2xl font-semibold mt-1.5 leading-none'}
        style={{ fontVariantNumeric: 'proportional-nums' }}
      >
        {value}
      </div>
      {delta && (
        <div className="text-sm mt-2 font-medium tabular" style={{ color }}>
          <span aria-hidden>{arrow}</span> {delta.value}
        </div>
      )}
      {sub && <div className="text-xs muted mt-2 leading-relaxed">{sub}</div>}
    </div>
  )
}
