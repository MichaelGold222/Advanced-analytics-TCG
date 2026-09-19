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
