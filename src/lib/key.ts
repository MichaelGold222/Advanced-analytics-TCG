/** Stable identity for an item, so a holding, a watch row and a price row line up. */
import { normalize } from './classify'

export interface KeyParts {
  name?: string
  set?: string
  number?: string
  grader?: string | null
  grade?: number | null
}

/**
 * Grade is part of the key: a PSA 10 and a raw copy of the same card are
 * different assets and must never share a price series.
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
  return [name, set, num, grade].filter(Boolean).join('|')
}

/** A looser key for matching a price row that omits the set or number. */
export function loseKey(parts: KeyParts): string {
  return normalize(parts.name ?? '')
}
