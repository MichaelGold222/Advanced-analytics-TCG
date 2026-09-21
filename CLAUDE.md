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

**The history is five sales deep, and it slides.** `get_cert_values_bulk`
returned exactly **5** `recent_sales` for every cert asked about — measured, run
27 of the API check. On a card that trades monthly that is three months of
history, and it is the *newest* five, so the window slides forward and whatever
falls off the back is gone unless the app kept it. Two consequences, both of
which were live bugs:

- The 52-week, two-year and all-time bands were the same five points, so all
  three showed the identical number and the "yearly high" was the high of a
  quarter. `RangeResult.coversWindow` now says when the sales do not reach back
  far enough to justify the window's name, and the UI prints the real span
  instead of the label. `WINDOW_COVERED_FRACTION` judges the *calendar* a band
  spans, never how many sales are in it — thirty sales inside a fortnight say
  nothing about the year.
- Every refresh overwrote the stored list, so the record got *shallower* the
  more often it was fetched. `mergeSalePoints` keeps the union, deduped on
  date and price. Depth now accrues: fetch monthly and after a year the
  52-week high is real.

Whether any endpoint carries more than five is unmeasured — `get_card_sales`
has never been called, and `get_cert_full_profile` carries `sale_records` whose
depth the picture probe never counted. The API check now asks all of them
(step: "How far back does the sales history go?"). Answer that before building
anything on top of the current five.

**Endpoints.** `get_cert_values_bulk` (POST, 3 credits) returns five recent
sales per cert. `search_by_certs_bulk` (POST, 1 credit) returns
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

### Ownership columns on a watchlist

A watchlist is things not bought yet, so cost, purchase date and profit do not
apply — but sheets carry those columns anyway, because people copy a holdings
template or their export insists. `OWNERSHIP_FIELDS` in `ingest.ts` names them.
They are recognised on purpose so they can be set aside and *said* to have been:
previously "Investment" was silently mapped to a field nothing reads (so the log
claimed it was in use) and "Potential Profit" came back as unrecognised (so a
perfectly ordinary header read like a fault in the file).

`profit` is a field only so it can be ignored — on holdings too, where gain is
computed from cost and today's value rather than read from whatever the market
was doing the day the cell was typed.

Two of a kind needs the leftover scan, not just the column map: a field claims
at most one column, so "Unrealized Gain" beside "ROI" left the second looking
unreadable. `partitionLeftovers` sorts the remainder.

Worth knowing: `costBasis` claims "Entry Price", so a watchlist using that
header to mean "the price I would pay" has it set aside rather than read as a
target. The log now names it, which is how anyone would find out.

### Slab photographs

`certImages` is keyed by certificate and already covered the watchlist —
`refreshGraded` builds its cert list from holdings **and** watchlist, and
fetches pictures for both. The watchlist simply never drew them. `CardThumb`
is shared by both tables (`sm` in a row, `lg` in the expanded panel) and
`thumbFor` lives in `lib/images.ts`, since a plain helper in a component file
breaks fast refresh.

The frame is drawn whether or not a picture exists, so rows do not jump as
images load, and a broken link falls back to the placeholder rather than a
torn-image icon.

### The watchlist table had thirteen columns

Now ten. The rank number folded into the buy case (`#3 · 75 strong`), the
yearly high went — it is already the right-hand label of the range meter and a
row of the detail's range table — and the entry verdict moved into the detail
beside "The entry call", where its own numbers are. Nothing was lost, and the
photo column had to come from somewhere.

The add-a-card form is a `<details>`, open only when the list is empty: six
fields and an upload box are what a first visit wants and clutter on every
visit after.

### The graded note was shown to every graded card

`GRADED_QUOTE_NOTE` was rendered on `item.grade != null` alone, so a PSA 10
priced correctly from its own certificate's sales was still told that "the
available market quote prices a raw card, so it is excluded from FMV" — untrue
when no quote existed, and read as an explanation for the grade being ignored
when it was not being ignored at all.

`gradedPricingNote` now says one of three things and otherwise says nothing:
priced from its own grade's sales (silence), graded with no cert (ask for the
column), or graded with a cert and no comps fetched (name the cert and the
button). The raw-quote clause is added only when a quote is genuinely being
excluded.

A graded card shows no sold comps until **Fetch sold comps** has run for its
cert. That is the whole answer to "it is not using PSA 10 sales" — the sales
are fetched per certificate and nothing fetches them on import.

### A variation is a different card

`itemKey` includes the variation. Shadowless and Unlimited Base Set Charizard
share a name, a set, a number and a grade, and are worth wildly different
money; without it they were one item whose price history was the two of them
interleaved, and `analyzeHoldings` kept only the first.

It is appended only when there is one, so anything imported before this keeps
the key it had. Graded prices attach through `item.cert` rather than the key
anyway, so a key change never orphans fetched sales — only `uploadedHistory`,
`snapshots` and `quotes` are key-addressed, and a re-import rebuilds those.

`Subject` is a low-priority `name` alias, so a grader's export works while an
explicit name column still wins. `Population` is stored and shown, not yet
modelled — it is the one genuinely exogenous signal available (a pop count
climbing is structural downward pressure that no price series contains).

**An unclaimed header is not automatically unknown.** A field claims one column,
so a sheet with "Card Name" beside "Subject" has two names and can use one.
`partitionLeftovers` checks the leftovers against every field before calling
anything unrecognised, because "not recognised" should mean a column might be
getting missed, and nothing else.

### "Upload a watchlist" means nothing lands in holdings

Four reports of the watchlist reaching holdings, four different causes. The
last one: a **multi-tab workbook**. With more than one sheet, tab names decided
routing — so a workbook uploaded through the watchlist zone with a tab called
"Collection" put that tab into holdings, where it counted toward portfolio
value. The mode was right, the file was right, and the tab name overruled both.

`routeSheet` now returns early for watchlist mode. A workbook uploaded there
may hold any number of tabs; they are all things being watched, whatever one of
them is called. The portfolio zone keeps the multi-tab routing, since it is the
general-purpose import and its own wording offers it.

Reproducing it needs a workbook the content check cannot save: **no price
columns at all**, so `looksLikeWatchlist` has nothing to judge on. With an
asking price present the override already caught it, which is why the first
reproduction attempt passed on both builds and proved nothing.

**An import now says where its rows went**, on screen, with a button to move
them if it is wrong (`ImportResultBanner`). Four rounds were slow for one
reason: the app made a routing decision and said nothing, so the only way to
learn the answer was to go looking. The fix for a wrong routing should be a
button, not a bug report.

### The upload that was never routed at all

Three reports of "my watchlist went to holdings" had three different causes,
and the third was not routing. The empty state — `isEmpty && tab !== 'data'` —
stands in for **every** tab while both lists are bare, and its upload zone was
hard-coded to `'portfolio'`. So on the Watchlist tab, with nothing imported
yet, the only box on screen filed the file under holdings. The mode was already
wrong before any routing rule ran, which is why fixing the routing twice
changed nothing.

Worse, the advice for recovering made it recur: emptying holdings put both
lists back to bare, which brought the empty state back, which sent the next
upload to holdings again.

The empty state now uploads into the tab it is standing in for, and says which.

**And contents now overrule the button where they are unambiguous**
(`looksLikeWatchlist`): nothing paid in any row, some price being asked, is a
list of candidates under every reading. Judged on values rather than headers,
because a watchlist copied from a holdings template carries an empty
"Investment" column and a header alone would read that as a record of what was
paid. One-directional only — a watchlist may legitimately carry costs, so a
sheet with costs is left to the button.

### Routing a sheet to the right tab

The button the person pressed outranks any guess made from a name. It did not
used to, and the cost was severe: `importWorkbook` treated a CSV's filename as
if it were a sheet name, so a watchlist uploaded through the watchlist zone
from a file called "my collection.csv" matched `/collection/`, was routed to
holdings, counted as owned, and put its asking prices into the portfolio total
— while the watchlist itself, being a replace, was emptied. Two wrong places at
once, from one word in a filename.

`routeSheet` decides, and a name may overrule the button only when there is
something to tell apart — that is, when the file holds more than one sheet. A
workbook with a Portfolio tab and a Watchlist tab needs its names read; a
single-sheet file *is* the thing that was uploaded, and whatever its one tab is
called is not a second opinion about which button was pressed.
`RawSheet.nameIsFilename` marks a CSV's invented name, which never counts.

It was wrong twice, and the second time is the instructive one. Fixing only the
CSV case left an .xlsx whose single tab was called "Collection" — which is what
an export names it, and what anyone copying their holdings template would have
— doing exactly the same thing. Proven by uploading such a file to the
watchlist zone: three rows into holdings before, three into the watchlist
after.

**The log now says where every sheet went** (`WorkbookImport.routed`, rendered
as `"Collection" went to watchlist`). Routing had been wrong twice with nothing
on screen admitting a decision had been made at all, which is why it took a
second report to find. Any future routing complaint should start there.

The history route also checks shape, not just the name — a watchlist called
"sales pipeline" matches the same words and is not a list of completed sales.

Belt and braces: a sheet with asking or target prices and no cost column that
lands in holdings anyway now says so at import, because landing there counts it
in the portfolio total and reports asking prices as wealth.

**Recovery, three ways, none of which costs anything fetched.** Prices, quotes
and slab photographs are keyed by card rather than by list, and an import
writes only holdings, watchlist and uploaded history — so rows can be moved or
deleted freely and the prices are still there when the right sheet arrives.

- The Holdings tab offers to move rows with nothing paid and no purchase date
  to the watchlist (`suspectedWatchItems`). Heuristic, so it lists them and
  moves nothing on its own.
- **Empty holdings / Empty watchlist** in Data & settings clears one list and
  nothing else. Deterministic, which is what to reach for when the heuristic
  does not match — a row with a cost in it will not be offered for moving.
- Re-uploading a sheet is a replace by default, so it clears that list too.

"Clear all data" is none of these: it takes the snapshots and the photographs
with it.

### Selecting rows

`useSelection` over the ids currently on screen, so select-all under a filter
means "all of these" rather than everything hidden behind it, and a ticked row
that then leaves — deleted, filtered out, replaced by a re-import — stops being
counted. A set trusted as stored would make the bar promise to act on rows that
no longer exist.

Bulk removal is `removeHoldings` / `removeWatchItems`, one state update for the
lot. A loop over the single-row version would re-analyse the collection once
per row for intermediate lists nobody sees.

The delete confirmation remembers the *selection* it was agreed for, not a
flag. Resetting on the count alone would leave it armed after one row was
unticked and another ticked in its place — same number, different cards.

### Why the app was slow, and what keeps it fast

Deleting one holding from a 90-slab collection took **12.7 seconds** in a real
browser. React recomputes every analysis whenever any part of the state
changes, and each analysis ran a two-thousand-path Monte Carlo. Three changes,
measured at each step:

- **Holdings do not get a forecast** (`withForecast: false`). Nothing on that
  side draws one — only the watchlist detail and the ranking read it — so the
  entire cost was being paid for numbers no one saw. `analyzeHoldings(90)` went
  4,323ms to 19ms on its own.
- **`computeForecast` caches on its inputs.** The key covers every argument, so
  a hit is exactly what the call would have returned. A re-render that changes
  nothing now costs 3ms instead of 880ms; typing a digit into one asking price
  re-simulates that card alone.
- **All horizons come off one set of paths.** Each used to get its own run, so
  the bands cost a year plus six months plus a quarter plus a month of
  simulated days instead of a year. Cheaper, and truer — the six-month band is
  now the same futures the one-month band came from.

Each path is seeded on its own index rather than drawing from one shared
stream. Otherwise a path starts wherever the previous one stopped, and adding a
ten-year projection silently moves the one-month band.

A delete is now ~110ms. If this regresses, measure `analyzeHoldings` first: it
is where a stray forecast, or anything else per-card and expensive, will show
up immediately.

### Three ways a page moves under the person using it

All three were reported as one thing — "the page is kinda glitching out" — and
each was reproduced and measured in a browser before and after.

- **Sorting a list by a value the list lets you edit.** The watchlist is ranked
  partly on asking price, so typing one digit moved the row from third place to
  fourteenth while the field still had focus. `useFrozenOrder` snapshots the
  order when focus lands inside and releases it when focus leaves *altogether*
  — not when it moves between fields, which would re-sort between two
  keystrokes of one edit. Scores and verdicts stay live; only the position
  waits.
- **A `colSpan` cell still votes on column widths.** Expanding a row moved it
  26px and resized every column (Item 255px → 183px), because the ten-column
  detail cell was measured like any other. Its contents go in a
  `width: 0; min-width: 100%` div, which takes it out of the calculation.
- **A bulk-action bar inserted above a table pushes the table down.** Ticking a
  checkbox moved the row the cursor was on by 79px. It belongs *below* the
  table, stuck to the bottom of the viewport.

### Stored state is older than the code

`hydrate` runs `migrate()` over whatever came back from IndexedDB, filling in
fields that did not exist when it was written. Do that for any new array or
object field, and never spread saved state in raw.

This is not hypothetical. Adding `ignoredHeaders` to the import log looked
purely additive, but every returning owner had log entries saved without it,
`e.ignoredHeaders.length` threw during render, React unmounted the tree, and
Data & settings was a black page. The data was untouched the whole time; only
the drawing of it failed.

Two reasons it got all the way to a person: every browser test starts from
empty storage, so no test had old-format state in it, and there was no error
boundary, so one bad read blanked everything rather than one panel.

`ErrorBoundary` now wraps the tab content, keyed by tab. `vite.config.ts`
includes `*.test.tsx` so components can be rendered and asserted on — added
for the boundary, because what it draws is the only thing between a bad render
and a blank page.

**To reproduce this class of bug:** seed IndexedDB (`advanced-analytics-tcg/v1`)
with state missing a field the code now reads, reload, and open the tab that
reads it.

### A trap worth remembering

`npx tsc --noEmit` at the repo root checks **nothing** — the root tsconfig is
`{"files": [], "references": [...]}`, so it compiles zero files and exits 0.
Use `npm run typecheck` (or `npm run build`, which runs `tsc -b`). A duplicate
identifier and a `Date` compared against a `number` both sat there clean.

Drift is in **logs** everywhere internally. Printing it as a percentage without
`Math.expm1` understates every fast mover: a card at 1.25 in logs is up 249% a
year, not 125%.

### A traded range is built from trades

`computeRange` filtered on the window and nothing else, so the high and low
were drawn from asking prices nobody took, figures typed into a sheet, and
quotes this app captured on past runs. A single ask set a yearly high the card
never reached. It now prefers `source === 'sale'` and falls back to the wider
set only when nothing has sold, with `fromTrades` saying which — because "the
market has not traded below this" is only a true sentence about trades.

### The entry price has to be one somebody would accept

The old target was fair value minus a volatility-derived discount, up to thirty
per cent. Nobody sells a card at seventy per cent of what it is worth, so that
target was never going to be met, and an entry price nobody will meet is the
same as having none.

It is now read off the band the card actually trades in: the 25th percentile of
this year's completed sales, which is a price a quarter of the year's sales
already went at. The floor is the yearly low — the market has not gone below
it, so there is nothing deeper to wait for — and the verdict comes from where
the ask sits in that band rather than from a discount to FMV. `anchoredOnTrades`
is false when fewer than `MIN_TRADES_FOR_TRADED_ENTRY` sales exist, and the
fair-value reasoning takes over with the rationale saying so.

Framed throughout as distance from the year's high, which is how the owner
reasons about it: "the target is 35% off the high, and a quarter of the year's
sales went at or below it".

### Two ways the projections were simply wrong

Reported as a ten-year median of $56 million, and both causes were real.

**The monthly pool carried its own sampling mean.** Six hundred sums of thirty
draws do not average to exactly zero, and *every path drew from that same
pool*, so the error was applied identically to all two thousand paths and never
averaged out. Over a hundred and twenty steps it compounded into a drift
nothing reported and nothing intended — a card measuring zero trend was
projected at −13% a year, and on a volatile one the same error ran the other
way. The pool is now centred on its own mean.

The tell was there and nobody looked: the daily-walked bands were always
centred exactly, so **the one-year band and the one-year projection disagreed
about the same card**. They now agree to under a per cent, and a test holds
them together.

**`dailyReturns` divided by the root of a tiny gap.** Two copies of a slab
selling three days apart at a fifteen per cent difference is two buyers, not
the card moving fifteen per cent in three days — but the arithmetic read it as
roughly 300% annualized volatility, and the whole simulation inherited that.
`MIN_GAP_DAYS` floors the spacing used for scaling at a fortnight. The gap
itself is kept, since only the scaling was wrong.

`MAX_VOLATILITY` (120% a year) is a backstop, not a model. Past it the number
is a symptom of the data rather than a measurement, and a ten-year simulation
built on it produces figures with no meaning.

**The invariant worth keeping:** with no measured trend, the projected median
must stay where it started, at every horizon. That is what both bugs broke, and
it is what the tests now assert.

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
