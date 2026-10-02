#!/usr/bin/env bun
/// <reference types="bun" />
/// <reference types="node" />
// Console presentation; no changes to provider requests or persisted data.
/** Presentation only: no requests, writes, filtering, or changes to updater state. */

const outputClean = (value: unknown): string => String(value ?? 'null').replace(/[\r\n\t]+/g, ' ');
/** Presentation only: per-fund retry and fallback notices are printed when VERBOSE is enabled. */
const outputVerbose = (): boolean => /^(1|true|yes|on)$/i.test((globalThis as any).process?.env?.VERBOSE ?? '');
function outputNote(message: string): void { if (outputVerbose()) console.warn(message); }
/** Names are the canonical environment knobs, not internal parser properties. */
function outputConfigEntries(config: Record<string, any>): [string, string][] {
  const values = new Map<string, string>();
  const aliases: Record<string, string> = {
    requestSleepSeconds: 'REQUEST_SLEEP', categories: 'CATEGORY',
    aumRange: 'AUM', terRange: 'TER', dividendYieldRange: 'DIVIDEND_YIELD', secYieldRange: 'SEC_YIELD',
    performanceRanges: 'PERFORMANCE', totalReturnRanges: 'TOTAL_RETURN',
    skipVanEck: 'SKIP_VANECK', skipProShares: 'SKIP_PROSHARES',
    skipWisdomTree: 'SKIP_WISDOMTREE', skipGoldmanSachs: 'SKIP_GOLDMANSACHS',
  };
  const range = (v: any): string => v?.source ?? `${Number.isFinite(v?.min) ? v.min : ''}:${Number.isFinite(v?.max) ? v.max : ''}`;
  for (const [key, value] of Object.entries(config)) {
    const name = aliases[key] ?? key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
    if (name === 'PERFORMANCE' || name === 'TOTAL_RETURN') {
      for (const period of ['YTD', '1Y', '3Y', '5Y', '10Y']) values.set(`${name}_${period}`, range(value?.[period]));
    } else if (['AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD'].includes(name)) {
      values.set(name, range(value));
    } else {
      values.set(name, value instanceof Set ? [...value].join(',') || 'all' : Array.isArray(value) ? value.join(',') || 'all' : outputClean(value));
    }
  }
  const first = ['MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY'];
  return [...values].sort(([a], [b]) => {
    const ai = first.indexOf(a), bi = first.indexOf(b);
    return (ai < 0 ? first.length : ai) - (bi < 0 ? first.length : bi) || a.localeCompare(b);
  });
}
function outputPrintConfig(brand: string, config: Record<string, any>): void {
  const entries: [string, string][] = [...outputConfigEntries(config), ['VERBOSE', String(outputVerbose())]];
  console.log(`[ config   ] ${brand} updater:\n${entries.map(([key, value]) => `              ${key}=${/TOKEN|PASSWORD|SECRET|COOKIE|^SEC_UA$/i.test(key) ? '<redacted>' : outputClean(value)}`).join('\n')}`);
}
function outputHasOutputFilters(config: Record<string, any>): boolean {
  return outputConfigEntries(config).some(([name, value]) =>
    /^(TICKERS|CATEGORY|AUM|TER|DIVIDEND_YIELD|SEC_YIELD|PERFORMANCE_|TOTAL_RETURN_)/.test(name) &&
    !['', ':', 'null', 'all'].includes(value));
}
function outputPrintFilter(selected: number, total: number, deferred = false): void {
  console.log(`[ filter   ] ${selected} of ${total} funds ${deferred ? 'selected for evaluation (data-dependent filters applied per fund)' : 'pass filters'}`);
}
function outputStable(value: any): any {
  if (Array.isArray(value)) return value.map(outputStable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => !['generatedAt', 'catalogReadAt'].includes(key)).map(key => [key, outputStable(value[key])]));
  return value;
}
function outputContentKey(value: unknown): string { return JSON.stringify(outputStable(value)) ?? 'null'; }
const outputCount = (value: any): unknown => typeof value === 'number' ? value : Array.isArray(value) ? value.length : value?.totalRows ?? value?.rows?.length ?? null;
const outputScalar = (value: any): any => value && typeof value === 'object' ? value.display ?? value.value ?? null : value;
function outputMoney(value: any): string {
  const raw = outputScalar(value);
  if (raw === null || raw === undefined || raw === '—' || raw === '--') return 'null';
  const text = String(raw).replace(/[$,\s]/g, '');
  const match = text.match(/^([+-]?[\d.]+)([KMBT])?$/i);
  if (!match) return outputClean(raw);
  const number = Number(match[1]) * ({ K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[match[2]?.toUpperCase() as 'K' | 'M' | 'B' | 'T'] ?? 1);
  if (!Number.isFinite(number)) return 'null';
  for (const [unit, scale] of [['T', 1e12], ['B', 1e9], ['M', 1e6], ['K', 1e3]] as const) {
    if (Math.abs(number) >= scale) return `$${(number / scale).toFixed(1)}${unit}`;
  }
  return `$${number.toFixed(2)}`;
}
function outputFundLine(index: number, total: number, ticker: string, status: string, data: any = {}, reason?: unknown): string {
  const width = Math.max(2, String(total).length);
  const metrics = data.metrics ?? {};
  // Presentation only. Keep valid zero/false values; omit unavailable fields.
  // outputMoney returns the string 'null' for an unavailable monetary value.
  const field = (key: string, value: unknown): string =>
    value === null || value === undefined || value === 'null' ? '' : `${key}=${outputClean(value)}`;
  const sources = [
    field('official', data.officialHistoryCount),
    field('yahoo', data.yahooHistoryCount),
  ].filter(part => part !== '').join(' ');
  const detail = [
    field('port', data.portId ?? data.portfolioId),
    field('history', outputCount(data.history ?? data.historyCount)),
    sources ? `(${sources})` : '',
    field('holdings', outputCount(data.holdings ?? data.holdingsCount)),
    field('divs', outputCount(data.worksheets?.Distributions ?? data.distributions)),
    field('netAssets', outputMoney(data.netAssets ?? data.aum)),
    field('total', outputMoney(data.totalFundNetAssets ?? data.totalNetAssets)),
    field('div', outputScalar(data.trailingYield ?? data.yields?.effectiveYield ?? data.yields?.dividendYield ?? data.dividendYield ?? metrics.dividendYield)),
    field('sec', outputScalar(data.secYield ?? data.yields?.secYield ?? metrics.secYield)),
    field('wp', data.workplaceRaw),
  ].filter(part => part !== '').join(' ');
  return `[ ${String(index).padStart(width)}/${String(total).padEnd(width)}  ] ${outputClean(ticker).padEnd(5)} ${status.padEnd(9)}${detail ? ` ${detail}` : ''}${reason ? ` reason=${outputClean(reason)}` : ''}`;
}


// Bun provides Node-compatible fs/promises and process globals for this script.
/// <reference types="bun" />
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';

declare const process: { env: Record<string, string | undefined>; argv: string[]; execArgv: string[]; execPath: string; exitCode?: number; exit(code?: number): never };

type JsonRecord = Record<string, any>;

const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1/projects/amplify-etfs-data-feed/databases/(default)/documents';
const AMPLIFY_SITE = 'https://amplifyetfs.com';
const CATALOG_PAGE = `${AMPLIFY_SITE}/our-etfs/`;
const YAHOO_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
const YAHOO_BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const SEC_DATA_HOST = 'https://data.sec.gov';
const SEC_EFTS_HOST = 'https://efts.sec.gov/LATEST';
const EDGAR_ARCHIVES = 'https://www.sec.gov/Archives/edgar/data';
const EDGAR_BROWSE_URL = 'https://www.sec.gov/cgi-bin/browse-edgar';
const SEC_FUND_TICKERS_URL = 'https://www.sec.gov/files/company_tickers_mf.json';
const SEC_COMPANY_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const SEC_UA_DEFAULT = 'daggerok ETF feed daggerok@gmail.com';

// The feed lives in api/amplify/ (same layout as every sibling repo); tests point it at a temp directory.
export let apiRoot = new URL('../api/amplify/', import.meta.url);
export function setApiRoot(url: URL): void { apiRoot = url; }
const indexFile = (): URL => new URL('index.json', apiRoot);

const CONCURRENCY_FALLBACK = 6;
const DEFAULT_REQUEST_SLEEP = 0;
const HOLDINGS_PAGE_SIZE_FALLBACK = 250;
const HISTORY_PAGE_SIZE_FALLBACK = 1000;
const DEFAULT_MAX_RETRIES = 2;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------------------------------------------------------------------------
// Updater configuration (environment variables, daggerok/iShares-style)
// ---------------------------------------------------------------------------
// All filters combine with AND logic and decide which funds are refreshed in
// api/amplify. Running without filters rebuilds the full active catalog.

type ReturnPeriod = 'YTD' | '1Y' | '3Y' | '5Y' | '10Y';
const RETURN_PERIODS: readonly ReturnPeriod[] = ['YTD', '1Y', '3Y', '5Y', '10Y'];

type Range = { min?: number; max?: number };
type AumRange = Range & { maxExclusive?: boolean; source: string };
type RangeMap = Partial<Record<ReturnPeriod, Range>>;

type UpdaterConfig = {
  maxFetches: number;
  requestSleepSeconds: number;
  concurrency: number;
  holdingsPageSize: number;
  historyPageSize: number;
  maxRetries: number;
  historyRange: string;
  secUa: string;
  skipYahoo: boolean;
  edgarFallback: boolean;
  tickers: string[];
  categories: string[];
  aumRange?: AumRange;
  terRange?: Range;
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

function envValue(env: Record<string, string | undefined>, name: string): string {
  return (env[name] ?? '').trim();
}

function parseBooleanControl(value: string, name: string, fallback: boolean): boolean {
  if (!value) return fallback;
  const text = value.toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(text)) return false;
  throw Error(`${name} must be a boolean (true/false); received ${JSON.stringify(value)}`);
}

/** `max` (every available day) or `Ny` (the last N years). */
export function parseHistoryRange(value: string): string {
  const text = value.trim().toLowerCase();
  if (!text) return 'max';
  if (!/^(max|[1-9]\d*y)$/.test(text)) throw Error(`HISTORY_RANGE must be max or Ny (for example 5y); received ${JSON.stringify(value)}`);
  return text;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanText(raw: unknown): string {
  return String(raw ?? '')
    .replace(/®/g, '')
    .replace(/™/g, '')
    .replace(/&#174;|&reg;/gi, '')
    .replace(/&#8482;|&trade;/gi, '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// "2.97057744E8" -> "297057744"; keeps non-numeric text untouched.
export function normalizeNumberText(raw: unknown): string {
  const text = String(raw ?? '').trim();
  if (text === '' || text === '-') return text;
  if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text.replace(/,/g, ''))) return text;
  const number = Number(text.replace(/,/g, ''));
  if (!Number.isFinite(number) || Math.abs(number) >= 1e21) return text;
  return number.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 10 });
}

export function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '' || text === '—' || text === '-' || text === '--' || /^n\/?a$/i.test(text)) return null;
  const parsed = Number(text.replace(/[$,\s]/g, '').replace(/%$/i, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// "2026-06-30" -> "Jun 30 2026" (the display style shared with the sibling apps).
export function formatEdgarDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!match) return String(iso || '');
  const [, year, month, day] = match;
  return `${MONTHS[Number(month) - 1] ?? month} ${day} ${year}`;
}

export function epochToIsoDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

export function formatUsDate(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  return `${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')}/${date.getUTCFullYear()}`;
}

// "08/21/2026" / "2026-08-21T00:00:00Z" -> "2026-08-21"; anything else passes through untouched.
export function toIsoDate(raw: unknown): string {
  const text = String(raw ?? '').trim();
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  return text;
}

export function isoDate(value: unknown): string | null {
  const s = String(value ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s|$)/.exec(s);
  const result = m ? `${m[1]}-${m[2]}-${m[3]}` : us ? `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}` : null;
  return result && Number.isFinite(Date.parse(result)) ? result : null;
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

function parseNonNegativeDecimal(value: string, name: string, fallback: number): number {
  if (!value) return fallback;
  const parsed = /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) throw Error(`${name} must be a non-negative number of seconds; received ${JSON.stringify(value)}`);
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

export function parseAumRange(value: string, name = 'AUM'): AumRange | undefined {
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

export function readConfig(env: Record<string, string | undefined>): UpdaterConfig {
  return {
    maxFetches: parseInteger(envValue(env, 'MAX_FETCHES'), 'MAX_FETCHES', 0, 0),
    requestSleepSeconds: parseNonNegativeDecimal(envValue(env, 'REQUEST_SLEEP'), 'REQUEST_SLEEP', DEFAULT_REQUEST_SLEEP),
    concurrency: parseInteger(envValue(env, 'CONCURRENCY'), 'CONCURRENCY', CONCURRENCY_FALLBACK, 1),
    holdingsPageSize: parseInteger(envValue(env, 'HOLDINGS_PAGE_SIZE'), 'HOLDINGS_PAGE_SIZE', HOLDINGS_PAGE_SIZE_FALLBACK, 1),
    historyPageSize: parseInteger(envValue(env, 'HISTORY_PAGE_SIZE'), 'HISTORY_PAGE_SIZE', HISTORY_PAGE_SIZE_FALLBACK, 1),
    maxRetries: parseInteger(envValue(env, 'MAX_RETRIES'), 'MAX_RETRIES', DEFAULT_MAX_RETRIES, 1),
    historyRange: parseHistoryRange(envValue(env, 'HISTORY_RANGE')),
    secUa: envValue(env, 'SEC_UA') || SEC_UA_DEFAULT,
    skipYahoo: parseBooleanControl(envValue(env, 'SKIP_YAHOO'), 'SKIP_YAHOO', false),
    edgarFallback: parseBooleanControl(envValue(env, 'EDGAR_FALLBACK'), 'EDGAR_FALLBACK', true),
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
    terRange: parseRange(envValue(env, 'TER'), 'TER'),
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

function inRange(value: number, range: Range): boolean {
  return !((range.min !== undefined && value < range.min) || (range.max !== undefined && value > range.max));
}

function cumulativeFromCagr(cagr: number, years: number): number {
  return (Math.pow(1 + cagr / 100, years) - 1) * 100;
}

type FundMetrics = {
  netAssetsValue: number | null;
  expenseRatioPercent: number | null;
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

export function fundFilterReasons(metrics: FundMetrics, config: UpdaterConfig): string[] {
  const reasons: string[] = [];
  if (config.aumRange) {
    if (metrics.netAssetsValue === null) reasons.push('net assets unavailable');
    else if (!inAumRange(metrics.netAssetsValue, config.aumRange)) reasons.push(`AUM range (${config.aumRange.source})`);
  }
  if (config.terRange) {
    if (metrics.expenseRatioPercent === null) reasons.push('expense ratio unavailable');
    else if (!inRange(metrics.expenseRatioPercent, config.terRange)) reasons.push(`TER range (${rangeLabel(config.terRange)})`);
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

export function selectCatalog(catalog: CatalogFund[], config: UpdaterConfig): CatalogFund[] {
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
  if (config.maxFetches > 0) selected = [...selected].sort((a, b) => a.ticker.localeCompare(b.ticker)).slice(0, config.maxFetches);
  return selected;
}

function hasFilters(config: UpdaterConfig): boolean {
  return Boolean(
    config.tickers.length ||
      config.categories.length ||
      config.maxFetches > 0 ||
      config.aumRange ||
      config.terRange ||
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

export const USAGE = `Update Amplify ETF static data (api/amplify/).

Usage:
  ./scripts/update-data.ts [-h|--help]

Defaults live in scripts/update-data.config.json; environment variables
override them (AMPLIFY_-prefixed aliases win over plain names). In GitHub
Actions the precedence is: file defaults < advanced JSON < nonblank inputs <
protected Actions variable/env. All filters combine with AND logic and decide
which funds are refreshed in api/amplify; a configured filter also skips
funds that do not publish the metric, and skipped funds keep their previously
published files. Run without filters to rebuild the full active catalog.

  MAX_FETCHES=0              0 means all selected funds; N > 0 fetches only the first N selected tickers (alphabetical)
  REQUEST_SLEEP=0            Minimum seconds between request starts of each worker lane (retries included)
  CONCURRENCY=6              Funds fetched in parallel, one request in flight per worker (legacy alias AMPLIFY_DATA_CONCURRENCY)
  TICKERS="DIVO IDVO"        Only refresh these tickers (spaces, commas, semicolons)
  CATEGORY="Income,Thematic" Only refresh these Amplify fund categories (Income, Thematic, Core, International)
  AUM=":"                    Net-assets range min:max; bounds are USD amounts (300M, 2B)
                             or nano/micro/small/mid/large presets; inclusive
  TER=":"                    Expense-ratio range in %
  DIVIDEND_YIELD=":"         Trailing Distribution Yield range in % (indicated yield from Yahoo dividends when Amplify publishes none)
  SEC_YIELD=":"              30-Day SEC Yield range in %
  PERFORMANCE_YTD=":"        YTD return range in % (official NAV, Yahoo adjusted closes when unpublished)
  PERFORMANCE_1Y=":"         1Y return range in %
  PERFORMANCE_3Y=":"         3Y annualized return (CAGR) range in %
  PERFORMANCE_5Y=":"         5Y annualized return (CAGR) range in %
  PERFORMANCE_10Y=":"        10Y annualized return (CAGR) range in %
  TOTAL_RETURN_YTD=":"       YTD cumulative total return range in %
  TOTAL_RETURN_1Y=":"        1Y cumulative total return (TR 1Y) range in %
  TOTAL_RETURN_3Y=":"        3Y cumulative total return (TR 3Y) range in %
  TOTAL_RETURN_5Y=":"        5Y cumulative total return (TR 5Y) range in %
  TOTAL_RETURN_10Y=":"       10Y cumulative total return (TR 10Y) range in %
  HOLDINGS_PAGE_SIZE=250     Holdings rows per static JSON page
  HISTORY_PAGE_SIZE=1000     Daily history rows per static JSON page
  MAX_RETRIES=2              Retries (>= 1) for network errors, HTTP 429 and 5xx
  HISTORY_RANGE=max          Yahoo daily history range: max or Ny (for example 5y); merges with previously published history
  SEC_UA="daggerok ETF feed daggerok@gmail.com"  SEC EDGAR contact User-Agent (redacted in logs; the SEC_UA Actions variable wins)
  SKIP_YAHOO=false           Skip Yahoo Finance history and dividends; retain published data (true/false)
  EDGAR_FALLBACK=true        SEC N-PORT-P holdings fallback for funds without Firestore holdings (true/false)
  VERBOSE=false              Print per-fund retry and fallback notices (true/false)
  USE_SYSTEM_CA=auto         TLS trust store: auto restarts once with Bun's --use-system-ca on an untrusted-certificate error, true always uses it, false never restarts

Ranges use strict inclusive min:max syntax ("15:", ":20", "5:20", "-5%:7.5",
":"); the colon is required.

Examples:
  TOTAL_RETURN_1Y="15:" ./scripts/update-data.ts
      Refreshes only funds whose 1-year Total Return (TR 1Y) is at least 15%;
      other funds keep their previously published files.
  MAX_FETCHES=3 REQUEST_SLEEP=0.5 ./scripts/update-data.ts
      Smoke run over the first three selected tickers.
  AUM="mid:" TER=":0.75" DIVIDEND_YIELD="4:" ./scripts/update-data.ts
      Only funds with >= $2B net assets and trailing yield >= 4%.
  TICKERS="DIVO" SKIP_YAHOO=true ./scripts/update-data.ts
      Single-fund refresh from Firestore only.`;

function printHelp(): void {
  console.log(USAGE);
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
type NamedFund = CatalogFund & { name: string };

// File defaults and explicit overrides, same mechanism as the sibling updaters:
// allowlisted scalar controls only, so GitHub Actions can resolve them without
// interpolating user input into bash. Precedence: config file < advanced JSON <
// nonblank inputs < environment (`AMPLIFY_<KEY>` alias wins over `<KEY>`;
// `AMPLIFY_DATA_CONCURRENCY` is the legacy alias of CONCURRENCY and
// `HISTORICAL_PAGE_SIZE` of HISTORY_PAGE_SIZE).
export const CONTROL_NAMES = [
  'MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY', 'TICKERS', 'CATEGORY', 'AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD',
  'HOLDINGS_PAGE_SIZE', 'HISTORY_PAGE_SIZE', 'MAX_RETRIES', 'HISTORY_RANGE', 'SEC_UA', 'SKIP_YAHOO', 'EDGAR_FALLBACK',
  ...['PERFORMANCE', 'TOTAL_RETURN'].flatMap(prefix => RETURN_PERIODS.map(period => `${prefix}_${period}`)),
  'VERBOSE', 'USE_SYSTEM_CA',
] as const;
export type ControlName = (typeof CONTROL_NAMES)[number];
export const CONFIG_FILE_URL = new URL('./update-data.config.json', import.meta.url);

const ENV_ALIASES: Partial<Record<ControlName, string[]>> = {
  CONCURRENCY: ['AMPLIFY_DATA_CONCURRENCY'],
  HISTORY_PAGE_SIZE: ['HISTORICAL_PAGE_SIZE'],
};

export function resolveControls(
  file: unknown = {},
  advanced: unknown = {},
  inputs: unknown = {},
  env: Record<string, string | undefined> = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  const known = new Set<string>(CONTROL_NAMES);
  const apply = (value: unknown, skipEmpty = false): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Configuration must be a JSON object');
    for (const [key, raw] of Object.entries(value)) {
      if (!known.has(key)) throw new Error(`Unknown updater control: ${key}`);
      if (skipEmpty && (raw === '' || raw === undefined || raw === null)) continue;
      if (!['string', 'number', 'boolean'].includes(typeof raw)) throw new Error(`${key}: expected string, number or boolean`);
      const text = String(raw);
      if (/[\r\n\0]/.test(text)) throw new Error(`${key}: multiline/control characters are not allowed`);
      result[key] = text;
    }
  };
  apply(file);
  apply(advanced);
  apply(inputs, true);
  for (const key of CONTROL_NAMES) {
    const value = [`AMPLIFY_${key}`, key, ...(ENV_ALIASES[key] ?? [])].map(name => env[name]).find(candidate => candidate !== undefined);
    if (value !== undefined) apply({ [key]: value });
  }
  if (result.VERBOSE && !/^(0|1|true|false|yes|no|y|n|on|off)$/i.test(result.VERBOSE)) throw new Error('VERBOSE: expected boolean');
  if (result.USE_SYSTEM_CA !== undefined && !/^(auto|true|false)$/i.test(result.USE_SYSTEM_CA)) throw new Error('USE_SYSTEM_CA: expected auto, true or false');
  readConfig(result); // validate numbers, booleans, HISTORY_RANGE and every min:max filter before any request or write
  return result;
}

export async function runtimeControls(env: Record<string, string | undefined> = process.env): Promise<Record<string, string>> {
  let file: unknown = {};
  try { file = JSON.parse(await readFile(CONFIG_FILE_URL, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return resolveControls(file, {}, {}, env);
}

// --- TLS trust store (identical in every ETF repo) ---
const SYSTEM_CA_MARKER = 'ETF_UPDATER_SYSTEM_CA';
const CERT_ERROR = /UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|CERT_HAS_EXPIRED|unable to get (?:local )?issuer certificate|self[- ]signed certificate|certificate has expired/i;

export function isCertError(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown; cause?: unknown } | null;
  return CERT_ERROR.test(`${String(e?.code ?? '')} ${String(e?.message ?? '')}`) || (e?.cause ? isCertError(e.cause) : false);
}

export function systemCaActive(env: Record<string, string | undefined> = process.env, execArgv: string[] = process.execArgv): boolean {
  return execArgv.includes('--use-system-ca') || env.NODE_USE_SYSTEM_CA === '1' || env[SYSTEM_CA_MARKER] === '1';
}

export function reexecWithSystemCa(): never {
  const child = Bun.spawnSync([process.execPath, '--use-system-ca', ...process.argv.slice(1)], {
    env: { ...process.env, [SYSTEM_CA_MARKER]: '1' },
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  process.exit(child.exitCode ?? 1);
}

/** mode: auto (restart once on an untrusted-certificate error), true (restart now), false (never). */
export function installSystemCa(mode: string, reexec: () => never = reexecWithSystemCa, active: boolean = systemCaActive()): void {
  if (mode === 'false' || active) return;
  if (mode === 'true') reexec();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    try { return await realFetch(...args); }
    catch (error) {
      if (!isCertError(error)) throw error;
      console.error('[ notice   ] TLS certificate not trusted; restarting once with --use-system-ca');
      return reexec();
    }
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// Request layer: retries and per-worker lanes shared by Firestore, Yahoo and SEC calls
// ---------------------------------------------------------------------------
// Request pacing and retries are set from the resolved controls in runUpdate.
export let httpSettings = { maxRetries: DEFAULT_MAX_RETRIES, requestSleepMs: DEFAULT_REQUEST_SLEEP * 1000 };
export function setHttpSettings(next: typeof httpSettings): void { httpSettings = next; }

// Per-worker request lanes: every fund worker owns one lane. A lane runs its requests one at a time
// (so total in-flight requests never exceed CONCURRENCY, even though one fund needs ~10 requests)
// and spaces its own request starts by REQUEST_SLEEP. N workers therefore give ~N times the throughput.
// Firestore, Yahoo and SEC are all direct (no proxy), so no global gate is needed.
export type RequestLane = { tail: Promise<unknown>; nextSlot: number };
export const createRequestLane = (): RequestLane => ({ tail: Promise.resolve(), nextSlot: 0 });
const laneStorage = new AsyncLocalStorage<RequestLane>();
const defaultLane = createRequestLane(); // calls made outside a worker (catalog listing)

function runInLane<T>(action: () => Promise<T>): Promise<T> {
  const lane = laneStorage.getStore() ?? defaultLane;
  const run = lane.tail.then(async () => {
    const sleepMs = httpSettings.requestSleepMs;
    if (sleepMs > 0) {
      const now = Date.now();
      const slot = Math.max(now, lane.nextSlot);
      lane.nextSlot = slot + sleepMs;
      if (slot > now) await sleep(slot - now);
    }
    return action();
  });
  lane.tail = run.then(() => undefined, () => undefined);
  return run;
}

class HttpStatusError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const isTransient = (error: unknown): boolean =>
  !(error instanceof HttpStatusError) || error.status === 429 || error.status >= 500;

/** `fetchWithRetry` messages are prefixed with the fetch label; a caller that prints its own tag must not repeat it. */
function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^\[[^\]]*\] ?/, '');
}

function bodyMessage(text: string): string {
  try { return String(JSON.parse(text)?.error?.message ?? ''); } catch { return ''; }
}

async function fetchWithRetry<T>(url: string, label: string, headers: Record<string, string>, parse: (text: string) => T): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await runInLane(async () => {
        const response = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
        const text = await response.text();
        if (!response.ok) throw new HttpStatusError(bodyMessage(text) || `${label}: HTTP ${response.status} ${response.statusText}`, response.status);
        return parse(text);
      });
    } catch (error) {
      if (attempt >= httpSettings.maxRetries || !isTransient(error)) throw error;
      outputNote(`retry ${attempt + 1}/${httpSettings.maxRetries} after ${errorMessage(error)}: ${label}`);
      await sleep(Math.min(250 * 2 ** attempt, 4000));
    }
  }
}

const JSON_HEADERS = { Accept: 'application/json' };
const yahooHeaders = (): Record<string, string> => ({ 'User-Agent': YAHOO_BROWSER_UA, Accept: 'application/json' });
const secHeaders = (config: UpdaterConfig): Record<string, string> => ({ 'User-Agent': config.secUa, Accept: 'application/json,*/*' });

export async function fetchText(url: string, label = url, headers: Record<string, string> = JSON_HEADERS, _config?: unknown): Promise<string> {
  return fetchWithRetry(url, label, headers, text => text);
}

export async function fetchJson(url: string, label = url, headers: Record<string, string> = JSON_HEADERS, _config?: unknown): Promise<JsonRecord> {
  return fetchWithRetry(url, label, headers, text => {
    let json: JsonRecord = {};
    if (text) json = JSON.parse(text);
    if (json.error) throw new HttpStatusError(json.error.message || String(json.error), Number(json.error.code) || 200);
    return json;
  });
}

// ---------------------------------------------------------------------------
// Firestore (Amplify's public data feed)
// ---------------------------------------------------------------------------
const firestoreUrl = (pathParts: string[], query = ''): string =>
  `${FIRESTORE_BASE}/${pathParts.map(encodeURIComponent).join('/')}${query ? `?${query}` : ''}`;

async function fetchFirestoreDoc(pathParts: string[]): Promise<DecodedDoc> {
  return decodeDocument(await fetchJson(firestoreUrl(pathParts)));
}

async function fetchFirestoreList(pathParts: string[], query = ''): Promise<DecodedDoc[]> {
  const json = await fetchJson(firestoreUrl(pathParts, query));
  return (json.documents || []).map(decodeDocument);
}

async function fetchFirestoreListAll(pathParts: string[], pageSize: number): Promise<DecodedDoc[]> {
  const docs: DecodedDoc[] = [];
  let pageToken = '';
  do {
    const json = await fetchJson(firestoreUrl(pathParts, `pageSize=${pageSize}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`));
    docs.push(...(json.documents || []).map(decodeDocument));
    pageToken = json.nextPageToken || '';
  } while (pageToken);
  return docs;
}

async function fetchLatestCollectionDoc(pathParts: string[]): Promise<DecodedDoc | null> {
  const docs = await fetchFirestoreList(pathParts, 'pageSize=1&orderBy=__name__%20desc');
  return docs[0] || null;
}

// The distributions collection currently answers 403 (Missing or insufficient permissions);
// it is still asked once per fund so published rows would be picked up if access opens.
async function fetchDistributions(ticker: string): Promise<DecodedDoc[]> {
  const path = ['funds', ticker, 'distributions'];
  try {
    return await fetchFirestoreList(path, 'pageSize=500&orderBy=exDate%20desc');
  } catch {
    return await fetchFirestoreList(path, 'pageSize=500');
  }
}

export function decodeDocument(doc: JsonRecord): DecodedDoc {
  const id = doc.name ? doc.name.split('/').pop() : '';
  const fields: JsonRecord = {};
  sortedFieldEntries(doc.fields).forEach(([key, value]) => { fields[key] = decodeFirestoreValue(value); });
  return { id, name: doc.name, fields };
}

// Firestore returns document and map fields in a non-stable order, which would rewrite
// the feed with reshuffled keys on identical runs. Decoding fields in sorted key order
// keeps the generated JSON byte-identical.
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

function normalizeAsOfDoc(doc: DecodedDoc | null): JsonRecord | null {
  if (!doc || doc.error || !doc.fields || Object.keys(doc.fields).length === 0) return null;
  return { asOfDate: doc.fields.asOfDate || doc.id, ...doc.fields };
}

export async function runFundPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  // Each worker gets its own request lane (see runInLane), so CONCURRENCY funds are in flight at once.
  const workers = Array.from({ length: Math.min(limit, queue.length) }, () => laneStorage.run(createRequestLane(), async () => {
    while (queue.length) {
      const item = queue.shift();
      if (item) await worker(item);
    }
  }));
  await Promise.all(workers);
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function parsePercent(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value > 0 && value < 1 ? value * 100 : value;
  const parsed = Number.parseFloat(String(value).replace('%', '').trim());
  if (!Number.isFinite(parsed)) return null;
  return parsed > 0 && parsed < 1 && !String(value).includes('%') ? parsed * 100 : parsed;
}

function formatMoney(value: unknown, { decimals = 0 } = {}): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return Number(value).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals,
  });
}

function sanitizeTicker(value: unknown): string {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9._-]/g, '');
}

function normalizeWhitespace(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

const percent = (v: number | null | undefined): string => v == null ? '—' : `${v.toFixed(2)}%`;
const money = (v: number | null | undefined): string => v == null ? '—' : `$${v.toFixed(2)}`;

/** Runs an optional source: a failure is a verbose-only notice and yields null. */
async function optional<T>(label: string, action: () => Promise<T>): Promise<T | null> {
  try { return await action(); } catch (error) { outputNote(`[ fallback ] ${label}: ${errorMessage(error)}`); return null; }
}

// ---------------------------------------------------------------------------
// Holdings sheet (standard columns shared with the sibling feeds)
// ---------------------------------------------------------------------------
export const HOLDINGS_HEADERS = ['Name', 'Ticker', 'Identifier', 'Weight', 'Market Value', 'Shares Held', 'SEDOL'];

// Firestore weights are percent strings ("5.38%"); nothing here ever turns a missing value into 0.
const textNumber = (value: unknown): string => {
  const parsed = finiteNumber(typeof value === 'string' ? value.replace('%', '').trim() : value);
  return parsed === null ? '' : String(parsed);
};

export function holdingsRowFromFirestore(raw: JsonRecord): JsonRecord | null {
  const ticker = normalizeWhitespace(raw.StockTicker || raw.Ticker || raw.Symbol).toUpperCase();
  const identifier = normalizeWhitespace(raw.CUSIP || raw.ISIN || raw.SEDOL);
  const name = normalizeWhitespace(raw.SecurityName || raw.Name || raw.Description || ticker);
  if (!ticker && !name && !identifier) return null;
  return {
    Name: name || ticker || identifier,
    Ticker: ticker,
    Identifier: identifier,
    Weight: textNumber(raw.Weightings ?? raw.Weighting ?? raw.Weight ?? raw.weight),
    'Market Value': textNumber(raw.MarketValue ?? raw.Market_Value_Notional ?? raw.NotionalValue),
    'Shares Held': textNumber(raw.Shares ?? raw.Quantity),
    SEDOL: normalizeWhitespace(raw.SEDOL),
  };
}

function sortHoldings(rows: JsonRecord[]): JsonRecord[] {
  return rows.slice().sort((a, b) => (numberOrNull(b.Weight) ?? -Infinity) - (numberOrNull(a.Weight) ?? -Infinity) || String(a.Name).localeCompare(String(b.Name)));
}

const HOLDING_NAME_SUFFIXES = new Set([
  'STOCK', 'COMMON', 'PREFERRED', 'PFD', 'SHARES', 'ORDINARY', 'DEPOSITARY', 'ADS', 'ADR',
  'INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LTD', 'LIMITED', 'PLC',
  'PUBLIC', 'SA', 'SAS', 'SARL', 'SRL', 'SL', 'KG', 'AG', 'BA', 'BV', 'NV', 'OY', 'SE',
  'AS', 'AB', 'AD', 'KK', 'KABUSHIKI', 'KAISHA', 'PTY', 'PT', 'SFC', 'ANONIMA', 'GMBH',
  'HOLDINGS', 'HLDGS', 'DEL', 'NEW', 'DELISTED', 'REPR', 'GROUP', 'TR', 'TRUST', 'NOTE',
  'NL', 'SPA', 'LP', 'LC', 'LLC', 'CAP', 'STK', 'SHS',
  'NOTES', 'BOND', 'BONDS', 'SER', 'SERIES',
]);
const HOLDING_NAME_PHRASES = new Set([
  'COMMON STOCK', 'PREFERRED STOCK', 'DEPOSITARY SHARES', 'AMERICAN DEPOSITARY SHARES',
  'ORDINARY SHARES', 'LIABILITY CO', 'S A', 'N V', 'B V', 'PRIVATE LTD', 'PUBLIC LTD',
]);
// Words that carry no identity at all: dropped wherever they sit at the edge
// of a filed name, so "The Coca-Cola Co" and "Coca CO" meet.
const HOLDING_NAME_FILLERS = new Set([
  'THE', 'OF', 'AND', 'FOR', 'DE', 'LA', 'LE', 'VAN', 'VON', 'DER', 'DEN', 'DI', 'Y',
  'E', 'DU', 'DA', 'LOS', 'LAS', 'EL', 'AL', 'DEL', 'NPV', 'PAR', 'VAL', 'USD', 'EUR',
  'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'HKD', 'CNY', 'SEK', 'NOK', 'NZD', 'MXN', 'INR',
]);

// Trailing share-class / security-type designations. The class letter is kept
// and canonicalized ("... Class C Capital Stock" -> "... Cl C") rather than
// dropped, so GOOG vs GOOGL - like BF/A vs BF/B - never collide.
const SHARE_CLASS_RE = /(?:\s+(?:CLASS|CL))\s+([A-Z])\b\s*$/;
// Words that only describe the security, never the issuer; safe to peel off the
// end of a filed name (and, once a share class is known, from behind it).
const SECURITY_TYPE_WORDS = new Set([
  'STOCK', 'STK', 'SHARES', 'SHS', 'SH', 'SHARE', 'CAPITAL', 'CAP', 'COMMON', 'ORDINARY',
  'GENERAL', 'VOTING', 'NON', 'NONVOTING', 'NVOTING', 'CONVERTIBLE', 'DEPOSITARY', 'PAID',
  'SUBORDINATED', 'NOTES', 'NOTE', 'SER', 'SERIES', 'LIABILITY', 'NEW', 'REP', 'REPR',
]);

export function normalizeHoldingName(raw: unknown): string {
  const text = String(raw ?? '')
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
  let tokens = text.split(' ').filter(Boolean);
  let classLetter = '';
  let changed = true;
  while (changed && tokens.length > 1) {
    changed = false;
    const withClass = tokens.join(' ').match(SHARE_CLASS_RE);
    if (withClass) {
      classLetter = withClass[1];
      tokens = tokens.slice(0, tokens.length - 2); // drop "Class C" (or "Cl C")
      changed = true;
    }
    const last = tokens[tokens.length - 1];
    if (SECURITY_TYPE_WORDS.has(last) && tokens.length > 1) {
      tokens.pop(); // "... Capital Stock" -> "... Capital"
      changed = true;
      continue;
    }
    if (tokens.length >= 2 && HOLDING_NAME_PHRASES.has(`${tokens[tokens.length - 2]} ${last}`)) {
      tokens = tokens.slice(0, -2);
      changed = true;
      continue;
    }
    if (HOLDING_NAME_SUFFIXES.has(last)) {
      tokens.pop();
      changed = true;
      continue;
    }
    while (tokens.length > 2 && HOLDING_NAME_FILLERS.has(tokens[tokens.length - 1])) {
      tokens.pop(); // keep peeling: a filler may hide the next legal-form suffix
      changed = true;
    }
  }
  while (tokens.length > 1 && HOLDING_NAME_FILLERS.has(tokens[0])) tokens.shift();
  const body = tokens.join(' ').trim();
  return classLetter ? `${body} CL ${classLetter}`.replace(/\s+/g, ' ').trim() : body;
}

export function normalizeHoldingNameCore(raw: unknown): string {
  return normalizeHoldingName(raw).replace(/ /g, '');
}

// Holding tickers keep their class-share markers (SCE^L, BF/A, BRK-B): they
// are the real exchange symbols, unlike fund tickers which sanitizeTicker
// upper-cases and strips everything but letters/digits.
const HOLDING_TICKER_PLACEHOLDERS = new Set(['', 'N/A', 'NA', 'NONE', 'NIL', 'NULL', '-', '--', '---', 'SEE FILE', 'VARIES']);

export function cleanHoldingTicker(raw: unknown): string {
  const symbol = String(raw ?? '').trim().toUpperCase();
  if (HOLDING_TICKER_PLACEHOLDERS.has(symbol)) return '';
  return /^[A-Z0-9][A-Z0-9.^/-]*$/.test(symbol) ? symbol : '';
}

// ---------------------------------------------------------------------------
// SEC EDGAR fallback layer: N-PORT-P positions for funds whose fund page does
// not carry a downloadable holdings sheet, resolved through EDGAR.
// ---------------------------------------------------------------------------

export type NportAccession = { accession: string; filed: string; reportDate: string; url: string };

export function nportUrlFor(cik: string, accession: string): string {
  return `${EDGAR_ARCHIVES}/${Number(String(cik).replace(/^0+/, '') || 0)}/${String(accession).replace(/-/g, '')}/primary_doc.xml`;
}

export function parseNportAccessions(submissions: JsonRecord): NportAccession[] {
  const recent = submissions?.filings?.recent;
  const result: NportAccession[] = [];
  if (!recent || !Array.isArray(recent.form)) return result;
  for (let i = 0; i < recent.form.length; i++) {
    if (recent.form[i] !== 'NPORT-P') continue;
    const accession: string = String(recent.accessionNumber?.[i] || '');
    if (!accession) continue;
    result.push({
      accession,
      filed: String(recent.filingDate?.[i] || ''),
      reportDate: String(recent.reportDate?.[i] || ''),
      url: nportUrlFor(String(submissions.cik || '0'), accession),
    });
  }
  return result;
}

// EDGAR publishes the authoritative "ticker -> registrant CIK + series id"
// table for every ETF and mutual fund class; it is the reliable way to reach a
// fund's own N-PORT-P filing (the full-text search is only a last resort).
export type SecSeriesRef = { cik: string; seriesId: string; classId: string };

export function parseFundTickerMap(payload: JsonRecord): Map<string, SecSeriesRef> {
  const map = new Map<string, SecSeriesRef>();
  const fields: string[] = Array.isArray(payload?.fields) ? payload.fields.map((field: unknown) => String(field)) : [];
  const rows: unknown[] = Array.isArray(payload?.data) ? payload.data : [];
  const at = (row: unknown[], field: string): string => {
    const index = fields.indexOf(field);
    return index >= 0 ? String(row[index] ?? '') : '';
  };
  for (const raw of rows) {
    if (!Array.isArray(raw)) continue;
    const ticker = sanitizeTicker(at(raw, 'symbol'));
    if (!ticker || map.has(ticker)) continue;
    const cik = at(raw, 'cik').replace(/\D/g, '');
    if (!cik || Number(cik) === 0) continue;
    map.set(ticker, {
      cik: cik.padStart(10, '0'),
      seriesId: at(raw, 'seriesId').toUpperCase(),
      classId: at(raw, 'classId').toUpperCase(),
    });
  }
  return map;
}

// Operating-company name -> exchange ticker, so N-PORT positions (which carry
// CUSIP/ISIN but never a ticker) still land in the watchlist with a symbol.
export function parseCompanyTickerMap(payload: JsonRecord): Map<string, string> {
  const map = new Map<string, string>();
  const rows = payload && typeof payload === 'object' ? Object.values(payload as JsonRecord) : [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as JsonRecord;
    const ticker = cleanHoldingTicker(record.ticker);
    const title = String(record.title ?? '');
    if (!ticker || !title) continue;
    for (const key of [normalizeHoldingName(title), normalizeHoldingNameCore(title)]) {
      if (key && !map.has(key)) map.set(key, ticker);
    }
  }
  return map;
}

export function edgarSeriesFilingsUrl(seriesId: string, count = 10): string {
  const params = new URLSearchParams({
    action: 'getcompany',
    CIK: String(seriesId || '').toUpperCase(),
    type: 'NPORT-P',
    dateb: '',
    owner: 'include',
    count: String(count),
    output: 'atom',
  });
  return `${EDGAR_BROWSE_URL}?${params.toString()}`;
}

// browse-edgar's Atom feed for one series: the newest N-PORT-P accessions of
// exactly that fund, newest first.
export function parseEdgarAtomFilings(xml: string): NportAccession[] {
  const result: NportAccession[] = [];
  for (const entry of String(xml || '').matchAll(/<entry>([\s\S]*?)<\/entry>/gi)) {
    const body = entry[1];
    const form = tagValue(body, 'filing-type') || tagValue(body, 'type');
    if (form && form.toUpperCase() !== 'NPORT-P') continue;
    const accession = tagValue(body, 'accession-number') || tagValue(body, 'accession-nunber');
    if (!accession) continue;
    const hrefMatch = /<filing-href>([\s\S]*?)<\/filing-href>/i.exec(body);
    const cikMatch = hrefMatch ? /\/edgar\/data\/(\d+)\//.exec(cleanText(hrefMatch[1])) : null;
    result.push({
      accession,
      filed: tagValue(body, 'filing-date'),
      reportDate: tagValue(body, 'period') || '',
      url: nportUrlFor(cikMatch ? cikMatch[1] : accession.slice(0, 10), accession),
    });
  }
  return result;
}

function tagValue(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return match ? cleanText(match[1]) : '';
}

export type NportHolding = JsonRecord;

export type ParsedNport = {
  regName: string;
  regCik: string;
  seriesName: string;
  seriesId: string;
  repPdDate: string;
  holdings: NportHolding[];
  totalValue: number;
  netAssets: number | null;
};

// Minimal, forgiving N-PORT-P XML reader (machine-generated schemas only),
// in the same spirit as SPDR's hand-rolled ZIP/OOXML workbook reader.
export function parseNport(xml: string): ParsedNport {
  const genInfoMatch = /<genInfo>([\s\S]*?)<\/genInfo>/i.exec(xml);
  const genInfo = genInfoMatch ? genInfoMatch[1] : String(xml || '').slice(0, 4000);
  const fundInfoMatch = /<fundInfo>([\s\S]*?)<\/fundInfo>/i.exec(xml);
  const fundInfo = fundInfoMatch ? fundInfoMatch[1] : '';
  const holdings: NportHolding[] = [];
  const blockRe = /<invstOrSec>([\s\S]*?)<\/invstOrSec>/g;
  let block: RegExpExecArray | null;
  let totalValue = 0;
  while ((block = blockRe.exec(xml)) !== null) {
    const body = block[1];
    const name = tagValue(body, 'name') || tagValue(body, 'title') || '-';
    const cusip = tagValue(body, 'cusip');
    let identifier = cusip && cusip.toUpperCase() !== 'N/A' ? cusip : '';
    if (!identifier) {
      // Real EDGAR schema: <identifiers><isin value="..."/><other value="..."/></identifiers>
      for (const tagMatch of body.matchAll(/<(isin|sedol|other|cusip)[^>]*value="([^"]+)"/gi)) {
        identifier = cleanText(tagMatch[2]);
        if (identifier) break;
      }
    }
    const weight = normalizeNumberText(tagValue(body, 'pctVal'));
    const valueMatch = /<valUSD[^>]*>([\s\S]*?)<\/valUSD>/i.exec(body);
    const valueText = valueMatch ? valueMatch[1].replace(/[,\s]/g, '') : tagValue(body, 'curVal');
    const value = valueText === '' ? null : Number(valueText); // a missing value stays missing, never 0
    const balance = normalizeNumberText(tagValue(body, 'balance'));
    holdings.push({
      Name: name,
      Ticker: '-',
      Identifier: identifier || '-',
      Weight: weight,
      'Market Value': value !== null && Number.isFinite(value) ? String(value) : '',
      'Shares Held': balance === '' ? '-' : balance,
      'Asset Category': tagValue(body, 'assetCat') || '-',
    });
    if (value !== null && Number.isFinite(value)) totalValue += value;
  }
  return {
    regName: tagValue(genInfo, 'regName'),
    regCik: tagValue(genInfo, 'regCik'),
    seriesName: tagValue(genInfo, 'seriesName'),
    seriesId: tagValue(genInfo, 'seriesId'),
    repPdDate: toIsoDate(tagValue(genInfo, 'repPdDate')),
    holdings,
    totalValue,
    netAssets: numberOrNull(normalizeNumberText(tagValue(fundInfo, 'netAssets'))),
  };
}

// EDGAR full-text search maps a fund ticker to the registrant that filed its
// N-PORT-P, so the fallback finds the right filing without a hand-kept table;
// no registrant is guessed: without a ticker-table or search hit the fallback gives up.
export function eftsSearchUrl(query: string): string {
  const params = new URLSearchParams({
    q: `"${query}"`,
    forms: 'NPORT-P',
    dateRange: 'custom',
    start: '0',
    end: String(25),
  });
  return `${SEC_EFTS_HOST}/search-index?${params.toString()}`;
}

export function pickEftsCik(payload: JsonRecord, fundName: string): string | null {
  // EDGAR returns { hits: { hits: [...] } }; older/simplified payloads (and the
  // unit-test fixtures) use a flat { hits: [...] } array.
  const hits: unknown[] = Array.isArray(payload?.hits)
    ? (payload.hits as unknown[])
    : Array.isArray((payload?.hits as JsonRecord)?.hits)
      ? ((payload.hits as JsonRecord).hits as unknown[])
      : [];
  const wanted = normalizeHoldingName(fundName);
  for (const raw of hits) {
    if (!raw || typeof raw !== 'object') continue;
    const hit = raw as JsonRecord;
    const source = (hit._source || {}) as JsonRecord;
    const display = source.display_names;
    // Real payload: display_names is ["NAME  (CIK 0001209466)", ...].
    const names: string[] = Array.isArray(display)
      ? display.map((entry: unknown) => String(entry))
      : Array.isArray((display as JsonRecord)?.names)
        ? ((display as JsonRecord).names as unknown[]).map((entry) => String(entry))
        : [];
    const fromDisplay = names.map((name) => /\(CIK\s*(\d{4,10})\)/i.exec(name)).find(Boolean);
    const ciks: string[] = Array.isArray(source.ciks) ? source.ciks.map((entry: unknown) => String(entry)) : [];
    const rawCik = String((display as JsonRecord)?.cik || fromDisplay?.[1] || ciks[0] || '');
    const cik = rawCik.replace(/\D/g, '').padStart(10, '0');
    if (!cik || cik === '0000000000') continue;
    if (wanted && names.length) {
      const matched = names.some((name) => {
        const normalized = normalizeHoldingName(name.replace(/\(CIK\s*\d+\)/i, ''));
        return normalized && (wanted.includes(normalized) || normalized.includes(wanted));
      });
      if (!matched) continue;
    }
    return cik;
  }
  return null;
}

export type ChartDay = { date: string; close: number; adjClose: number; volume: number };

export type ParsedChart = {
  exchangeName: string;
  longName: string;
  navPrice: number | null;
  regularMarketPrice: number | null;
  regularMarketTime: number | null;
  firstTradeDate: number | null;
  days: ChartDay[];
  dividends: Array<{ epoch: number; amount: number }>;
};

export function parseChart(payload: JsonRecord): ParsedChart {
  const result = (payload?.chart?.result || [])[0] as JsonRecord | undefined;
  if (!result) throw new Error('chart: empty result');
  const meta = (result.meta || {}) as JsonRecord;
  const timestamps: number[] = result.timestamp || [];
  const quote = ((result.indicators || {}).quote || [])[0] as JsonRecord | undefined;
  const adj = ((result.indicators || {}).adjclose || [])[0] as JsonRecord | undefined;
  const closes: unknown[] = (quote && quote.close) || [];
  const volumes: unknown[] = (quote && quote.volume) || [];
  const adjCloses: unknown[] = (adj && adj.adjclose) || closes;
  const days: ChartDay[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = closes[i];
    if (typeof close !== 'number' || !Number.isFinite(close)) continue;
    const adjClose = typeof adjCloses[i] === 'number' && Number.isFinite(adjCloses[i] as number) ? (adjCloses[i] as number) : close;
    days.push({
      date: epochToIsoDate(timestamps[i]),
      close: round(close, 6),
      // Yahoo recomputes the split/dividend-adjusted close on every request;
      // at 6 decimals the last digit or two jitters between otherwise
      // identical requests, making every history row (and the fund) look
      // "updated" on every single run. 2 decimals is well past any
      // meaningful precision for a price and absorbs that jitter.
      adjClose: round(adjClose, 2),
      volume: typeof volumes[i] === 'number' ? (volumes[i] as number) : 0,
    });
  }
  const events = ((result.events || {}) as JsonRecord).dividends as Record<string, JsonRecord> | undefined;
  const dividends = Object.values(events || {})
    .map((event) => ({ epoch: Number(event.date), amount: Number(event.amount) }))
    .filter((event) => Number.isFinite(event.epoch) && Number.isFinite(event.amount) && event.amount > 0)
    .sort((a, b) => a.epoch - b.epoch);
  return {
    exchangeName: String(meta.fullExchangeName || meta.exchangeName || ''),
    longName: String(meta.longName || meta.shortName || ''),
    navPrice: numberOrNull(meta.navPrice),
    regularMarketPrice: numberOrNull(meta.regularMarketPrice) ?? numberOrNull(meta.previousClose),
    regularMarketTime: numberOrNull(meta.regularMarketTime),
    firstTradeDate: numberOrNull(meta.firstTradeDate),
    days,
    dividends,
  };
}

export function chartUrl(ticker: string, config: Pick<UpdaterConfig, 'historyRange'>, now = Date.now()): string {
  // Explicit period1/period2: `range=max` silently downgrades to monthly bars.
  const period2 = Math.floor(now / 1000);
  let period1 = 0; // "max"
  const yearsMatch = /^(\d+)y$/i.exec(config.historyRange);
  if (yearsMatch) period1 = Math.floor(period2 - Number(yearsMatch[1]) * 365.25 * 86_400);
  return `${YAHOO_CHART_URL}/${encodeURIComponent(ticker)}?period1=${period1}&period2=${period2}&interval=1d&events=div%7Csplit`;
}

// ---------------------------------------------------------------------------
// Derived catalog metrics (unit-tested helpers, sibling parity)
// ---------------------------------------------------------------------------

// (1 + CAGR)^n - 1 - the exact inverse of annualizing (same helper as SPDR).
export function annualizedToTotal(annualizedPercent: number | null | undefined, years: number): number | null {
  if (typeof annualizedPercent !== 'number' || !Number.isFinite(annualizedPercent)) return null;
  if (years <= 0) return null;
  return round(((1 + annualizedPercent / 100) ** years - 1) * 100, 2);
}

export function totalToAnnualized(totalPercent: number | null | undefined, years: number): number | null {
  if (typeof totalPercent !== 'number' || !Number.isFinite(totalPercent)) return null;
  if (years <= 0) return null;
  return round(((1 + totalPercent / 100) ** (1 / years) - 1) * 100, 2);
}

// Indicated yield: latest distribution x payments per year / price - used only
// when the product list publishes no trailing-12-month yield for the fund.
export function indicatedYield(
  latestDistribution: number | null | undefined,
  paymentsPerYear: number | null | undefined,
  price: number | null | undefined,
): number | null {
  if (typeof latestDistribution !== 'number' || typeof paymentsPerYear !== 'number' || typeof price !== 'number') return null;
  if (!Number.isFinite(latestDistribution) || !Number.isFinite(paymentsPerYear) || !Number.isFinite(price) || price <= 0) return null;
  if (paymentsPerYear <= 0 || latestDistribution <= 0) return null;
  return round(((latestDistribution * paymentsPerYear) / price) * 100, 2);
}

export function inferDistributionFrequency(
  dividends: Array<{ epoch: number; amount: number }>,
): { frequency: string; paymentsPerYear: number | null } {
  if (!dividends.length) return { frequency: 'None', paymentsPerYear: null };
  const recent = dividends.slice(-9);
  if (recent.length < 2) return { frequency: 'Unknown', paymentsPerYear: null };
  const gapsDays: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    const gap = (recent[i].epoch - recent[i - 1].epoch) / 86_400;
    if (gap > 14 && gap < 400) gapsDays.push(gap);
  }
  if (!gapsDays.length) return { frequency: 'Unknown', paymentsPerYear: null };
  gapsDays.sort((a, b) => a - b);
  const medianGap = gapsDays[Math.floor(gapsDays.length / 2)];
  if (medianGap >= 300) return { frequency: 'Annually', paymentsPerYear: 1 };
  if (medianGap >= 150) return { frequency: 'Semi-annually', paymentsPerYear: 2 };
  if (medianGap >= 75) return { frequency: 'Quarterly', paymentsPerYear: 4 };
  if (medianGap >= 25) return { frequency: 'Monthly', paymentsPerYear: 12 };
  return { frequency: 'Irregular', paymentsPerYear: null };
}

export type PriceReturns = {
  asOfDate: string;
  ytd: number | null;
  yr1: number | null;
  cagr3y: number | null;
  cagr5y: number | null;
  cagr10y: number | null;
  siAnn: number | null;
  mo1: number | null;
  qtd: number | null;
};

const EMPTY_PRICE_RETURNS: PriceReturns = {
  asOfDate: '', ytd: null, yr1: null, cagr3y: null, cagr5y: null, cagr10y: null, siAnn: null, mo1: null, qtd: null,
};

function pctChange(start: number, end: number): number {
  return round(((end - start) / start) * 100, 2);
}

function annualized(start: number, end: number, years: number): number | null {
  if (start <= 0 || years <= 0) return null;
  return round(((end / start) ** (1 / years) - 1) * 100, 2);
}

// Total returns from an adjusted daily series anchored to the last trading day
// at or before `now`. The series is the Yahoo adjusted market-price history
// (Amplify publishes official NAV returns in its Firestore feed, so these only
// fill the gaps and drive the History-derived blocks).
export function priceReturns(days: ChartDay[], now = new Date(), coveredFrom: string | null = null): PriceReturns {
  const empty: PriceReturns = { ...EMPTY_PRICE_RETURNS };
  if (!days.length) return empty;
  const last = days[days.length - 1];
  // A window is derivable only when its anchor day lies inside the span the
  // adjusted series covers (see reinvestmentCoverageStart).
  const anchored = (day: ChartDay | null): day is ChartDay => day !== null && day.date < last.date && (coveredFrom === null || day.date >= coveredFrom);
  const lastEpoch = Date.parse(`${last.date}T00:00:00Z`) / 1000;
  const atOrBefore = (iso: string): ChartDay | null => {
    const target = Date.parse(`${iso}T00:00:00Z`) / 1000;
    if (Number.isNaN(target)) return null;
    let found: ChartDay | null = null;
    for (const day of days) {
      if (Date.parse(`${day.date}T00:00:00Z`) / 1000 <= target) found = day;
      else break;
    }
    return found;
  };
  const yearsAgo = (years: number): ChartDay | null => {
    const date = new Date(now.getTime());
    date.setUTCFullYear(date.getUTCFullYear() - years);
    return atOrBefore(date.toISOString().slice(0, 10));
  };
  const ytdStart = atOrBefore(`${now.getUTCFullYear()}-01-01`);
  const mo1Start = new Date(now.getTime() - 31 * 86_400_000).toISOString().slice(0, 10);
  const quarterStart = `${now.getUTCFullYear()}-${String(Math.floor(now.getUTCMonth() / 3) * 3 + 1).padStart(2, '0')}-01`;
  const year1 = yearsAgo(1);
  const year3 = yearsAgo(3);
  const year5 = yearsAgo(5);
  const year10 = yearsAgo(10);
  const first = days[0];
  const siYears = (lastEpoch - Date.parse(`${first.date}T00:00:00Z`) / 1000) / (365.25 * 86_400);
  const mo1StartDay = atOrBefore(mo1Start);
  const qtdStartDay = atOrBefore(quarterStart);
  return {
    asOfDate: last.date,
    ytd: anchored(ytdStart) && ytdStart.adjClose > 0 ? pctChange(ytdStart.adjClose, last.adjClose) : null,
    yr1: anchored(year1) ? pctChange(year1.adjClose, last.adjClose) : null,
    cagr3y: anchored(year3) ? annualized(year3.adjClose, last.adjClose, 3) : null,
    cagr5y: anchored(year5) ? annualized(year5.adjClose, last.adjClose, 5) : null,
    cagr10y: anchored(year10) ? annualized(year10.adjClose, last.adjClose, 10) : null,
    siAnn: siYears >= 0.75 && anchored(first) ? annualized(first.adjClose, last.adjClose, siYears) : null,
    mo1: anchored(mo1StartDay) ? pctChange(mo1StartDay.adjClose, last.adjClose) : null,
    qtd: anchored(qtdStartDay) ? pctChange(qtdStartDay.adjClose, last.adjClose) : null,
  };
}

// Resolver validates fund identity: the latest filing for a trust is NOT necessarily this ETF's filing.
let fundTickerPromise:Promise<Map<string,SecSeriesRef>>|null=null;
let companyTickerPromise:Promise<Map<string,string>>|null=null;
const submissionsCache=new Map<string,Promise<JsonRecord>>();
export function resetSecCaches():void { fundTickerPromise=null; companyTickerPromise=null; submissionsCache.clear(); }
async function loadFundTickerMap(config:UpdaterConfig):Promise<Map<string,SecSeriesRef>> {
  return fundTickerPromise??=fetchJson(SEC_FUND_TICKERS_URL,'[ edgar    ] ticker table',secHeaders(config),config).then(parseFundTickerMap).catch(e=>{
    console.warn(`[ edgar    ] ticker table unavailable: ${errorMessage(e)} - retaining published data when needed`);return new Map();
  });
}
async function loadCompanyTickerMap(config:UpdaterConfig):Promise<Map<string,string>> {
  return companyTickerPromise??=fetchJson(SEC_COMPANY_TICKERS_URL,'[ edgar    ] company table',secHeaders(config),config).then(parseCompanyTickerMap).catch(e=>{outputNote(`[ edgar    ] ${errorMessage(e)}`);return new Map();});
}
export function nportMatches(fund:NamedFund,parsed:ParsedNport,ref?:SecSeriesRef):boolean {
  if (ref && parsed.regCik.replace(/^0+/,'')!==ref.cik.replace(/^0+/,'')) return false;
  if (ref?.seriesId) return parsed.seriesId===ref.seriesId;
  // Exact normalized series name only: no first-filing or partial-name guesses.
  return parsed.seriesName.toLowerCase().replace(/[^a-z0-9]/g,'')===fund.name.toLowerCase().replace(/[^a-z0-9]/g,'');
}
export async function resolveNportFiling(fund:NamedFund,config:UpdaterConfig):Promise<JsonRecord|null> {
  const table=await loadFundTickerMap(config), ref=table.get(fund.ticker);
  let candidates:NportAccession[]=[];
  if (ref?.seriesId) {
    try {candidates=parseEdgarAtomFilings(await fetchText(edgarSeriesFilingsUrl(ref.seriesId),'[ edgar    ] series',secHeaders(config),config));}
    catch(e){outputNote(`[ edgar    ] ${fund.ticker}: ${errorMessage(e)}`);}
  }
  let cik=ref?.cik;
  if (!cik) {
    try {cik=pickEftsCik(await fetchJson(eftsSearchUrl(fund.name),'[ edgar    ] discovery',secHeaders(config),config),fund.name)??undefined;}
    catch(e){outputNote(`[ edgar    ] ${fund.ticker}: ${errorMessage(e)}`);}
  }
  // The XML series has to match this fund before any holdings row is published.
  if (!candidates.length && cik) {
    try {
      if (!submissionsCache.has(cik)) submissionsCache.set(cik,fetchJson(`${SEC_DATA_HOST}/submissions/CIK${cik}.json`,'[ edgar    ] submissions',secHeaders(config),config));
      candidates=parseNportAccessions(await submissionsCache.get(cik)!);
    } catch(e){outputNote(`[ edgar    ] ${fund.ticker}: ${errorMessage(e)}`);}
  }
  for (const accession of candidates.slice(0,40)) {
    try {
      const xml=await fetchText(accession.url,`[ edgar    ] ${fund.ticker} N-PORT`,secHeaders(config),config);
      const parsed=parseNport(xml);
      if (!nportMatches(fund,parsed,ref) || !parsed.holdings.length) continue;
      const names=await loadCompanyTickerMap(config);
      const rows=parsed.holdings.map(row=>({...row,Ticker:names.get(normalizeHoldingName(row.Name))||names.get(normalizeHoldingNameCore(row.Name))||''}));
      return {rows:sortHoldings(rows),headers:HOLDINGS_HEADERS,asOfDate:parsed.repPdDate,source:accession.url,status:'available'};
    } catch(e){outputNote(`[ edgar    ] ${fund.ticker}: ${errorMessage(e)}`);}
  }
  return null;
}

// ---------------------------------------------------------------------------
// Deterministic writers (iShares/SPDR/Fidelity-style)
// ---------------------------------------------------------------------------
const pad3 = (value: number): string => String(value).padStart(3, '0');

function samePublishedContent(previous: string, value: unknown): boolean {
  try { return outputContentKey(JSON.parse(previous)) === outputContentKey(value); }
  catch { return false; }
}

async function readJson(file: URL): Promise<JsonRecord | null> {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

async function writeIfChanged(file: URL, value: unknown): Promise<boolean> {
  const previous = await readFile(file, 'utf8').catch(() => '');
  if (samePublishedContent(previous, value)) return false;
  await mkdir(new URL('./', file), { recursive: true });
  const temp = new URL(`${file.href}.tmp`);
  await writeFile(temp, JSON.stringify(value, null, 1) + '\n');
  await rename(temp, file);
  return true;
}

async function removeStalePages(fundDir: URL, kind: 'holdings' | 'history', kept: Set<string>): Promise<boolean> {
  let removed = false;
  let entries: string[] = [];
  try { entries = await readdir(new URL(`${kind}/`, fundDir)); } catch { return false; }
  for (const entry of entries) {
    if (entry.endsWith('.json') && !kept.has(`${kind}/${entry}`)) {
      await rm(new URL(`${kind}/${entry}`, fundDir), { force: true });
      removed = true;
    }
  }
  return removed;
}

async function writePages(
  dir: URL,
  ticker: string,
  kind: 'holdings' | 'history',
  headers: string[],
  rows: JsonRecord[],
  pageSize: number,
): Promise<{ manifest: { pages: string[]; pageSize: number; totalRows: number }; changed: boolean }> {
  const pages: string[] = [];
  let changed = false;
  if (rows.length) {
    const pageCount = Math.ceil(rows.length / pageSize);
    for (let page = 1; page <= pageCount; page++) {
      const name = `${kind}/${pad3(page)}.json`;
      changed = (await writeIfChanged(new URL(name, dir), {
        ticker,
        page,
        pageSize,
        totalRows: rows.length,
        headers,
        rows: rows.slice((page - 1) * pageSize, page * pageSize),
      })) || changed;
      pages.push(name);
    }
  }
  changed = (await removeStalePages(dir, kind, new Set(pages))) || changed;
  return { manifest: { pages, pageSize, totalRows: rows.length }, changed };
}

async function readPreviousSheet(ticker: string, kind: 'holdings' | 'history'): Promise<JsonRecord[]> {
  const rows: JsonRecord[] = [];
  for (let page = 1; ; page++) {
    const payload = await readJson(new URL(`funds/${ticker}/${kind}/${pad3(page)}.json`, apiRoot));
    if (!payload) return rows;
    rows.push(...(payload.rows || []));
    const totalRows = numberOrNull(payload.totalRows);
    if ((totalRows !== null && rows.length >= totalRows) || !(payload.rows || []).length) return rows;
  }
}

async function readPreviousSheetHeaders(ticker: string, kind: 'holdings' | 'history'): Promise<string[]> {
  const payload = await readJson(new URL(`funds/${ticker}/${kind}/${pad3(1)}.json`, apiRoot));
  return Array.isArray(payload?.headers) ? (payload!.headers as string[]) : [];
}

// ---------------------------------------------------------------------------
// History, dividends, returns and metrics
// ---------------------------------------------------------------------------
const HISTORY_HEADERS = ['Date', 'Close', 'Adj Close', 'Volume'];

function historyRows(days: ChartDay[]): JsonRecord[] {
  return days.map(day => ({
    Date: formatEdgarDate(day.date),
    Close: String(day.close),
    'Adj Close': String(day.adjClose),
    Volume: String(day.volume),
  }));
}

// Array rows (not objects): meta.distributions feeds renderDistributionsTable directly, same as the siblings.
function distributionRows(dividends: Dividend[]): string[][] {
  return dividends.map(dividend => [formatUsDate(dividend.epoch), String(round(dividend.amount, 6))]);
}

type Dividend = { epoch: number; amount: number };

export function mergeHistory(previous: JsonRecord[], fresh: ChartDay[]): JsonRecord[] {
  const byDate = new Map<string, JsonRecord>();
  for (const row of previous) {
    const epoch = Date.parse(String(row.Date));
    if (Number.isFinite(epoch)) byDate.set(new Date(epoch).toISOString().slice(0, 10), row);
  }
  for (const row of historyRows(fresh)) {
    const key = new Date(Date.parse(row.Date)).toISOString().slice(0, 10), published = byDate.get(key);
    // Yahoo recomputes adjusted closes on every request. A value that sits on a .xx5 rounding
    // boundary flips the published cent back and forth between otherwise identical requests,
    // and the feed would churn on every run. A published row therefore keeps its cent while
    // the fresh value moves by less than two cents; a genuine restatement or dividend
    // adjustment is larger and replaces the row normally.
    const freshAdj = numberOrNull(row['Adj Close']), publishedAdj = published ? numberOrNull(published['Adj Close']) : null;
    if (freshAdj !== null && publishedAdj !== null && Math.abs(freshAdj - publishedAdj) < 0.02) row['Adj Close'] = published!['Adj Close'];
    byDate.set(key, row);
  }
  return [...byDate].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row);
}

function chartDaysFromRows(rows: JsonRecord[]): ChartDay[] {
  return rows.flatMap(row => {
    const date = new Date(Date.parse(String(row.Date))), close = numberOrNull(row.Close), adjClose = numberOrNull(row['Adj Close']);
    return Number.isFinite(date.getTime()) && close !== null && adjClose !== null
      ? [{ date: date.toISOString().slice(0, 10), close, adjClose, volume: numberOrNull(row.Volume) ?? 0 }]
      : [];
  });
}

function previousDividends(meta: JsonRecord): Dividend[] {
  return (meta.distributions?.rows ?? []).flatMap((row: any[]) => {
    const date = isoDate(row[0]), amount = numberOrNull(row[1]);
    return date && amount !== null ? [{ epoch: Date.parse(date) / 1000, amount }] : [];
  });
}

/** Published rows, then Yahoo dividend events, then Firestore distribution documents (same ex-date: the later source wins). */
export function mergeDividends(old: JsonRecord, chart: ParsedChart | null, official: Dividend[] = []): Dividend[] {
  const byDate = new Map(previousDividends(old).map(dividend => [epochToIsoDate(dividend.epoch), dividend]));
  for (const dividend of chart?.dividends ?? []) byDate.set(epochToIsoDate(dividend.epoch), dividend);
  for (const dividend of official) byDate.set(epochToIsoDate(dividend.epoch), dividend);
  return [...byDate.values()].sort((a, b) => a.epoch - b.epoch);
}

function firestoreDividends(docs: DecodedDoc[]): Dividend[] {
  return docs.flatMap(doc => {
    const date = isoDate(doc.fields.exDate || doc.id), amount = numberOrNull(doc.fields.amount);
    return date && amount !== null && amount > 0 ? [{ epoch: Date.parse(date) / 1000, amount }] : [];
  });
}

// Official NAV month-end / quarter-end block from a Firestore performance document (YTD and 1Y are
// period returns, 3Y/5Y/10Y/SI are annualized). Amplify publishes trailing 3M, not quarter-to-date,
// so qtd stays unset here and is only ever filled from the Yahoo adjusted closes.
export function officialReturns(doc: DecodedDoc | null): JsonRecord | null {
  if (!doc || doc.error || !doc.fields) return null;
  const rows: JsonRecord[] = Array.isArray(doc.fields.returns) ? doc.fields.returns : [];
  const nav = rows.find(row => String(row.type || '').toUpperCase() === 'NAV');
  const asOf = isoDate(doc.fields.asOfDate || doc.id);
  if (!nav || !nav.returns || !asOf) return null;
  const r: JsonRecord = nav.returns;
  return {
    asOfDate: formatEdgarDate(asOf),
    ytd: numberOrNull(r.YTD),
    yr1: numberOrNull(r['1Y']),
    yr3: numberOrNull(r['3Y']),
    yr5: numberOrNull(r['5Y']),
    yr10: numberOrNull(r['10Y']),
    sinceInception: numberOrNull(r.SI_Ann),
    mo1: numberOrNull(r['1M']),
    qtd: null,
  };
}

export function buildMetrics(month: JsonRecord | null, derived: PriceReturns, secYield: number | null, divYield: number | null): JsonRecord {
  const ytd = month?.ytd ?? derived.ytd, tr1y = month?.yr1 ?? derived.yr1;
  const cagr3y = month?.yr3 ?? derived.cagr3y, cagr5y = month?.yr5 ?? derived.cagr5y, cagr10y = month?.yr10 ?? derived.cagr10y;
  return {
    ytd, tr1y, cagr3y, cagr5y, cagr10y,
    tr3y: annualizedToTotal(cagr3y, 3), tr5y: annualizedToTotal(cagr5y, 5), tr10y: annualizedToTotal(cagr10y, 10),
    siAnn: month?.sinceInception ?? derived.siAnn,
    secYield, secYieldText: percent(secYield), dividendYield: divYield, dividendYieldText: percent(divYield),
  };
}

function metricsForFilters(aum: number | null, ter: number | null, metrics: JsonRecord): FundMetrics {
  return {
    netAssetsValue: aum,
    expenseRatioPercent: ter,
    dividendYield: numberOrNull(metrics.dividendYield),
    secYield: numberOrNull(metrics.secYield),
    returns: { YTD: metrics.ytd ?? null, '1Y': metrics.tr1y ?? null, '3Y': metrics.cagr3y ?? null, '5Y': metrics.cagr5y ?? null, '10Y': metrics.cagr10y ?? null },
  };
}

// ---------------------------------------------------------------------------
// Fund assembly
// ---------------------------------------------------------------------------
export type FundOutcome = { row: JsonRecord | null; changed: boolean; reason?: string; detail: JsonRecord; warnings: string[] };

export async function processFund(fund: CatalogFund, config: UpdaterConfig, previousIndex: JsonRecord): Promise<FundOutcome> {
  const { ticker, category } = fund;
  const dir = new URL(`funds/${ticker}/`, apiRoot);
  const old = (await readJson(new URL('meta.json', dir))) ?? {};
  const warnings: string[] = [];
  const failed = new Set<string>();
  // A failing Firestore document is reported on the fund's result line; published values are kept only for failed sources.
  const guard = <T>(source: string, action: () => Promise<T | null>): Promise<T | null> =>
    action().catch(error => { failed.add(source); warnings.push(`${source}: ${errorMessage(error)}`); return null; });
  const [metaDoc, dailyDoc, holdingsDoc, yieldsDoc, monthlyDoc, quarterlyDoc, distributionDocs] = await Promise.all([
    guard('metadata', () => fetchFirestoreDoc(['funds', ticker, 'fund_metadata', 'overview'])),
    guard('daily', () => fetchLatestCollectionDoc(['funds', ticker, 'daily'])),
    guard('holdings', () => fetchLatestCollectionDoc(['funds', ticker, 'holdings'])),
    guard('yields', () => fetchLatestCollectionDoc(['funds', ticker, 'yields'])),
    guard('monthly performance', () => fetchLatestCollectionDoc(['funds', ticker, 'performance_monthly'])),
    guard('quarterly performance', () => fetchLatestCollectionDoc(['funds', ticker, 'performance_quarterly'])),
    fetchDistributions(ticker).catch(error => { outputNote(`[ fallback ] ${ticker} distributions: ${errorMessage(error)}`); return [] as DecodedDoc[]; }),
  ]);
  const meta: JsonRecord = metaDoc?.fields ?? {};
  const daily: JsonRecord = dailyDoc?.fields ?? {};
  const yields: JsonRecord = normalizeAsOfDoc(yieldsDoc) ?? {};
  const kept = <T>(source: string, fresh: T | null, previous: T | null | undefined): T | null =>
    fresh ?? (failed.has(source) ? previous ?? null : null);

  const fundName = cleanText(meta.DisplayName || meta.FundName || meta.Name) || cleanText(old.name) || ticker;
  const nav = kept('daily', finiteNumber(daily.NAV), numberOrNull(old.nav?.value));
  const aum = kept('daily', finiteNumber(daily.NetAssets), numberOrNull(old.aum?.value));
  const expenseFraction = finiteNumber(meta.ExpenseRatio);
  const ter = kept('metadata', expenseFraction === null ? null : round(expenseFraction * 100, 4), numberOrNull(old.expenseRatio?.value));
  const secYield = kept('yields', parsePercent(yields['30_Day_SECYield']), numberOrNull(old.yields?.secYield));
  const officialYield = kept('yields', parsePercent(yields.Distribution_Yield), null);

  // Evaluate headline filters that Firestore decides on its own before any history or SEC download.
  const early = fundFilterReasons(metricsForFilters(aum, ter, { secYield }), {
    ...config, dividendYieldRange: undefined, performanceRanges: {}, totalReturnRanges: {},
  });
  if (early.length) return { row: null, changed: false, reason: early.join('; '), detail: {}, warnings };

  // Holdings: Firestore first, SEC N-PORT-P next, the previously published sheet as the last resort.
  let holdings: JsonRecord | null = null;
  const firestoreRows = (Array.isArray(holdingsDoc?.fields.holdings) ? (holdingsDoc!.fields.holdings as JsonRecord[]) : [])
    .map(holdingsRowFromFirestore)
    .filter((row): row is JsonRecord => row !== null);
  if (firestoreRows.length) {
    const source = cleanText(holdingsDoc!.fields.source);
    holdings = {
      rows: sortHoldings(firestoreRows), headers: HOLDINGS_HEADERS,
      asOfDate: isoDate(holdingsDoc!.fields.asOfDate || holdingsDoc!.id),
      source: `amplifyetfs.com Firestore holdings feed${source ? ` (${source})` : ''}`, status: 'available',
    };
  }
  if (!holdings && config.edgarFallback) holdings = await optional(`${ticker} SEC holdings`, () => resolveNportFiling({ ...fund, name: fundName }, config));
  if (!holdings) {
    const rows = await readPreviousSheet(ticker, 'holdings'), headers = await readPreviousSheetHeaders(ticker, 'holdings');
    if (old.holdings?.totalRows && rows.length !== old.holdings.totalRows) throw new Error(`${ticker}: previous holdings incomplete; refusing overwrite`);
    holdings = {
      rows, headers: headers.length ? headers : HOLDINGS_HEADERS, asOfDate: old.holdings?.asOfDate ?? null,
      source: old.holdings?.source ?? 'unavailable from Firestore or SEC N-PORT-P',
      status: old.holdings?.status ?? (rows.length ? 'available' : 'unavailable'),
    };
  }

  // Daily market-price history and dividend events from Yahoo Finance.
  const chart = config.skipYahoo ? null : await optional(`${ticker} Yahoo`, async () =>
    parseChart(await fetchJson(chartUrl(ticker, config), `[ chart    ] ${ticker}`, yahooHeaders(), config)));
  const oldHistory = await readPreviousSheet(ticker, 'history');
  if (old.history?.totalRows && oldHistory.length !== old.history.totalRows) throw new Error(`${ticker}: previous history incomplete; refusing overwrite`);
  const history = chart?.days.length ? mergeHistory(oldHistory, chart.days) : oldHistory;
  const days = chartDaysFromRows(history);
  const dividends = mergeDividends(old, chart, firestoreDividends(distributionDocs)), latest = dividends.at(-1) ?? null;
  const frequency = dividends.length
    ? inferDistributionFrequency(dividends)
    : old.distributions?.frequency && old.distributions.frequency !== '—'
      ? { frequency: String(old.distributions.frequency), paymentsPerYear: numberOrNull(old.distributions.paymentsPerYear) }
      : { frequency: '—', paymentsPerYear: null };

  const navDate = isoDate(daily.asOfDate || dailyDoc?.id);
  const price = kept('daily', finiteNumber(daily.MarketPrice), null) ?? chart?.regularMarketPrice ?? numberOrNull(old.marketPrice?.value);
  const priceDate = (finiteNumber(daily.MarketPrice) !== null ? navDate : null) ?? (chart?.regularMarketTime ? epochToIsoDate(chart.regularMarketTime) : null);
  // Never compute a premium from prices belonging to different days.
  const publishedPremium = finiteNumber(daily.PremiumDiscount);
  const premium = publishedPremium !== null ? round(publishedPremium, 4)
    : nav !== null && nav > 0 && price !== null && navDate && priceDate && navDate === priceDate
      ? round((price / nav - 1) * 100, 2)
      : kept('daily', null, numberOrNull(old.premiumDiscount?.value));
  const divYield = officialYield ?? indicatedYield(latest?.amount ?? null, frequency.paymentsPerYear, price) ?? numberOrNull(old.yields?.dividendYield);

  let month: JsonRecord | null = officialReturns(monthlyDoc) ?? old.returns?.monthEnd ?? null;
  const quarter: JsonRecord | null = officialReturns(quarterlyDoc) ?? old.returns?.quarterEnd ?? null;
  const anchor = month?.asOfDate ? new Date(Date.parse(month.asOfDate)) : days.length ? new Date(`${days.at(-1)!.date}T00:00:00Z`) : null;
  const usable = anchor ? days.filter(day => Date.parse(day.date) <= anchor.getTime()) : [];
  const derived = usable.length ? priceReturns(usable, anchor!) : { ...EMPTY_PRICE_RETURNS };
  // A range-limited Yahoo download is not a since-inception return.
  if (!chart?.firstTradeDate || !days.length || Date.parse(days[0].date) / 1000 - chart.firstTradeDate > 7 * 86400) derived.siAnn = null;
  const hasOfficialReturns = Boolean(officialReturns(monthlyDoc)) || Boolean(month && !String(old.returns?.derivedFrom ?? '').startsWith('Yahoo adjusted'));
  const metrics = buildMetrics(month, derived, secYield, divYield);
  if (month) month = { ...month, ytd: month.ytd ?? derived.ytd, mo1: month.mo1 ?? derived.mo1, qtd: month.qtd ?? derived.qtd };
  else if (usable.length) month = { asOfDate: formatEdgarDate(derived.asOfDate), mo1: derived.mo1, qtd: derived.qtd, ytd: derived.ytd, yr1: derived.yr1, yr3: derived.cagr3y, yr5: derived.cagr5y, yr10: derived.cagr10y, sinceInception: derived.siAnn };
  const filtered = fundFilterReasons(metricsForFilters(aum, ter, metrics), config);
  if (filtered.length) return { row: null, changed: false, reason: filtered.join('; '), detail: {}, warnings };
  // No fresh source must not null fields from the last successful publication.
  const previousMetrics = previousIndex.metrics ?? {};
  for (const key of Object.keys(metrics)) if (metrics[key] === null && previousMetrics[key] !== undefined) metrics[key] = previousMetrics[key];
  if (!metaDoc && !dailyDoc && !chart && !Object.keys(old).length) throw new Error(`${ticker}: no usable per-fund source`);

  const holdingsOut = await writePages(dir, ticker, 'holdings', holdings.headers, holdings.rows, config.holdingsPageSize);
  const oldHistoryHeaders = await readPreviousSheetHeaders(ticker, 'history');
  const historyOut = await writePages(dir, ticker, 'history', chart?.days.length ? HISTORY_HEADERS : oldHistoryHeaders.length ? oldHistoryHeaders : HISTORY_HEADERS, history, config.historyPageSize);
  const historySource = chart?.days.length ? 'Yahoo Finance daily market-price closes / adjusted closes (not official NAV)' : old.history?.source ?? 'unavailable';
  const returnsBasis = hasOfficialReturns
    ? 'official Amplify NAV month-end/quarter-end total returns (Firestore performance feed); missing metrics derived from Yahoo adjusted closes at the same reporting date'
    : 'Yahoo adjusted market-price returns, not official NAV';
  const exchange = cleanText(meta.PrimaryExchange) || cleanText(old.inception?.exchange) || chart?.exchangeName || '';
  const fundInception = isoDate(meta.InceptionDate || meta.LaunchDate) ?? old.inception?.fundInceptionDate ?? null;
  const categoryName = cleanText(category) || cleanText(old.category) || 'ETF';
  const fundPage = `${AMPLIFY_SITE}/${encodeURIComponent(ticker)}/`;
  const holdingsPage = `${AMPLIFY_SITE}/${encodeURIComponent(ticker.toLowerCase())}-holdings/`;
  const asOfLabel = navDate ? formatEdgarDate(navDate) : null;
  const metaOut = {
    ticker, name: fundName, category: categoryName, categoryPath: categoryName,
    source: {
      fundPage, catalog: `${FIRESTORE_BASE}/fund_category`, holdingsDownload: holdingsPage, holdingsSource: holdings.source, historySource,
      yahooChart: `${YAHOO_CHART_URL}/${ticker}`,
      provider: 'Amplify ETFs Firestore data feed (amplify-etfs-data-feed); SEC EDGAR N-PORT-P holdings fallback; Yahoo Finance market-history/dividend data',
    },
    providerIds: { fundPage, holdingsPage },
    legalStructure: cleanText(meta.FundType) || old.legalStructure || null,
    identifiers: {
      cusip: cleanText(meta.CUSIP) || old.identifiers?.cusip || null,
      isin: cleanText(meta.ISIN) || old.identifiers?.isin || null,
      sedol: cleanText(meta.SEDOL) || old.identifiers?.sedol || null,
      indexTicker: cleanText(meta.UnderlyingIndexTicker) || old.identifiers?.indexTicker || null,
    },
    inception: { fundInceptionDate: fundInception, shareClassInceptionDate: isoDate(meta.LaunchDate) ?? old.inception?.shareClassInceptionDate ?? null, exchange },
    expenseRatio: { display: percent(ter), value: ter, gross: ter, net: ter },
    nav: { display: money(nav), value: nav, asOfDate: asOfLabel ?? old.nav?.asOfDate ?? '—' },
    marketPrice: { display: money(price), value: price, asOfDate: priceDate ? formatEdgarDate(priceDate) : old.marketPrice?.asOfDate ?? '—' },
    premiumDiscount: { display: percent(premium), value: premium },
    aum: { display: aum === null ? '—' : formatMoney(aum), value: aum, asOfDate: asOfLabel ?? old.aum?.asOfDate ?? '—', source: aum === null ? old.aum?.source ?? 'unavailable' : 'Amplify Firestore daily net assets' },
    yields: {
      dividendYield: metrics.dividendYield, dividendYieldText: metrics.dividendYieldText,
      dividendYieldKind: officialYield !== null ? 'trailing distribution yield published by Amplify (Firestore yields)' : 'indicated (latest distribution x payments per year / market price)',
      secYield: metrics.secYield, secYieldText: metrics.secYieldText,
      secYieldKind: secYield !== null ? '30-day SEC yield published by Amplify (Firestore yields)' : 'not published',
      unsubsidizedSecYield: parsePercent(yields['30_Day_UnsubSECYield']) ?? old.yields?.unsubsidizedSecYield ?? null,
    },
    returns: { monthEnd: month, quarterEnd: quarter, derivedFrom: returnsBasis },
    distributions: { frequency: frequency.frequency, paymentsPerYear: frequency.paymentsPerYear, headers: ['Ex-Date', 'Amount'], rows: distributionRows(dividends) },
    holdings: { ...holdingsOut.manifest, asOfDate: holdings.asOfDate, asOf: holdings.asOfDate ? formatEdgarDate(holdings.asOfDate) : '—', source: holdings.source, status: holdings.status },
    history: { ...historyOut.manifest, asOf: days.length ? formatEdgarDate(days.at(-1)!.date) : old.history?.asOf ?? '—', source: historySource },
  };
  const metaChanged = await writeIfChanged(new URL('meta.json', dir), metaOut);
  const row = {
    ticker, name: fundName, category: categoryName, fundPage, dataFile: `./funds/${ticker}/meta.json`,
    cusip: metaOut.identifiers.cusip, isin: metaOut.identifiers.isin, ter: metaOut.expenseRatio.display, terValue: ter,
    nav: metaOut.nav.display, navValue: nav, aum: metaOut.aum.display, aumValue: aum,
    asOfDate: metaOut.nav.asOfDate, inceptionDate: fundInception ? formatEdgarDate(fundInception) : '—',
    exchange, closePrice: metaOut.marketPrice.display, closePriceValue: price,
    premiumDiscount: metaOut.premiumDiscount.display, premiumDiscountValue: premium,
    distributions: { frequency: frequency.frequency, exDate: latest ? formatUsDate(latest.epoch) : '—', dividend: latest ? String(round(latest.amount, 6)) : '—' },
    returns: metaOut.returns, metrics, holdings: holdings.rows.length, history: history.length,
  };
  return {
    row, warnings,
    changed: metaChanged || holdingsOut.changed || historyOut.changed || outputContentKey(previousIndex) !== outputContentKey(row),
    detail: {
      holdings: holdings.rows.length, history: history.length, yahooHistoryCount: chart ? chart.days.length : null,
      distributions: dividends, aum, dividendYield: metrics.dividendYield, secYield: metrics.secYield,
    },
  };
}

// ---------------------------------------------------------------------------
// Catalog and run
// ---------------------------------------------------------------------------
async function loadCatalog(): Promise<CatalogFund[]> {
  const docs = await fetchFirestoreListAll(['fund_category'], 200);
  return docs
    .map(doc => ({
      ticker: sanitizeTicker(doc.fields.ticker || doc.id),
      category: doc.fields.category || 'Unknown',
      active: doc.fields.isActive !== false,
    }))
    .filter(fund => fund.ticker && fund.active && fund.category !== 'Unknown')
    .sort((a, b) => a.ticker.localeCompare(b.ticker));
}

export async function runUpdate(env: Record<string, string | undefined> = process.env): Promise<void> {
  const controls = await runtimeControls(env);
  if (controls.VERBOSE !== undefined) process.env.VERBOSE = controls.VERBOSE;
  installSystemCa((controls.USE_SYSTEM_CA ?? 'auto').toLowerCase());
  const config = readConfig(controls);
  outputPrintConfig('Amplify', config);
  httpSettings = { maxRetries: config.maxRetries, requestSleepMs: config.requestSleepSeconds * 1000 };

  const previous = await readJson(indexFile());
  const oldFunds = new Map<string, JsonRecord>((previous?.funds ?? []).map((fund: JsonRecord) => [fund.ticker, fund]));
  const activeCatalog = await loadCatalog();
  if (!activeCatalog.length) throw new Error('Firestore returned no active funds; refusing an empty feed');
  const catalog = selectCatalog(activeCatalog, config);
  outputPrintFilter(catalog.length, activeCatalog.length, outputHasOutputFilters(config));

  const result = new Map(oldFunds);
  let completed = 0, processed = 0, skipped = 0, failures = 0;
  await runFundPool(catalog, config.concurrency, async fund => {
    const index = ++completed;
    try {
      const outcome = await processFund(fund, config, oldFunds.get(fund.ticker) ?? {});
      if (outcome.row) { result.set(fund.ticker, outcome.row); processed++; } else skipped++;
      console.log(outputFundLine(index, catalog.length, fund.ticker, outcome.row ? (outcome.changed ? 'updated' : 'unchanged') : 'skipped', outcome.detail,
        [outcome.reason, ...(outcome.warnings.length ? [`partial refresh: ${outcome.warnings.join('; ')}`] : [])].filter(Boolean).join('; ') || undefined));
    } catch (error) {
      failures++;
      console.log(outputFundLine(index, catalog.length, fund.ticker, 'failed', {}, errorMessage(error)));
    }
  });

  // A full unfiltered pass drops funds Amplify no longer lists as active (and their files).
  if (!hasFilters(config) && !failures) {
    const active = new Set(activeCatalog.map(fund => fund.ticker));
    for (const ticker of [...result.keys()]) {
      if (active.has(ticker)) continue;
      result.delete(ticker);
      await rm(new URL(`funds/${ticker}/`, apiRoot), { recursive: true, force: true });
    }
  }
  if (!result.size) throw new Error('No publishable funds; not replacing the index');
  const funds = [...result.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
  const counts = { funds: funds.length, holdings: funds.reduce((sum, fund) => sum + (fund.holdings ?? 0), 0), history: funds.reduce((sum, fund) => sum + (fund.history ?? 0), 0) };
  const now = new Date().toISOString();
  const indexWritten = await writeIfChanged(indexFile(), {
    generatedAt: now, catalogReadAt: now,
    source: { provider: 'Amplify ETFs', site: CATALOG_PAGE, catalog: `${FIRESTORE_BASE}/fund_category` },
    counts, funds,
  });
  console.log(indexWritten ? `Wrote ${indexFile().pathname}` : 'Fetched data is unchanged; keeping api/amplify/index.json untouched.');
  console.log(`[ done     ] ${processed} funds processed, ${skipped} skipped, ${failures} failures`);
  console.log(`[ done     ] counts: ${counts.funds} funds / ${counts.holdings} holdings rows / ${counts.history} history rows`);
  if (failures) process.exitCode = 1;
}

async function main(): Promise<void> {
  if (wantsHelp(process.argv.slice(2))) {
    printHelp();
    return;
  }
  await runUpdate();
}

if (import.meta.main) {
  main().catch(error => {
    console.error(`[ done     ] ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
