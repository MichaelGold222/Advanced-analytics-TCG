# Working notes

## Calling Parse (Card Ladder data)

Graded prices come from the `cardladder.com API` (slug `cardladder-com-api`) in
the owner's [Parse](https://parse.bot) account. Parse wraps the Card Ladder site
as a typed HTTP API; reference docs are at https://docs.parse.bot.

Shape of a call:

```
GET|POST https://api.parse.bot/scraper/{scraper_id}/{endpoint_name}
X-API-Key: <key>
```

`{scraper_id}` is not the id printed next to the API in the dashboard — that one
is the build task. The callable id is the `result_scraper_id` field from
`GET /v1/apis`, which `resolveScraperId()` in
`src/lib/providers/cardladder-client.ts` looks up and caches.

Endpoints this project uses:

- `get_cert_values_bulk` — up to 200 certificate numbers per call, one credit.
- `get_card_sales` — individual completed sales with dates, for a single card.

Parse serves CORS (`access-control-allow-origin: *`, and it allows the
`x-api-key` request header), so the dashboard calls it straight from the browser.
Credit usage comes back in `X-Credits-Charged` / `X-Credits-Remaining` /
`X-Credits-Limit`, which Parse also exposes to browser code.

### Where the key lives

**Never commit a key, and never write one into a file in this repo — it is
public.**

- In the browser: the user pastes it into Data & settings, and it is kept in
  `localStorage` under `aa-tcg.parseKey`. It is sent to `api.parse.bot` and
  nowhere else.
- In CI (`scripts/fetch-prices.ts`): read from the `PARSE_API_KEY` environment
  variable, populated from the repository secret of the same name. Cert numbers
  come from the `PORTFOLIO_CERTS` secret, never from a tracked file.

Card Ladder files Pokémon under the set label **"Pokemon Game"**, not "Base Set"
— searches keyed on the latter return nothing.

## What the upstream actually does

Measured against the live API, not read from documentation. Re-measure with
`.github/workflows/api-check.yml` (Actions → Price API check → Run workflow)
rather than assuming any of it still holds.

**Allowances, and which one bites first.** The plan is 200 credits and **100
requests a day**, with a burst of 30 refilling at 5 a minute. Requests run out
first, so the client is tuned to spend few of them: a collection is split into
three calls (`TARGET_CALLS`), whatever its size, and 400 slabs cost the same
three requests as 90 — only longer calls. A price call is charged 3 credits, a
picture call 1, so a full refresh of 90 slabs is 6 requests and 12 credits.

**Speed, and how much it varies.** In good conditions a call costs about two
seconds plus six tenths per cert: 1 cert 2.5s, 4 certs 4.5s, 12 certs 9.0s.
Under load the same 12-cert call has taken over five minutes. The endpoint
scrapes on demand; it is not reading a stored number. A call has a 75-second
deadline, and a call that times out is halved and both halves retried rather
than repeated at the size that just failed.

**A 429 means three different things** and they need opposite responses. A
spent burst refills in under a minute and is worth waiting for. An exhausted
day and an empty balance do not recover, and telling someone to wait for
either is telling them to wait forever. They are told apart by
`X-Credits-Remaining` and `X-RateLimit-Daily-Remaining` — note that
`Number(null)` is 0, so an absent header must not be read as none left.

**Endpoints.** `get_cert_values_bulk` (POST, 3 credits) returns up to ten
recent sales per cert. `search_by_certs_bulk` (POST, 1 credit) returns
`image` and `thumbnail` per cert; both serve publicly, no token, and render in
a browser. `get_cert_full_profile` carries the same pictures but takes one
cert per call, which is why the bulk search is used instead. All of them
require `grading_company` alongside the cert number.

## How the forecast is put together

`src/lib/forecast.ts` and `src/lib/marketindex.ts`. Three ideas, each there to
stop a specific way this could be wrong.

**Drift is shrunk harder than volatility, because it is known worse.** The
standard error of an annual trend is the volatility over the root of the
*calendar span* — more sales inside the same two years barely help, since a
trend needs a longer lever rather than a denser one. Volatility's error falls
as the root of the count. On a typical card here that makes the trend three or
four times less determined, so it gets pulled toward zero by
`shrunkDrift`. Before this existed, a Lugia measuring 19% a year against a
standard error of ~18% was reading 77% up at a year; with it, 10% and 65%.

**Most of what a card does is the market.** `buildRepeatSalesIndex` is a
repeat-sales regression (Bailey–Muth–Nourse; Case–Shiller) over every card that
sold twice, which is the standard method for assets that are expensive,
individually distinct and sell rarely. `estimateBeta` then splits each card into
the market's part and its own, so the common component is estimated from
hundreds of pairs rather than one card's nine. Nothing is compared across
different cards — only each card against itself at two dates — which is what
makes the comparison legitimate.

Four things in there are load-bearing and were each put in to fix an observed
failure, so think before removing any of them:

- The prior on period-to-period change is deliberately weak (half a sale). At
  two sales it flattened a genuine peak.
- The robust scale has a floor (`MIN_RESIDUAL_SIGMA`). Without it, a run of
  tidy comps collapses the median deviation, and the long pairs carrying the
  market across a quiet stretch get trimmed as outliers — exactly backwards.
- Beta needs the market to have *shape*. Against a market rising in a straight
  line, "moves twice as hard" and "has its own drift" are the same numbers
  twice; `separable` reports when the split was impossible and falls back to
  beta 1.
- A constant sale interval is an intercept, not collinearity. Treating it as
  degenerate refuses every evenly-spaced card.

**The index counts `sale` and `user` points, not quotes.** A dated column from
the owner's sheet is a price for one card on one date, which is what a pair is
made of. Market quotes, asks, midpoints and this app's own snapshots are
opinions rather than prices paid, and snapshots would manufacture a repeat sale
every time the page was opened.

## The long view, and the buy ranking

**Projections (1, 5, 10 years).** The trend decays with a two-year half-life
(`DRIFT_HALF_LIFE_DAYS`). Without it a measured 20% a year compounds to seven
times the money over a decade, which is not a forecast anyone should publish off
nine sales. The decay caps what a trend can ever contribute at about eighteen
months of it; the first year barely changes, the decade changes entirely.
Long horizons step monthly from a pooled set of thirty-day sums rather than
walking 3,650 days per path — the draws are independent, so pooling is exact and
keeps the bootstrap's fat tails, which a normal approximation would discard.

Returns are annualized against `basis`, which is the **asking price** when there
is one, not the card's value. "What do I get if I pay what they are asking" is
the question; measuring from fair value would flatter every overpriced card.

**The ranking** (`ranking.ts`) weighs four things and shows all four: distance
below the all-time high (0.30), expected one-year return (0.30), asking price
against the entry target (0.25), and which way the latest sales point (0.15).
Weights renormalize over whatever could be measured.

The drawdown was the thing asked for and is the trap: the cards furthest below
their peak are disproportionately the ones that deserve to be. Three things
guard against it, and two were added only after watching a falling knife rank
fourth:

- **The recent trend is counted in sales, not days.** Every fixed window fails
  the same way — ninety days needs three sales in a quarter, nine months needs
  three in nine — and a thinly traded card has too few in either, so the guard
  goes missing exactly when it matters. Worse, the remaining weights then
  renormalize and the card is scored purely on being cheap. Six sales adapts to
  whatever cadence the card trades at, and the span is reported in the wording.
- **A falling card is flagged whether or not it is far off its high.** Tying the
  warning to a deep drawdown let a card sliding from near its peak pass in
  silence while the panel displayed the slide two lines above it.
- **A forecast that disagrees with the card's own sales says so.** Beta means a
  falling card in a rising market can show a positive expected return, because
  its own decline was shrunk as too thinly evidenced. Defensible arithmetic,
  and indefensible to leave unsaid next to a green number.

Nothing here knows about reprints, grading populations, or sets going in and out
of fashion. It is a screen over the sales record, and the UI says so.

### A trap worth remembering

`npx tsc --noEmit` at the repo root checks **nothing** — the root tsconfig is
`{"files": [], "references": [...]}`, so it compiles zero files and exits 0.
Use `npm run typecheck` (or `npm run build`, which runs `tsc -b`). A duplicate
identifier and a `Date` compared against a `number` both sat there clean.

Drift is in **logs** everywhere internally. Printing it as a percentage without
`Math.expm1` understates every fast mover: a card at 1.25 in logs is up 249% a
year, not 125%.

### What is still missing

Nothing measures whether the 80% bands actually contain the price 80% of the
time. Until a backtest exists — fit each card through a cutoff date, check
where the real later price landed, aggregate across the collection — "is this
accurate?" has no measured answer, including for the two fixes above. That is
the highest-value next piece of work, well above adding another model.

## Where things stand

The dashboard is deployed from this branch to
https://michaelgold222.github.io/Advanced-analytics-TCG/ on every push. The
footer carries the build time, which is the way to tell a stale page from a
current one — a browser will otherwise serve a cached copy indefinitely.

Left unfinished on the night of 2026-09-19: the owner's 90-slab collection had
30 priced and no pictures, with the upstream badly degraded and the day's
request allowance nearly spent. Nothing was lost — prices, pictures, typed-in
values and imported sheets all persist in the browser, and a refresh only ever
asks about what is still missing. The next step is simply to press **Retry the
N still missing** once, on a day when the allowance has reset.

Two things worth knowing before debugging anything here again:

- Holdings are stored exactly as they were parsed. An importer fix reaches a
  sheet only when it is uploaded again, so a column that now maps correctly
  will still read as it did until then.
- `.github/workflows/browser-check.yml` drives the built app in a real browser
  against the live API and reports what reached storage and what drew on the
  page. Several bugs this session looked like API failures and were not; that
  check is what told them apart.
