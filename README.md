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
deliberately excluded from FMV. Import your own graded comps to value slabs
accurately. Grade is part of an item's identity throughout, so a PSA 9 and a PSA 10
of the same card never share a price series.

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
