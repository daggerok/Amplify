# ETF Watchlist UI contract

The provider applications share this interaction contract so users do not need to learn a different workflow for each data source. This document is the binding contract for the Amplify app (`index.html` + `api/data.json`); sibling repos apply the same rules to their own file layouts, tab names, identifiers, and payload schemas.

## Catalog

- Search placeholder: `Search ETFs, fund names, holdings, tickers, CUSIPs...`
- Opening the application starts with no funds selected. The user explicitly chooses funds for comparison.
- `All ETFs` and category tabs filter the catalog; they do not change the saved selection.
- Catalog columns use the common order documented in the README and preserve unavailable provider metrics as `—`.

## Sort persistence

- Every tab remembers its own last **explicitly selected** column and direction.
- The sort is recorded only when the user clicks a column header, per tab, and persisted in browser `localStorage` under this repo's prefix: **`amplify-tab-sorts`** (JSON: `{ "<tab>": { "key", "dir" } }`, e.g. `{"All": {"key":"ytdReturn","dir":"desc"}}`).
- The remembered sort is restored whenever the tab is reopened **and after a full page reload**. A tab that was never explicitly sorted keeps its existing default sort (e.g. `rank asc` for the catalog, `weightSum desc` for Watchlist).
- No button or checkbox resets sorting: row Use checkboxes, the header Use select-all, the All ETFs pill checkbox, tab buttons, search, Copy Tickers, CSV/TXT export, theme toggle, blacklist actions, and **Clear**.
- **Clear removes selection and searches only.** It must not delete or reset remembered sorts.
- Malformed `localStorage` entries are sanitized on restore: only a non-empty string `key` and `dir` of `asc`/`desc` are accepted; a stale key that no longer matches a column is a stable no-op (rows keep their order) and can never break rendering.
- Invalid-tab fallbacks (e.g. the Watchlist/detail tabs disappear when the selection is cleared) restore the *remembered* sort of the fallback tab — never an unconditional default reset.

## Selection scopes

Selection is persisted per provider in `localStorage` (`amplify-selected-etfs`). There are three separate selection operations:

1. **Row Use checkbox** — toggles exactly one ETF.
2. **Use checkbox in the table header** — operates **only on the rows currently rendered** by the catalog table: current catalog/category tab + active search filter + blacklist exclusion. Checking selects exactly those visible rows; unchecking deselects exactly those visible rows and leaves selections hidden by another filter untouched. The checkbox is checked iff **every** visible row is selected (computed with `.every`, never a `selected.size === candidates.length` comparison, because unrelated selections may exist outside the current scope).
3. **Checkbox inside the All ETFs pill** — always operates on **every non-blacklisted ETF in the entire catalog**, while any category, detail, Holdings, or Watchlist tab is active and while any search filter is active. Checking selects the whole catalog; unchecking clears the whole catalog selection. Clicking it toggles selection only and never navigates to All ETFs. Its checked state is computed with `.every` over all non-blacklisted catalog funds (candidates come directly from the catalog minus the blacklist — never from a category-scoped helper).

## Selection reactivity

After **every** selection writer — row toggle, filtered header select-all, All ETFs pill, blacklist removal from selection, Clear, and `localStorage` restore — the UI updates immediately:

- selected ETF count;
- clickable selected ticker badges in the subtitle (clicking a badge activates that fund and opens its detail view);
- active fund ticker and the selected detail-tabs panel visibility;
- Overview/Holdings/Performance/Allocations/Distributions/Yields/Price counts;
- Watchlist tab visibility and count;
- persisted `amplify-selected-etfs` and `amplify-active-fund` values.

Clicking a **catalog ticker**, a **selected ticker badge**, or an **ETF badge in the Watchlist** activates that fund and opens/loads its detail view (selecting it first if needed).

On reload, the selection and the active fund (if still selected, otherwise a selected fallback) are restored and the Watchlist is rebuilt from the restored selection without any user interaction.

## Watchlist aggregation

- The Watchlist tab aggregates the underlying holdings of every selected ETF. The tab count is the number of **deduplicated holding rows**, not the number of selected ETFs.
- Deduplication uses this fallback order, adapted to this provider's payload: **Ticker/Symbol → CUSIP → published security name**. (The Amplify feed publishes `symbol`, `rawSymbol`, `cusip`, and `name` per position; it does not publish ISIN/SEDOL/FIGI per position, so the chain ends at the name for legitimate cash, futures, swaps, or derivatives that genuinely have no identifier.)
- Blank values, `-`, `—`, `N/A`, and similar placeholders are treated as missing. A literal `-` Ticker never prevents fallback to a valid identifier.
- Positions are **not** dropped by flag: cash, options, derivatives, treasuries, foreign-suffix tickers, and zero-weight rows with otherwise valid provider data are all retained (their nature is visible through the `Flags` column). Only a position with no usable ticker, identifier, or name is omitted.
- Columns: Ticker (security key), Name, ETFs (badge per selected ETF holding the ticker), # ETFs, Weight Sum (%), Max Weight (%), Market Value ($), Flags, Identifier (the first real identifier merged into the row — CUSIP in this feed; also the dedup key when no exchange ticker is published).
- Deselecting ETFs immediately removes their positions and recalculates the Watchlist count, Weight Sum, Max Weight, ETF badges, # ETFs, and Market Value. Because holdings overlap, deselecting one ETF does not guarantee every count decreases, but all values exactly reflect the remaining selection.

## Watchlist data states and loading

- This provider embeds all holdings in the single static `api/data.json` (there is no per-fund `meta.json`/page fetching and therefore no in-flight page race). The Watchlist aggregation is therefore always complete and synchronous once the feed is loaded — the tab count is always exact; a `Loading…`/`N+` state is only ever needed for a provider with asynchronous per-fund loaders.
- If a search matches no Watchlist rows, a search-specific empty state is shown.
- Only when loading has completed and no selected fund has usable holdings may the app show: “Holdings data is not available yet for the selected ETFs. Run the data refresh workflow (`./scripts/update-data.ts`) to regenerate `api/data.json`.”

## Large Watchlist rendering

- Large all-catalog Watchlists are rendered in **500-row scroll chunks**: the first chunk renders immediately and a “Showing X of Y holdings — scroll or click to load more…” sentinel loads the next chunk (scroll or click; idempotent, no duplicate work).
- Tab counts, status text, **Copy Tickers**, and CSV/TXT exports always operate on the **complete filtered result**, never just the rendered chunk.

## Detail views and data states

- Clicking a selected fund loads that fund's actual detail data; the rendered headers and row keys must agree with the feed.
- Holdings shows real rows when the feed has them; Performance/Overview/Allocations/Yields/Price show their published rows; Distributions show rows when present (the feed uses the distribution's `exDate` as the ex-date).
- Switching funds or tabs replaces the table atomically — the previous fund's rows are never left visible.
- Missing datasets produce a provider-specific explanatory state (“… data is not available yet for TICKER. Run the data refresh workflow (`./scripts/update-data.ts`) …”), and a search that matches nothing says so (“No … rows match your search.”). Feed load failure produces a failure state, never “no search matches”.
- Each fund detail view identifies the source provider and URL, the holdings/return as-of dates, and known freshness or coverage limitations. The UI distinguishes loading, unavailable, and not-applicable values; an em dash must not imply that a request is still loading.

## Sticky columns

During horizontal table scrolling:

- the catalog **Use** header/body cells stay pinned at the left edge, and the catalog **Ticker** header/body cells stay pinned immediately after Use;
- the **Watchlist Ticker** header/body cells stay pinned at the left edge;
- the `#` index column is not pinned — it scrolls away with the rest of the row;
- sticky positioning is applied **directly to each `th`/`td`** via dedicated classes (`.catalog-sticky-use`, `.catalog-sticky-ticker`, `.watchlist-sticky-ticker`), never to a nested span, and scoped to those classes only (the same `<table>` skeleton renders every tab with different columns);
- pinned cells use opaque light/dark backgrounds (default/hover/selected) and correct z-index so scrolled text cannot bleed through; the right edge of the last pinned column carries a soft shadow.

## Accessibility baseline

Interactive controls should have an accessible name, active tabs should expose `aria-selected`, sortable headers should expose `aria-sort`, and loading/error status changes should be announced to assistive technology. Keyboard focus and reduced-motion preferences must remain visible/respected.
