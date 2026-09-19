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
