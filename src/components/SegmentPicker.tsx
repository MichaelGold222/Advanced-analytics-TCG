import { SEGMENTS, SEGMENT_LABELS } from '../lib/types'
import type { Segment } from '../lib/types'

/** Inline segment override. "Auto" hands the row back to the classifier. */
export function SegmentPicker({
  value, onChange, inferred,
}: {
  value: Segment | null
  onChange: (s: Segment | null) => void
  inferred: Segment
}) {
  return (
    <select
      className="input py-1 text-xs w-44"
      value={value ?? ''}
      aria-label="Segment"
      onChange={(e) => onChange((e.target.value || null) as Segment | null)}
    >
      <option value="">Auto · {SEGMENT_LABELS[inferred]}</option>
      {SEGMENTS.map((s) => (
        <option key={s} value={s}>{SEGMENT_LABELS[s]}</option>
      ))}
    </select>
  )
}
