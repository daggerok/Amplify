# Amplify

## Using bun

```bash
bunx degit daggerok/Amplify#main ./12345 && cd $_
bunx serve . -p 1234
open http://0:1234
```

The published application is available at <https://daggerok.github.io/Amplify/>.

## Shared UI contract

The common interaction and data-state rules are documented in [`docs/ui-contract.md`](./docs/ui-contract.md). New provider-specific behavior should preserve this contract.

## Sibling applications

| Application | Data provider | Repository |
|---|---|---|
| Amplify ETF Holdings to Watchlist | Amplify ETFs (Firestore data feed) | [daggerok/Amplify](https://github.com/daggerok/Amplify) · [published app](https://daggerok.github.io/Amplify/) |
| iShares Excel .xls to Watchlist | iShares (BlackRock) product workbooks | [daggerok/iShares](https://github.com/daggerok/iShares) · [published app](https://daggerok.github.io/iShares/) |
| SPDR ETF Holdings to Watchlist | SSGA / State Street public feeds | [daggerok/SPDR](https://github.com/daggerok/SPDR) · [published app](https://daggerok.github.io/SPDR/) |

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

## Brands table

| Бренд                        | Фонды | Где брать данные |
|------------------------------|---|---|
| **SPDR / State Street** (14) ✅ | SPYM, SPYG, SPYD, SDY, XTL, XLK, XLF, XLV, XLY, XLU, XLC, XLI, XLP, XLE | [us.spdrs.com](https://us.spdrs.com/) · [каталог ssga.com](https://www.ssga.com/us/en/intermediary/etfs/fund-finder) · секторы: [selectsectorspdrs.com](https://www.selectsectorspdrs.com/) — весь каталог SSGA уже интегрирован в наше приложение [daggerok/SPDR](https://github.com/daggerok/SPDR) |
| **Invesco** (14)             | QQQM, RSP, SPLV, SPHD, SPMO, SPHQ, SPGP, RPV, RPG, RWL, DBA, IDMO, IDHQ, IDLV | [invesco.com `?ticker=`](https://www.invesco.com/us/financial-products/etfs/product-detail?ticker=IDHQ) |
| **iShares / BlackRock** (14) | IVV, SGOV, DGRO, SOXX, MTUM, DVY, HDV, IAUM, PICK (Global Metals & Mining), GARP (MSCI USA Quality GARP), SLVP (Global Silver Miners), RING (Global Gold Miners) | [www.ishares.com](https://www.ishares.com/) · XLS-экспорт holdings со страниц фондов (уже интегрирован в наше приложение, весь каталог)
| **Vanguard** (10)            | VOO, VUG, VTV, VIG, VYM, VGT, MGK, VOOG, VIGI, VYMI | [investor.vanguard.com](https://investor.vanguard.com/investment-products/etfs) → `…/profile/VOO` |
| **Fidelity** (5)             | FTEC, FDVV, FDIS, FCOM, FNILX* | [fidelity.com/etfs](https://www.fidelity.com/etfs) · [fundresearch.fidelity.com](https://fundresearch.fidelity.com/) — *FNILX вообще не ETF, а взаимный фонд ZERO |
| **Schwab** (3)               | SCHD, SCHG, SCHB | [schwabassetmanagement.com/products/schd](https://www.schwabassetmanagement.com/products/schd) |
| **VanEck** (3)               | SMH, GDX, GDXJ | [vaneck.com/etf/smh/](https://www.vaneck.com/etf/smh/) |
| **Amplify** (3)              | DIVO, IDVO (CWP Intl Enhanced Dividend), SILJ (Junior Silver Miners, экс-ETFMG) | [amplifyetfs.com](https://amplifyetfs.com/) · Firestore-фид данных (уже интегрирован в наше приложение)
| **JPMorgan** (2)             | JEPI, JEPQ | [JEPI](https://am.jpmorgan.com/us/en/asset-management/adv/products/jpmorgan-equity-premium-income-etf-etf-shares-46641q332) · [JEPQ](https://am.jpmorgan.com/us/en/asset-management/adv/products/jpmorgan-nasdaq-equity-premium-income-etf-etf-shares-46654q203) |
| **Global X** (2)             | URA, SIL | [globalxetfs.com/funds/ura/](https://www.globalxetfs.com/funds/ura/) |
| **abrdn** (2)                | SGOL, SIVR | [abrdn.com](https://www.abrdn.com) → Investments → ETFs |
| **NEOS** (2)                 | SPYI, QQQI | [neosfunds.com](https://neosfunds.com/) |
| **Goldman Sachs** (2)        | GPIX, GPIQ | [GSAM.com/ETFs](https://www.gsam.com/etfs) |
| **Sprott** (2)               | SGDM, SGDJ | [sprott.com/investments](https://sprott.com/investments/) |
| **First Trust** (1)          | RDVY | [ftportfolios.com](https://www.ftportfolios.com/Retail/etf/etfsummary.aspx?ticker=RDVY) |
| **WisdomTree** (1)           | DGRW | [wisdomtree.com/investments/etfs/dgrw](https://www.wisdomtree.com/investments/etfs/dgrw) |
| **Capital Group** (1)        | CGDV | [capitalgroup.com/etf/cgdv.html](https://www.capitalgroup.com/etf/cgdv.html) |
| **FlexShares** (1)           | GUNR | [flexshares.com/us/en/individual/funds/gunr](https://www.flexshares.com/us/en/individual/funds/gunr) |
| **Roundhill** (1)            | DRAM | [roundhillinvestments.com/etf/dram/](https://www.roundhillinvestments.com/etf/dram/) |
| **ProShares** (1)            | ISPY | [proshares.com](https://www.proshares.com/our-etfs/strategic/ispy) |
| **Themes ETFs** (1)          | AGMI | [themesetfs.com/etfs/agmi](https://themesetfs.com/etfs/agmi) |
| **SP Funds** (1)             | SPWO (шариат-фонд) | [sp-funds.com](https://www.sp-funds.com/) |

## Brands list

#	Бренд	Фонды из списка (кол-во)	Официальный сайт / страницы фондов
1	SPDR / State Street — 14 ✅	SPYM (бывш. SPLG), SPYG, SPYD, SDY, XTL + секторы XLK, XLF, XLV, XLY, XLU, XLC, XLI, XLP, XLE	https://us.spdrs.com/ · каталог: https://www.ssga.com/us/en/intermediary/etfs/fund-finder · секторы: https://www.selectsectorspdrs.com/ — весь каталог SSGA (179 фондов) уже интегрирован в наше приложение https://github.com/daggerok/SPDR
2	Invesco — 14	QQQM, RSP, SPLV, SPHD, SPMO, SPHQ, SPGP, RPV, RPG, RWL, DBA, IDMO, IDHQ, IDLV	https://www.invesco.com/us/financial-products/etfs/product-detail?ticker=IDHQ (паттерн ?ticker={TICKER})
3	iShares (BlackRock) — 12 ✅	IVV, SGOV, DGRO, SOXX, MTUM, DVY, HDV, IAUM, PICK (Global Metals & Mining), GARP (MSCI USA Quality GARP), SLVP (Global Silver Miners), RING (Global Gold Miners)	https://www.ishares.com/ — XLS-экспорт holdings со страниц фондов (уже интегрирован в наше приложение, весь каталог)
4	Vanguard — 10	VOO, VUG, VTV, VIG, VYM, VGT, MGK, VOOG, VIGI, VYMI	https://investor.vanguard.com/investment-products/etfs — профиль фонда: …/etfs/profile/VOO
5	Fidelity — 5	FTEC, FDVV, FDIS, FCOM, FNILX*	https://www.fidelity.com/etfs · исследование: https://fundresearch.fidelity.com/ (*FNILX — взаимный фонд ZERO, не ETF)
6	Schwab Asset Management — 3	SCHD, SCHG, SCHB	https://www.schwabassetmanagement.com/products/schd (паттерн /products/{ticker})
7	VanEck — 3	SMH, GDX, GDXJ	https://www.vaneck.com/etf/smh/ (паттерн /etf/{ticker}/)
8	Amplify — 3 ✅	DIVO, IDVO (CWP Intl Enhanced Dividend), SILJ (Junior Silver Miners, экс-ETFMG)	https://amplifyetfs.com/ — Firestore-фид данных (уже интегрирован в наше приложение)
9	JPMorgan Asset Management — 2	JEPI, JEPQ	https://am.jpmorgan.com/us/en/asset-management/adv/products/jpmorgan-equity-premium-income-etf-etf-shares-46641q332 · …/jpmorgan-nasdaq-equity-premium-income-etf-etf-shares-46654q203
10	Global X — 2	URA, SIL	https://www.globalxetfs.com/funds/ura/ (паттерн /funds/{ticker}/)
11	abrdn — 2	SGOL, SIVR	https://www.abrdn.com (раздел Investments → ETFs; физическое золото/серебро, daily bar list)
12	NEOS — 2	SPYI, QQQI	https://neosfunds.com/ · https://neosfunds.com/spyi-lp/ · https://neosfunds.com/qqqi-lp/
13	Goldman Sachs (GSAM) — 2	GPIX, GPIQ	https://www.gsam.com/etfs (GSAM.com/ETFs) · GPIX: https://www.gsam.com/content/gsam/us/en/advisors/fund-center/etf-fund-finder/goldman-sachs-s&p-500-core-premium-income-etf.html
14	Sprott — 2	SGDM, SGDJ	https://sprott.com/investments/ · https://api.sprott.com/sgdm-sprott-gold-miners-etf/ · …/sgdj-sprott-junior-gold-miners-etf/
15	First Trust — 1	RDVY (Rising Dividend Achievers)	https://www.ftportfolios.com/Retail/etf/etfsummary.aspx?ticker=RDVY
16	WisdomTree — 1	DGRW	https://www.wisdomtree.com/investments/etfs/dgrw
17	Capital Group — 1	CGDV (Dividend Value)	https://www.capitalgroup.com/etf/cgdv.html (паттерн /etf/{ticker}.html)
18	FlexShares (Northern Trust) — 1	GUNR	https://www.flexshares.com/us/en/individual/funds/gunr
19	Roundhill — 1	DRAM (Memory ETF, зап. 04/2026)	https://www.roundhillinvestments.com/etf/dram/
20	ProShares — 1	ISPY (S&P 500 High Income)	https://www.proshares.com/our-etfs/strategic/ispy
21	Themes ETFs — 1	AGMI (Silver Miners)	https://themesetfs.com/etfs/agmi (паттерн /etfs/{ticker})
22	SP Funds (ShariaPortfolio) — 1	SPWO (S&P World ex-US, шариат)	https://www.sp-funds.com/
