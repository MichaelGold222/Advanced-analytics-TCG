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
import {
  FETCH_CONCURRENCY, batchCerts, parseBulkResponse, parseCertImages,
  type CertImage, type CertPrices, type CertRequest,
} from './cardladder'

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

/** How long to wait before retrying, from whichever header the server sent. */
function retryAfterMs(res: Response): number {
  const after = Number(res.headers.get('Retry-After'))
  if (Number.isFinite(after) && after > 0) return Math.min(after * 1000, 60_000)
  const reset = Number(res.headers.get('X-RateLimit-Reset'))
  if (Number.isFinite(reset) && reset > 0) {
    // Sent as a unix timestamp; treat anything small as a plain duration.
    const ms = reset > 1e9 ? reset * 1000 - Date.now() : reset * 1000
    if (ms > 0) return Math.min(ms, 60_000)
  }
  // The burst refills at 5/min, so a quarter minute frees several slots.
  return 15_000
}

/** When the daily allowance comes back, in words, or '' if the server did not say. */
function resetsIn(res: Response): string {
  const raw = res.headers.get('X-RateLimit-Daily-Reset')
  const secs = raw == null ? NaN : Number(raw)
  if (!Number.isFinite(secs) || secs <= 0) return ''
  const hours = Math.round(secs / 3600)
  if (hours >= 1) return `, and resets in about ${hours} hour${hours === 1 ? '' : 's'}`
  return `, and resets in about ${Math.max(1, Math.round(secs / 60))} minutes`
}

/** A spent burst rather than a spent balance: worth waiting for. */
export class RateLimited extends Error {
  readonly retryAfterMs: number
  constructor(retryAfterMs: number) {
    super(
      'Too many requests in a short time. The allowance refills at about 5 a minute, '
      + 'so waiting a minute and fetching again picks up where this left off.',
    )
    this.retryAfterMs = retryAfterMs
    this.name = 'RateLimited'
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

/**
 * How long to wait on one call before giving up on it.
 *
 * The endpoint scrapes, so it is slow by nature — but when the upstream is
 * struggling a call can hang for many minutes. Without a deadline one stuck
 * call holds a worker forever and the fetch looks frozen with no way to tell
 * it apart from ordinary slowness. A timeout is transient, so it is retried.
 */
const CALL_TIMEOUT_MS = 75_000

async function call(path: string, key: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), CALL_TIMEOUT_MS)
  const onOuterAbort = () => controller.abort(init.signal?.reason)
  init.signal?.addEventListener('abort', onOuterAbort, { once: true })

  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { 'X-API-Key': key, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    })
  } catch (err) {
    // The caller's own cancellation must propagate; our deadline must not.
    if (init.signal?.aborted) throw err
    if ((err as Error)?.name === 'TimeoutError' || (err as Error)?.name === 'AbortError') {
      throw new ParseError(408, `Card Ladder did not answer within ${CALL_TIMEOUT_MS / 1000}s.`)
    }
    throw new ParseError(0, 'Could not reach the Card Ladder API. Check your connection.')
  } finally {
    clearTimeout(timer)
    init.signal?.removeEventListener('abort', onOuterAbort)
  }
  if (res.status === 401 || res.status === 403) {
    throw new ParseError(res.status, 'That API key was refused. Check it at parse.bot/settings.')
  }
  if (res.status === 429) {
    // Three different situations share this status, and they need opposite
    // responses: a spent burst refills in under a minute and is worth waiting
    // for, while an exhausted day or an empty balance will not fix itself no
    // matter how long anything waits.
    // Number(null) is 0, so an absent header must not read as zero left.
    const count = (h: string) => {
      const v = res.headers.get(h)
      return v == null || v.trim() === '' ? NaN : Number(v)
    }
    const credits = count('X-Credits-Remaining')
    if (Number.isFinite(credits) && credits <= 0) {
      throw new ParseError(429, 'Out of credits. Check your plan at parse.bot.')
    }
    const daily = count('X-RateLimit-Daily-Remaining')
    if (Number.isFinite(daily) && daily <= 0) {
      const limit = count('X-RateLimit-Daily-Limit')
      throw new ParseError(
        429,
        `Today's request allowance is used up${Number.isFinite(limit) ? ` (${limit} a day)` : ''}`
          + `${resetsIn(res)}. What has already been fetched is kept.`,
      )
    }
    throw new RateLimited(retryAfterMs(res))
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
  /** Certs the upstream answered for but had no sales for. */
  unmatched: string[]
  /** Certs never answered for, because the call failed. Worth retrying. */
  failed: string[]
  usage: UsageInfo | null
  /** Set when some batches failed but others returned; the fetch is partial. */
  partialError: string | null
}

/**
 * Errors worth trying again.
 *
 * A 5xx is the upstream having a bad moment, not a verdict on the request —
 * treating it as final loses a whole batch of slabs to a blip. 0 is a network
 * failure, which browsers report without a status.
 *
 * 429 is deliberately absent: a spent burst arrives as RateLimited and is
 * waited out on the server's own timing, while a 429 that reaches here is an
 * empty credit balance, which no amount of retrying will refill.
 */
function isTransient(status: number): boolean {
  return status === 0 || status === 408 || status === 425 || status >= 500
}

/** Backoff between attempts, with jitter so eight workers do not retry in lockstep. */
function backoffMs(attempt: number): number {
  return [1000, 3000, 7000][attempt] ?? 7000 + Math.random() * 2000
}

/**
 * Price graded slabs by certificate number.
 *
 * The endpoint scrapes each slab when asked, so this is inherently slow: the
 * work is split into small batches run a few at a time, and progress is
 * reported as each lands rather than only at the end.
 *
 * A batch that fails does not lose the rest. A refused key or an exhausted
 * credit balance does stop the run, since every remaining call would fail the
 * same way and each one still costs time.
 */
export async function fetchCertPrices(
  certs: CertRequest[],
  opts: { key: string; signal?: AbortSignal; onProgress?: (done: number, total: number) => void },
): Promise<CertFetchResult> {
  if (certs.length === 0) return { prices: [], unmatched: [], failed: [], usage: null, partialError: null }

  const scraperId = await resolveScraperId(opts.key, opts.signal)
  const batches = batchCerts(certs)
  const prices: CertPrices[] = []
  const unmatched: string[] = []
  const failed: string[] = []
  let usage: UsageInfo | null = null
  let done = 0
  const failures: ParseError[] = []
  let fatal = false

  const runOne = async (batch: CertRequest[]) => {
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
  }

  const sleep = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      const id = setTimeout(resolve, ms)
      opts.signal?.addEventListener('abort', () => {
        clearTimeout(id)
        reject(new DOMException('Aborted', 'AbortError'))
      }, { once: true })
    })

  /**
   * The work left, as a queue rather than a fixed list.
   *
   * A batch that times out can be split and put back, so the size adapts to
   * how the upstream is behaving rather than being decided once at the start.
   */
  const queue: { certs: CertRequest[]; attempts: number }[] = batches.map((certs) => ({ certs, attempts: 0 }))

  /** Below this, splitting further costs more requests than it saves. */
  const SPLIT_FLOOR = 8

  /**
   * How many extra calls splitting may buy in total.
   *
   * Each split turns one request into two, and requests are the allowance that
   * runs out first. Without a ceiling a badly degraded upstream would halve
   * its way through a day's worth of them.
   */
  let splitsLeft = Math.max(2, Math.ceil(batches.length / 2))

  const worker = async () => {
    while (!fatal) {
      const job = queue.shift()
      if (!job) return
      try {
        await runOne(job.certs)
        done += job.certs.length
        opts.onProgress?.(Math.min(done, certs.length), certs.length)
        continue
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') throw err

        const giveUp = (pe: ParseError, stop: boolean) => {
          failures.push(pe)
          if (stop) fatal = true
          for (const c of job.certs) failed.push(c.cert_number)
          done += job.certs.length
          opts.onProgress?.(Math.min(done, certs.length), certs.length)
        }

        // A spent burst refills on the server's own timing. Checked before
        // anything else, because it shares its status with two situations that
        // do not recover and must not be treated as one of them.
        if (err instanceof RateLimited) {
          if (job.attempts < 3) {
            queue.push({ certs: job.certs, attempts: job.attempts + 1 })
            await sleep(err.retryAfterMs)
          } else {
            giveUp(new ParseError(429, err.message), false)
          }
          continue
        }

        const pe = err instanceof ParseError
          ? err
          : new ParseError(0, (err as Error)?.message ?? String(err))

        // A bad key, an empty balance or a spent day will not fix itself.
        if (pe.status === 401 || pe.status === 403 || pe.status === 429) {
          giveUp(pe, true)
          continue
        }

        // A call that ran out of time is not a call that will not work: it is
        // one asking for too much at once. Halving it and putting both back
        // lets the size settle to whatever the upstream can manage, instead of
        // timing out on the same oversized request until the attempts run out.
        if (pe.status === 408 && job.certs.length > SPLIT_FLOOR && splitsLeft > 0) {
          splitsLeft -= 1
          const mid = Math.ceil(job.certs.length / 2)
          queue.push(
            { certs: job.certs.slice(0, mid), attempts: job.attempts },
            { certs: job.certs.slice(mid), attempts: job.attempts },
          )
          continue
        }

        if (isTransient(pe.status) && job.attempts < 3) {
          queue.push({ certs: job.certs, attempts: job.attempts + 1 })
          await sleep(backoffMs(job.attempts))
          continue
        }

        giveUp(pe, false)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, queue.length) }, worker))

  // Nothing came back at all: the failure is the result, not a footnote.
  const failure = failures[0]
  if (failure && prices.length === 0) throw failure

  const short = certs.length - prices.length - unmatched.length
  return {
    prices,
    unmatched,
    failed,
    usage,
    partialError: failure
      ? `${failure.message} Priced ${prices.length} of ${certs.length}${
          short > 0 ? `; ${short} could not be reached and will be retried next time you refresh` : ''
        }.`
      : null,
  }
}

/**
 * Pictures for a set of slabs.
 *
 * A separate endpoint from the prices, and a cheaper one — a bulk search is
 * charged a single credit where the price call is charged three. Pictures also
 * do not go stale the way a price does, so this is worth doing once and
 * keeping, rather than on every refresh.
 *
 * A failure here is not worth interrupting anything for: the collection is
 * perfectly usable without pictures, so batches that fail are simply left out.
 */
export async function fetchCertImages(
  certs: CertRequest[],
  opts: { key: string; signal?: AbortSignal; onProgress?: (done: number, total: number) => void },
): Promise<{ images: CertImage[]; usage: UsageInfo | null }> {
  if (certs.length === 0) return { images: [], usage: null }

  const scraperId = await resolveScraperId(opts.key, opts.signal)
  const batches = batchCerts(certs)
  const images: CertImage[] = []
  let usage: UsageInfo | null = null
  let done = 0
  let next = 0

  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= batches.length) return
      const batch = batches[i]
      try {
        const res = await call(`/scraper/${scraperId}/search_by_certs_bulk`, opts.key, {
          method: 'POST',
          body: JSON.stringify({ certs: batch }),
          signal: opts.signal,
        })
        usage = readUsage(res)
        images.push(...parseCertImages(await res.json(), batch))
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') throw err
        // No picture is a cosmetic loss; it must not fail a refresh.
      }
      done += batch.length
      opts.onProgress?.(Math.min(done, certs.length), certs.length)
    }
  }

  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, batches.length) }, worker))
  return { images, usage }
}
