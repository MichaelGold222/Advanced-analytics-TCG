/**
 * Calling Card Ladder from the browser, through Parse.
 *
 * Parse serves CORS on both the preflight and the response
 * (access-control-allow-origin: *, allow-headers: x-api-key,content-type), so
 * the dashboard can do this itself. The key is the user's own and stays in
 * their browser; it is never committed and never sent anywhere but Parse.
 *
 * Graded cards are priced by certificate number: one call covers 200 slabs and
 * returns up to ten completed sales each, which is what the median-of-five
 * valuation needs.
 */
import { batchCerts, parseBulkResponse, type CertPrices, type CertRequest } from './cardladder'

const BASE = 'https://api.parse.bot'
const KEY_STORAGE = 'aa-tcg.parseKey'
const SCRAPER_STORAGE = 'aa-tcg.parseScraperId'

export function getParseKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? ''
  } catch {
    return ''
  }
}

export function setParseKey(key: string): void {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key)
    else {
      localStorage.removeItem(KEY_STORAGE)
      localStorage.removeItem(SCRAPER_STORAGE)
    }
  } catch {
    /* storage unavailable; the key simply will not persist */
  }
}

/** Credit and rate-limit counters Parse exposes to browser code. */
export interface UsageInfo {
  creditsCharged: number | null
  creditsRemaining: number | null
  creditsLimit: number | null
  dailyRemaining: number | null
}

function readUsage(res: Response): UsageInfo {
  const num = (h: string) => {
    const v = res.headers.get(h)
    const n = v == null ? NaN : Number(v)
    return Number.isFinite(n) ? n : null
  }
  return {
    creditsCharged: num('X-Credits-Charged'),
    creditsRemaining: num('X-Credits-Remaining'),
    creditsLimit: num('X-Credits-Limit'),
    dailyRemaining: num('X-RateLimit-Daily-Remaining'),
  }
}

export class ParseError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'ParseError'
  }
}

async function call(path: string, key: string, init: RequestInit = {}): Promise<Response> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'X-API-Key': key, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    })
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err
    throw new ParseError(0, 'Could not reach the Card Ladder API. Check your connection.')
  }
  if (res.status === 401 || res.status === 403) {
    throw new ParseError(res.status, 'That API key was refused. Check it at parse.bot/settings.')
  }
  if (res.status === 429) {
    throw new ParseError(429, 'Out of credits or rate limited for now. Check your plan at parse.bot.')
  }
  if (!res.ok) {
    throw new ParseError(res.status, `The Card Ladder API returned ${res.status}.`)
  }
  return res
}

/**
 * Find the callable scraper for the Card Ladder API on this account.
 *
 * The task record's own id is not it: executing with that returns "Scraper
 * with ID … not found". The callable one is `result_scraper_id`.
 */
export async function resolveScraperId(key: string, signal?: AbortSignal): Promise<string> {
  try {
    const cached = localStorage.getItem(SCRAPER_STORAGE)
    if (cached) return cached
  } catch {
    /* fall through and resolve it */
  }

  const listed = await (await call('/dispatch/tasks?limit=100', key, { signal })).json() as
    { tasks?: unknown[] } | unknown[]
  const tasks = (Array.isArray(listed) ? listed : (listed.tasks ?? [])) as Record<string, string>[]
  const task = tasks.find((t) => /cardladder/i.test(`${t.slug ?? ''} ${t.url ?? ''} ${t.name ?? ''}`))
  if (!task) {
    throw new ParseError(404, 'No Card Ladder API on this Parse account. Add it from the Parse marketplace first.')
  }

  const detail = await (await call(`/dispatch/tasks/${task.id}`, key, { signal })).json() as
    { result_scraper_id?: string; scraper_id?: string }
  const id = detail.result_scraper_id ?? detail.scraper_id
  if (!id) throw new ParseError(404, 'That Card Ladder API has not finished building yet.')

  try {
    localStorage.setItem(SCRAPER_STORAGE, id)
  } catch {
    /* not cacheable; it will be resolved again next time */
  }
  return id
}

export interface CertFetchResult {
  prices: CertPrices[]
  unmatched: string[]
  usage: UsageInfo | null
}

/** Price graded slabs by certificate number, 200 per call. */
export async function fetchCertPrices(
  certs: CertRequest[],
  opts: { key: string; signal?: AbortSignal; onProgress?: (done: number, total: number) => void },
): Promise<CertFetchResult> {
  if (certs.length === 0) return { prices: [], unmatched: [], usage: null }

  const scraperId = await resolveScraperId(opts.key, opts.signal)
  const batches = batchCerts(certs)
  const prices: CertPrices[] = []
  const unmatched: string[] = []
  let usage: UsageInfo | null = null
  let done = 0

  for (const batch of batches) {
    const res = await call(`/scraper/${scraperId}/get_cert_values_bulk`, opts.key, {
      method: 'POST',
      body: JSON.stringify({ certs: batch }),
      signal: opts.signal,
    })
    usage = readUsage(res)
    const got = parseBulkResponse(await res.json())
    prices.push(...got)

    // An unresolvable cert is simply absent from the results.
    const returned = new Set(got.map((g) => g.cert))
    for (const c of batch) if (!returned.has(c.cert_number)) unmatched.push(c.cert_number)

    done += batch.length
    opts.onProgress?.(done, certs.length)
  }

  return { prices, unmatched, usage }
}
