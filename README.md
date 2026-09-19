# Pokémon Portfolio Analytics

A local-first dashboard for a Pokémon TCG collection. Upload your collection as an
Excel or CSV file, see it broken down into **Sealed**, **Vintage**, **Modern** and
**Pikachu Promos**, and run cards you are considering buying through a valuation
that reports fair market value, the 52-week high, and a concrete entry price.

Everything runs in the browser. Your collection is stored in IndexedDB on your own
machine and is never uploaded — the only thing that leaves the page is the name of a
card being priced, sent to the price API you choose.

## Running it

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # 68 unit tests over the analytics and ingest layers
npm run build    # production bundle in dist/
```

`npm run build` emits a static site. Any static host works; `base: './'` is already
set so it also runs from a subdirectory or off the filesystem.

```bash
npm run build:single   # dist/pokemon-portfolio-analytics.html
```

`build:single` inlines the whole app — scripts, styles, every chunk — into one
self-contained .html. Double-click it and it runs: no server, no install, nothing
to resolve. It is the easiest way to hand the app to someone, and the easiest way
to keep a working copy that does not depend on a checkout.

Generated files (the template, the analysis export) normally download straight from
the browser. A host that mediates downloads — the claude.ai Artifact viewer, where a
plain download link silently does nothing — is detected at runtime and the save is
routed through it instead, so the same build works in both places.

## Automatic sold comps for graded cards (Card Ladder)

Graded slabs are priced from **completed sales of that exact card at that exact
grade**. Nothing to upload but your own collection sheet.

Two numbers, because they answer different questions:

- **Last sold** is the most recent completed sale: the price this exact card
  actually changed hands for, with how long ago and — where it is recorded —
  which marketplace. **Portfolio value, unrealized and return are all measured
  against it**, so a gain compares a price paid with a price achieved rather
  than with an average. The venue is shown rather than filtered on, since an
  auction-house result carries a buyer's premium worth knowing about but is
  still a real sale.
- **Median of 5** is the middle of the last five comps across every venue, the
  steadier estimate. It is shown for reference, and stands in where nothing has
  sold inside the year so a position is never left unvalued.

Each row carries a **photograph of the slab**, taken from the listing it last
sold in, so a card is recognisable at a glance rather than by its certificate
number. Pictures come from the bulk cert search, which is charged one credit a
call against the price call's three, and are fetched once per certificate and
kept — a photograph does not go stale the way a price does, so a cert that
already has one is never asked about again.

The pencil at the end of a row sets your own figure for that card — for a
lowball auction, a private sale you know about, or a card that has not traded.
It then reads "yours", and clearing the box hands the card back to the fetched
price. A **Market Value** column in your sheet sets the same thing.

All three run through one function, so the per-position figures and the
portfolio totals cannot disagree about how anything was valued.

Source: Card Ladder, reached through [Parse](https://parse.bot), via its
`get_cert_values_bulk` endpoint. Sales carry ISO dates and prices and come from
eBay, Fanatics and the auction houses Card Ladder tracks.

### How long it takes, and why

Card Ladder prices a slab when asked rather than reading a stored number, so
the wait scales with the collection. Measured against the live endpoint:

| certs in one call | time | credits charged |
|---|---|---|
| 1 | 2.5s | 3 |
| 4 | 4.5s | 3 |
| 12 | 9.0s | 3 |

About two seconds of fixed cost per call, six tenths of a second per cert, and
a flat three credits however many certs are in it.

That shapes the client. Filling a call to its 200-cert ceiling is one request
running roughly two minutes with nothing to report until it returns, which
reads as a hang. One-cert calls are worse in the other direction: they
multiply both the fixed cost and the per-call charge, and the account allows
only 100 requests a day.

So the collection is split into as many calls as run at once — eight, inside
the account's burst of 30 — which makes the wait the length of one call rather
than the length of the collection, with a floor so a small collection does not
buy calls it has no use for:

| slabs | calls | wait | credits |
|---|---|---|---|
| 8 | 1 × 15 | ~7s | 3 |
| 50 | 4 × 15 | ~11s | 12 |
| 90 | 6 × 15 | ~11s | 18 |
| 400 | 8 × 50 | ~32s | 24 |

Past a point the cost stops growing: 400 slabs take the same eight calls as
150, just longer ones.

A spent burst is waited out and retried, not reported as failure — and a call
that fails outright costs only its own slabs, not the whole run.

### Setting it up

1. Add a **Cert Number** column to your sheet — that is what matches a slab to
   its own sold comps. Cert numbers can also be typed into a watchlist row.
2. Open **Data & settings** and paste your key from parse.bot/settings into
   *Graded cards — Card Ladder*, then Save.
3. Press **Fetch sold comps** (or the header's *Refresh prices*, which does
   graded first).

The key is kept in this browser's `localStorage` and sent to `api.parse.bot`
alone — it is never committed, never part of the built page, and never travels
to any other service. Parse serves CORS headers, so the page calls it directly;
there is no proxy or server in between. Credits charged and remaining are read
back from the response and shown next to the button.

Fetched sales are stored locally alongside your holdings, so a refresh is only
needed when you want newer comps.

### Optional: fetch on a schedule instead

If you would rather have prices published with the site than fetched per browser,
the same call runs in CI. Add two repository secrets (Settings → Secrets and
variables → Actions):

| Secret | Value |
|---|---|
| `PARSE_API_KEY` | Your key from parse.bot/settings |
| `PORTFOLIO_CERTS` | Lines like `PSA 12345678`. Comma, semicolon, newline or JSON all work; either order within a pair |

**The cert list is a secret rather than a file on purpose.** This repository is
public and a collection sheet carries cost basis. Secrets are encrypted and never
published, so what ships with the site is certificate numbers and public sale
prices alone — nothing about what anything cost you.

That fetch runs before each deploy and once a day, writes `public/prices.json`,
and commits it so the record outlives the subscription. It can never fail the
deploy: a stale feed beats no dashboard. Where both paths are in use the app
pools their sales and collapses exact duplicates, then values off the five most
recent.

Run it by hand with `PARSE_API_KEY=… PORTFOLIO_CERTS=… npm run prices`.

## About the singles price service

Measured directly against `api.pokemontcg.io` (see `.github/workflows/api-check.yml`,
which can be re-run any time): the service currently **fails roughly half of all
requests** with HTTP 500 and Cloudflare 502, and request spacing makes no
difference — 4/10 failures back to back, 5/10 at 0.5s apart, 5/10 at 1.2s apart.
It is not rate limiting; the service is simply unreliable.

Its error responses also carry no `Access-Control-Allow-Origin` header, so a
browser discards them and hands page code a bare failure with no status — which
is indistinguishable from the page being blocked from making the request at all.
That is why a failing refresh used to report the wrong cause.

Each lookup is therefore retried up to 5 times with backoff, which brings a
single card's chance of failing to roughly 3%. A refresh that misses a few cards
is expected; running it again picks them up.

## If prices will not load

Price lookups go from the page straight to the Pokémon TCG API. Some hosts
forbid a page from calling an outside service at all, and a browser reports that
exactly like being offline, so no client-side change can work around it.

**A page opened straight from a file can never fetch live prices.** Double-clicking
the standalone .html gives the page no origin, and browsers do not let a page with
no origin call an outside service. Imports, valuations from your own comps and the
whole dashboard still work — only the live lookup is unavailable. The app detects
this and says so.

**Data & settings → Test connection** makes one small request and says which of
"opened from a file", "cannot reach the API", "rate limited", "server error" or
"working" applies.

For live prices, serve the app over http. Either host it — the included
`.github/workflows/pages.yml` publishes it to GitHub Pages, needing only
Settings → Pages → Source → "GitHub Actions" once — or run it yourself:

```bash
npm run serve      # http://localhost:4300
```

That serves the app with the price API proxied through the same origin. There is
no cross-origin request left for anything to block. It is the reliable option
when a page is restricted.

## Importing your sheet

Click **Download template** for a workbook with the expected shape, or just upload
what you already have. Column headers are matched by name, so `Paid`,
`Purchase Price` and `Cost Basis` all land on the same field. Only a card or item
name is required; everything else sharpens the analysis.

Sheets are routed by name:

| Sheet name contains | Read as |
|---|---|
| `watch`, `buy`, `target`, `wish` | Watchlist |
| `price`, `history`, `sales`, `comps`, `sold` | Price history |
| anything else | Holdings |

Two history formats work. **Long**: one row per observation, with `Date` and
`Price` columns. **Wide**: date-headed columns (`2026-01-01`, `2026-04-01`) on the
holdings sheet, each cell a price on that date. The import log shows exactly which
columns were mapped, which were ignored, and which rows were skipped — nothing is
dropped silently.

## How the four segments are decided

Precedence is fixed, and every row records the reason it landed where it did:

1. **An explicit `Segment` column** — always wins. You can also change any row in the app.
2. **Sealed** — the name matches sealed product (booster box, ETB, tin, blister, case, bundle, sealed deck…). Product form beats everything else, so a sealed Pikachu box is Sealed.
3. **Pikachu Promos** — a Pikachu card carrying a promo marker (`promo`, `black star`, `jumbo`, `prerelease`, or a promo number like `SWSH284`). A Pikachu from a main set is not a promo and is filed by era.
4. **Vintage** — released 2003 or earlier: the WotC era, Base Set through Skyridge. Recognised by set name (which also backfills a missing year) or by the `Year` column.
5. **Modern** — everything else.

## How the numbers are produced

### Fair market value

Every observation is blended, weighted by source quality and recency:

| Source | Weight | |
|---|---|---|
| Provider market price | 1.00 | |
| Completed sale | 0.95 | |
| Snapshot this app captured earlier | 0.70 | |
| Midpoint of a provider low/high band | 0.50 | |
| A price you typed or imported | 0.45 | |
| Active listing | 0.25 | cut a further 8% before blending |

Recency decays on a 45-day half-life, so a six-week-old comp counts half as much as
today's. Only the last 365 days are used. Once there are five or more points,
anything more than 3 MAD from the median is discarded as an outlier — MAD rather
than standard deviation, because two wild comps inflate a standard deviation enough
to hide themselves.

Active listings get a haircut rather than just a low weight: asks sit systematically
above where cards clear, and a systematic bias does not average out however many
listings you add.

Each estimate carries a **confidence** level from the sample size, how stale the
newest point is, how much the inputs agree, and whether any hard source (a real sale
or a market quote) is in the mix.

### The 52-week high

Taken from the observed series over the trailing year, and marked **estimated**
whenever the window covers under 90 days or holds fewer than 8 points. A "yearly
high" computed from three data points is not a yearly high, and the app says so
rather than quietly reporting the maximum of what it has.

This is the number that most rewards giving the app history. It has two ways to get
it: the Price History sheet you import, and its own snapshots — every price refresh
stores a dated point, so the range sharpens the longer you use it.

### The entry point

Required discount scales with volatility: a more volatile card has to be bought
further below fair value to be a safe entry. Annualized volatility is computed from
day-gap-scaled log returns, then halved and clamped to 6–30%.

- **Good entry** — the discount applied to FMV, blended with the 35th percentile of the last year's prices once there are at least 8 points, so the target is reachable rather than theoretical.
- **Stretch bid** — a further discount below that, never proposed below anything the market has actually traded at this year, and never above the standard target.
- **Call** — `Strong buy` / `Buy` / `Fair` / `Rich` / `Overpriced`, from where the asking price sits against those targets, plus a 0–100 score blending discount-to-FMV with position in the 52-week band.

A Strong buy is never issued off low-confidence evidence — it is capped at Buy, and
the reason is stated. Expand any watchlist row to see every input, its weight, and
the full chain of reasoning.

### Graded cards

A TCGplayer-style quote prices a **raw** card. Applying it to a PSA 10 would value a
slab at ungraded money, so for any graded item the quote is shown as context and
deliberately excluded from FMV. Slabs are valued from their own sold comps instead
— fetched by cert number as above, or imported. Grade is part of an item's identity
throughout, so a PSA 9 and a PSA 10 of the same card never share a price series.

### What is not valued

Sealed product is not priced by the singles API, and positions with no observation
anywhere are counted as **unvalued** rather than falling back to cost basis — which
would invent a 0% return. The dashboard states how many positions that affects.

## Price data

The default provider is the free [Pokémon TCG API](https://pokemontcg.io) (TCGplayer
and Cardmarket data), which needs no key but is rate limited. A free key from
`dev.pokemontcg.io` raises the limit and is stored only in your browser.

Adding another provider means implementing the `PriceProvider` interface in
`src/lib/pricing.ts` and registering it — nothing else needs to change.

## Layout

```
src/lib/
  types.ts         domain model
  classify.ts      segment rules and their explanations
  ingest.ts        sheet reading, header matching, price-history extraction
  analytics.ts     FMV, the 52-week band, entry points
  portfolio.ts     aggregation and value-trend reconstruction
  pricing.ts       price providers
  store.ts         state, IndexedDB persistence, snapshot capture
  workbook-out.ts  template and analysis export
src/components/    dashboard, tables, charts
```

Charts follow a validated palette: the four segment colors clear colorblind-safety
and contrast gates in both light and dark mode, every chart has a table view, and
labels never rely on color alone.

## Limits worth knowing

- Estimates, not appraisals. A low-confidence number is a starting point for research, not a price.
- Sealed product needs your own comps until a provider that covers it is wired in.
- The value trend holds each position at its earliest known price before that price was first observed, so the line tracks price movement rather than the growth of your own data.
- Data lives in one browser on one device. Use **Export analysis** to get it out.
