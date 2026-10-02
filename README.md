# Amplify

One of the app's features lets you select Amplify ETFs in the Watchlist and aggregate their holdings to see how often each ticker appears across the selected funds. Repeated holdings make overlapping exposure visible: the more selected funds include a ticker, the greater its potential influence on the portfolio; gains in that holding may help, while declines may hurt, and actual impact also depends on each fund's position size.  Another feature makes it faster and easier to find funds with stronger growth over different periods, higher dividend yields or distributions, greater Total Return (price performance plus dividends), and other key performance metrics. A single-file client-side tool that reads the generated `./api/data.json` static feed (Amplify's public Firestore data feed; no SEC or Yahoo Finance sources) into a searchable ETF/category catalog with per-fund tabs, watchlist aggregation, ticker copy and CSV/TXT export - the same look, feel, columns and business logic as the sibling applications.

## Using Bun

```bash
bunx degit daggerok/Amplify#main ./12345 && cd $_
bunx serve . -p 1234
open http://0:1234
```

The published application is available at <https://daggerok.github.io/Amplify/>.

## Updating the static Amplify data

```bash
bun install --frozen-lockfile
./scripts/update-data.ts
```

Defaults for every control live in `scripts/update-data.config.json` (flat object, all values strings). Run `./scripts/update-data.ts -h` (or `--help`) to print every control with usage examples. Environment variables override the file (an explicitly set variable wins even when empty and clears the control), and an `AMPLIFY_` prefixed name wins over the plain one.

The **Update Amplify ETF data** GitHub Actions workflow runs weekly and on demand. Precedence: file defaults < `advanced` JSON < nonblank inputs < protected Actions variable/env. A blank input inherits the file value, and `advanced` accepts any control from the table below as a JSON object of scalars. The workflow and the CLI share the same `resolveControls` function, and the output is always `api/data.json`. All supplied filters use **AND** logic

### Data sources

| Block | Source |
| --- | --- |
| Catalog (active US Amplify ETFs) | Firestore project `amplify-etfs-data-feed` (`fund_category` collection) behind <https://amplifyetfs.com/> |
| Fund metadata, daily NAV and net assets, yields, performance, allocations, holdings, distributions | Per-fund Firestore collections of the same project |
| Previously published data | `api/data.json`, used to keep unchanged blocks and to compute the run summary |

### Metrics and caveats

- `PERFORMANCE_*` filters use the official monthly NAV returns: YTD and 1Y are period returns, 3Y, 5Y and 10Y are annualized (CAGR)
- `TOTAL_RETURN_*` filters use cumulative total return: YTD and 1Y as published, 3Y, 5Y and 10Y as `(1 + CAGR)^n - 1`
- `DIVIDEND_YIELD` is the published trailing distribution yield and `SEC_YIELD` the 30-day SEC yield, both in %
- `AUM` compares against the latest daily net assets; the `nano`, `micro`, `small`, `mid` and `large` presets use upper bounds that are exclusive
- `TER` compares the published expense ratio in %
- `historyCount` is the number of published daily documents, not a price history; `HISTORY_RANGE`, `HOLDINGS_PAGE_SIZE`, `SEC_UA`, `SKIP_YAHOO` and `EDGAR_FALLBACK` do not exist because holdings come as one document per fund and no SEC or Yahoo source is used
- A configured filter drops funds that do not publish the metric: unavailable is never treated as 0
- Document stamps (`UpdatedAt`) refreshed by the vendor without a data change keep the previously committed block, so stamp-only refreshes do not produce a diff
- The app derives its catalog columns (YTD Return, TR 1Y/3Y/5Y/10Y, CAGR, SI Ann.) from the published performance data
- With no filters the full active catalog is rebuilt

### Update controls

| Control | Default | Meaning |
| --- | --: | --- |
| `MAX_FETCHES` | `0` | `0` means all selected funds; a positive value fetches only the first N selected tickers (alphabetical) |
| `REQUEST_SLEEP` | `0` | Minimum seconds between request starts, shared by all workers, retries included |
| `CONCURRENCY` | `6` | Parallel fund fetch workers (legacy alias `AMPLIFY_DATA_CONCURRENCY`) |
| `TICKERS` | all | Space-, comma- or semicolon-separated ticker allowlist, e.g. `DIVO IDVO SILJ BLOK` |
| `CATEGORY` | all | Fund categories to include, comma-separated (`Income`, `Thematic`, `Core`) |
| `AUM` | `:` | Net Assets range `min:max`. Each bound may be a USD amount or `K`/`M`/`B`/`T`, or one of `nano`, `micro`, `small`, `mid`, `large` |
| `TER` | `:` | Expense-ratio range in % |
| `DIVIDEND_YIELD` | `:` | Trailing distribution yield range in % |
| `SEC_YIELD` | `:` | 30-day SEC yield range in % |
| `PERFORMANCE_YTD` / `_1Y` / `_3Y` / `_5Y` / `_10Y` | `:` | NAV return range in % per period (3Y, 5Y and 10Y are annualized); the colon is required |
| `TOTAL_RETURN_YTD` / `_1Y` / `_3Y` / `_5Y` / `_10Y` | `:` | Cumulative total-return range in % per period; the colon is required |
| `HISTORY_PAGE_SIZE` | `300` | Page size of the daily-history document count query (`historyCount`) |
| `MAX_RETRIES` | `2` | Retries (at least 1) for network errors, HTTP 429 and 5xx; other 4xx fail immediately |
| `VERBOSE` | `false` | Print per-fund retry and fallback notices |

`TICKERS` combines with the other filters using AND logic; it does not override them

### Examples

```bash
TICKERS="DIVO IDVO SILJ BLOK" ./scripts/update-data.ts
MAX_FETCHES=3 REQUEST_SLEEP=0.5 MAX_RETRIES=1 ./scripts/update-data.ts
AUM="mid:" TER=":0.75" DIVIDEND_YIELD="4:" ./scripts/update-data.ts
TOTAL_RETURN_1Y="15:" ./scripts/update-data.ts
```

## TypeScript and verification

The browser app is intentionally build-free: `index.html` carries the markup, styles and TypeScript compiled in the browser - no build step, no bundler, no `tsconfig.json` needed. Bun runs TypeScript out of the box.

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
| **Pacer ETFs** | [paceretfs.com](https://www.paceretfs.com/products/) \| [Pacer](https://daggerok.github.io/Pacer/) (deployment pending) |
| **ProShares** | [proshares.com](https://www.proshares.com/our-etfs/find-proshares-etfs) \| [ProShares](https://daggerok.github.io/ProShares/) |
| **Schwab** | [schwabassetmanagement.com](https://www.schwabassetmanagement.com/products) \| [Schwab](https://daggerok.github.io/Schwab/) |
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
| Amplify | Amplify ETFs (Firestore data feed) | [Amplify](https://github.com/daggerok/Amplify) |
| ARK Invest | ark-funds.com fund pages + overview/NAV-history/performance JSON + official daily holdings CSV + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance distributions/history fallback | [ARK](https://github.com/daggerok/ARK) |
| Capital Group | Official Capital Group fund data + SEC N-PORT holdings fallback + Yahoo history fallback | [Capital-Group](https://github.com/daggerok/Capital-Group) |
| Fidelity | SEC EDGAR N-PORT-P + Yahoo Finance | [Fidelity](https://github.com/daggerok/Fidelity) |
| First Trust | ftportfolios.com official ETF list + fund summary, holdings, distribution and price-history export pages + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history fallback | [First-Trust](https://github.com/daggerok/First-Trust) |
| Franklin Templeton | franklintempleton.com ETF listings + product pages + SEC EDGAR N-PORT-P | [Franklin](https://github.com/daggerok/Franklin) |
| Global X | globalxetfs.com Next.js catalog and fund pages + dated full-holdings CSV | [Global-X](https://github.com/daggerok/Global-X) |
| Goldman Sachs | am.gs.com fund finder + detail pages + SEC EDGAR N-PORT-P | [Goldman-Sachs](https://github.com/daggerok/Goldman-Sachs) |
| Invesco | invesco.com CSV downloads + Yahoo Finance | [Invesco](https://github.com/daggerok/Invesco) |
| iShares | iShares (BlackRock) product workbooks | [iShares](https://github.com/daggerok/iShares) |
| JPMorgan | am.jpmorgan.com fund explorer + product-data JSON | [JPMorgan](https://github.com/daggerok/JPMorgan) |
| NEOS | neosfunds.com lineup table + official fund pages + daily holdings CSV | [Neos](https://github.com/daggerok/Neos) |
| Northern Trust | etfs.ntam.northerntrust.com funds list + per-fund CSV/JSON downloads | [Northern-Trust](https://github.com/daggerok/Northern-Trust) |
| Pacer ETFs | paceretfs.com product catalog and fund pages (Cloudflare WAF; r.jina.ai proxy fallback) + SEC EDGAR N-PORT-P (Pacer Funds Trust) + Yahoo Finance history/dividends | [Pacer](https://github.com/daggerok/Pacer) |
| ProShares | proshares.com ETF finder + fund pages + official data host | [ProShares](https://github.com/daggerok/ProShares) |
| Schwab | schwabassetmanagement.com product pages + CSV exports | [Schwab](https://github.com/daggerok/Schwab) |
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
