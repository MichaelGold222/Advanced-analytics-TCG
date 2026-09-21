/** Stable identity for an item, so a holding, a watch row and a price row line up. */
import { normalize } from './classify'

export interface KeyParts {
  name?: string
  set?: string
  number?: string
  /** Shadowless, 1st Edition, Reverse Holo — a different card, not a note. */
  variation?: string
  grader?: string | null
  grade?: number | null
}

/**
 * Grade is part of the key: a PSA 10 and a raw copy of the same card are
 * different assets and must never share a price series.
 *
 * So is the variation, for exactly the same reason. A Shadowless Base Set
 * Charizard and an Unlimited one share a name, a set, a number and a grade,
 * and are worth wildly different money; without it they became one item whose
 * price history was the two of them interleaved. It is appended only when
 * there is one, so every item imported before this keeps the key it had and
 * stays attached to whatever was stored against it.
 */
export function itemKey(parts: KeyParts): string {
  const name = normalize(parts.name ?? '')
  const set = normalize(parts.set ?? '')
  const num = normalize(parts.number ?? '').replace(/^0+/, '')
  const grade =
    parts.grade != null && parts.grader
      ? `${String(parts.grader).toLowerCase()}${parts.grade}`
      : parts.grade != null
        ? String(parts.grade)
        : 'raw'
  const variation = normalize(parts.variation ?? '')
  return [name, set, num, grade, variation].filter(Boolean).join('|')
}

/** A looser key for matching a price row that omits the set or number. */
export function loseKey(parts: KeyParts): string {
  return normalize(parts.name ?? '')
}
