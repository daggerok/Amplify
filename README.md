# Amplify

Single-page browser app for creating watchlists from Amplify ETF holdings.

The app is modeled after [`daggerok/iShares`](https://github.com/daggerok/iShares), but instead of uploading an iShares spreadsheet it reads Amplify ETF metadata and latest holdings from Amplify's public Firestore-backed data used by [amplifyetfs.com/our-etfs](https://amplifyetfs.com/our-etfs/).

## Features

- Browse Amplify ETFs by ticker, fund name, and fund type.
- Select one or more ETFs and load the latest holdings for each selected fund.
- Build a deduped watchlist from constituent tickers.
- Filter presets:
  - **Watchlistable default**: excludes cash, money-market rows, Treasuries/CUSIP-like identifiers, options, and derivative/futures rows.
  - **U.S. tickers only**.
  - **All except cash**.
  - **Raw holdings**.
- Search loaded holdings across symbol, name, ETF, CUSIP, and flags.
- Copy symbols as comma-separated text or one symbol per line.
- Export CSV/TXT.
- Light/dark theme and local browser persistence for selected ETFs and preferences.

## Run locally

No build step is required. Serve the file with any static web server:

```bash
python3 -m http.server 4173 --bind 0.0.0.0
open http://0.0.0.0:4173
```

## Using bun / Parcel

```bash
bunx degit daggerok/Amplify#main ./amplify && cd $_
bunx parcel ./index.html
open http://0:1234
```

## Data source

The app calls the public Firestore REST endpoints used by Amplify's own data widgets:

- `fund_category` for active ETF category data.
- `funds/{TICKER}/fund_metadata/overview` for fund names and expense ratios.
- `funds/{TICKER}/daily` for NAV and net assets.
- `funds/{TICKER}/holdings` for the latest holdings document.

An embedded fallback ETF list is included so the catalog still renders if the remote catalog request fails.

Fund holdings are subject to change at any time and should not be considered recommendations to buy or sell any security.
