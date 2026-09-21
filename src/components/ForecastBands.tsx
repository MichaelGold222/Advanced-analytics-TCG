import { money, plainPct } from '../lib/format'
import type { ForecastMarket, ForecastResult } from '../lib/types'

/** Nearer horizons darker: one hue, and the ramp carries how far out it is. */
const SHADES = ['var(--seq-550)', 'var(--seq-450)', 'var(--seq-250)', 'var(--seq-100)']

const LABELS: Record<number, string> = { 30: '1 month', 90: '3 months', 180: '6 months', 365: '1 year' }

/**
 * Where the price lands in most simulated futures.
 *
 * A band per horizon on one shared scale, so the widening is the point and is
 * visible as widening rather than having to be read off four sets of numbers.
 * Every figure is also written out: the bars carry the comparison, the text
 * carries the values, and nothing depends on reading a position or a colour.
 *
 * Deliberately not a fan chart. A fan drawn through four points implies a
 * continuous path that was never simulated, and invites reading a peak or a
 * dip off a curve that is an artefact of joining the dots.
 */
export function ForecastBands({ forecast }: { forecast: ForecastResult }) {
  const lows = forecast.bands.map((b) => b.low)
  const highs = forecast.bands.map((b) => b.high)
  const min = Math.min(...lows, forecast.from)
  const max = Math.max(...highs, forecast.from)
  const span = max - min
  const at = (v: number) => (span <= 0 ? 50 : ((v - min) / span) * 100)
  const today = at(forecast.from)

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div>
        <p className="text-xs secondary leading-relaxed mb-3">
          Where the price lands in 8 of 10 simulated futures, starting from {money(forecast.from)}. The dashed
          line is today.
        </p>

        <div className="space-y-2.5">
          {forecast.bands.map((b, i) => (
            <div key={b.horizonDays}>
              <div className="flex items-baseline justify-between gap-3 text-xs mb-1">
                <span className="secondary">{LABELS[b.horizonDays] ?? `${b.horizonDays} days`}</span>
                <span className="tabular muted">
                  {money(b.low)} – {money(b.high)} · mid {money(b.mid)} · {plainPct(b.chanceUp, 0)} chance up
                </span>
              </div>
              <div className="relative h-4" title={`${money(b.low)} to ${money(b.high)}, midpoint ${money(b.mid)}`}>
                <div className="absolute inset-y-1.5 left-0 right-0 rounded-sm" style={{ background: 'var(--surface-2)' }} />
                <div
                  className="absolute inset-y-0 rounded-sm"
                  style={{
                    left: `${at(b.low)}%`,
                    width: `${Math.max(1, at(b.high) - at(b.low))}%`,
                    background: SHADES[i] ?? SHADES[SHADES.length - 1],
                    // A 2px surface gap keeps a band from fusing with the one below.
                    boxShadow: '0 0 0 2px var(--surface-1)',
                  }}
                />
                <div
                  className="absolute inset-y-0 w-0.5"
                  style={{ left: `${at(b.mid)}%`, background: 'var(--surface-1)' }}
                  aria-hidden
                />
                <div
                  className="absolute -inset-y-0.5 w-0 border-l border-dashed"
                  style={{ left: `${today}%`, borderColor: 'var(--text-secondary)' }}
                  aria-hidden
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        {forecast.market && <MarketSplit market={forecast.market} />}
        <ul className="text-sm space-y-1.5 leading-relaxed">
          {forecast.rationale.map((r) => <li key={r}>· {r}</li>)}
        </ul>
      </div>
    </div>
  )
}

/**
 * How much of this card's movement is the market's, and how much is its own.
 *
 * Two segments of one bar rather than two bars: they are shares of one thing
 * and always sum to it, so the comparison worth seeing is which is larger.
 * Both are written out beside their own segment, so the split never has to be
 * read off a length or a colour.
 */
function MarketSplit({ market }: { market: ForecastMarket }) {
  const share = Math.max(0, Math.min(1, market.marketShare))
  const pct = Math.round(share * 100)

  return (
    <div className="mb-3">
      <div className="flex items-baseline justify-between gap-3 text-xs mb-1.5">
        <span className="secondary">What moves it</span>
        <span className="tabular muted">
          {market.separable
            ? `beta ${market.beta.toFixed(2)}`
            : 'beta not measurable'}
        </span>
      </div>
      <div className="relative h-4 rounded-sm overflow-hidden" style={{ background: 'var(--surface-2)' }}>
        <div
          className="absolute inset-y-0 left-0"
          style={{ width: `${pct}%`, background: 'var(--seq-450)', boxShadow: '0 0 0 2px var(--surface-1)' }}
        />
      </div>
      <div className="flex items-baseline justify-between gap-3 text-xs mt-1">
        <span className="tabular">{pct}% the market</span>
        <span className="tabular muted">{100 - pct}% this card alone</span>
      </div>
    </div>
  )
}
