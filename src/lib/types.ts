/** Core domain model for the portfolio analytics platform. */

export type Segment = 'sealed' | 'vintage' | 'mid' | 'modern' | 'pikachu_promo'

export const SEGMENTS: Segment[] = ['sealed', 'vintage', 'mid', 'modern', 'pikachu_promo']

export const SEGMENT_LABELS: Record<Segment, string> = {
  sealed: 'Sealed',
  vintage: 'Vintage',
  mid: 'Mid-era',
  modern: 'Modern',
  pikachu_promo: 'Pikachu Promos',
}

/** A single position in the collection. */
export interface Holding {
  id: string
  name: string
  set?: string
  number?: string
  year?: number
  /** Raw condition text, e.g. "NM", "PSA 10", "CGC 9.5". */
  condition?: string
  grader?: 'PSA' | 'BGS' | 'CGC' | 'SGC' | 'ACE' | 'TAG' | null
  grade?: number | null
  /**
   * The grader's certification number. Identifies one physical slab exactly,
   * which lets a price source skip name matching entirely.
   */
  cert?: string
  quantity: number
  /** Per-unit acquisition cost. */
  costBasis: number
  purchaseDate?: string
  /** Per-unit price the user supplied in the sheet, if any. */
  userPrice?: number
  language?: string
  notes?: string
  /** Explicit segment from the sheet; wins over inference. */
  segmentOverride?: Segment | null
  segment: Segment
  /** Human-readable explanation of why this segment was chosen. */
  segmentReason: string
}

/** A card or product the user is considering buying. */
export interface WatchItem {
  id: string
  name: string
  set?: string
  number?: string
  year?: number
  condition?: string
  grader?: Holding['grader']
  grade?: number | null
  cert?: string
  /** Price currently being asked, if the user is looking at a specific listing. */
  askingPrice?: number
  /** The user's own ceiling, if they set one. */
  targetPrice?: number
  quantity?: number
  notes?: string
  segmentOverride?: Segment | null
  segment: Segment
  segmentReason: string
}

/** One observed price for one item at one point in time. */
export interface PricePoint {
  /** ISO date (YYYY-MM-DD). */
  date: string
  price: number
  source: PriceSource
  /** Units transacted, when the source reports it. Used to volume-weight. */
  volume?: number
}

export type PriceSource =
  | 'market'        // provider market price (e.g. TCGplayer market)
  | 'sale'          // an observed completed sale
  | 'listing'       // an active ask
  | 'user'          // typed in or read from the user's sheet
  | 'snapshot'      // a market price this app captured on a past run
  | 'mid'           // midpoint of a provider low/high band

/** A time series for one item, assembled from every available source. */
export interface PriceSeries {
  key: string
  points: PricePoint[]
  /** Provider's current quote, when we have one. */
  quote?: PriceQuote
  /**
   * True when a quote exists but was kept out of the blend because it prices a
   * raw card and this item is graded. The number is still worth showing as
   * context — withholding it entirely just looks like the lookup failed.
   */
  quoteExcluded?: boolean
}

export interface PriceQuote {
  low?: number
  mid?: number
  high?: number
  market?: number
  directLow?: number
  updatedAt?: string
  currency: string
  provider: string
  url?: string
}

export type Confidence = 'high' | 'medium' | 'low' | 'none'

export interface FmvResult {
  /** The blended fair market value, or null when nothing supports an estimate. */
  fmv: number | null
  confidence: Confidence
  /** 0-1: how much the inputs agree. */
  agreement: number
  /** Days since the newest input. */
  stalenessDays: number | null
  sampleSize: number
  contributors: { source: PriceSource; value: number; weight: number; date: string }[]
  rationale: string[]
}

export interface RangeResult {
  high: number | null
  low: number | null
  /** Where the current price sits in the 52-week band, 0 = at the low, 1 = at the high. */
  position: number | null
  /** Days between the oldest and newest point used. */
  coverageDays: number
  sampleSize: number
  confidence: Confidence
  /** True when the window is too thin to be a real 52-week high. */
  estimated: boolean
}

export type EntryVerdict = 'strong_buy' | 'buy' | 'fair' | 'rich' | 'overpriced' | 'unknown'

export interface EntryResult {
  verdict: EntryVerdict
  /** 0-100. Higher means a better entry at the reference price. */
  score: number
  /** Buy at or below this for a good entry. */
  entryPrice: number | null
  /** The deeper, patient bid. */
  stretchEntry: number | null
  /** Discount to FMV the analysis demands, derived from volatility. */
  requiredDiscount: number
  /** Annualized volatility of the series, 0-1+. */
  volatility: number | null
  /** Trailing 90-day drift, as a fraction. */
  momentum90d: number | null
  rationale: string[]
}

export interface ItemAnalysis {
  key: string
  fmv: FmvResult
  /** Twelve-month high and low. */
  range: RangeResult
  /** The same over six months, which turns sooner than the yearly figure. */
  sixMonthRange: RangeResult
  entry: EntryResult
  referencePrice: number | null
  /** The provider's live quote, whether or not it fed the valuation. */
  quote?: PriceQuote
  /** See `PriceSeries.quoteExcluded`. */
  quoteExcluded?: boolean
}

export interface SegmentStats {
  segment: Segment
  items: number
  units: number
  marketValue: number
  /** Cost of every position, valued or not. */
  costBasis: number
  /**
   * Cost of only the positions we could value. Return is measured against
   * this: counting an unpriced position's cost against a market value it
   * never contributed to would report a loss that did not happen.
   */
  valuedCostBasis: number
  unrealized: number
  roi: number | null
  /** Share of total portfolio market value, 0-1. */
  weight: number
}

export interface PortfolioStats {
  marketValue: number
  /** Cost of every position, valued or not. */
  costBasis: number
  /** Cost of only the positions we could value; the basis for return. */
  valuedCostBasis: number
  unrealized: number
  roi: number | null
  items: number
  units: number
  segments: SegmentStats[]
  /** Herfindahl index over positions, 0-1. Higher means more concentrated. */
  concentration: number
  topPosition: { name: string; value: number; weight: number } | null
  /** Positions we could not value, so the user knows what the totals omit. */
  unvalued: number
}

export interface ValueSnapshot {
  date: string
  marketValue: number
  costBasis: number
  bySegment: Partial<Record<Segment, number>>
}
