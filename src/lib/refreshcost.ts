/**
 * What pressing the button will cost, before it is pressed.
 *
 * The owner asked "how many credits will this cost?" and nothing could answer
 * — which is the same gap that let four diagnostic runs quietly empty a
 * month's balance. A number that only appears on the invoice is not a number
 * anyone can act on.
 *
 * Every figure here is measured against the live API rather than assumed:
 * see the endpoint table in CLAUDE.md.
 */
import { WINDOW_COVERED_FRACTION, WINDOW_DAYS } from './analytics'
import { CREDITS_PER_CALL, batchCerts } from './providers/cardladder'
import { daysAgo } from './stats'
import type { PricePoint } from './types'

/** `search_by_certs_bulk`, measured: 1 credit however many certs are in it. */
export const SEARCH_CREDITS_PER_CALL = 1
/** `get_card_sales`, measured: 1 credit for a card's entire history. */
export const HISTORY_CREDITS_PER_CARD = 1

export interface RefreshCost {
  /** Pass 1: the bulk search, which runs every time. */
  search: number
  /** Pass 2: the price call, only for certs the search cannot answer. */
  price: number
  /** Pass 3: full history, one credit per CARD, once ever. */
  history: number
  total: number
  /** Certs in the collection. */
  certs: number
  /** Distinct cards needing history — fewer than certs when copies are held. */
  cards: number
  /** Certs covered by those cards, so a saving can be shown. */
  certsCoveredByHistory: number
}

export function estimateRefresh(input: {
  certs: string[]
  certSales: Record<string, PricePoint[]>
  certCardIds: Record<string, string>
  certDeepFetched: Record<string, unknown>
  now?: Date
}): RefreshCost {
  const { certs, certSales, certCardIds, certDeepFetched, now = new Date() } = input
  const unique = [...new Set(certs)]

  const search = unique.length === 0
    ? 0
    : batchCerts(unique.map((c) => ({ cert_number: c, grading_company: 'PSA' as const })))
      .length * SEARCH_CREDITS_PER_CALL

  // Pass 2 is a gap-filler. Certs with no sales at all are the ones the search
  // has historically failed to answer for; on a collection it answers fully,
  // this is zero.
  const gaps = unique.filter((c) => (certSales[c] ?? []).length === 0)
  const price = gaps.length === 0
    ? 0
    : batchCerts(gaps.map((c) => ({ cert_number: c, grading_company: 'PSA' as const })))
      .length * CREDITS_PER_CALL

  // Pass 3: one credit per distinct card whose record is still too short, and
  // never for a card already fetched.
  const cards = new Set<string>()
  let certsCoveredByHistory = 0
  for (const cert of unique) {
    const cardId = certCardIds[cert]
    if (!cardId || certDeepFetched[cert]) continue
    const sales = (certSales[cert] ?? []).filter((p) => p.source === 'sale')
    if (sales.length === 0) continue
    const oldest = sales.reduce((a, b) => (a.date <= b.date ? a : b)).date
    if (daysAgo(oldest, now) >= WINDOW_DAYS * WINDOW_COVERED_FRACTION) continue
    cards.add(cardId)
    certsCoveredByHistory += 1
  }
  const history = cards.size * HISTORY_CREDITS_PER_CARD

  return {
    search, price, history, total: search + price + history,
    certs: unique.length, cards: cards.size, certsCoveredByHistory,
  }
}

/** One line for a button: "about 3 credits" / "3 + 41 for history = 44". */
export function describeCost(c: RefreshCost): string {
  if (c.certs === 0) return 'No certificate numbers yet, so nothing to fetch.'
  const parts = [`${c.search} for the bulk search`]
  if (c.price > 0) parts.push(`${c.price} for the ${c.certs === 1 ? 'cert' : 'certs'} it cannot answer`)
  if (c.history > 0) {
    const saved = c.certsCoveredByHistory - c.cards
    parts.push(
      `${c.history} for the full history of ${c.cards} card${c.cards === 1 ? '' : 's'}`
      + (saved > 0 ? ` (${c.certsCoveredByHistory} slabs, but copies of one card share a call)` : '')
      + ', charged once ever',
    )
  }
  return `About ${c.total} credit${c.total === 1 ? '' : 's'}: ${parts.join(', ')}.`
}
