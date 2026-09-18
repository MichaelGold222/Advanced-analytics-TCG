import { CONFIDENCE_LABEL } from '../lib/format'
import type { Confidence } from '../lib/types'

const STYLE: Record<Confidence, { bg: string; fg: string; mark: string }> = {
  high: { bg: 'color-mix(in oklab, var(--good) 16%, transparent)', fg: 'var(--good)', mark: '●●●' },
  medium: { bg: 'color-mix(in oklab, var(--warning) 20%, transparent)', fg: 'var(--text-secondary)', mark: '●●○' },
  low: { bg: 'color-mix(in oklab, var(--serious) 18%, transparent)', fg: 'var(--text-secondary)', mark: '●○○' },
  none: { bg: 'var(--surface-2)', fg: 'var(--text-muted)', mark: '○○○' },
}

/** Confidence is carried by the dot glyph as well as the tint, never color alone. */
export function ConfidenceChip({ level, detail }: { level: Confidence; detail?: string }) {
  const s = STYLE[level]
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap"
      style={{ background: s.bg, color: s.fg }}
      title={detail ?? CONFIDENCE_LABEL[level]}
    >
      <span aria-hidden style={{ letterSpacing: '-1px' }}>{s.mark}</span>
      {CONFIDENCE_LABEL[level]}
    </span>
  )
}
