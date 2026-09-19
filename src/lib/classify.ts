/**
 * Segment classification.
 *
 * Precedence is deliberate and fixed:
 *   1. an explicit override in the sheet
 *   2. sealed        - product form beats everything; a sealed Pikachu box is sealed
 *   3. pikachu promo - a Pikachu single with a promo marker
 *   4. vintage       - released before the mid era
 *   5. mid-era       - 2007 to 2012 inclusive
 *   6. modern        - everything left over
 *
 * Every decision returns the reason that drove it, so a surprising bucket is
 * always traceable back to the word that caused it.
 */
import type { Segment } from './types'

export type Era = 'vintage' | 'mid' | 'modern' | 'unknown'

/**
 * Era boundaries.
 *
 * The mid era runs 2007 to 2012 inclusive; anything before it is vintage and
 * anything after is modern. That puts the vintage line at 2006 rather than at
 * the end of the WotC era, so Diamond & Pearl through to the end of Black &
 * White reads as its own period instead of being lumped in with current sets.
 */
export const MID_ERA_START_YEAR = 2007
export const MID_ERA_END_YEAR = 2012
export const VINTAGE_CUTOFF_YEAR = MID_ERA_START_YEAR - 1

const SEALED_PATTERNS: [RegExp, string][] = [
  [/\bbooster box\b/, 'booster box'],
  [/\belite trainer box\b|\betb\b/, 'elite trainer box'],
  [/\bultra premium collection\b|\bupc\b/, 'ultra premium collection'],
  [/\bpremium collection\b/, 'premium collection'],
  [/\bbooster bundle\b/, 'booster bundle'],
  [/\bbuild (?:&|and) battle\b/, 'build & battle box'],
  [/\bbooster pack\b|\bsleeved booster\b|\bhanger pack\b/, 'sealed pack'],
  [/\bblister\b/, 'blister pack'],
  [/\b(?:mini )?tin\b/, 'tin'],
  [/\bcollection box\b|\bbox set\b|\bgift set\b|\bcollector'?s? chest\b/, 'boxed collection'],
  [/\btheme deck\b|\bstarter deck\b|\bbattle deck\b|\bdeck box\b/, 'sealed deck'],
  [/\bbooster case\b|\bsealed case\b|\bdisplay box\b/, 'case'],
  [/\bprerelease kit\b/, 'prerelease kit'],
  [/\bfactory sealed\b|\bsealed\b/, 'marked sealed'],
]

const PROMO_PATTERNS: [RegExp, string][] = [
  [/\bblack star promo\b/, 'black star promo'],
  [/\bpromos?\b/, 'promo'],
  [/\bjumbo\b|\boversized\b/, 'jumbo promo'],
  [/\bprerelease\b/, 'prerelease promo'],
  [/\bstaff\b|\bstamped\b/, 'stamped promo'],
  // Promo numbering: SVP 001, SWSH284, XY183, SM210, BW100, DP01, HGSS01.
  [/\b(?:svp|swsh|xy|sm|bw|dp|hgss)\s?-?\d{1,3}\b/, 'promo card number'],
  [/\bpr-?[a-z]{2}\b/, 'promo card number'],
]

const PIKACHU_PATTERN = /\bpikachu\b|\bpika\b(?!\w)/

/** WotC-era sets, with a display name and the year each shipped. */
const VINTAGE_SETS: [RegExp, string, number][] = [
  [/\bbase set 2\b/, 'Base Set 2', 2000],
  [/\bbase set\b|\bbase\b(?= |$)/, 'Base Set', 1999],
  [/\bjungle\b/, 'Jungle', 1999],
  [/\bfossil\b/, 'Fossil', 1999],
  [/\bteam rocket\b/, 'Team Rocket', 2000],
  [/\bgym heroes\b/, 'Gym Heroes', 2000],
  [/\bgym challenge\b/, 'Gym Challenge', 2000],
  [/\bneo genesis\b/, 'Neo Genesis', 2000],
  [/\bneo discovery\b/, 'Neo Discovery', 2001],
  [/\bneo revelation\b/, 'Neo Revelation', 2001],
  [/\bneo destiny\b/, 'Neo Destiny', 2002],
  [/\blegendary collection\b/, 'Legendary Collection', 2002],
  [/\bexpedition\b/, 'Expedition', 2002],
  [/\baquapolis\b/, 'Aquapolis', 2003],
  [/\bskyridge\b/, 'Skyridge', 2003],
  [/\bsouthern islands\b/, 'Southern Islands', 2001],
  [/\bvending\b/, 'Vending Series', 1998],
  [/\bwizards black star\b/, 'Wizards Black Star Promos', 1999],
  [/\bbest of game\b/, 'Best of Game', 2002],
  [/\be-?card\b/, 'e-Card Series', 2002],
  [/\bvs series\b|\bpokemon vs\b/, 'VS Series', 2001],
  [/\bweb series\b|\bpokemon web\b/, 'Pokémon Web', 2001],
]

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[_/]/g, ' ')
    .replace(/[^\w\s&'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface ClassifyInput {
  name?: string
  set?: string
  number?: string
  year?: number | null
  notes?: string
  category?: string
  override?: Segment | null
}

export interface ClassifyResult {
  segment: Segment
  reason: string
  flags: { sealed: boolean; promo: boolean; pikachu: boolean; era: Era }
  /** Year we inferred from the set name, when the sheet did not give one. */
  inferredYear?: number
}

/** Map free-text category values ("Sealed Product", "vintage") onto a segment. */
export function parseSegment(raw: unknown): Segment | null {
  if (raw == null) return null
  const v = normalize(String(raw))
  if (!v) return null
  if (/pikachu/.test(v)) return 'pikachu_promo'
  if (/seal|box|product/.test(v)) return 'sealed'
  if (/vintage|wotc|old/.test(v)) return 'vintage'
  // Checked before "modern" so "mid" is not swallowed by a looser match.
  if (/\bmid\b|mid ?era|midera/.test(v)) return 'mid'
  if (/modern|new/.test(v)) return 'modern'
  return null
}

function matchFirst(text: string, patterns: [RegExp, string][]): string | null {
  for (const [re, label] of patterns) if (re.test(text)) return label
  return null
}

export function classify(input: ClassifyInput): ClassifyResult {
  const haystack = normalize(
    [input.name, input.set, input.number, input.notes, input.category].filter(Boolean).join(' '),
  )

  const sealedHit = matchFirst(haystack, SEALED_PATTERNS)
  const promoHit = matchFirst(haystack, PROMO_PATTERNS)
  const pikachuHit = PIKACHU_PATTERN.test(haystack)

  let inferredYear: number | undefined
  let vintageSetHit: string | undefined
  for (const [re, label, year] of VINTAGE_SETS) {
    if (re.test(haystack)) {
      inferredYear = year
      vintageSetHit = label
      break
    }
  }

  const year = input.year ?? inferredYear ?? null
  const era: Era =
    year == null
      ? 'unknown'
      : year <= VINTAGE_CUTOFF_YEAR
        ? 'vintage'
        : year <= MID_ERA_END_YEAR
          ? 'mid'
          : 'modern'

  const flags = { sealed: !!sealedHit, promo: !!promoHit, pikachu: pikachuHit, era }

  if (input.override) {
    return { segment: input.override, reason: 'Set explicitly in your sheet', flags, inferredYear }
  }
  if (sealedHit) {
    return { segment: 'sealed', reason: `Sealed product (matched "${sealedHit}")`, flags, inferredYear }
  }
  if (pikachuHit && promoHit) {
    return { segment: 'pikachu_promo', reason: `Pikachu promo (matched "${promoHit}")`, flags, inferredYear }
  }
  if (era === 'vintage') {
    const why = vintageSetHit
      ? `WotC-era set "${vintageSetHit}" (${year})`
      : `released ${year}, before ${MID_ERA_START_YEAR}`
    return { segment: 'vintage', reason: `Vintage: ${why}`, flags, inferredYear }
  }
  if (era === 'mid') {
    return {
      segment: 'mid',
      reason: `Mid-era: released ${year}, between ${MID_ERA_START_YEAR} and ${MID_ERA_END_YEAR}`,
      flags,
      inferredYear,
    }
  }
  if (era === 'modern') {
    return { segment: 'modern', reason: `Modern: released ${year}, after ${MID_ERA_END_YEAR}`, flags, inferredYear }
  }
  return {
    segment: 'modern',
    reason: 'No year or set matched, so filed under Modern — add a Year or Segment column to correct it',
    flags,
    inferredYear,
  }
}
