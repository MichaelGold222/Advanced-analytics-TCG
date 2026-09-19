/**
 * Segment → categorical slot.
 *
 * Slots of the validated palette, in a fixed order that never cycles and
 * never depends on rank: filtering the dashboard must not repaint the segments
 * that remain. Both modes clear the colorblind-safety and contrast gates for
 * adjacent forms; the two light-mode slots below 3:1 are why every chart using
 * them ships direct labels and a table view.
 */
import type { Segment } from './types'

/**
 * Keyed by segment rather than by position, so adding one in the middle of the
 * display order does not repaint every segment after it.
 */
const SLOTS: Record<Segment, string> = {
  sealed: 'var(--series-1)',
  vintage: 'var(--series-2)',
  modern: 'var(--series-3)',
  pikachu_promo: 'var(--series-4)',
  mid: 'var(--series-5)',
}

export function segmentColor(segment: Segment): string {
  return SLOTS[segment] ?? 'var(--text-muted)'
}
