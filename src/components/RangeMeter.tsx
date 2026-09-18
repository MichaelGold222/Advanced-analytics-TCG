import { money } from '../lib/format'

interface Props {
  low: number | null
  high: number | null
  fmv: number | null
  entry: number | null
  asking?: number | null
  estimated?: boolean
}

/**
 * One ratio against a band, so a meter rather than a chart.
 * Every marker is labelled; nothing here relies on position or color alone.
 */
export function RangeMeter({ low, high, fmv, entry, asking, estimated }: Props) {
  if (low == null || high == null) {
    return <span className="text-xs muted">No range</span>
  }
  const span = high - low
  const at = (v: number | null | undefined) =>
    v == null || span <= 0 ? null : Math.min(100, Math.max(0, ((v - low) / span) * 100))

  const entryPos = at(entry)
  const fmvPos = at(fmv)
  const askPos = at(asking)

  return (
    <div className="w-44">
      <div
        className="relative h-2 rounded-full"
        style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
        role="img"
        aria-label={`52-week range ${money(low)} to ${money(high)}${asking != null ? `, asking ${money(asking)}` : ''}${fmv != null ? `, fair value ${money(fmv)}` : ''}`}
      >
        {/* The zone at or below the entry target. */}
        {entryPos != null && (
          <div
            className="absolute inset-y-0 left-0 rounded-l-full"
            style={{ width: `${entryPos}%`, background: 'color-mix(in oklab, var(--good) 22%, transparent)' }}
          />
        )}
        {fmvPos != null && (
          <div
            className="absolute -top-0.5 h-3 w-0.5"
            style={{ left: `calc(${fmvPos}% - 1px)`, background: 'var(--text-secondary)' }}
            title={`FMV ${money(fmv)}`}
          />
        )}
        {askPos != null && (
          <div
            className="absolute -top-1 size-4 rounded-full"
            style={{
              left: `calc(${askPos}% - 8px)`,
              background: 'var(--seq-450)',
              border: '2px solid var(--surface-1)',
            }}
            title={`Asking ${money(asking)}`}
          />
        )}
      </div>
      <div className="flex justify-between mt-1 text-[11px] muted tabular">
        <span>{money(low, { compact: true })}</span>
        <span>{estimated ? 'est. range' : '52-wk range'}</span>
        <span>{money(high, { compact: true })}</span>
      </div>
    </div>
  )
}
