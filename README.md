# Amplify

## Using bun

```bash
bunx degit daggerok/Amplify#main ./12345 && cd $_
bunx parcel ./index.html
open http://0:1234
```

## Update static data API

The app reads Amplify ETF catalog, holdings, distributions, yields, performance/total returns, allocations, and daily price metrics from `./api/data.json`.

The catalog table surfaces Dividend Yield, 30-Day SEC Yield, YTD / 1-year total return, 3Y/5Y/10Y total return and CAGR, since-inception annualized return, and daily History count from that same feed. Hover any column header for the abbreviation and a short explanation (for example **Net Assets** = AUM, Assets Under Management). The **All ETFs** tab and the **Use** header have a checkbox to select or clear every fund.

Regenerate it with bun:

```bash
bun ./scripts/update-data.ts
```

The repository also includes a manually triggered GitHub Actions workflow that refreshes `api/data.json` and commits it back to the repository.

## TypeScript

The browser app is intentionally single-file: `index.html` contains inline TypeScript compiled in the browser with Babel standalone, following the `daggerok/youtube` no-src-files approach.
