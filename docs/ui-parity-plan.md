# Amplify — UI parity plan

Full rationale, pitfall catalog, and cross-repo context: read
`/tmp/etf-ui-parity-plan.md` (master plan) in full before starting, especially
its §1.1 ("Amplify specifically") and §2-§4 (the sticky-column saga). This
document is the Amplify-specific action list; it does not repeat the master
plan's reasoning, only what to do here.

## 0. Branch situation — read this first

This repo currently has branch `arena/01a0b323-amplify` (one commit ahead of
`main`: `7211978` "fix: complete the ETF UI contract — sort memory, selection
scopes, reactive Watchlist, sticky columns", co-authored by a different
automated agent). That commit already implements most of §2/§3 below, with
two known bugs. **Fix this branch forward and merge it to `main` — do not
reimplement its scope from scratch.** Everything below assumes you're working
on top of `arena/01a0b323-amplify` (or `main` after it's merged).

## 1. Sticky-column color fixes (already implemented, wrong colors)

`index.html` already has `.catalog-sticky-col` / `.catalog-sticky-use` /
`.catalog-sticky-ticker` (catalog Use+Ticker pin) AND `.watchlist-sticky-ticker`
(Watchlist Ticker pin) — both with the same two bugs:

1. **Sticky header cells have no explicit background.** Find:
   ```css
   #table-scroll thead .catalog-sticky-col{top:0;z-index:30}
   ...
   #table-scroll thead .watchlist-sticky-ticker{top:0;z-index:30}
   ```
   Change to:
   ```css
   #table-scroll thead .catalog-sticky-col{top:0;z-index:30;background:#f8fafc}
   ...
   #table-scroll thead .watchlist-sticky-ticker{top:0;z-index:30;background:#f8fafc}
   ```
   And add dark-mode header rules (currently absent entirely):
   ```css
   .dark #table-scroll thead .catalog-sticky-col,.dark #table-scroll thead .watchlist-sticky-ticker{background:#0f172a}
   ```

2. **Dark-mode base/hover/selected colors are flat, unblended Tailwind
   tokens instead of the real composited color.** Find:
   ```css
   .dark #table-scroll .catalog-sticky-col{background:#1e293b}
   .dark #table-scroll .watchlist-sticky-ticker{background:#1e293b}
   ...
   .dark #table-scroll tbody tr:hover .catalog-sticky-col{background:#243043}
   .dark #table-scroll tbody tr:hover .watchlist-sticky-ticker{background:#243043}
   .dark #table-scroll tbody tr.selected-row .catalog-sticky-col{background:#1e2e55}
   ```
   Replace the hex values with the pre-blended equivalents (Amplify uses the
   same page/card/hover/selected Tailwind stack as WisdomTree/SPDR/Vanguard —
   `dark:bg-slate-900` page, `dark:bg-slate-800/50` table card,
   `dark:hover:bg-slate-700/30` row hover, `.dark .selected-row{background:rgba(30,64,175,.22)}`
   — verify this against Amplify's actual `<body>`/table-card classes before
   pasting, per master plan §4.3, but it was already confirmed to match):
   - `#1e293b` → **`#172033`** (base)
   - `#243043` → **`#1f2a3d`** (hover)
   - `#1e2e55` → **`#19274e`** (selected)

Do not touch the light-mode colors (`#fff`/`#f8fafc`/`#eff6ff`) — those are
already correct and opaque.

## 2. Fix the broken test harness before trusting anything else

`bun test` currently fails 34/35 with `TypeError: window.eval is not a
function` inside `scripts/ui-contract.test.ts`'s `boot()` helper (`window.eval(APP_JS)`),
using `happy-dom@20.14.5` under Bun 1.3.11. Investigate whether this is a
Bun/happy-dom incompatibility (Bun's `bun test` runtime may not fully support
whatever `window.eval` needs) and find a real fix — e.g. evaluating `APP_JS`
via Node's `vm` module against the happy-dom window's globals instead of
`window.eval`, or checking if a different happy-dom API does this. Do not
weaken or delete tests to force a pass. Get the existing 35 tests green
before relying on them to verify anything else in this plan.

## 3. Verify the branch's other claimed work, don't just trust the commit message

Commit `7211978`'s message claims: per-tab sort memory (`amplify-tab-sorts`,
confirmed present — `state.sortByTab`, `TAB_SORTS_KEY`), scoped select-alls,
reactive Watchlist with dedup fallback + placeholder handling, chunked
Watchlist rendering (500-row chunks), and distinguishing "no search matches"
from "data not available" empty states. Read the actual diff (`git show
7211978`) against master plan §5.4-§5.8 and confirm each claim holds — do not
assume correctness from the commit message alone. Fix anything that doesn't
match the spec there (selection-scope semantics in particular: row checkbox
vs. catalog-header select-all vs. "All ETFs" pill are three distinct scopes,
see master plan §5.4).

## 4. Still fully missing — implement fresh

- **§3 (master plan) Frequency catalog column.** Amplify's data is
  Firestore-backed with a `distributions` subcollection that has **no raw
  frequency field** — per master plan §3, this means the frequency code must
  be *derived* in `scripts/update-data.ts` from the raw per-event distribution
  history (e.g. inferred from the typical interval between distribution
  dates) and published as a new feed field, not read from an existing raw
  cadence string like the other repos can. Use the coded-label scheme from
  master plan §3 (`00 - —`, `01 - Monthly`, `04 - Quarterly`,
  `06 - Semi-annually`, `12 - Annually`, `99 - Irregular`) so plain string
  sort works. New column goes between SEC Yield and YTD Return, catalog table
  only. Update `COLUMN_TOOLTIPS`, the empty-state `colspan`, and CSV/TXT
  export parity.
- **Per-tab filter/search persistence.** Amplify still uses a single global
  `SEARCHES_KEY` (`state.searches`, one shared blob) — grep for `SEARCHES_KEY`
  and `state.searches` in `index.html` to find every read/write site. Replace
  with the per-tab scheme from master plan §5.1/§5.2: a `amplify-tab-filters`
  JSON map (`tabId -> query`), saved when leaving a tab / loaded when
  entering one, migrated once from the old `SEARCHES_KEY` blob at boot. Add
  the `#search-clear-btn` behavior (hidden when empty, clears only the active
  tab's query) if not already present.
- **Blacklist panel smooth expand/collapse.** Grep for the blacklist button's
  click handler (`classList.toggle('hidden')` on the blacklist panel element)
  and its CSS. Apply the exact pattern from master plan §6: CSS max-height/
  opacity/transform/padding/border-color transition (`.32s`/`.22s` ease,
  respecting `prefers-reduced-motion`), remove the `hidden` utility class from
  the panel's markup, change its `p-4` to `px-4`, swap the JS toggle to
  `classList.toggle('is-visible')` plus a `syncBlacklistPanelHeight()` helper
  that sets `style.maxHeight` from `scrollHeight` (called at the end of
  whatever function re-renders the blacklist chips, so it also resizes
  smoothly as chips are added/removed while open).

## 5. Sequencing

1. Fix the test harness (§2) first — you need working tests to verify
   everything else.
2. Fix the sticky-column colors (§1) — small, mechanical, verify visually
   (scroll fully right, both themes, per master plan §4.5).
3. Verify §3's claims (§3 above) and fix anything wrong.
4. Merge `arena/01a0b323-amplify` → `main` once 1-3 are done and green.
5. On `main`: add the Frequency column, per-tab filters, and blacklist
   animation (§4 above), in that order (frequency column first since it
   shifts other column indices).

## 6. Verification checklist

- `bun test` green (all 35+ tests).
- `bun run typecheck` (if present) clean.
- Real/headless browser: scroll catalog and Watchlist tables fully right in
  both light and dark theme — pinned columns stay opaque, no scrolled-behind
  text bleeds through, header cell color matches the rest of the header row.
- Switch tabs with different search queries per tab, reload, confirm each
  tab's query is independently remembered.
- Sort a few different tabs, reload, confirm each tab's sort is independently
  remembered and no other control (Clear, blacklist, exports) resets it.
- Open/close the Blacklist panel — animates smoothly, not instant; add/remove
  a blacklisted ticker while open — panel resizes smoothly.
