import { TONE_COLOR, VERDICT } from '../lib/format'
import type { EntryVerdict } from '../lib/types'

/** Status color always ships with its icon and label — never hue alone. */
export function VerdictBadge({ verdict, score }: { verdict: EntryVerdict; score?: number }) {
  const v = VERDICT[verdict]
  const color = TONE_COLOR[v.tone]
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold whitespace-nowrap"
      style={{ background: `color-mix(in oklab, ${color} 16%, transparent)`, color: 'var(--text-primary)' }}
    >
      <span aria-hidden style={{ color, fontSize: '0.7em', letterSpacing: '-1px' }}>{v.icon}</span>
      {v.label}
      {verdict !== 'unknown' && score != null && (
        <span className="tabular font-normal secondary">{score}</span>
      )}
    </span>
  )
}
