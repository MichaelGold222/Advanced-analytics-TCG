/**
 * Segment → categorical slot.
 *
 * Slots 1-4 of the validated palette, in a fixed order that never cycles and
 * never depends on rank: filtering the dashboard must not repaint the segments
 * that remain. Both modes clear the colorblind-safety and contrast gates for
 * adjacent forms; the two light-mode slots below 3:1 are why every chart using
 * them ships direct labels and a table view.
 */
import { SEGMENTS } from './types'
import type { Segment } from './types'

const SLOTS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)']

export function segmentColor(segment: Segment): string {
  return SLOTS[SEGMENTS.indexOf(segment)] ?? 'var(--text-muted)'
}
