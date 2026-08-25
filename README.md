# Amplify

## Using bun

```bash
bunx degit daggerok/Amplify#main ./12345 && cd $_
bunx serve . -p 1234
open http://0:1234
```

## Update static data API

The app reads Amplify ETF catalog, holdings, distributions, yields, performance/total returns, allocations, and daily price metrics from `./api/data.json`.

The catalog table surfaces Dividend Yield, 30-Day SEC Yield, YTD / 1-year total return, 3Y/5Y/10Y total return and CAGR, since-inception annualized return, and daily History count from that same feed. Hover any column header for the abbreviation and a short explanation (for example **Net Assets** = AUM, Assets Under Management). The **All ETFs** tab and the **Use** header have a checkbox to select or clear every fund.

The **Watchlist** tab aggregates the underlying holdings of every selected ETF. The **ETFs** column shows a badge per selected ETF holding the ticker, followed by the **# ETFs** count column.

Any ETF can be **blacklisted**: click the small ✕ next to a fund's Use checkbox or type tickers into the **Blacklist** panel in the toolbar. Blacklisted ETFs disappear from All ETFs (and from selection); the list is kept per browser in localStorage and can be edited or cleared in the same panel.

Regenerate it with bun:

```bash
./scripts/update-data.ts
```

The updater reads configuration from environment variables; run `./scripts/update-data.ts -h` (or `--help`) to print every variable with its default and usage examples. Filters combine with AND logic and decide which funds are included in `api/data.json`; a configured filter also drops funds that do not publish the metric. Run without filters to rebuild the full active catalog.

```bash
TOTAL_RETURN_1Y="15:" ./scripts/update-data.ts   # keep only funds with TR 1Y >= 15%
AUM="mid:" DIVIDEND_YIELD="4:" ./scripts/update-data.ts
TICKERS="DIVO" ./scripts/update-data.ts
```

Available variables: `CONCURRENCY`, `TICKERS`, `CATEGORY`, `AUM` (USD amounts or `nano/micro/small/mid/large` presets), `DIVIDEND_YIELD`, `SEC_YIELD`, `PERFORMANCE_YTD|1Y|3Y|5Y|10Y` (annualized; 3Y+ are CAGR), and `TOTAL_RETURN_YTD|1Y|3Y|5Y|10Y` (cumulative, `TR nY = (1 + CAGR)^n − 1`). Ranges use strict inclusive `min:max` syntax (`"15:"`, `":20"`, `"5:20"`); the colon is required.

The repository also includes a manually triggered GitHub Actions workflow that refreshes `api/data.json` and commits it back to the repository. The workflow exposes the same filters as manual inputs.

The vendor feed refreshes document stamps (`UpdatedAt`) on its own schedule even when a fund's data did not change. The updater compares each ticker's blocks with the stamps stripped and keeps the previously committed block on stamp-only refreshes, so `UpdatedAt` moves in `api/data.json` only together with a real data change.

## TypeScript

The browser app is intentionally single-file: `index.html` contains inline TypeScript compiled in the browser with Babel standalone, following the `daggerok/youtube` no-src-files approach.
