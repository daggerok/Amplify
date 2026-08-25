#!/usr/bin/env bun

// Bun provides Node-compatible fs/promises and process globals for this script.
// @ts-expect-error node types are intentionally not installed in this no-dependency repo.
import { mkdir, readFile, writeFile } from 'node:fs/promises';

declare const process: { env: Record<string, string | undefined>; argv: string[]; exitCode?: number };

const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1/projects/amplify-etfs-data-feed/databases/(default)/documents';
const OUT_FILE = new URL('../api/data.json', import.meta.url);

async function readExistingPayload(): Promise<{ text: string; payload: JsonRecord | null }> {
  try {
    const text = await readFile(OUT_FILE, 'utf8');
    return { text, payload: JSON.parse(text) };
  } catch {
    return { text: '', payload: null };
  }
}

function comparablePayload(payload: JsonRecord): JsonRecord {
  const { generatedAt: _generatedAt, ...stablePayload } = payload;
  return stablePayload;
}

// The vendor feed refreshes document stamps (UpdatedAt) on its own schedule,
// even when the document's data did not change, which used to turn every
// updater run into a stamp-only api/data.json diff. Comparing blocks with the
// stamps stripped and keeping the previously committed block hides those
// refreshes; a real data change still brings the fresh block and its fresh
// stamp.
function stripUpdatedStamps(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUpdatedStamps);
  if (value && typeof value === 'object') {
    const out: JsonRecord = {};
    Object.entries(value as JsonRecord).forEach(([key, inner]) => {
      if (key === 'UpdatedAt' || key === 'updatedAt') return;
      out[key] = stripUpdatedStamps(inner);
    });
    return out;
  }
  return value;
}

function preserveUnchangedBlock(previous: unknown, next: JsonRecord): JsonRecord {
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) return next;
  const previousBlock = previous as JsonRecord;
  const onlyStampsChanged =
    JSON.stringify(stripUpdatedStamps(previousBlock)) === JSON.stringify(stripUpdatedStamps(next));
  return onlyStampsChanged ? previousBlock : next;
}

const CONCURRENCY_FALLBACK = 6;
type JsonRecord = Record<string, any>;

// ---------------------------------------------------------------------------
// Updater configuration (environment variables, daggerok/iShares-style)
// ---------------------------------------------------------------------------
// All filters combine with AND logic and decide which funds are included in
// api/data.json. Running without filters rebuilds the full active catalog.

type ReturnPeriod = 'YTD' | '1Y' | '3Y' | '5Y' | '10Y';
const RETURN_PERIODS: readonly ReturnPeriod[] = ['YTD', '1Y', '3Y', '5Y', '10Y'];

type Range = { min?: number; max?: number };
type AumRange = Range & { maxExclusive?: boolean; source: string };
type RangeMap = Partial<Record<ReturnPeriod, Range>>;

type UpdaterConfig = {
  concurrency: number;
  tickers: string[];
  categories: string[];
  aumRange?: AumRange;
  dividendYieldRange?: Range;
  secYieldRange?: Range;
  performanceRanges: RangeMap;
  totalReturnRanges: RangeMap;
};

const AUM_PRESET_BOUNDS = {
  nano: { min: 0, max: 10_000_000 },
  micro: { min: 10_000_000, max: 300_000_000 },
  small: { min: 300_000_000, max: 2_000_000_000 },
  mid: { min: 2_000_000_000, max: 10_000_000_000 },
  large: { min: 10_000_000_000, max: undefined },
} as const;
type AumPreset = keyof typeof AUM_PRESET_BOUNDS;

function envValue(env: Record<string, string | undefined>, name: string, aliases: string[] = []): string {
  for (const key of [name, `AMPLIFY_${name}`, ...aliases]) {
    const value = env[key];
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return '';
}

function parseDataNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/[$,%\s,]/g, '');
  if (!normalized || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseConfigNumber(value: string, name: string): number {
  const parsed = parseDataNumber(value);
  if (parsed === null) throw Error(`${name} must be a number; received ${JSON.stringify(value)}`);
  return parsed;
}

function parseInteger(value: string, name: string, fallback: number, minimum: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw Error(`${name} must be an integer >= ${minimum}; received ${JSON.stringify(value)}`);
  }
  return parsed;
}

function parseRange(value: string, name = 'range'): Range | undefined {
  const input = value.trim();
  if (!input) return undefined;
  const parts = input.split(':');
  if (parts.length !== 2) {
    throw Error(`${name} must contain exactly one colon using min:max syntax; received ${JSON.stringify(value)}`);
  }
  const min = parts[0].trim() ? parseConfigNumber(parts[0], name) : undefined;
  const max = parts[1].trim() ? parseConfigNumber(parts[1], name) : undefined;
  if (min === undefined && max === undefined) return undefined;
  if (min !== undefined && max !== undefined && min > max) {
    throw Error(`${name} minimum cannot exceed its maximum`);
  }
  return { min, max };
}

function isAumPreset(value: string): value is AumPreset {
  return Object.hasOwn(AUM_PRESET_BOUNDS, value);
}

function parseAum(value: string, name: string): number {
  const normalized = value.replace(/[$,\s]/g, '').toUpperCase();
  const match = normalized.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))([KMBT])?$/);
  if (!match) {
    throw Error(`${name} must be a USD amount such as 300M or 2000000000; received ${JSON.stringify(value)}`);
  }
  const multipliers: Record<string, number> = { '': 1, K: 1_000, M: 1_000_000, B: 1_000_000_000, T: 1_000_000_000_000 };
  return Number(match[1]) * multipliers[match[2] || ''];
}

function parseAumRange(value: string, name = 'AUM'): AumRange | undefined {
  const input = value.trim();
  if (!input) return undefined;
  const parts = input.split(':');
  if (parts.length !== 2) {
    throw Error(`${name} must contain exactly one colon using min:max syntax; received ${JSON.stringify(value)}`);
  }
  const [rawMin, rawMax] = parts.map(part => part.trim());
  if (!rawMin && !rawMax) return undefined;

  const parseBound = (bound: string, side: 'min' | 'max') => {
    if (!bound) return { value: undefined, preset: false };
    const preset = bound.toLowerCase();
    if (isAumPreset(preset)) return { value: AUM_PRESET_BOUNDS[preset][side], preset: true };
    return { value: parseAum(bound, name), preset: false };
  };

  const minBound = parseBound(rawMin, 'min');
  const maxBound = parseBound(rawMax, 'max');
  const min = minBound.value;
  const max = maxBound.value;
  const maxExclusive = maxBound.preset && max !== undefined;
  if (min !== undefined && max !== undefined && (min > max || (maxExclusive && min >= max))) {
    throw Error(`${name} minimum cannot reach or exceed its maximum`);
  }
  return { min, max, maxExclusive, source: input };
}

function parseRanges(env: Record<string, string | undefined>, prefix: 'PERFORMANCE' | 'TOTAL_RETURN'): RangeMap {
  const ranges: RangeMap = {};
  for (const period of RETURN_PERIODS) {
    const range = parseRange(envValue(env, `${prefix}_${period}`), `${prefix}_${period}`);
    if (range) ranges[period] = range;
  }
  return ranges;
}

function readConfig(env: Record<string, string | undefined> = process.env): UpdaterConfig {
  return {
    concurrency: parseInteger(envValue(env, 'CONCURRENCY', ['AMPLIFY_DATA_CONCURRENCY']), 'CONCURRENCY', CONCURRENCY_FALLBACK, 1),
    tickers: [
      ...new Set(
        envValue(env, 'TICKERS')
          .toUpperCase()
          .split(/[\s,;]+/)
          .map(ticker => ticker.trim())
          .filter(Boolean),
      ),
    ],
    categories: envValue(env, 'CATEGORY')
      .split(/[\s,;]+/)
      .map(category => category.trim())
      .filter(Boolean),
    aumRange: parseAumRange(envValue(env, 'AUM'), 'AUM'),
    dividendYieldRange: parseRange(envValue(env, 'DIVIDEND_YIELD'), 'DIVIDEND_YIELD'),
    secYieldRange: parseRange(envValue(env, 'SEC_YIELD'), 'SEC_YIELD'),
    performanceRanges: parseRanges(env, 'PERFORMANCE'),
    totalReturnRanges: parseRanges(env, 'TOTAL_RETURN'),
  };
}

function rangeLabel(range?: Range): string {
  if (!range) return ':';
  return `${range.min ?? ''}:${range.max ?? ''}`;
}

function configLines(config: UpdaterConfig): string[] {
  const lines = [
    `CONCURRENCY=${config.concurrency}`,
    `TICKERS=${config.tickers.join(' ') || 'all'}`,
    `CATEGORY=${config.categories.join(',') || 'all'}`,
    `AUM=${config.aumRange?.source ?? ':'}`,
    `DIVIDEND_YIELD=${rangeLabel(config.dividendYieldRange)}`,
    `SEC_YIELD=${rangeLabel(config.secYieldRange)}`,
  ];
  for (const period of RETURN_PERIODS) lines.push(`PERFORMANCE_${period}=${rangeLabel(config.performanceRanges[period])}`);
  for (const period of RETURN_PERIODS) lines.push(`TOTAL_RETURN_${period}=${rangeLabel(config.totalReturnRanges[period])}`);
  return lines;
}

function inRange(value: number, range: Range): boolean {
  return !((range.min !== undefined && value < range.min) || (range.max !== undefined && value > range.max));
}

function cumulativeFromCagr(cagr: number, years: number): number {
  return (Math.pow(1 + cagr / 100, years) - 1) * 100;
}

type FundMetrics = {
  netAssetsValue: number | null;
  dividendYield: number | null;
  secYield: number | null;
  returns: JsonRecord;
};

// YTD and 1Y are period returns as published; 3Y/5Y/10Y are annualized (CAGR).
function performanceValue(returns: JsonRecord, period: ReturnPeriod): number | null {
  return parseDataNumber(returns[period]);
}

// TR nY is cumulative: TR = (1 + CAGR)^n - 1 (same math the UI uses).
function totalReturnValue(returns: JsonRecord, period: ReturnPeriod): number | null {
  if (period === 'YTD' || period === '1Y') return parseDataNumber(returns[period]);
  const cagr = parseDataNumber(returns[period]);
  return cagr === null ? null : cumulativeFromCagr(cagr, Number(period.replace('Y', '')));
}

function inAumRange(value: number, range: AumRange): boolean {
  if (range.min !== undefined && value < range.min) return false;
  if (range.max === undefined) return true;
  return range.maxExclusive ? value < range.max : value <= range.max;
}

function fundFilterReasons(metrics: FundMetrics, config: UpdaterConfig): string[] {
  const reasons: string[] = [];
  if (config.aumRange) {
    if (metrics.netAssetsValue === null) reasons.push('net assets unavailable');
    else if (!inAumRange(metrics.netAssetsValue, config.aumRange)) reasons.push(`AUM range (${config.aumRange.source})`);
  }
  if (config.dividendYieldRange) {
    if (metrics.dividendYield === null) reasons.push('dividend yield unavailable');
    else if (!inRange(metrics.dividendYield, config.dividendYieldRange)) reasons.push(`dividend yield range (${rangeLabel(config.dividendYieldRange)})`);
  }
  if (config.secYieldRange) {
    if (metrics.secYield === null) reasons.push('SEC yield unavailable');
    else if (!inRange(metrics.secYield, config.secYieldRange)) reasons.push(`SEC yield range (${rangeLabel(config.secYieldRange)})`);
  }
  for (const period of RETURN_PERIODS) {
    const performanceRange = config.performanceRanges[period];
    if (performanceRange) {
      const value = performanceValue(metrics.returns, period);
      if (value === null) reasons.push(`${period} performance unavailable`);
      else if (!inRange(value, performanceRange)) reasons.push(`${period} performance range (${rangeLabel(performanceRange)})`);
    }
    const totalReturnRange = config.totalReturnRanges[period];
    if (totalReturnRange) {
      const value = totalReturnValue(metrics.returns, period);
      if (value === null) reasons.push(`${period} total return unavailable`);
      else if (!inRange(value, totalReturnRange)) reasons.push(`${period} total return range (${rangeLabel(totalReturnRange)})`);
    }
  }
  return reasons;
}

function monthlyNavReturns(doc: DecodedDoc): JsonRecord {
  const monthly = normalizePerformanceDoc(doc);
  const rows = monthly && Array.isArray(monthly.returns) ? monthly.returns : [];
  const navRow = rows.find(row => String(row.type || '').toUpperCase() === 'NAV');
  return (navRow && navRow.returns) || {};
}

function selectCatalog(catalog: CatalogFund[], config: UpdaterConfig): CatalogFund[] {
  let selected = catalog;
  if (config.tickers.length) {
    const known = new Set(catalog.map(fund => fund.ticker));
    for (const ticker of config.tickers) {
      if (!known.has(ticker)) console.warn(`Requested ticker not found: ${ticker}`);
    }
    selected = selected.filter(fund => config.tickers.includes(fund.ticker));
  }
  if (config.categories.length) {
    const wanted = new Set(config.categories.map(category => category.toLowerCase()));
    selected = selected.filter(fund => wanted.has(fund.category.toLowerCase()));
  }
  return selected;
}

function hasFilters(config: UpdaterConfig): boolean {
  return Boolean(
    config.tickers.length ||
      config.categories.length ||
      config.aumRange ||
      config.dividendYieldRange ||
      config.secYieldRange ||
      Object.keys(config.performanceRanges).length ||
      Object.keys(config.totalReturnRanges).length,
  );
}

const HELP_FLAGS = new Set(['-h', '--help', 'help']);

function wantsHelp(args: string[]): boolean {
  return args.some(arg => HELP_FLAGS.has(arg.toLowerCase()));
}

function printHelp(): void {
  console.log(`Update Amplify ETF static data (api/data.json).

Usage:
  ./scripts/update-data.ts [-h|--help]

Configuration is read from environment variables (AMPLIFY_-prefixed aliases
work too). All filters combine with AND logic and decide which funds are
included in api/data.json; a configured filter also drops funds that do not
publish the metric. Run without filters to rebuild the full active catalog.

  CONCURRENCY=6              Parallel fund fetch workers (alias AMPLIFY_DATA_CONCURRENCY)
  TICKERS="DIVO IDVO"        Only include these tickers (spaces, commas, semicolons)
  CATEGORY="Income,Thematic" Only include these fund categories (Thematic = Growth in the UI)
  AUM=":"                    Net-assets range min:max; bounds are USD amounts (300M, 2B)
                             or nano/micro/small/mid/large presets; inclusive
  DIVIDEND_YIELD=":"         Trailing Distribution Yield range in %
  SEC_YIELD=":"              30-Day SEC Yield range in %
  PERFORMANCE_YTD=":"        YTD NAV return range in %
  PERFORMANCE_1Y=":"         1Y NAV return range in %
  PERFORMANCE_3Y=":"         3Y annualized NAV return (CAGR) range in %
  PERFORMANCE_5Y=":"         5Y annualized NAV return (CAGR) range in %
  PERFORMANCE_10Y=":"        10Y annualized NAV return (CAGR) range in %
  TOTAL_RETURN_YTD=":"       YTD cumulative total return range in %
  TOTAL_RETURN_1Y=":"        1Y cumulative total return (TR 1Y) range in %
  TOTAL_RETURN_3Y=":"        3Y cumulative total return (TR 3Y) range in %
  TOTAL_RETURN_5Y=":"        5Y cumulative total return (TR 5Y) range in %
  TOTAL_RETURN_10Y=":"       10Y cumulative total return (TR 10Y) range in %

Ranges use strict inclusive min:max syntax ("15:", ":20", "5:20", "-5%:7.5",
":"); the colon is required.

Examples:
  TOTAL_RETURN_1Y="15:" ./scripts/update-data.ts
      api/data.json keeps only funds whose 1-year Total Return (TR 1Y) is at
      least 15%; funds below 15% are filtered out.
  AUM="mid:" DIVIDEND_YIELD="4:" ./scripts/update-data.ts
      Only funds with >= $2B net assets and trailing yield >= 4%.
  TICKERS="DIVO" ./scripts/update-data.ts
      Single-fund api/data.json.`);
}

type DecodedDoc = {
  id: string;
  name?: string;
  fields: JsonRecord;
  error?: unknown;
};

type CatalogFund = {
  ticker: string;
  category: string;
  active: boolean;
};

function emptyDoc(id = '', error?: unknown): DecodedDoc {
  return { id, fields: {}, error };
}

async function main() {
  if (wantsHelp(process.argv.slice(2))) {
    printHelp();
    return;
  }
  const config = readConfig();
  console.log(`Config: ${configLines(config).join(' ')}`);

  const existing = await readExistingPayload();
  console.log('Fetching Amplify ETF catalog...');
  const categoryDocs = await fetchFirestoreList(['fund_category'], 'pageSize=200');
  const activeCatalog: CatalogFund[] = categoryDocs
    .map(doc => ({
      ticker: sanitizeTicker(doc.fields.ticker || doc.id),
      category: doc.fields.category || 'Unknown',
      active: doc.fields.isActive !== false,
    }))
    .filter(fund => fund.ticker && fund.active && fund.category !== 'Unknown');
  const catalog = selectCatalog(activeCatalog, config);

  console.log(`Found ${activeCatalog.length} active Amplify ETFs; updating ${catalog.length}.`);

  const funds: JsonRecord[] = [];
  const holdingsByTicker: Record<string, JsonRecord> = {};
  const detailsByTicker: Record<string, JsonRecord> = {};

  await promisePool(catalog, config.concurrency, async ({ ticker, category }) => {
    console.log(`Fetching ${ticker}...`);
    const [
      metaDoc,
      dailyDoc,
      holdingsDoc,
      yieldsDoc,
      monthlyPerformanceDoc,
      quarterlyPerformanceDoc,
      dimensionsDoc,
      distributionsDocs,
      historyCount,
    ] = await Promise.all([
      fetchFirestoreDoc(['funds', ticker, 'fund_metadata', 'overview']).catch(error => emptyDoc('overview', error)),
      fetchLatestCollectionDoc(['funds', ticker, 'daily']).catch(error => emptyDoc('', error)),
      fetchLatestCollectionDoc(['funds', ticker, 'holdings']).catch(error => emptyDoc('', error)),
      fetchLatestCollectionDoc(['funds', ticker, 'yields']).catch(error => emptyDoc('', error)),
      fetchLatestCollectionDoc(['funds', ticker, 'performance_monthly']).catch(error => emptyDoc('', error)),
      fetchLatestCollectionDoc(['funds', ticker, 'performance_quarterly']).catch(error => emptyDoc('', error)),
      fetchLatestCollectionDoc(['funds', ticker, 'dimensions']).catch(error => emptyDoc('', error)),
      fetchDistributions(ticker).catch(error => {
        console.warn(`Failed distributions for ${ticker}:`, error?.message || error);
        return [] as DecodedDoc[];
      }),
      countCollectionDocs(['funds', ticker, 'daily']).catch(error => {
        console.warn(`Failed daily history count for ${ticker}:`, error?.message || error);
        return null;
      }),
    ]);

    const meta: JsonRecord = metaDoc?.fields || {};
    const daily: JsonRecord = dailyDoc?.fields || {};
    const holdingsFields: JsonRecord = holdingsDoc?.fields || {};
    const asOfDate = holdingsFields.asOfDate || holdingsDoc?.id || '';
    const fundName = meta.DisplayName || meta.FundName || meta.Name || ticker;
    const rawHoldings: JsonRecord[] = Array.isArray(holdingsFields.holdings) ? holdingsFields.holdings : [];
    const positions = rawHoldings
      .map((holding: JsonRecord, index: number) => normalizePosition(holding, { ticker, fundName, asOfDate, index }))
      .filter(Boolean);

    const navValue = finiteNumber(daily.NAV);
    const netAssetsValue = finiteNumber(daily.NetAssets);
    const expenseRatioValue = finiteNumber(meta.ExpenseRatio);

    const yields = normalizeAsOfDoc(yieldsDoc) || {};
    const metrics: FundMetrics = {
      netAssetsValue,
      dividendYield: parsePercent(yields.Distribution_Yield),
      secYield: parsePercent(yields['30_Day_SECYield']),
      returns: monthlyNavReturns(monthlyPerformanceDoc),
    };
    const reasons = fundFilterReasons(metrics, config);
    if (reasons.length) {
      console.log(`Filtered out ${ticker}: ${reasons.join(', ')}`);
      return;
    }

    funds.push({
      ticker,
      name: fundName,
      category,
      nav: Number.isFinite(navValue) ? formatMoney(navValue, { decimals: 2 }) : '—',
      navValue: Number.isFinite(navValue) ? navValue : null,
      netAssets: Number.isFinite(netAssetsValue) ? formatMoney(netAssetsValue, { decimals: 0 }) : '—',
      netAssetsValue: Number.isFinite(netAssetsValue) ? netAssetsValue : null,
      expenseRatio: expenseRatioValue !== null ? formatPercent(expenseRatioValue * 100) : '—',
      expenseRatioValue,
      holdingsAsOfDate: asOfDate,
      holdingsCount: positions.length,
      historyCount,
      fundPage: `https://amplifyetfs.com/${encodeURIComponent(ticker)}/`,
      holdingsPage: `https://amplifyetfs.com/${encodeURIComponent(ticker.toLowerCase())}-holdings/`,
    });

    holdingsByTicker[ticker] = {
      ticker,
      fundName,
      asOfDate,
      source: holdingsFields.source || '',
      positions,
      error: holdingsDoc?.error ? String((holdingsDoc.error as Error).message || holdingsDoc.error) : undefined,
    };

    detailsByTicker[ticker] = {
      ticker,
      fundName,
      category,
      metadata: normalizeMetadata(meta),
      daily: normalizeAsOfDoc(dailyDoc),
      yields: normalizeAsOfDoc(yieldsDoc),
      distributions: distributionsDocs.map(normalizeDistribution).filter(Boolean),
      performance: {
        monthly: normalizePerformanceDoc(monthlyPerformanceDoc),
        quarterly: normalizePerformanceDoc(quarterlyPerformanceDoc),
      },
      allocations: normalizeAllocationDoc(dimensionsDoc),
    };
  });

  funds.sort((a, b) => (b.netAssetsValue ?? -Infinity) - (a.netAssetsValue ?? -Infinity) || a.ticker.localeCompare(b.ticker));
  funds.forEach((fund, index) => { fund.rank = index + 1; });

  // Key insertion order must not depend on which concurrent fetch finished
  // first: rebuild both maps in the deterministic (rank) order of `funds`.
  // Blocks whose only change is an UpdatedAt stamp keep their committed
  // version, so stamp-only vendor refreshes do not show up in the diff.
  const previousHoldings: JsonRecord = (existing.payload?.holdings as JsonRecord) || {};
  const previousDetails: JsonRecord = (existing.payload?.details as JsonRecord) || {};
  const orderedHoldings: JsonRecord = {};
  const orderedDetails: JsonRecord = {};
  for (const fund of funds) {
    orderedHoldings[fund.ticker] = preserveUnchangedBlock(previousHoldings[fund.ticker], holdingsByTicker[fund.ticker]);
    orderedDetails[fund.ticker] = preserveUnchangedBlock(previousDetails[fund.ticker], detailsByTicker[fund.ticker]);
  }

  const stablePayload = {
    source: {
      site: 'https://amplifyetfs.com/our-etfs/',
      firestoreProject: 'amplify-etfs-data-feed',
      firestoreRestBase: FIRESTORE_BASE,
    },
    counts: {
      funds: funds.length,
      holdings: Object.values(orderedHoldings).reduce((sum, item) => sum + item.positions.length, 0),
      distributions: Object.values(orderedDetails).reduce((sum, item) => sum + (item.distributions?.length || 0), 0),
    },
    funds,
    holdings: orderedHoldings,
    details: orderedDetails,
  };

  const unchanged = existing.payload && JSON.stringify(comparablePayload(existing.payload)) === JSON.stringify(stablePayload);
  const payload = {
    generatedAt: unchanged ? existing.payload?.generatedAt : new Date().toISOString(),
    ...stablePayload,
  };
  const nextText = `${JSON.stringify(payload, null, 2)}\n`;

  if (nextText === existing.text) {
    console.log('Fetched data is unchanged; keeping api/data.json untouched.');
  } else {
    await mkdir(new URL('../api/', import.meta.url), { recursive: true });
    await writeFile(OUT_FILE, nextText, 'utf8');
    console.log(`Wrote ${OUT_FILE.pathname}`);
  }
  console.log(`Funds: ${payload.counts.funds}${hasFilters(config) ? ` of ${activeCatalog.length} (filters applied)` : ''}; normalized positions: ${payload.counts.holdings}; distributions: ${payload.counts.distributions}`);
}

async function countCollectionDocs(pathParts: string[]): Promise<number> {
  let total = 0;
  let pageToken = '';
  do {
    const query = `pageSize=300&orderBy=__name__%20desc${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const json = await fetchJson(`${FIRESTORE_BASE}/${pathParts.map(encodeURIComponent).join('/')}?${query}`);
    total += Array.isArray(json.documents) ? json.documents.length : 0;
    pageToken = json.nextPageToken || '';
  } while (pageToken);
  return total;
}

async function fetchLatestCollectionDoc(pathParts: string[]): Promise<DecodedDoc | null> {
  const docs = await fetchFirestoreList(pathParts, 'pageSize=1&orderBy=__name__%20desc');
  return docs[0] || null;
}

async function fetchDistributions(ticker: string): Promise<DecodedDoc[]> {
  const path = ['funds', ticker, 'distributions'];
  try {
    return await fetchFirestoreList(path, 'pageSize=500&orderBy=exDate%20desc');
  } catch {
    const docs = await fetchFirestoreList(path, 'pageSize=500');
    return docs.sort((a, b) => String(b.fields.exDate || b.id).localeCompare(String(a.fields.exDate || a.id)));
  }
}

async function fetchFirestoreDoc(pathParts: string[]): Promise<DecodedDoc> {
  const url = `${FIRESTORE_BASE}/${pathParts.map(encodeURIComponent).join('/')}`;
  const json = await fetchJson(url);
  return decodeDocument(json);
}

async function fetchFirestoreList(pathParts: string[], query = ''): Promise<DecodedDoc[]> {
  const url = `${FIRESTORE_BASE}/${pathParts.map(encodeURIComponent).join('/')}${query ? `?${query}` : ''}`;
  const json = await fetchJson(url);
  return (json.documents || []).map(decodeDocument);
}

async function fetchJson(url: string): Promise<JsonRecord> {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  const text = await response.text();
  let json: JsonRecord = {};
  if (text) json = JSON.parse(text);
  if (!response.ok || json.error) {
    const message = json.error?.message || `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return json;
}

function decodeDocument(doc: JsonRecord): DecodedDoc {
  const id = doc.name ? doc.name.split('/').pop() : '';
  const fields: JsonRecord = {};
  sortedFieldEntries(doc.fields).forEach(([key, value]) => { fields[key] = decodeFirestoreValue(value); });
  return { id, name: doc.name, fields };
}

// Firestore returns document and map fields in a non-stable order, which made
// identical updater runs rewrite api/data.json with reshuffled keys. Decoding
// fields in sorted key order keeps the generated JSON byte-identical.
function sortedFieldEntries(fields: JsonRecord | undefined): [string, any][] {
  return Object.entries(fields || {}).sort(([left], [right]) => left.localeCompare(right));
}

function decodeFirestoreValue(value: any): any {
  if (!value || typeof value !== 'object') return value;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('booleanValue' in value) return Boolean(value.booleanValue);
  if ('timestampValue' in value) return value.timestampValue;
  if ('nullValue' in value) return null;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decodeFirestoreValue);
  if ('mapValue' in value) {
    const out: JsonRecord = {};
    sortedFieldEntries(value.mapValue.fields).forEach(([key, inner]) => { out[key] = decodeFirestoreValue(inner); });
    return out;
  }
  return value;
}

function normalizeMetadata(meta: JsonRecord): JsonRecord {
  return pick(meta, [
    'Ticker',
    'DisplayName',
    'FundName',
    'FundCategory',
    'FundType',
    'LaunchDate',
    'InceptionDate',
    'AmplifyStartDate',
    'PrimaryExchange',
    'CUSIP',
    'ISIN',
    'SEDOL',
    'AssetClassFocus',
    'ExpenseRatio',
    'EffectiveCollectedFee',
    'SharesOutstanding',
    'CUSize',
    'CUFee',
    'UnderlyingIndexTicker',
    'isActivelyManaged',
    'isTrading',
    'UpdatedAt',
  ]);
}

function normalizeAsOfDoc(doc: DecodedDoc | null): JsonRecord | null {
  if (!doc || doc.error || !doc.fields || Object.keys(doc.fields).length === 0) return null;
  return {
    asOfDate: doc.fields.asOfDate || doc.id,
    ...doc.fields,
  };
}

function normalizeDistribution(doc: DecodedDoc): JsonRecord | null {
  if (!doc?.fields) return null;
  return {
    id: doc.id,
    exDate: doc.fields.exDate || '',
    recordDate: doc.fields.recordDate || '',
    payableDate: doc.fields.payableDate || '',
    amount: doc.fields.amount ?? '',
    currency: doc.fields.currency || 'USD',
    type: doc.fields.type || '',
    note: doc.fields.note || null,
    year: doc.fields.year || inferYear(doc.fields.exDate || doc.id),
  };
}

function normalizePerformanceDoc(doc: DecodedDoc | null): JsonRecord | null {
  if (!doc || doc.error || !doc.fields) return null;
  return {
    asOfDate: doc.fields.asOfDate || doc.id,
    source: doc.fields.source || '',
    returns: Array.isArray(doc.fields.returns) ? doc.fields.returns.map(normalizePerformanceRow) : [],
  };
}

function normalizePerformanceRow(row: JsonRecord): JsonRecord {
  return {
    ticker: row.ticker || '',
    label: row.label || row.ticker || '',
    type: row.type || '',
    returns: row.returns || {},
  };
}

function normalizeAllocationDoc(doc: DecodedDoc | null): JsonRecord | null {
  if (!doc || doc.error || !doc.fields) return null;
  return {
    asOfDate: doc.fields.asOfDate || doc.id,
    allocations: Array.isArray(doc.fields.allocations) ? doc.fields.allocations.map(normalizeAllocationDimension).filter(Boolean) : [],
  };
}

function normalizeAllocationDimension(allocation: JsonRecord): JsonRecord | null {
  if (!allocation) return null;
  return {
    dimensionID: allocation.dimensionID ?? null,
    dimensionName: allocation.dimensionName || 'Allocation',
    dimvalues: Array.isArray(allocation.dimvalues)
      ? allocation.dimvalues.map((value: JsonRecord) => ({
          label: value.ValueLabel || value.label || '',
          weight: finiteNumber(value.RescaledWeight ?? value.Weight ?? value.weight),
          holdingCount: finiteNumber(value.HoldingCt ?? value.holdingCount),
        })).filter((value: JsonRecord) => value.label)
      : [],
  };
}

function normalizePosition(raw: JsonRecord, ctx: JsonRecord): JsonRecord | null {
  const rawSymbol = normalizeWhitespace(raw.StockTicker || raw.Ticker || raw.Symbol || raw.CUSIP || '');
  const symbol = rawSymbol.toUpperCase();
  const name = normalizeWhitespace(raw.SecurityName || raw.Name || raw.Description || symbol || 'Unknown holding');
  if (!symbol && !name) return null;
  const cusip = normalizeWhitespace(raw.CUSIP || '');
  const weight = parsePercent(raw.Weightings ?? raw.Weighting ?? raw.Weight ?? raw.weight);
  const marketValue = finiteNumber(raw.MarketValue ?? raw.Market_Value_Notional ?? raw.NotionalValue);
  const shares = finiteNumber(raw.Shares ?? raw.Quantity);
  const price = finiteNumber(raw.Price);
  const flags = classifyHolding({ symbol, name, cusip, raw });

  return {
    id: `${ctx.ticker}-${ctx.index}-${symbol || cusip}`,
    fundTicker: ctx.ticker,
    fundName: ctx.fundName,
    asOfDate: ctx.asOfDate,
    symbol,
    rawSymbol,
    name,
    cusip,
    weight: Number.isFinite(weight) ? weight : null,
    marketValue: Number.isFinite(marketValue) ? marketValue : null,
    shares: Number.isFinite(shares) ? shares : null,
    price: Number.isFinite(price) ? price : null,
    flags,
  };
}

function classifyHolding({ symbol, name, cusip, raw }: JsonRecord): string[] {
  const compact = symbol.replace(/\s+/g, '');
  const upperName = name.toUpperCase();
  const flags: string[] = [];
  const isCash = /CASH/.test(symbol) || /CASH\s*&\s*OTHER|CASH COLLATERAL|CASH AND OTHER/.test(upperName) || symbol === 'USD';
  const isMoneyMarket = raw.MoneyMarketFlag === true || raw.money_market_flag === true || /GOVERNMENT\s*&\s*AGENCY PORTFOLIO|MONEY MARKET|TREASURY PORTFOLIO/.test(upperName) || /^[A-Z]{3,5}XX$/.test(symbol);
  const isTreasury = /UNITED STATES TREASURY|TREASURY BILL|TREASURY NOTE|TREASURY BOND/.test(upperName) || /^912[0-9A-Z]{6,}$/.test(symbol) || /^912[0-9A-Z]{6,}$/.test(cusip);
  const isOption = /\d{6}[CP]\d{7,}/.test(compact) || /\b\d{2}\/\d{2}\/\d{4}\s+[\d.]+\s+[CP]\b/.test(upperName) || /\b[CP]\d{5,}\b/.test(symbol);
  const isDerivative = /\b(SWAP|FUTURE|FORWARD|FFA|INDEX|TIMECHARTER|OPTION)\b/.test(upperName) || /\bINDEX\b/.test(symbol);
  const isNumericIdentifier = /^[0-9][0-9A-Z]{7,}$/.test(symbol) || (/^[0-9A-Z]{9}$/.test(symbol) && /\d/.test(symbol) && !/[.\-\s]/.test(symbol));
  const isForeignSuffix = /\s[A-Z]{2,3}$/.test(symbol);
  if (isCash) flags.push('cash');
  if (isMoneyMarket) flags.push('money-market');
  if (isTreasury) flags.push('treasury');
  if (isOption) flags.push('option');
  if (isDerivative) flags.push('derivative');
  if (isNumericIdentifier) flags.push('cusip-like');
  if (isForeignSuffix) flags.push('exchange-suffix');
  if (!flags.length) flags.push('symbol');
  return flags;
}

async function promisePool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (item) await worker(item);
    }
  });
  await Promise.all(workers);
}

function pick(obj: JsonRecord, keys: string[]): JsonRecord {
  const out: JsonRecord = {};
  keys.forEach(key => {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') out[key] = obj[key];
  });
  return out;
}

function inferYear(value: unknown): number | null {
  const match = String(value || '').match(/^(\d{4})/);
  return match ? Number(match[1]) : null;
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePercent(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value > 0 && value < 1 ? value * 100 : value;
  const parsed = Number.parseFloat(String(value).replace('%', '').trim());
  if (!Number.isFinite(parsed)) return null;
  return parsed > 0 && parsed < 1 && !String(value).includes('%') ? parsed * 100 : parsed;
}

function formatMoney(value: unknown, { decimals = 0 } = {}): string {
  if (!Number.isFinite(Number(value))) return '—';
  return Number(value).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals,
  });
}

function formatPercent(value: unknown): string {
  if (!Number.isFinite(Number(value))) return '—';
  return `${Number(value).toFixed(2)}%`;
}

function sanitizeTicker(value: unknown): string {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9._-]/g, '');
}

function normalizeWhitespace(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
