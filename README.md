# Amplify

One of the app's features lets you select Amplify ETFs in the Watchlist and aggregate their holdings to see how often each ticker appears across the selected funds. Repeated holdings make overlapping exposure visible: the more selected funds include a ticker, the greater its potential influence on the portfolio; gains in that holding may help, while declines may hurt, and actual impact also depends on each fund's position size.  Another feature makes it faster and easier to find funds with stronger growth over different periods, higher dividend yields or distributions, greater Total Return (price performance plus dividends), and other key performance metrics. A single-file client-side tool that reads the generated `./api/amplify` static feed (Amplify's public Firestore data feed for the catalog, holdings, NAV, yields and official performance, with SEC EDGAR N-PORT-P as a holdings fallback and Yahoo Finance daily prices/history/dividends) into a searchable ETF/category catalog with per-fund tabs, watchlist aggregation, ticker copy and CSV/TXT export - the same look, feel, columns and business logic as the sibling applications.

## Using Bun

```bash
bunx degit daggerok/Amplify#main ./12345 && cd $_
bunx serve . -p 1234
open http://0:1234
```

The published application is available at <https://daggerok.github.io/Amplify/>.

### Column types and filters

Every column of the ETF catalog and of the Watchlist, Holdings, History and Distributions tabs has a type: text (`ABC`), number (`123`), percentage (`%`), money (`$`), date (`D`), date and time (`DT`) or time of day (`T`). The type is detected from the texts the column shows (80% of the filled cells must agree, otherwise text) and is written in the badge next to the column title: click it to cycle the type, Shift+click to return to auto-detection. Dates are read as `2024-06-15`, `6/15/2024`, `15.06.2024`, `Jun 15, 2024` or `15-Jun-2024`, date and time as `2024-06-15T09:30:00Z` or `2024-06-15 09:30`, time as `09:30`, `16:00:00` or `9:30 PM`

A row of filter inputs sits under the column headers (the `Filters` button hides it, `Clear filters` empties it). Filters of different columns are combined with AND, the search box applies on top, and Copy Tickers and the exports use the filtered rows. Filters and type overrides are remembered in the browser. `Sticky #` (next to `Filters`, off by default, remembered in the browser) numbers the rows by their rank in the table sorted by the current column before the column filters, so a filtered fund keeps its rank and the numbers keep gaps; the sort, the search and the category and blacklist choices rank again. The catalog starts sorted by Net Assets, largest first, unavailable values sort last in both directions, and every export starts with the `#` column. The red `Clear` button forgets everything saved in the browser without asking, except the blacklist and the theme, so the page looks like a first visit (also after a reload)

Inside one filter: a space means AND, a comma means OR, a leading `!` means NOT, `?` matches an empty or unavailable value and `!?` a value that is there; a value that is unavailable matches only `?` and negated conditions. An unquoted space ends the value, so quote values that contain one (`>="2024-06-15 09:30"`)

| Type | Examples |
| --- | --- |
| Text | `bank` contains, `"two words"`, `!bank`, `=exact`, `^starts`, `ends$`, `/regex/`, `tech, health` |
| Number, percentage, money | `>10`, `>=10 <50`, `=22` (matches what rounds to 22), `!=22`, `10..50`, `..50`, `10..`, `>1B` and `K` `M` `B` `T` suffixes, an optional `$` or `%` |
| Date, date and time | `>2024-06-01`, `2024` (the whole year), `2024-06` (the whole month), `2024-01..2024-06`, `today`, `yesterday`, `-7d..` (the last 7 days), `+2w`, `-3m`, `-1y` |
| Time | `>09:30`, `09:30..16:00`, `=12:00` (the whole minute) |

The `Columns` menu next to `Filters` lists every column of the ETF table from the first to the last, all of them shown by default, with a search box and the `All`, `Clear`, `Toggle` and `Reset` buttons. `Use` and `Ticker` are listed but locked. Hiding a column only removes it from the table: the filters, the sorting, the exports and Copy Tickers still use it. The choice is remembered in the browser (localStorage, never the data) and the menu is shown on the ETF catalog only

The asset classes are one `Asset classes` multi-select next to the `All ETFs` pill instead of one tab per class: every class is selected by default (= all ETFs), `Only` or unchecking narrows the table, and the `All ETFs` pill is lit only while nothing narrows it (all or none of the classes checked); clicking the pill clears the selection. The choice is remembered in the browser (localStorage, never the data)

## Updating the static Amplify data

```bash
bun install --frozen-lockfile
./scripts/update-data.ts
```

Defaults for every control live in `scripts/update-data.config.json` (flat object, all values strings). Run `./scripts/update-data.ts -h` (or `--help`) to print every control with usage examples. Environment variables override the file (an explicitly set variable wins even when empty and clears the control), and an `AMPLIFY_` prefixed name wins over the plain one.

The **Update Amplify ETF data** GitHub Actions workflow runs weekly and on demand. Precedence: file defaults < `advanced` JSON < nonblank inputs < protected Actions variable/env. A blank input inherits the file value, and `advanced` accepts any control from the table below as a JSON object of scalars. The workflow and the CLI share the same `resolveControls` function, and the output is always `api/amplify`: `index.json` (catalog, counts, per-fund metrics), `funds/<TICKER>/meta.json` and the paginated `funds/<TICKER>/holdings/NNN.json` and `funds/<TICKER>/history/NNN.json` pages, the same layout as every sibling feed. A fund that is not refreshed keeps its published files; a full unfiltered pass also removes funds the provider no longer lists at all (see Metrics and caveats). All supplied filters use **AND** logic

### Data sources

| Block | Source |
| --- | --- |
| Catalog (active Amplify ETFs) | Firestore project `amplify-etfs-data-feed` (`fund_category` collection) behind <https://amplifyetfs.com/> |
| Fund facts, daily NAV, market price, net assets, premium/discount, yields, month-end/quarter-end NAV returns | Per-fund Firestore documents of the same project (`fund_metadata`, `daily`, `yields`, `performance_monthly`, `performance_quarterly`) |
| Holdings per fund | The latest Firestore `holdings` document; SEC EDGAR Form N-PORT-P (resolved through the SEC fund ticker table, exact series match) when Firestore has none (`EDGAR_FALLBACK`); the previously published sheet as the last resort |
| Daily history, dividends | Yahoo Finance chart prices, adjusted closes and dividend events (`SKIP_YAHOO`, `HISTORY_RANGE`) |
| Previously published data | `api/amplify`, merged with fresh history; a fund whose source fails is kept exactly as published |

The Firestore `distributions` and `history` collections answer `403 Missing or insufficient permissions` to the public key, so distributions come from Yahoo dividend events (the Firestore rows would win for the same ex-date if access ever opens) and the price history comes from Yahoo. International partner funds listed by Amplify (K-DIVO, K-QDVO, HK-BLOK) publish only net assets in Firestore and have no Yahoo or SEC data, so their holdings, history, prices and returns stay empty; they carry `status: "aum-only"` and a Yahoo "symbol not found" is treated as an honest absence, not a failure.

### Metrics and caveats

- Each fund carries a derived `metrics` object in `index.json` that powers the catalog columns: `ytd`, `tr1y`, `cagr3y`/`cagr5y`/`cagr10y`, `tr3y`/`tr5y`/`tr10y` as `(1 + CAGR)^n - 1`, `siAnn`, `secYield` and `dividendYield`, plus the mandatory `returnsBasis` (non-empty text, same as `returns.derivedFrom`: official NAV or Yahoo derived) and `performanceAsOf` (ISO date the returns are as of: the official table date, or the last Yahoo close for Yahoo-derived returns, never the NAV date; `null` only when unknown), both always last in the object
- Returns are the official Amplify NAV month-end/quarter-end figures (YTD and 1Y are period returns, 3Y, 5Y, 10Y and since inception are annualized); only missing metrics are derived from Yahoo adjusted closes at the same reporting date and the `derivedFrom` label says which basis applies. A range-limited `HISTORY_RANGE` never produces a since-inception figure
- The history series is Yahoo daily market price (close and adjusted close), not official NAV
- `dividendYield` is the trailing distribution yield published by Amplify (a published `0.00%` stays an official zero: AHBM, AWAY, BNAV, CNBS, ROBX, STBQ, TKNQ, XQBT and XWNG publish exactly that); when Amplify publishes none it is the trailing 12 months of Yahoo distributions over the market price, `null` with under 12 months of history. `secYield` is the published 30-day SEC yield
- `dividendYieldBasis` (in `metrics`, right after `dividendYieldText`) is a short code for the definition behind `dividendYield`, `null` exactly when `dividendYield` is `null`; the code always travels with the yield it describes, and rows retained from earlier runs get it from the published `yields.dividendYieldKind`:

  | Code | Amplify meaning |
  | --- | --- |
  | `official-trailing-12m` | the trailing distribution yield published by Amplify (Firestore `yields`), including a published `0.00%` |
  | `computed-trailing-12m` | trailing 12 months of Yahoo distributions over the market price (Amplify publishes none) |
  | `indicated` | only for a retained row whose published kind text is not recognized; the updater itself does not estimate |
  | `official-distribution-rate`, `official-other` | allowed by the shared standard, not used by Amplify |

- `PERFORMANCE_*` filters compare YTD and 1Y returns and the 3Y, 5Y and 10Y annualized (CAGR) values; `TOTAL_RETURN_*` filters compare YTD and 1Y as published and 3Y, 5Y and 10Y as `(1 + CAGR)^n - 1`
- `AUM` compares against the latest daily net assets; the `nano`, `micro`, `small`, `mid` and `large` presets use upper bounds that are exclusive; `TER` compares the published expense ratio in %. Amplify publishes a single figure: it is the net ratio (`terValue`, `expenseRatio.net`), and `terGrossValue` / `expenseRatio.gross` stay `null` because no gross figure is published
- A configured filter skips funds that do not publish the metric: unavailable is never treated as 0, and no value is ever invented as zero (missing weights, market values and prices stay empty or `null`)
- `siAnn` is `null` for a fund under one year old at the as-of date, and the percent figures are published as percent: nothing is rescaled (`0.5` means 0.5%)
- **Fund-level consistency:** a fund is either fully updated or fully kept as published. If any source of a fund fails (Firestore document, Yahoo, SEC; HTTP errors and timeouts, not "document not found") the fund's files and index row stay byte-for-byte as published (`kept` in the run output), and a fund that was never published is not published half-way. The workflow commits after a partial run, which is safe because no fund is ever half-updated. An honest empty answer (missing document, empty collection, no performance table) is a `null`, never a reason to copy an old value, and the returns, `returnsBasis` and `performanceAsOf` always belong together
- **Status:** each row and `meta.json` carry `status`: `active`, `pre-launch` (placeholder or future-dated daily document, e.g. CPU: NAV, price, net assets and a future inception date are not published, the expected date is kept as `inception.expectedInceptionDate`), `delisted` (`DelistDate` reached, e.g. SMAP: values are the last official ones) or `aum-only`
- A SEC N-PORT filing replaces published holdings only when its report date is newer; SEC requests share one paced gate (at least 150 ms between starts) and a 403 or 429 from SEC is retried; every request has a 45 s timeout that also covers the body
- **Exit code and deadline:** non-zero when any fund fails or when every examined fund was kept because a source failed. The run stops taking new funds after 25 minutes (workflow limit: 30) and still writes the index; the cursor does not move then
- `NEW FUNDS: A, B` (tickers new in the active catalog) and `DROPPED FUNDS: A` are printed and appended to the Actions step summary
- With no filters the full active catalog is refreshed. Funds the provider still lists but marks inactive or with category `Unknown` are not refreshed and not removed; only funds absent from `fund_category` are purged, at most max(3, 10% of the published funds) per run (a larger drop is refused and reported)
- With no filters the full active catalog is rebuilt

### Update controls

| Control | Default | Meaning |
| --- | --: | --- |
| `MAX_FETCHES` | `0` | `0` means all selected funds and removes the cursor; a positive value is a resumable batch: N funds that pass the filters, in ticker order after the cursor (`api/amplify/update-state.json`), wrapping around; the cursor does not move when the batch has failures. A `TICKERS` run never reads, moves or deletes it |
| `REQUEST_SLEEP` | `0` | Minimum seconds between request starts of each worker lane (N workers give about N times the throughput), retries included |
| `CONCURRENCY` | `6` | Funds fetched in parallel, one request in flight per worker for Firestore, Yahoo and SEC alike, so peak in-flight requests equal CONCURRENCY (legacy alias `AMPLIFY_DATA_CONCURRENCY`) |
| `TICKERS` | all | Space-, comma- or semicolon-separated ticker allowlist, e.g. `DIVO IDVO SILJ BLOK`; a ticker that is not an active fund in the catalog is an error |
| `CATEGORY` | all | Fund categories to include, comma-separated (`Income`, `Thematic`, `Core`, `International`) |
| `AUM` | `:` | Net Assets range `min:max`. Each bound may be a USD amount or `K`/`M`/`B`/`T`, or one of `nano`, `micro`, `small`, `mid`, `large` |
| `TER` | `:` | Net expense-ratio range in % (Amplify publishes a single ratio) |
| `DIVIDEND_YIELD` | `:` | Trailing distribution yield range in %; funds without one are excluded |
| `SEC_YIELD` | `:` | 30-day SEC yield range in % |
| `HOLDINGS_PAGE_SIZE` | `250` | Holdings rows per JSON page |
| `HISTORY_PAGE_SIZE` | `1000` | Daily history rows per JSON page (alias `HISTORICAL_PAGE_SIZE`) |
| `MAX_RETRIES` | `2` | Retries (at least 1) for network errors, timeouts, HTTP 429 and 5xx (SEC: also 403); other 4xx fail immediately |
| `HISTORY_RANGE` | `max` | Yahoo daily history range: `max` or `Ny` (for example `5y`), sent as explicit `period1`/`period2`; merges with the previously published history |
| `SEC_UA` | `daggerok ETF feed daggerok@gmail.com` | SEC EDGAR contact User-Agent, redacted in logs; the Actions variable `SEC_UA` overrides it when nonblank. Do not put credentials here |
| `SKIP_YAHOO` | `false` | Skip Yahoo history and dividends; retain published data |
| `EDGAR_FALLBACK` | `true` | SEC N-PORT-P holdings fallback for funds without Firestore holdings |
| `PERFORMANCE_YTD` / `_1Y` / `_3Y` / `_5Y` / `_10Y` | `:` | Return range in % per period (3Y, 5Y and 10Y are annualized); the colon is required |
| `TOTAL_RETURN_YTD` / `_1Y` / `_3Y` / `_5Y` / `_10Y` | `:` | Cumulative total-return range in % per period; the colon is required |
| `VERBOSE` | `false` | Print per-fund retry and fallback notices (`1`, `true`, `yes`, `y`, `on` enable it) |
| `USE_SYSTEM_CA` | `auto` | TLS trust store: `auto` restarts the updater once with Bun's `--use-system-ca` when a request fails with an untrusted-certificate error; `true` always uses the system CA store; `false` never restarts. Not an individual workflow input: use `advanced`, the config file or the CLI environment. |

`TICKERS` combines with the other filters using AND logic; it does not override them. A fund filtered out keeps its published files, so a filtered run never shrinks the feed. A blank (whitespace-only) workflow input inherits the file value. `EDGAR_FALLBACK`, `SEC_UA` and `VERBOSE` are reached in the workflow through `advanced` (the workflow has 24 individual inputs plus `advanced`).

### Examples

```bash
TICKERS="DIVO IDVO SILJ BLOK" ./scripts/update-data.ts
SKIP_YAHOO=true HISTORY_RANGE=5y ./scripts/update-data.ts
MAX_FETCHES=3 REQUEST_SLEEP=0.5 MAX_RETRIES=1 ./scripts/update-data.ts
AUM="mid:" TER=":0.75" DIVIDEND_YIELD="4:" ./scripts/update-data.ts
TOTAL_RETURN_1Y="15:" ./scripts/update-data.ts
```

## TypeScript and verification

The browser app is intentionally build-free: `index.html` carries the markup, styles and bootstrap, and `app.tsx` is TypeScript compiled in the browser with Babel standalone - no build step, no bundler, no `tsconfig.json` needed. Bun runs TypeScript out of the box.

Verification before every publish:

```bash
bun install --frozen-lockfile
bun test
bun build --target=bun scripts/update-data.ts --outfile=/dev/null
git diff --check
```

`bun test` (`scripts/update-data.test.ts`) also covers the resolver, parsers, request retries, and README, config file, `--help` and workflow parity.

## Brands table

| Brand | Where to get the data |
| --- | --- |
| **AAM** | [aamlive.com](https://www.aamlive.com/ETF) \| [AAM](https://daggerok.github.io/AAM/) |
| **abrdn (Aberdeen)** | [aberdeeninvestments.com](https://www.aberdeeninvestments.com/en-us/investor/funds/etfs) \| [aberdeen](https://daggerok.github.io/aberdeen/) |
| **Amplify** | [amplifyetfs.com](https://amplifyetfs.com/) \| [Amplify](https://daggerok.github.io/Amplify/) |
| **ARK Invest** | [ark-funds.com](https://www.ark-funds.com/our-etfs/) \| [ARK](https://daggerok.github.io/ARK/) |
| **Capital Group** | [capitalgroup.com](https://www.capitalgroup.com/advisor/investments/exchange-traded-funds.html) \| [Capital-Group](https://daggerok.github.io/Capital-Group/) |
| **Fidelity** | [fidelity.com](https://www.fidelity.com/etfs) \| [Fidelity](https://daggerok.github.io/Fidelity/) |
| **First Trust** | [ftportfolios.com](https://www.ftportfolios.com/Retail/etf/etflist.aspx) \| [First-Trust](https://daggerok.github.io/First-Trust/) |
| **Franklin Templeton** | [franklintempleton.com](https://www.franklintempleton.com/investments/options/exchange-traded-funds) \| [Franklin](https://daggerok.github.io/Franklin/) |
| **Global X** | [globalxetfs.com/explore](https://www.globalxetfs.com/explore) \| [Global-X](https://daggerok.github.io/Global-X/) |
| **Goldman Sachs** | [am.gs.com](https://am.gs.com/en-us/individual/funds?locale=en-us&audience=individual&sf=funds&filters=funds%7CETF&limit=100) \| [Goldman-Sachs](https://daggerok.github.io/Goldman-Sachs/) |
| **Invesco** | [invesco.com](https://www.invesco.com/us/en/financial-products/etfs.html) \| [Invesco](https://daggerok.github.io/Invesco/) |
| **iShares** | [ishares.com](https://www.ishares.com/) \| [iShares](https://daggerok.github.io/iShares/) |
| **JPMorgan** | [am.jpmorgan.com](https://am.jpmorgan.com/us/en/asset-management/adv/products/fund-explorer/etf) \| [JPMorgan](https://daggerok.github.io/JPMorgan/) |
| **NEOS** | [neosfunds.com](https://neosfunds.com/#explore-etfs) \| [Neos](https://daggerok.github.io/Neos/) |
| **Northern Trust** | [etfs.ntam.northerntrust.com](https://etfs.ntam.northerntrust.com/us/en/individual/funds) \| [Northern-Trust](https://daggerok.github.io/Northern-Trust/) |
| **Pacer ETFs** | [paceretfs.com](https://www.paceretfs.com/products/) \| [Pacer](https://daggerok.github.io/Pacer/) |
| **Parametric** | [eatonvance.com](https://www.eatonvance.com/products/etfs.html) \| [Parametric](https://daggerok.github.io/Parametric/) |
| **ProShares** | [proshares.com](https://www.proshares.com/our-etfs/find-proshares-etfs) \| [ProShares](https://daggerok.github.io/ProShares/) |
| **Schwab** | [schwabassetmanagement.com](https://www.schwabassetmanagement.com/products) \| [Schwab](https://daggerok.github.io/Schwab/) |
| **SP Funds** | [sp-funds.com](https://www.sp-funds.com/) \| [SP-Funds](https://daggerok.github.io/SP-Funds/) |
| **SPDR** | [ssga.com](https://www.ssga.com/us/en/intermediary/etfs/fund-finder) \| [SPDR](https://daggerok.github.io/SPDR/) |
| **Sprott ETFs** | [sprottetfs.com](https://sprottetfs.com/) \| [Sprott](https://daggerok.github.io/Sprott/) |
| **Tema ETFs** | [temaetfs.com](https://temaetfs.com/funds) \| [Tema](https://daggerok.github.io/Tema/) |
| **Themes ETFs** | [themesetfs.com/etfs](https://themesetfs.com/etfs) \| [Themes](https://daggerok.github.io/Themes/) |
| **VanEck** | [vaneck.com](https://www.vaneck.com/us/en/etf-mutual-fund-finder/) \| [VanEck](https://daggerok.github.io/VanEck/) |
| **Vanguard** | [investor.vanguard.com](https://investor.vanguard.com/etf/list) \| [Vanguard](https://daggerok.github.io/Vanguard/) |
| **VictoryShares** | [vcm.com VictoryShares ETFs](https://www.vcm.com/products/victoryshares-etfs/victoryshares-etfs-list) \| [VictoryShares](https://daggerok.github.io/VictoryShares/) |
| **WisdomTree** | [wisdomtree.com](https://www.wisdomtree.com/investments) \| [WisdomTree](https://daggerok.github.io/WisdomTree/) |
| **Xtrackers** | [etf.dws.com](https://etf.dws.com/en-us/etf-products/) \| [Xtrackers](https://daggerok.github.io/Xtrackers/) |

## Sibling applications

| Application | Data provider | Repository |
| --- | --- | --- |
| AAM | Official AAM catalog/detail HTML + full holdings XLS + SEC N-PORT holdings fallback + Yahoo market history/dividends | [AAM](https://github.com/daggerok/AAM) |
| abrdn (Aberdeen) | Official Aberdeen gateway + SEC N-PORT holdings fallback + Yahoo history/dividends | [aberdeen](https://github.com/daggerok/aberdeen) |
| Amplify | Amplify ETFs Firestore data feed + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history/dividends | [Amplify](https://github.com/daggerok/Amplify) |
| ARK Invest | ark-funds.com fund pages + overview/NAV-history/performance JSON + official daily holdings CSV + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance distributions/history fallback | [ARK](https://github.com/daggerok/ARK) |
| Capital Group | Official Capital Group fund data + SEC N-PORT holdings fallback + Yahoo history fallback | [Capital-Group](https://github.com/daggerok/Capital-Group) |
| Fidelity | SEC EDGAR N-PORT-P + Yahoo Finance | [Fidelity](https://github.com/daggerok/Fidelity) |
| First Trust | ftportfolios.com official ETF list + fund summary, holdings, distribution and price-history export pages + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history fallback | [First-Trust](https://github.com/daggerok/First-Trust) |
| Franklin Templeton | franklintempleton.com ETF listings + product pages + SEC EDGAR N-PORT-P | [Franklin](https://github.com/daggerok/Franklin) |
| Global X | globalxetfs.com Next.js catalog and fund pages + dated full-holdings CSV | [Global-X](https://github.com/daggerok/Global-X) |
| Goldman Sachs | am.gs.com fund finder + detail pages + SEC EDGAR N-PORT-P | [Goldman-Sachs](https://github.com/daggerok/Goldman-Sachs) |
| Invesco | invesco.com fund pages and sitemap + official Invesco fund API (monthly returns, NAV, AUM, yields, daily holdings, expense ratio) + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history/dividends | [Invesco](https://github.com/daggerok/Invesco) |
| iShares | iShares (BlackRock) product workbooks | [iShares](https://github.com/daggerok/iShares) |
| JPMorgan | am.jpmorgan.com fund explorer + product-data JSON | [JPMorgan](https://github.com/daggerok/JPMorgan) |
| NEOS | neosfunds.com lineup table + official fund pages + daily holdings CSV | [Neos](https://github.com/daggerok/Neos) |
| Northern Trust | etfs.ntam.northerntrust.com funds list + per-fund CSV/JSON downloads | [Northern-Trust](https://github.com/daggerok/Northern-Trust) |
| Pacer ETFs | paceretfs.com product catalog and fund pages (Cloudflare WAF; r.jina.ai proxy fallback) + SEC EDGAR N-PORT-P (Pacer Funds Trust) + Yahoo Finance history/dividends | [Pacer](https://github.com/daggerok/Pacer) |
| Parametric | eatonvance.com ETF catalog and Parametric product pages + SEC EDGAR N-PORT-P holdings + Yahoo Finance history/dividends | [Parametric](https://github.com/daggerok/Parametric) |
| ProShares | proshares.com ETF finder + fund pages + official data host | [ProShares](https://github.com/daggerok/ProShares) |
| Schwab | schwabassetmanagement.com product pages + CSV exports | [Schwab](https://github.com/daggerok/Schwab) |
| SP Funds | sp-funds.com homepage catalog, fund pages and daily holdings CSV + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history/dividends | [SP-Funds](https://github.com/daggerok/SP-Funds) |
| SPDR | SSGA / State Street public feeds | [SPDR](https://github.com/daggerok/SPDR) |
| Sprott ETFs | sprottetfs.com fund pages + SEC EDGAR N-PORT-P (Sprott Funds Trust) + Yahoo Finance history/dividends | [Sprott](https://github.com/daggerok/Sprott) |
| Tema ETFs | Tema official fund pages + dated daily holdings CSV; SEC EDGAR N-PORT-P holdings fallback only + Yahoo Finance price/history/dividend fallback | [Tema](https://github.com/daggerok/Tema) |
| Themes ETFs | themesetfs.com catalog + daily holdings CSV + Yahoo Finance history/dividends + SEC N-PORT-P holdings fallback | [Themes](https://github.com/daggerok/Themes) |
| VanEck | vaneck.com ETF finder + product pages | [VanEck](https://github.com/daggerok/VanEck) |
| Vanguard | Vanguard product pages + SEC EDGAR N-PORT-P | [Vanguard](https://github.com/daggerok/Vanguard) |
| VictoryShares | VCM VictoryShares catalog and product JSON + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance adjusted-market-price history | [VictoryShares](https://github.com/daggerok/VictoryShares) |
| WisdomTree | WisdomTree product table + SEC EDGAR N-PORT-P + Yahoo Finance | [WisdomTree](https://github.com/daggerok/WisdomTree) |
| Xtrackers | Official DWS catalog/US sitemap + PDP/XLSX + SEC N-PORT-P holdings fallback + Yahoo Finance daily prices/history/dividends | [Xtrackers](https://github.com/daggerok/Xtrackers) |

## License

[MIT - same as all sibling ETF repositories.](./LICENSE)

Amplify ETFs™ and the fund names/tickers referenced here are trademarks of Amplify Investments LLC. This is an independent, unofficial tool; it is not affiliated with, endorsed by, or sponsored by Amplify ETFs. All data is reproduced from Amplify's own public website and data feed for research purposes. All other trademarks, including index names, are the property of their respective owners.
