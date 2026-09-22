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
  /** Shadowless, 1st Edition, Reverse Holo — part of what card this is. */
  variation?: string
  /** Graded population at this grade, when the sheet carries one. */
  population?: number
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
  variation?: string
  population?: number
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
  /** Where the sale happened: 'ebay', 'fanatics', 'goldin', or a host. */
  venue?: string
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
  /**
   * True when the high and low are completed sales rather than asking prices,
   * sheet figures and captured quotes. Only then is "the market traded between
   * these" a true sentence.
   */
  fromTrades: boolean
  /** Where the current price sits in the 52-week band, 0 = at the low, 1 = at the high. */
  position: number | null
  /** Days between the oldest and newest point used. */
  coverageDays: number
  sampleSize: number
  confidence: Confidence
  /** True when the window is too thin to be a real 52-week high. */
  estimated: boolean
  /** The window that was asked for, in days. */
  windowDays: number
  /** The oldest and newest points the band rests on. */
  oldest: string | null
  newest: string | null
  /**
   * True when the sales actually reach back far enough to justify the window's
   * name. When it is false the band is still correct — it is the high and low
   * of what traded — but it is the high of `coverageDays`, not of the year,
   * and calling it a 52-week high overstates it.
   */
  coversWindow: boolean
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
  /**
   * True when the target was read off the prices the card actually traded at
   * this year, rather than reasoned from fair value for want of any.
   */
  anchoredOnTrades: boolean
  /** How far below the year's high the target sits, 0-1. */
  entryDownFromHigh: number | null
  /** How far below the year's high the asking price sits, 0-1. */
  askingDownFromHigh: number | null
  rationale: string[]
}

export interface LastSale {
  price: number
  date: string
  /** Marketplace it sold on, when recorded; null for older stored comps. */
  venue: string | null
  /** Days since it sold, so a stale market value can be seen to be stale. */
  ageDays: number
}

export interface ForecastBand {
  horizonDays: number
  /** 10th, 50th and 90th percentile of the simulated price. */
  low: number
  mid: number
  high: number
  /** Chance the price ends above where it started. */
  chanceUp: number
}

/** Where a card might be years out, and what that would return on today's price. */
export interface Projection {
  years: number
  low: number
  mid: number
  high: number
  /** Annualized return from the basis price to each of the three, as a rate. */
  roiLow: number
  roiMid: number
  roiHigh: number
  /** Chance of ending above the price it starts from. */
  chanceUp: number
  /** Chance of at least getting back what a buyer pays today. */
  chanceAboveBasis: number
}

/** How a forecast split the card's future between the market and the card. */
export interface ForecastMarket {
  /** Sensitivity to the market, shrunk toward one. */
  beta: number
  rawBeta: number
  /** Share of this card's past movement the market accounted for. */
  marketShare: number
  /** False when the market's path was too straight to measure sensitivity. */
  separable: boolean
  /** The index's own annual drift, after being shrunk for its span. */
  marketDriftPerYear: number
  /** What is left for the card itself, annualized and shrunk. */
  alphaPerYear: number
  /** Annualized volatility the market does not account for. */
  idiosyncratic: number
  /** Cards and repeat sales the index was built from. */
  cardCount: number
  pairCount: number
}

export interface ForecastResult {
  from: number
  volatility: number
  /** True when volatility leant mostly on the segment prior, not this card. */
  shrunk: boolean
  driftPerYear: number
  /** True when the measured trend was pulled toward zero as too noisy to trust. */
  driftShrunk: boolean
  sampleSize: number
  bands: ForecastBand[]
  /** Present when the forecast was built against a market index. */
  market?: ForecastMarket
  /** The long view: one, five and ten years, and what each would return. */
  projections: Projection[]
  /** The price returns are figured against — what a buyer would pay today. */
  basis: number
  rationale: string[]
}

export interface ItemAnalysis {
  key: string
  fmv: FmvResult
  /** Twelve-month high and low. */
  range: RangeResult
  /**
   * One month. On a card selling several times a week this is the band that
   * is actually being traded in right now, and it only became measurable once
   * the record went from five sales to several hundred.
   */
  oneMonthRange: RangeResult
  /** Three months — a quarter, which is long enough to survive a quiet week. */
  threeMonthRange: RangeResult
  /** The same over six months, which turns sooner than the yearly figure. */
  sixMonthRange: RangeResult
  /** Two years: long enough to hold a full cycle for most modern cards. */
  twoYearRange: RangeResult
  /** Every sale on record — the all-time high and low. */
  allTimeRange: RangeResult
  /** The most recent completed sale, shown beside market value. */
  lastSale: LastSale | null
  /** Simulated range ahead, or null where the history is too thin to model. */
  forecast: ForecastResult | null
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
