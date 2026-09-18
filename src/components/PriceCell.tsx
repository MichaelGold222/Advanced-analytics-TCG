import { ConfidenceChip } from './ConfidenceChip'
import { money } from '../lib/format'
import type { ItemAnalysis } from '../lib/types'

/**
 * The valuation cell.
 *
 * When there is no FMV but the provider did return a quote, the quote is shown
 * as a labelled reference rather than left blank. It is the wrong number for a
 * graded copy, but showing nothing reads as a broken lookup and tells the user
 * less than showing the number with a warning attached.
 */
export function PriceCell({ analysis }: { analysis?: ItemAnalysis }) {
  const fmv = analysis?.fmv.fmv ?? null
  if (fmv != null) {
    return (
      <>
        <div className="tabular font-medium">{money(fmv)}</div>
        <div className="mt-1"><ConfidenceChip level={analysis!.fmv.confidence} detail={analysis!.fmv.rationale.join(' ')} /></div>
      </>
    )
  }

  const raw = analysis?.quote?.market ?? analysis?.quote?.mid ?? null
  if (raw != null && analysis?.quoteExcluded) {
    return (
      <>
        <div className="tabular" style={{ color: 'var(--text-secondary)' }}>{money(raw)}</div>
        <div
          className="text-[11px] mt-0.5 leading-tight"
          style={{ color: 'var(--serious)' }}
          title="This is the market price for an ungraded copy. A slab is worth a different amount — often many times more — so it is shown for reference and kept out of the valuation. Import your own sold comps at this grade for a real number."
        >
          raw-card price · not your grade
        </div>
      </>
    )
  }
  if (raw != null) {
    return <div className="tabular font-medium">{money(raw)}</div>
  }
  return (
    <>
      <div className="muted">—</div>
      <div className="mt-1"><ConfidenceChip level="none" /></div>
    </>
  )
}
