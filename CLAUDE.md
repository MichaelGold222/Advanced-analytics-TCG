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

**Every run of that check spends the owner's credits, and the plan is 200 a
month.** Four runs in ten minutes emptied the balance and left ~60 slabs
unpriceable until the reset. Roughly half of that went on the picture steps,
re-asking questions run 27 had already answered and recorded in this file —
paid for twice, for nothing. So: read this section before asking the API
anything, batch every open question into ONE run, and pick the probes with the
`probes` input, which now defaults to prices only. The picture answers are
settled and do not need asking again.

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

**`search_by_certs_bulk` is the better source of sales, and it was already
being called.** Measured, run 30. For cert 141142901 it returned **ten** sales
where `get_cert_values_bulk` returned five — and the price call dated all five
to the day of the request, a 0-day span, while the search dated them properly
across nine days. Deeper, better dated, **1 credit against 3**, and the app was
making the call anyway for the photographs and discarding the sales. It now
merges them (`parseCertImages` returns `sales`; `refreshImages` folds them in).
For a cert with only five sales on record both return the same five, so this
never narrows anything.

Two caveats before leaning on it further: it has been seen to return ten, not
proven to have no cap of its own, and the price call remains the source of
`cl_value` and `last_sale_price`.

**Deeper still, untested: `get_card_sales_detail`.** The spec lists it with
`page`, `limit` and `card_id` — pagination, which means full history. Its
`card_id` is a Firestore document id, and **`search_by_certs_bulk` already
returns it as `id`** on a card in the catalogue (cert 141142901 →
`Zrxi8aY5mAA6roFkKUVX`, the same id the picture URL carries). A cert that is
not catalogued gets a 40-character hash there instead, which the upstream
rejects with "Card with id ... not found". Untested only because the account's
monthly credits ran out mid-probe — four diagnostic runs in ten minutes did
it, so batch the questions into one run next time. This is the thing to try
first when credits return.

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

### A band is built from prices, and the sales do not reach far enough

`computeRange` filtered on the window and nothing else, so the high and low
were drawn from asking prices nobody took and quotes this app captured on past
runs. A single ask set a yearly high the card never reached. Filtering to
`source === 'sale'` fixed that and **broke something worse in the same stroke**:
the owner's own dated prices went out with the asks, and since the feed only
ever hands back five sales, those records are the only evidence of any month
before them. A card with a year of sheet history and five fetched sales had the
history silently dropped the moment the sales arrived — a $9,400 price from 250
days ago became a $3,600 "yearly high" over 92 days.

The rule now is about **reach**, not about source alone:

- Where the sales record covers a period, the sales decide it. A sheet figure
  of $2,200 beside six sales between $870 and $1,450 is an opinion however it
  got there, and the tests that guard this predate the fix and still pass
  untouched.
- Where the sales record does not reach — before the oldest fetched sale, or
  after the newest — a dated price from the owner's sheet is the only evidence
  of that period anyone has, and it counts. This is the same judgement
  `PAIRABLE_SOURCES` makes in marketindex.ts, where a `user` point is trusted
  to form half of a repeat sale.
- Asks, quotes, midpoints and snapshots never count at any date, and remain
  the fallback only when nothing else exists.

`fromTrades` keeps its original meaning — every point under the band is a
completed sale — because "the market has not traded below this" is only a true
sentence about trades. A mixed band says so in its own words instead.

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

### Two different reasons a number is wrong, and only one is fixed by backfilling

`historygaps.ts`, shown in Data & settings. The owner asked for accurate
numbers and had no way to find out which ones were not, so "get history for
all 32 cards" looked like the only option when the real list is usually much
shorter.

- **Thin.** The record does not reach back a year, so the "yearly" high is the
  high of however many days it does reach. Fixed once, by getting sales in
  from anywhere.
- **Outpaced.** The card sells more often than one fetch can carry, so sales
  are lost *permanently* between refreshes — the feed returns the newest few
  and anything that scrolled off is gone. Backfilling does nothing for this;
  only refreshing more often does. A card can be perfectly covered today and
  drifting out of true from tomorrow, which is why it is labelled apart rather
  than folded into one warning.

`SALES_PER_FETCH` is the measured five, and `safeRefreshDays` is that over the
card's trade rate: how long a refresh can wait before the card outruns it. The
rate is taken over the **last five sales only**. A wider slice was the first
implementation and it was wrong in the exact way the feature exists to catch —
a backfilled year of quiet trading averaged away a slab that had started
selling daily. The window is the same size as the thing it tests: at this
rate, does one fetch still keep up?

Typed figures are excluded from the rate: a `user` point says a price on a
date, nothing about how often the card changes hands.

### The expensive call was leading, and it returned less

A full refresh of 122 slabs cost **12 credits and now costs 3**, for strictly
more data. The waste was the order of two calls.

| | credits per call | covers | sales | also carries |
|---|---|---|---|---|
| `get_cert_values_bulk` | 3 | 200 certs | 5 | `cl_value`, `last_sale_price` |
| `search_by_certs_bulk` | **1** | 200 certs | **10** | `cl_value`, `current_value`, `market_value`, `pop`, pictures, **card id** |

Measured, run 30. There is nothing the price call gives that the search does
not, it returned twice the sales, and its dates were right where the price
call dated all five of its own to the day of the request. Yet the price call
led every refresh and the search ran afterwards as a cosmetic afterthought —
9 credits of every 12, for less.

The search now leads, and the price call runs **only for certs the search
could not answer for**. On a collection it answers fully, the price call never
runs at all.

**The charge is per call, not per cert**, which is the thing to hold on to
before optimising this further. One call covers up to 200 certs for 1 credit,
so a collection of 122 costs the same 3 credits as a collection of 2 — and
`refreshImages` therefore no longer skips certs that already have a
photograph. It looks like paying for photos again and is the opposite: the
call is being made for the *sales*, which do go stale, and the photograph
rides along in the same response for nothing. Skipping those certs would not
save a credit; it would only throw away the sales in the reply.

Pinned in tests (`what a full refresh costs`), because the ordering is worth
real money and an innocent-looking edit could reverse it.

### The lookup is by name, not by certificate

Measured across runs 31-37. The chain that works:

```
search_cards?query=<name>   1 credit  ->  cards[], each with its own id AND grade
get_card_sales?card_id=<id> 1 credit  ->  the whole price history of that card
```

A `search_cards` hit looks like this, and carries everything needed to match a
row in the collection without any certificate at all:

```json
{"id": "ePSC20G9FDYBEGwAMVq5",
 "label": "2000 Pokemon Gym Challenge Blaine's Charizard 1st Edition Holo #2 PSA 10",
 "slug": "2000-pokemon-gym-challenge-blaines-charizard-1-st-edition-holo-2-psa-10",
 "set": "Pokemon Gym Challenge", "number": "2", "variation": "1st Edition Holo",
 "condition": "PSA 10", "num_sales": 206, "pop": 421, "market_value": 25551}
```

**`condition` is part of the card record**, so a card id is a card *at a
grade* — which is why `get_card_sales` for one answers with some other slab's
cert number. Every PSA 10 of a card shares one history, and that is the right
unit for a price series.

**Going in by certificate was the mistake, and it fails for real cards.** Cert
77865285 returns a 40-character hash where a card id should be, and its only
photograph is a listing photo, so there is no id to be had from it — both
candidates answered 422 "Card with id ... not found". The app was right to
skip it and right to spend nothing, but a cert whose slab is not catalogued
can never be reached that way, however well catalogued the card is. The
collection already holds name, set, number, variation and grade for every row;
that is what the lookup should use.

Failed lookups are charged **0 credits**, so trying several spellings is free.
Only a search that answers 200 costs anything.

### The whole history of a card is one call and one credit

Measured, run 31. `get_card_sales?card_id=...` answered with **627 dated
prices going back years, charged 1 credit**, against the five sales spanning
six days the bulk endpoints were giving. That is the answer to the yearly
high, and the backfill is built on it.

**`get_card_sales_detail` is not used.** Asked for page 1 at `limit=200` it
returned `"sales":[]`, forced `limit:50`, still claimed `has_more:true`, and
charged the same credit for nothing. Walking it page by page — which is what
was built before this run — would have spent many credits per card to collect
thousands of individual sales, in order to compute two numbers.

**The rows are aggregated, and that is the right thing to ask for.**
`{date, price, count}`: a price standing for `count` sales. An Umbreon VMAX
PSA 10 has 21,000 copies and thousands of sales behind it; paying to download
every one to find a high and a low would be absurd. `count` is carried through
as `volume`, which the valuation already weights on.

The cost of that aggregation, which the UI has to keep saying: an averaged
point **understates a high and overstates a low**. Seven sales averaged to
$814 may hide one at $1,100. The band is a floor on the true range rather than
the range itself — still enormously better than five sales over six days, and
the only version of this that is affordable.

`card_id` identifies the **card at a grade, not the slab**: the response comes
back labelled with a different cert from the one asked about, because every
PSA 10 of that card shares one history. That is the right unit for a price
series, and it means two slabs of the same card cost one call between them —
worth exploiting, and not yet exploited.

Dates arrive as `MM/DD/YYYY`. `toISODate` handles them; the Python probe did
not, which is why a run log said "no readable dates" about perfectly readable
data. Do not trust that phrase from `depth.py` again.

### The button does the whole job

**Fetch sold comps** runs three passes, and the third is the one above:

1. `search_by_certs_bulk` — 1 credit per 200 certs: sales, `cl_value`, `pop`,
   pictures, and the card id.
2. `get_cert_values_bulk` — 3 credits, **only for certs the search could not
   answer**. Usually none.
3. `get_card_sales` — 1 credit per card, **only for cards whose record still
   does not reach back a year**, and **once per card ever**.

So a routine refresh of the whole collection is 3 credits; a first backfill of
122 slabs is about 122 more, one time. `certDeepFetched` records every cert
walked — history does not get older, so it is never walked twice — and records
a refusal the same way, so a dead endpoint is asked once rather than forever.
A 402 or 429 throws and marks nothing, so the next press resumes where it
stopped.

`usableCardId` keeps a call from being spent on a cert that cannot work: a
catalogued card carries a Firestore document id, an uncatalogued one carries a
40-character hash, and that hash was measured answering "Card with id ... not
found" while still costing a request.

### Tracking the highs forward is a cron job, and it was never wired up

`scripts/fetch-prices.ts` says in its own docstring that it "runs on a schedule
in CI". Nothing ran it — there was no workflow, so it was dead code, and the
one path that could have been accumulating history for months was not running
at all.

`.github/workflows/prices.yml` runs it now, and `mergeFeeds` makes running it
worth doing. Without the merge a schedule is pointless: the upstream returns
the newest few sales per cert, so writing the response straight out leaves a
file holding a sliding few weeks, and running it weekly for a year produces
exactly as little history as running it once. Simulated over 52 weekly runs
against a card selling weekly:

| | sales | high | low | reaches back |
|---|---|---|---|---|
| truth | 52 | $1,400 | $600 | 12 months |
| merged | 52 | $1,400 | $600 | 12 months |
| overwritten | 5 | $1,400 | $1,319 | 5 weeks |

The low is the tell. The high happened to survive; the low was wrong by more
than double.

Three things about it worth keeping:

- **The record lives in the repository, not in a browser.** It outlives cleared
  site data and is readable from any machine — which matters most if a paid
  backfill ever lands in it.
- **A cert missing from a run keeps what it had.** A bad night upstream must
  not delete history that was already paid for.
- **A run that adds nothing makes no commit**, so the log does not fill with
  fifty-two rows that only moved `fetchedAt`.

**The schedule is committed commented out.** ~3 credits a run, ~12 a month
weekly, out of 200 — but after emptying the balance once already, nothing here
starts spending on its own. The owner uncomments the cron.

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

### Paused on 2026-09-21 with the credit balance at zero

**Nothing is broken and nothing is lost.** Prices, pictures, typed-in values
and imported sheets all persist in the browser. The app is green: 500 tests,
typecheck, lint and build all clean, working tree clean, everything pushed.

The balance is at zero because **four diagnostic runs of the API check in ten
minutes spent roughly 95 credits of a 200-a-month plan** — `get_cert_full_profile`
turns out to cost 10 a call, not the 3 that was assumed, and it was being
called twice per run. Half of it re-asked picture questions that run 27 had
already answered and written into this file. That is the single most expensive
mistake of the session and the reason the check's probes are now opt-in.
Read this file before asking the API anything.

### The one question to settle when credits reset

**Does `get_card_sales_detail` return full sales history, and what does a call
cost?** Everything downstream turns on it, it has never been called, and it can
be answered for ~10 credits. Batch every other open question into the same run.

- Card id: `search_by_certs_bulk` returns it as `id` for a card in the
  catalogue (cert 141142901 → `Zrxi8aY5mAA6roFkKUVX`). A cert that is not
  catalogued gets a 40-character hash there instead, which the upstream
  rejects — that case needs its own answer.
- Run it as: Actions → Price API check → Run workflow, branch
  `claude/determined-gates-pl6w4q`, `probes: prices,depth`.

Then the fork:

- **If it returns full history** → one month of Parse's Hobby tier ($30, 1,000
  credits, from the 402 body) backfills every card once. Because refreshes now
  merge rather than overwrite, that is a **one-time** spend: afterwards the
  1-credit bulk search keeps the record current for ~3 credits a month. Build
  the backfill and an export before spending, so a paid backfill cannot be lost
  to a cleared IndexedDB.
- **If it caps too** → build the paste importer (below) for whatever cards the
  history-gaps panel says actually need it.

### What the owner actually asked for, and what is still owed

"I just want the numbers to be accurate." Two separate failures stand between
the app and that, and Data & settings now names them per card
(`historygaps.ts`): a **thin** record is fixed once by getting history in; an
**outpaced** card loses sales permanently between refreshes and is fixed only
by refreshing more often. Start any future session by reading that panel — it
turns "all 32 watchlist cards" into a short ordered list, and it may say the
job is five cards.

Designed and agreed, not built:

- **A paste importer.** A box that takes messy pasted text — a sales table
  copied off a screen — parses dates and prices out of it, shows what it read,
  and lets it be corrected before it commits. Per card or in a batch. This is
  the zero-credit route to correct numbers and it works today.
- **A backfill + export path**, so deep history once fetched is written to a
  file rather than living only in IndexedDB.

### Where the data can and cannot come from

- **Card Ladder has no public API.** They offer enterprise access to dealers.
- **Their Terms of Use prohibit** using "any robot, spider... to retrieve,
  index, 'scrape,' 'data mine'... without Company's express prior written
  consent", and they may terminate a paid account without refund for it. A
  Playwright scraper against the owner's own Pro login is not a workaround; it
  risks the subscription. **Do not build one.** The clause names consent as the
  mechanism — a paying subscriber asking them directly is the legitimate route
  and has not been tried.
- **Unexplored and legitimate:** eBay has an official API with sold-item data,
  and most of what Card Ladder aggregates is eBay completed listings. PSA has
  an API for cert lookup and population. Population is the one genuinely
  exogenous signal the model still lacks.
- **Eleven of the thirteen Parse endpoints have never been called.**
  `get_index_history` and `list_indices` would give a real market index where
  `buildRepeatSalesIndex` currently builds one from the owner's own cards;
  `get_pokemon_set_psa_prices` may price a whole set at once.

### Still outstanding from earlier

- **Rotate the Parse key** — it was exposed in chat in an earlier session and
  has not been rotated.
- ~60 slabs remain unpriced. Press **Retry the N still missing** once the
  allowance is back.
- Holdings are stored exactly as they were parsed. An importer fix reaches a
  sheet only when it is uploaded again, so a column that now maps correctly
  will still read as it did until then.
- `.github/workflows/browser-check.yml` drives the built app in a real browser
  against the live API and reports what reached storage and what drew on the
  page. Several bugs have looked like API failures and were not; that check is
  what tells them apart.
