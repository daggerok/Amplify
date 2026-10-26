#!/usr/bin/env bun
/// <reference types="bun" />
/// <reference types="node" />
import { readFile as outputReadFile, readdir as outputReadDir } from 'node:fs/promises';
import { createHash as outputCreateHash } from 'node:crypto';
import { join as outputJoin } from 'node:path';
import { fileURLToPath as outputFileURLToPath } from 'node:url';
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
    skipGlobalX: 'SKIP_GLOBALX', skipNorthernTrust: 'SKIP_NORTHERNTRUST',
  };
  const range = (v: any): string => typeof v === 'string' ? v : v?.source ?? `${Number.isFinite(v?.min) ? v.min : ''}:${Number.isFinite(v?.max) ? v.max : ''}`;
  for (const [key, value] of Object.entries(config)) {
    if (['proxyGapMs', 'fetchTimeoutMs', 'retryDelayMs'].includes(key)) continue;
    const name = aliases[key] ?? (/^[A-Z0-9_]+$/.test(key) ? key : key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase());
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
function outputConfigValue(key: string, value: string): string {
  if (/TOKEN|PASSWORD|SECRET|COOKIE|SEC_UA/i.test(key)) return '<redacted>';
  if (key === 'TICKERS' && ['', 'null', 'undefined'].includes(value)) return 'all';
  return outputClean(value);
}
function outputPrintConfig(brand: string, config: Record<string, any>): void {
  const entries: [string, string][] = [...outputConfigEntries(config), ['VERBOSE', String(outputVerbose())]];
  console.log(`[ config   ] ${brand} updater:\n${entries.map(([key, value]) => `              ${key}=${outputConfigValue(key, value)}`).join('\n')}`);
}
function outputHasOutputFilters(config: Record<string, any>): boolean {
  return outputConfigEntries(config).some(([name, value]) =>
    /^(CATEGORY|AUM|TER|DIVIDEND_YIELD|SEC_YIELD|PERFORMANCE_|TOTAL_RETURN_)/.test(name) &&
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
async function outputInspectFund(root: URL | string, ticker: string): Promise<{ digest: string; meta: any }> {
  const dir = outputJoin(root instanceof URL ? outputFileURLToPath(root) : root, 'funds', ticker);
  const hash = outputCreateHash('sha256');
  async function visit(path: string): Promise<void> {
    const entries = await outputReadDir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) await visit(outputJoin(path, entry.name));
      else if (entry.name.endsWith('.json')) {
        const text = await outputReadFile(outputJoin(path, entry.name), 'utf8').catch(() => '');
        hash.update(outputJoin(path.slice(dir.length), entry.name));
        try { hash.update(outputContentKey(JSON.parse(text))); } catch { hash.update(text); }
      }
    }
  }
  await visit(dir);
  const meta = await outputReadFile(outputJoin(dir, 'meta.json'), 'utf8').then(JSON.parse).catch(() => ({}));
  return { digest: hash.digest('hex'), meta };
}
const outputCount = (value: any): unknown => typeof value === 'number' ? value : Array.isArray(value) ? value.length : value?.totalRows ?? value?.rows?.length ?? null;
const outputScalar = (value: any): any => value && typeof value === 'object' ? value.display ?? value.value ?? null : value;
const outputUnits: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12, THOUSAND: 1e3, MILLION: 1e6, BILLION: 1e9, TRILLION: 1e12 };
function outputMoney(value: any): string {
  const raw = value && typeof value === 'object' && typeof value.value === 'number' && Number.isFinite(value.value) ? value.value : outputScalar(value);
  if (raw === null || raw === undefined || raw === '—' || raw === '--') return 'null';
  const text = String(raw).replace(/[$,\s]/g, '');
  const match = text.match(/^([+-]?[\d.]+)(K|M|B|T|Thousand|Million|Billion|Trillion)?$/i);
  if (!match) return outputClean(raw);
  const number = Number(match[1]) * (outputUnits[match[2]?.toUpperCase() ?? ''] ?? 1);
  if (!Number.isFinite(number)) return 'null';
  for (const [unit, scale] of [['T', 1e12], ['B', 1e9], ['M', 1e6], ['K', 1e3]] as const) {
    if (Math.abs(number) >= scale) return `$${(number / scale).toFixed(1)}${unit}`;
  }
  return `$${number.toFixed(2)}`;
}
/** Yields: rounded to 2 decimals without trailing zeros; placeholders are omitted like null. */
function outputPercent(value: any): unknown {
  const raw = outputScalar(value);
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? Number(raw.toFixed(2)) : null;
  const text = String(raw).trim().replace(/%$/, '').trim();
  if (['', '-', '—', '--', 'n/a'].includes(text.toLowerCase())) return null;
  const number = Number(text.replace(/,/g, ''));
  return Number.isFinite(number) ? Number(number.toFixed(2)) : outputClean(raw);
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
    field('div', outputPercent(data.trailingYield ?? data.yields?.effectiveYield ?? data.yields?.dividendYield ?? data.dividendYield ?? metrics.dividendYield)),
    field('sec', outputPercent(data.secYield ?? data.yields?.secYield ?? metrics.secYield)),
    field('wp', data.workplaceRaw),
  ].filter(part => part !== '').join(' ');
  return `[ ${String(index).padStart(width)}/${String(total).padEnd(width)}  ] ${outputClean(ticker).padEnd(5)} ${status.padEnd(9)}${detail ? ` ${detail}` : ''}${reason ? ` reason=${outputClean(reason)}` : ''}`;
}
function outputCreateReporter(root: URL | string, total: number) {
  let completed = 0;
  const tally = new Map<string, number>();
  return {
    before: (ticker: string) => outputInspectFund(root, ticker),
    async result(ticker: string, before: { digest: string }, status?: string, reason?: unknown, extra: any = {}) {
      const after = await outputInspectFund(root, ticker);
      const final = status ?? (before.digest === after.digest ? 'unchanged' : 'updated');
      tally.set(final, (tally.get(final) ?? 0) + 1);
      console.log(outputFundLine(++completed, total, ticker, final, { ...after.meta, ...extra }, reason));
    },
    /** First [ done ] line: the statuses of every fund line this reporter printed. */
    summary(startedAt: number): string {
      const order = ['updated', 'unchanged', 'kept', 'skipped', 'failed'];
      const statuses = [...order, ...[...tally.keys()].filter(status => !order.includes(status))];
      return `[ done     ] ${completed} fund${completed === 1 ? '' : 's'}: ${statuses.map(status => `${tally.get(status) ?? 0} ${status}`).join(', ')} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
    },
  };
}
/** Second [ done ] line: published totals. */
function outputCounts(funds: number, holdings: number, history: number): string {
  return `[ done     ] counts: ${funds.toLocaleString('en-US')} funds / ${holdings.toLocaleString('en-US')} holdings rows / ${history.toLocaleString('en-US')} history rows`;
}


// Bun provides Node-compatible fs/promises and process globals for this script.
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';

type JsonRecord = Record<string, any>;

const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1/projects/amplify-etfs-data-feed/databases/(default)/documents';
const AMPLIFY_SITE = 'https://amplifyetfs.com';
const CATALOG_PAGE = `${AMPLIFY_SITE}/our-etfs/`;
const YAHOO_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
const YAHOO_BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const SEC_EFTS_HOST = 'https://efts.sec.gov/LATEST';
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

/** ISO `YYYY-MM-DD` from an ISO date or an `Mon DD YYYY` label; null when it is neither (shared calendar-dates block: plain calendar text, no time zone). */
export function performanceAsOfDate(value: unknown): string | null {
  return calendarIso(value);
}

export function epochToIsoDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

export function formatUsDate(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  return `${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')}/${date.getUTCFullYear()}`;
}

// "08/21/2026" / "2026-08-21T00:00:00Z" / "Aug 21, 2026" -> "2026-08-21"; anything else passes through untouched.
export function toIsoDate(raw: unknown): string {
  const text = String(raw ?? '').trim();
  return calendarIso(text) ?? text;
}

/** ISO `YYYY-MM-DD` of a calendar date (ISO, U.S. or month-name text), null otherwise; never read through the local time zone. */
export function isoDate(value: unknown): string | null {
  return calendarIso(value);
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

/**
 * Funds that pass the TICKERS/CATEGORY allowlists, in cursor order for a bounded batch (alphabetical, the fund after the cursor first, wrapping around).
 * Unknown TICKERS entries are rejected before this by assertKnownTickers (shared fund-selection block); a published fund that is
 * not active in the catalog (a closed fund included) is known but not selected here, so it keeps its published data.
 */
export function selectCatalog(catalog: CatalogFund[], config: UpdaterConfig, cursor: string | null = null): CatalogFund[] {
  let selected = catalog;
  if (config.tickers.length) selected = selected.filter(fund => config.tickers.includes(fund.ticker));
  if (config.categories.length) {
    const wanted = new Set(config.categories.map(category => category.toLowerCase()));
    selected = selected.filter(fund => wanted.has(fund.category.toLowerCase()));
  }
  if (config.maxFetches > 0) {
    selected = [...selected].sort((a, b) => a.ticker.localeCompare(b.ticker));
    const at = selected.findIndex(fund => fund.ticker === cursor);
    if (at >= 0) selected = selected.slice(at + 1).concat(selected.slice(0, at + 1));
  }
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

  MAX_FETCHES=0              0 means all selected funds; N > 0 is a resumable batch: N funds that pass the filters, in ticker order from the cursor, wrapping around
  REQUEST_SLEEP=0            Minimum seconds between request starts of each worker lane (retries included)
  CONCURRENCY=6              Funds fetched in parallel, one request in flight per worker (legacy alias AMPLIFY_DATA_CONCURRENCY)
  TICKERS="DIVO IDVO"        Only refresh these tickers (spaces, commas, semicolons); a ticker neither in the catalog nor published is an error before any fund request
  CATEGORY="Income,Thematic" Only refresh these Amplify fund categories (Income, Thematic, Core, International)
  AUM=":"                    Net-assets range min:max; bounds are USD amounts (300M, 2B)
                             or nano/micro/small/mid/large presets; inclusive
  TER=":"                    Net expense-ratio range in % (Amplify publishes a single ratio)
  DIVIDEND_YIELD=":"         Trailing Distribution Yield range in % (trailing 12 months from Yahoo dividends when Amplify publishes none)
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
      Smoke run over three funds; the next run continues after the last one.
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
      if (skipEmpty && (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === ''))) continue;
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

/** HTTP 404 (a missing document, collection or symbol): an honest "nothing published", never a source failure. */
export const isNotFound = (error: unknown): boolean => error instanceof HttpStatusError && error.status === 404;

const isTransient = (error: unknown): boolean =>
  !(error instanceof HttpStatusError) || error.status === 429 || error.status >= 500;

// Every request has a timeout that covers the headers AND the body (the signal stays attached while the body is read).
let fetchTimeoutMs = 45_000;
export function setFetchTimeoutMs(ms: number): void { fetchTimeoutMs = ms; }

// SEC asks for at most 10 requests per second per client: all SEC calls share one gate (>= 150 ms between starts),
// reserved synchronously before waiting, and a 403/429 from SEC is retried with a longer backoff.
const isSecUrl = (url: string): boolean => { try { return new URL(url).hostname.endsWith('sec.gov'); } catch { return false; } };
let secIntervalMs = 150;
let secNextAt = 0;
export function setSecInterval(ms: number): void { secIntervalMs = ms; secNextAt = 0; }
async function secGate(): Promise<void> {
  const now = Date.now();
  const start = Math.max(now, secNextAt);
  secNextAt = start + secIntervalMs;
  if (start > now) await sleep(start - now);
}

/** `fetchWithRetry` messages are prefixed with the fetch label; a caller that prints its own tag must not repeat it. */
function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^\[[^\]]*\] ?/, '');
}

function bodyMessage(text: string): string {
  try { return String(JSON.parse(text)?.error?.message ?? ''); } catch { return ''; }
}

async function fetchWithRetry<T>(url: string, label: string, headers: Record<string, string>, parse: (text: string) => T): Promise<T> {
  const sec = isSecUrl(url);
  for (let attempt = 0; ; attempt++) {
    try {
      return await runInLane(async () => {
        if (sec) await secGate();
        const response = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(fetchTimeoutMs) });
        const text = await response.text();
        if (!response.ok) throw new HttpStatusError(bodyMessage(text) || `${label}: HTTP ${response.status} ${response.statusText}`, response.status);
        return parse(text);
      });
    } catch (error) {
      const transient = isTransient(error) || (sec && error instanceof HttpStatusError && error.status === 403);
      if (attempt >= httpSettings.maxRetries || !transient) throw error;
      outputNote(`retry ${attempt + 1}/${httpSettings.maxRetries} after ${errorMessage(error)}: ${label}`);
      await sleep(Math.min((sec ? 1000 : 250) * 2 ** attempt, 4000));
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

/** Percent figures are published as percent ("0.5%" and 0.5 both mean 0.5%); nothing is rescaled. */
export function parsePercent(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Number.parseFloat(String(value).replace('%', '').trim());
  return Number.isFinite(parsed) ? parsed : null;
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
/** Funds whose holdings legitimately fail a holdingsGuard check (geared, futures, look-through, top-N lists): ticker, or '*' for every fund -> relaxed checks. */
export const HOLDINGS_GUARD_RELAX: Record<string, string[]> = { BDRY: ['sum'], BWET: ['sum'] }; // freight futures funds: weights add up to ~230
/** Funds the issuer closed, each confirmed from an SEC filing or the issuer notice (`source`): never fetched or guarded, last published data kept, index row marked closed. */
export const CLOSED_FUNDS: ClosedFund[] = [];

// Firestore weights are percent strings ("5.38%"); nothing here ever turns a missing value into 0.
const textNumber = (value: unknown): string => {
  const parsed = finiteNumber(typeof value === 'string' ? value.replace('%', '').trim() : value);
  return parsed === null ? '' : String(parsed);
};

/** Firestore `holding_type`s whose StockTicker is no exchange listing: a currency code (`PEN`), `Cash&Other` or a T-bill's CUSIP. */
const UNLISTED_HOLDING_TYPES = ['cash', 'cash_fx', 'treasury'];

/**
 * Is a Firestore row a cash or debt line (published with Ticker `-`)? Its `holding_type` says so, or, without one, its
 * identifier is a cash code (`CASHPEN`, `Cash&Other`). The currency code of a cash line would land on a real U.S. symbol in
 * the Watchlist (PEN is Penumbra, NOK the Nokia ADR); Firestore itself qualifies a non-U.S. listing with its exchange
 * (`BHP AU`, `ASML NA`) and keeps a bare symbol only for a U.S. listing.
 */
export function unlistedHolding(raw: JsonRecord, identifier: string): boolean {
  return UNLISTED_HOLDING_TYPES.indexOf(String(raw.holding_type ?? '').trim().toLowerCase()) >= 0 || /^CASH(?:[A-Z]{3}|&OTHER)$/i.test(identifier.replace(/\s+/g, ''));
}

export function holdingsRowFromFirestore(raw: JsonRecord): JsonRecord | null {
  const ticker = normalizeWhitespace(raw.StockTicker || raw.Ticker || raw.Symbol).toUpperCase();
  const identifier = normalizeWhitespace(raw.CUSIP || raw.ISIN || raw.SEDOL);
  const name = normalizeWhitespace(raw.SecurityName || raw.Name || raw.Description || ticker);
  if (!ticker && !name && !identifier) return null;
  return {
    Name: name || ticker || identifier,
    Ticker: unlistedHolding(raw, identifier) ? '-' : ticker,
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

// ---------------------------------------------------------------------------
// SEC EDGAR fallback layer: N-PORT-P positions for funds without Firestore holdings. The shared nport-reader block at the end
// of this file finds, reads and checks the filing; this layer only finds the registrant and maps the positions to the sheet.
// ---------------------------------------------------------------------------

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

// adjCloseRaw: Yahoo's unrounded value, only used to tell float noise from a real change (never persisted).
export type ChartDay = { date: string; close: number; adjClose: number; volume: number; adjCloseRaw?: number };

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
      adjCloseRaw: adjClose,
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
    siAnn: siYears >= 1 && anchored(first) ? annualized(first.adjClose, last.adjClose, siYears) : null,
    mo1: anchored(mo1StartDay) ? pctChange(mo1StartDay.adjClose, last.adjClose) : null,
    qtd: anchored(qtdStartDay) ? pctChange(qtdStartDay.adjClose, last.adjClose) : null,
  };
}

/** One run's SEC state: the two SEC ticker tables (each loaded once) and the N-PORT reader cache (submissions and documents). */
let secState: { funds: Promise<Map<string, NportSeriesRef>> | null; names: Promise<Map<string, string>> | null; reader: Map<string, unknown> } = { funds: null, names: null, reader: new Map() };

/** A fresh SEC state for a run (runUpdate and tests). */
export function resetSecState(): void {
  secState = { funds: null, names: null, reader: new Map() };
}

/** SEC's ticker -> registrant CIK + series id table, loaded once per run (a failed load is asked again by the next fund). */
function loadFundTickerTable(config: UpdaterConfig): Promise<Map<string, NportSeriesRef>> {
  if (!secState.funds) {
    const loading = fetchJson(SEC_FUND_TICKERS_URL, '[ edgar    ] ticker table', secHeaders(config)).then((payload) => parseSecFundTickers(payload));
    secState.funds = loading;
    loading.catch(() => { if (secState.funds === loading) secState.funds = null; });
  }
  return secState.funds;
}

/** SEC's company name -> ticker table for the N-PORT rows, loaded once per run. */
function loadCompanyNames(config: UpdaterConfig): Promise<Map<string, string>> {
  if (!secState.names) {
    const loading = fetchJson(SEC_COMPANY_TICKERS_URL, '[ edgar    ] company table', secHeaders(config)).then((payload) => parseSecCompanyNames(payload));
    secState.names = loading;
    loading.catch(() => { if (secState.names === loading) secState.names = null; });
  }
  return secState.names;
}

/**
 * The Amplify holdings sheet of an N-PORT filing. Every row has exactly the published HOLDINGS_HEADERS keys, so header and
 * cell always agree (the old parser wrote an `Asset Category` key under a `SEDOL` header): SEDOL is the position's `other`
 * code when its otherDesc names a SEDOL, else '-'. A missing number stays empty (never 0), a missing text is '-'; tickers come
 * from nportTickers (U.S. equities only). Sorted by weight like the Firestore sheet.
 */
export function nportHoldingsSheet(filing: NportFiling, tickers: ReadonlyArray<string>): { headers: string[]; rows: JsonRecord[] } {
  const rows = filing.positions.map((position, index) => {
    const cells: JsonRecord = {
      Name: position.name || '-',
      Ticker: tickers[index] || '-',
      Identifier: nportIdentifier(position) || '-',
      Weight: nportCell(position.weight),
      'Market Value': nportCell(position.value, 2),
      'Shares Held': nportCell(position.balance),
      SEDOL: position.other && /sedol/i.test(position.otherDesc) ? position.other : '-',
    };
    const row: JsonRecord = {};
    for (const header of HOLDINGS_HEADERS) row[header] = cells[header];
    return row;
  });
  return { headers: HOLDINGS_HEADERS, rows: sortHoldings(rows) };
}

/**
 * The fund's own newest N-PORT-P filing as a holdings sheet, or null when there is none to publish (no filing, another series,
 * not strictly newer than `published`). The registrant comes from SEC's fund ticker table (with the series id), else from the
 * EDGAR full-text search by fund name (then the series name must equal the fund name exactly). A request failure that leaves
 * no answer throws: the holdings source failed and the fund stays as published.
 */
export async function resolveNportFiling(fund: NamedFund, config: UpdaterConfig, published: { asOf?: string | null; rows?: number | null } = {}): Promise<JsonRecord | null> {
  const ref = (await loadFundTickerTable(config)).get(fund.ticker);
  const cik = ref?.cik || pickEftsCik(await fetchJson(eftsSearchUrl(fund.name), '[ edgar    ] discovery', secHeaders(config)), fund.name);
  if (!cik) {
    outputNote(`[ edgar    ] ${fund.ticker}: not in the SEC fund ticker table and no full-text search hit`);
    return null;
  }
  let transport: unknown = null;
  const read = await readNportHoldings(
    { ticker: fund.ticker, cik, seriesId: ref?.seriesId || null, name: fund.name },
    { asOf: published.asOf ?? null, rows: published.rows ?? 0 },
    (url, label) => fetchText(url, `[ edgar    ] ${label}`, secHeaders(config)).catch((error: unknown) => { transport = error; throw error; }),
    { cache: secState.reader, maxDocuments: ref?.seriesId ? undefined : 40 },
  );
  if ('problem' in read) {
    // the series feed or every document request failed: no answer, a source failure (not "no filing")
    if (transport && /filings unavailable|unreadable/.test(read.problem)) throw transport;
    outputNote(`[ edgar    ] ${read.problem}`);
    return null;
  }
  if (read.loose) {
    outputNote(`[ edgar    ] ${fund.ticker}: ${read.candidate.accession} names series "${read.filing.seriesName}", not exactly "${fund.name}"`);
    return null;
  }
  const names = await loadCompanyNames(config).catch(() => null);
  const sheet = nportHoldingsSheet(read.filing, nportTickers(read.filing.positions, names));
  return { rows: sheet.rows, headers: sheet.headers, asOfDate: read.filing.repPdDate || null, source: read.url, status: 'available' };
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

export async function removeStalePages(fundDir: URL, kind: 'holdings' | 'history', kept: Set<string>): Promise<boolean> {
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

// Yahoo's adjusted close is float32 and its last digits move with the request's period2, so a value
// sitting on a cent boundary (31.544998 vs 31.545001) flips between runs. Within that noise the
// published cent is kept: a rerun with the same source data changes nothing.
export const ADJ_CLOSE_NOISE = 1e-4;
export function mergeHistory(previous: JsonRecord[], fresh: ChartDay[]): JsonRecord[] {
  const byDate = new Map<string, JsonRecord>();
  // Dates are text ("Jun 30 2026"): read them as calendar dates, never through the local-time Date parser.
  for (const row of previous) {
    const key = performanceAsOfDate(row.Date);
    if (key) byDate.set(key, row);
  }
  for (const day of fresh) {
    const [row] = historyRows([day]), key = performanceAsOfDate(row.Date)!, published = byDate.get(key);
    // Close and Volume update as usual; a real adjusted-close change beyond the noise is written.
    const publishedAdj = published ? numberOrNull(published['Adj Close']) : null, raw = day.adjCloseRaw ?? day.adjClose;
    if (publishedAdj !== null && row['Adj Close'] !== published!['Adj Close'] && Math.abs(raw - publishedAdj) <= 0.005 + ADJ_CLOSE_NOISE) row['Adj Close'] = published!['Adj Close'];
    byDate.set(key, row);
  }
  return [...byDate].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row);
}

function chartDaysFromRows(rows: JsonRecord[]): ChartDay[] {
  return rows.flatMap(row => {
    const date = performanceAsOfDate(row.Date), close = numberOrNull(row.Close), adjClose = numberOrNull(row['Adj Close']);
    return date && close !== null && adjClose !== null ? [{ date, close, adjClose, volume: numberOrNull(row.Volume) ?? 0 }] : [];
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

// Which definition stands behind dividendYield. `official`: Amplify's published trailing distribution yield
// (Firestore yields.Distribution_Yield); `computed`: trailing 12 months of Yahoo distributions / market price.
export type YieldSource = 'official' | 'computed';
export const DIVIDEND_YIELD_BASES = ['official-trailing-12m', 'official-distribution-rate', 'official-other', 'computed-trailing-12m', 'indicated'] as const;
export type DividendYieldBasis = typeof DIVIDEND_YIELD_BASES[number];

export function dividendYieldBasisFor(source: YieldSource, divYield: number | null): DividendYieldBasis | null {
  if (divYield === null) return null;
  switch (source) {
    case 'official': return 'official-trailing-12m';
    case 'computed': return 'computed-trailing-12m';
  }
}

// Meta kind texts published so far (retained rows from before the code existed); anything else is an estimate.
export function dividendYieldBasisFromKind(kind: unknown, divYield: number | null): DividendYieldBasis | null {
  if (divYield === null) return null;
  const text = typeof kind === 'string' ? kind : '';
  if (text.startsWith('trailing distribution yield published by Amplify')) return 'official-trailing-12m';
  if (text.startsWith('trailing 12 months')) return 'computed-trailing-12m';
  return 'indicated';
}

export function buildMetrics(month: JsonRecord | null, derived: PriceReturns, secYield: number | null, divYield: number | null, yieldSource: YieldSource): JsonRecord {
  const ytd = month?.ytd ?? derived.ytd, tr1y = month?.yr1 ?? derived.yr1;
  const cagr3y = month?.yr3 ?? derived.cagr3y, cagr5y = month?.yr5 ?? derived.cagr5y, cagr10y = month?.yr10 ?? derived.cagr10y;
  return {
    ytd, tr1y, cagr3y, cagr5y, cagr10y,
    tr3y: annualizedToTotal(cagr3y, 3), tr5y: annualizedToTotal(cagr5y, 5), tr10y: annualizedToTotal(cagr10y, 10),
    siAnn: month?.sinceInception ?? derived.siAnn,
    secYield, secYieldText: percent(secYield), dividendYield: divYield, dividendYieldText: percent(divYield),
    dividendYieldBasis: dividendYieldBasisFor(yieldSource, divYield),
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
export type FundOutcome = { row: JsonRecord | null; changed: boolean; reason?: string; detail: JsonRecord; warnings: string[]; kept?: boolean };

// The clock is injectable so tests can pin "today" (future-dated placeholder rows are judged against it).
let clock: () => number = () => Date.now();
export function setClock(next: () => number): void { clock = next; }
const todayIso = (): string => new Date(clock()).toISOString().slice(0, 10);
const isoSeconds = (): string => new Date(clock()).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Distributions with an ex-date in the 12 months up to `asOfIso` over the market price; null without 12 months of history or any distribution in the window. */
export function trailingYield(dividends: Dividend[], price: number | null, asOfIso: string | null, historyStartIso: string | null): number | null {
  if (!asOfIso || !historyStartIso || typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return null;
  const startIso = new Date(Date.parse(`${asOfIso}T00:00:00Z`) - 365 * 86_400_000).toISOString().slice(0, 10);
  if (historyStartIso > startIso) return null;
  const total = dividends.filter(d => { const day = epochToIsoDate(d.epoch); return day > startIso && day <= asOfIso; }).reduce((sum, d) => sum + d.amount, 0);
  return total > 0 ? round((total / price) * 100, 2) : null;
}

export async function processFund(fund: CatalogFund, config: UpdaterConfig, previousIndex: JsonRecord): Promise<FundOutcome> {
  const { ticker, category } = fund;
  const today = todayIso();
  const dir = new URL(`funds/${ticker}/`, apiRoot);
  const old = (await readJson(new URL('meta.json', dir))) ?? {};
  const warnings: string[] = [];
  const failed = new Set<string>();
  // A missing document/collection (HTTP 404) is an honest "nothing published"; any other failure is a source failure:
  // the whole fund then stays exactly as published (fund-level consistency), nothing is mixed.
  const guard = <T>(source: string, action: () => Promise<T | null>): Promise<T | null> =>
    action().catch(error => { if (!isNotFound(error)) { failed.add(source); warnings.push(`${source}: ${errorMessage(error)}`); } return null; });
  let holdingsFailed = false;
  const [metaDoc, dailyDoc, holdingsDoc, yieldsDoc, monthlyDoc, quarterlyDoc, distributionDocs] = await Promise.all([
    guard('metadata', () => fetchFirestoreDoc(['funds', ticker, 'fund_metadata', 'overview'])),
    guard('daily', () => fetchLatestCollectionDoc(['funds', ticker, 'daily'])),
    fetchLatestCollectionDoc(['funds', ticker, 'holdings']).catch(error => { if (!isNotFound(error)) { holdingsFailed = true; warnings.push(`holdings: ${errorMessage(error)}`); } return null; }),
    guard('yields', () => fetchLatestCollectionDoc(['funds', ticker, 'yields'])),
    guard('monthly performance', () => fetchLatestCollectionDoc(['funds', ticker, 'performance_monthly'])),
    guard('quarterly performance', () => fetchLatestCollectionDoc(['funds', ticker, 'performance_quarterly'])),
    fetchDistributions(ticker).catch(error => { outputNote(`[ fallback ] ${ticker} distributions: ${errorMessage(error)}`); return [] as DecodedDoc[]; }),
  ]);
  const meta: JsonRecord = metaDoc?.fields ?? {};
  const daily: JsonRecord = dailyDoc?.fields ?? {};
  const yields: JsonRecord = normalizeAsOfDoc(yieldsDoc) ?? {};

  // Placeholder or future-dated daily documents (a pre-launch fund) carry no real NAV, price or net assets.
  const dailyDate = isoDate(daily.asOfDate || dailyDoc?.id);
  const placeholder = daily.isPlaceholder === true || daily.bootstrapSource === 'pre-inception-guard' || (dailyDate !== null && dailyDate > today);
  const currencyOk = !daily.Currency || String(daily.Currency).toUpperCase() === 'USD';
  const fundName = cleanText(meta.DisplayName || meta.FundName || meta.Name) || cleanText(old.name) || ticker;
  const nav = placeholder ? null : finiteNumber(daily.NAV);
  const aum = placeholder || !currencyOk ? null : finiteNumber(daily.NetAssets);
  const expenseFraction = finiteNumber(meta.ExpenseRatio);
  const ter = expenseFraction === null ? null : round(expenseFraction * 100, 4);
  const secYield = parsePercent(yields['30_Day_SECYield']);
  const officialYield = parsePercent(yields.Distribution_Yield);

  // Headline filters that Firestore decides on its own run before any history or SEC download. A failed source
  // is judged by its published value here only to decide whether to skip the fund; nothing is published from it.
  const forFilter = <T>(source: string, freshValue: T | null, previous: T | null | undefined): T | null => failed.has(source) ? previous ?? null : freshValue;
  const early = fundFilterReasons(metricsForFilters(
    forFilter('daily', aum, numberOrNull(old.aum?.value)), forFilter('metadata', ter, numberOrNull(old.expenseRatio?.value)),
    { secYield: forFilter('yields', secYield, numberOrNull(old.yields?.secYield)) },
  ), { ...config, dividendYieldRange: undefined, performanceRanges: {}, totalReturnRanges: {} });
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
  if (!holdings && config.edgarFallback) {
    try {
      // the fund's own newest filing, read only when strictly newer than the published holdings (shared nport-reader block)
      const published = old.holdings?.status === 'available' ? { asOf: old.holdings?.asOfDate ?? null, rows: numberOrNull(old.holdings?.totalRows) ?? 0 } : { rows: 0 };
      holdings = await resolveNportFiling({ ...fund, name: fundName }, config, published);
    } catch (error) { holdingsFailed = true; warnings.push(`SEC holdings: ${errorMessage(error)}`); }
  }
  if (!holdings && holdingsFailed) failed.add('holdings');
  // Fresh holdings (Firestore or N-PORT) that look broken (no weight column, non-numeric weights, a bad weight sum, half the rows gone)
  // never replace the published ones: the fund fails before any write and keeps its published files and index row; a fund with nothing published is not written.
  // No relax lets a sheet without a single numeric weight replace a published sheet with numeric weights (Q24).
  const publishedHeaders = holdings && Object.keys(old).length ? await readPreviousSheetHeaders(ticker, 'holdings') : [];
  const publishedWeights = holdings && Object.keys(old).length ? holdingsWeightCount(publishedHeaders.length ? publishedHeaders : HOLDINGS_HEADERS, await readPreviousSheet(ticker, 'holdings')) : null;
  const holdingsProblem = holdings ? holdingsGuard(holdings.headers, holdings.rows, numberOrNull(old.holdings?.totalRows), HOLDINGS_GUARD_RELAX[ticker] ?? HOLDINGS_GUARD_RELAX['*'] ?? [], publishedWeights) : null;
  if (holdingsProblem) throw new Error(`holdings guard: ${holdingsProblem}; ${Object.keys(old).length ? 'kept the previous complete data' : 'no data published for this fund yet'}`);

  // Daily market-price history and dividend events from Yahoo Finance. "Symbol not found" (HTTP 404, empty result)
  // is an honest absence (international partner funds, pre-launch, delisted); every other failure is a source failure.
  let chart: ParsedChart | null = null;
  if (!config.skipYahoo) {
    try {
      const fetched = parseChart(await fetchJson(chartUrl(ticker, config), `[ chart    ] ${ticker}`, yahooHeaders(), config));
      // A HISTORY_RANGE window never shrinks the published history: the older published days are joined and rescaled to the
      // fresh adjusted closes (shared windowed-chart block); a window that does not join them keeps the fund as published.
      chart = config.historyRange === 'max' ? fetched : mergeWindowedChart(fetched, await readPreviousSheet(ticker, 'history'), Array.isArray(old.distributions?.rows) ? old.distributions.rows : []);
      if (!chart) throw new Error(`chart window does not join the published history (${config.historyRange})`);
    }
    catch (error) {
      if (isNotFound(error) || /empty result/.test(errorMessage(error))) outputNote(`[ fallback ] ${ticker} Yahoo: ${errorMessage(error)}`);
      else { failed.add('yahoo'); warnings.push(`yahoo: ${errorMessage(error)}`); }
    }
  }
  const hasPublished = Object.keys(old).length > 0 && Boolean(previousIndex.ticker);
  if (failed.size) {
    const reason = `source failed: ${[...failed].join(', ')}`;
    // Fund-level consistency: fully updated or fully kept as published.
    if (hasPublished) return { row: previousIndex, changed: false, reason, detail: {}, warnings, kept: true };
    throw new Error(`${ticker}: ${reason}; nothing published to keep`);
  }
  if (!holdings) {
    const rows = await readPreviousSheet(ticker, 'holdings'), headers = await readPreviousSheetHeaders(ticker, 'holdings');
    if (old.holdings?.totalRows && rows.length !== old.holdings.totalRows) throw new Error(`${ticker}: previous holdings incomplete; refusing overwrite`);
    holdings = {
      rows, headers: headers.length ? headers : HOLDINGS_HEADERS, asOfDate: old.holdings?.asOfDate ?? null,
      source: old.holdings?.source ?? 'unavailable from Firestore or SEC N-PORT-P',
      status: old.holdings?.status ?? (rows.length ? 'available' : 'unavailable'),
    };
  }
  const oldHistory = await readPreviousSheet(ticker, 'history');
  if (old.history?.totalRows && oldHistory.length !== old.history.totalRows) throw new Error(`${ticker}: previous history incomplete; refusing overwrite`);
  const history = chart?.days.length ? mergeHistory(oldHistory, chart.days) : oldHistory;
  const days = chartDaysFromRows(history);
  const dividends = mergeDividends(old, chart, firestoreDividends(distributionDocs)), latest = dividends.at(-1) ?? null;
  const frequency = dividends.length ? inferDistributionFrequency(dividends) : { frequency: '—', paymentsPerYear: null };

  const navDate = placeholder ? null : dailyDate;
  const dailyPrice = placeholder ? null : finiteNumber(daily.MarketPrice);
  // With SKIP_YAHOO the published price and its date stand in for the skipped source.
  const price = dailyPrice ?? chart?.regularMarketPrice ?? (config.skipYahoo ? numberOrNull(old.marketPrice?.value) : null);
  const priceDate = (dailyPrice !== null ? navDate : null) ?? (chart?.regularMarketTime ? epochToIsoDate(chart.regularMarketTime) : config.skipYahoo ? performanceAsOfDate(old.marketPrice?.asOfDate) : null);
  // Never compute a premium from prices belonging to different days; unmatched dates give null.
  const publishedPremium = placeholder ? null : finiteNumber(daily.PremiumDiscount);
  const premium = publishedPremium !== null ? round(publishedPremium, 4)
    : nav !== null && nav > 0 && price !== null && navDate && priceDate && navDate === priceDate ? round((price / nav - 1) * 100, 2) : null;
  // Amplify's own trailing distribution yield when published (a published 0.00% stays an official zero); otherwise trailing 12 months from the distributions.
  const divYield = officialYield ?? trailingYield(dividends, price, priceDate ?? (days.length ? days.at(-1)!.date : null), days.length ? days[0].date : null);

  // Returns: the official NAV table of this run, else Yahoo-derived. An old table never survives under a new date.
  const officialMonth = officialReturns(monthlyDoc);
  let month: JsonRecord | null = officialMonth;
  const quarter: JsonRecord | null = officialReturns(quarterlyDoc);
  const monthIso = performanceAsOfDate(month?.asOfDate);
  const anchorIso = monthIso ?? (days.length ? days.at(-1)!.date : null);
  const anchor = anchorIso ? new Date(`${anchorIso}T00:00:00Z`) : null;
  const usable = anchorIso ? days.filter(day => day.date <= anchorIso) : [];
  const priced = usable.length ? priceReturns(usable, anchor!) : { ...EMPTY_PRICE_RETURNS };
  // A range-limited Yahoo download is not a since-inception return.
  if (!chart?.firstTradeDate || !days.length || Date.parse(`${days[0].date}T00:00:00Z`) / 1000 - chart.firstTradeDate > 7 * 86400) priced.siAnn = null;
  const hasOfficialReturns = Boolean(officialMonth);
  const rawInception = isoDate(meta.InceptionDate || meta.LaunchDate);
  const futureInception = rawInception !== null && rawInception > today;
  const fundInception = futureInception ? null : rawInception;
  // The shared "younger than one year" rule (calendar anniversary, inclusive): no 1-year or since-inception return before the
  // first anniversary and no 3, 5 or 10-year one before those, official or derived; an unknown inception keeps the values.
  const performanceAsOf = monthIso ?? (priced.asOfDate || null);
  const derived = withoutYoungReturns(priced, fundInception, performanceAsOf, { yr1: 1, cagr3y: 3, cagr5y: 5, cagr10y: 10, siAnn: 1 });
  const officialHorizons = { yr1: 1, yr3: 3, yr5: 5, yr10: 10, sinceInception: 1 };
  if (month) month = withoutYoungReturns(month, fundInception, performanceAsOf, officialHorizons);
  const quarterEnd = quarter ? withoutYoungReturns(quarter, fundInception, performanceAsOfDate(quarter.asOfDate), officialHorizons) : null;
  const metrics = buildMetrics(month, derived, secYield, divYield, officialYield !== null ? 'official' : 'computed');
  if (month) month = { ...month, ytd: month.ytd ?? derived.ytd, mo1: month.mo1 ?? derived.mo1, qtd: month.qtd ?? derived.qtd };
  else if (usable.length) month = { asOfDate: formatEdgarDate(derived.asOfDate), mo1: derived.mo1, qtd: derived.qtd, ytd: derived.ytd, yr1: derived.yr1, yr3: derived.cagr3y, yr5: derived.cagr5y, yr10: derived.cagr10y, sinceInception: derived.siAnn };
  const filtered = fundFilterReasons(metricsForFilters(aum, ter, metrics), config);
  if (filtered.length) return { row: null, changed: false, reason: filtered.join('; '), detail: {}, warnings };
  const returnsBasis = hasOfficialReturns
    ? 'official Amplify NAV month-end/quarter-end total returns (Firestore performance feed); missing metrics derived from Yahoo adjusted closes at the same reporting date'
    : 'Yahoo adjusted market-price returns, not official NAV';
  // Mandatory contract fields, always last: the basis and the date the returns are as of (the month-end
  // table date, or the last Yahoo close for Yahoo-derived returns), never the NAV date.
  delete metrics.returnsBasis; delete metrics.performanceAsOf;
  metrics.returnsBasis = returnsBasis;
  metrics.performanceAsOf = performanceAsOfDate(month?.asOfDate);
  if (!metaDoc && !dailyDoc && !chart && !Object.keys(old).length) throw new Error(`${ticker}: no usable per-fund source`);

  const delistDate = isoDate(meta.DelistDate);
  const status = placeholder || futureInception ? 'pre-launch'
    : delistDate !== null && delistDate <= today ? 'delisted'
      : nav === null && price === null && aum !== null ? 'aum-only' : 'active';

  // Order: pages, then meta.json, then stale-page cleanup; the index row is written by the caller last.
  const holdingsOut = await writePages(dir, ticker, 'holdings', holdings.headers, holdings.rows, config.holdingsPageSize);
  const oldHistoryHeaders = await readPreviousSheetHeaders(ticker, 'history');
  const historyOut = await writePages(dir, ticker, 'history', chart?.days.length ? HISTORY_HEADERS : oldHistoryHeaders.length ? oldHistoryHeaders : HISTORY_HEADERS, history, config.historyPageSize);
  const historySource = chart?.days.length ? 'Yahoo Finance daily market-price closes / adjusted closes (not official NAV)' : old.history?.source ?? 'unavailable';
  const exchange = cleanText(meta.PrimaryExchange) || chart?.exchangeName || '';
  const categoryName = cleanText(category) || 'ETF';
  const fundPage = `${AMPLIFY_SITE}/${encodeURIComponent(ticker)}/`;
  const holdingsPage = `${AMPLIFY_SITE}/${encodeURIComponent(ticker.toLowerCase())}-holdings/`;
  const asOfLabel = navDate ? formatEdgarDate(navDate) : null;
  const metaOut = {
    ticker, name: fundName, category: categoryName, categoryPath: categoryName, status,
    source: {
      fundPage, catalog: `${FIRESTORE_BASE}/fund_category`, holdingsDownload: holdingsPage, holdingsSource: holdings.source, historySource,
      yahooChart: `${YAHOO_CHART_URL}/${ticker}`,
      provider: 'Amplify ETFs Firestore data feed (amplify-etfs-data-feed); SEC EDGAR N-PORT-P holdings fallback; Yahoo Finance market-history/dividend data',
    },
    providerIds: { fundPage, holdingsPage },
    legalStructure: cleanText(meta.FundType) || null,
    identifiers: {
      cusip: cleanText(meta.CUSIP) || null,
      isin: cleanText(meta.ISIN) || null,
      sedol: cleanText(meta.SEDOL) || null,
      indexTicker: cleanText(meta.UnderlyingIndexTicker) || null,
    },
    inception: { fundInceptionDate: fundInception, shareClassInceptionDate: (() => { const d = isoDate(meta.LaunchDate); return d !== null && d <= today ? d : null; })(), exchange, ...(futureInception ? { expectedInceptionDate: rawInception } : {}), ...(delistDate ? { delistDate } : {}) },
    // Amplify publishes one expense ratio: it is the net figure; a gross figure is not published.
    expenseRatio: { display: percent(ter), value: ter, gross: null, net: ter },
    nav: { display: money(nav), value: nav, asOfDate: asOfLabel ?? '—' },
    marketPrice: { display: money(price), value: price, asOfDate: priceDate ? formatEdgarDate(priceDate) : '—' },
    premiumDiscount: { display: percent(premium), value: premium },
    aum: { display: aum === null ? '—' : formatMoney(aum), value: aum, asOfDate: aum === null ? '—' : asOfLabel ?? '—', source: aum === null ? 'unavailable' : 'Amplify Firestore daily net assets' },
    yields: {
      dividendYield: metrics.dividendYield, dividendYieldText: metrics.dividendYieldText,
      dividendYieldKind: officialYield !== null ? 'trailing distribution yield published by Amplify (Firestore yields; a published 0.00% is an official zero)' : 'trailing 12 months (distributions with an ex-date in the last 12 months / market price; null with under 12 months of history)',
      secYield: metrics.secYield, secYieldText: metrics.secYieldText,
      secYieldKind: secYield !== null ? '30-day SEC yield published by Amplify (Firestore yields)' : 'not published',
      unsubsidizedSecYield: parsePercent(yields['30_Day_UnsubSECYield']),
    },
    returns: { monthEnd: month, quarterEnd, derivedFrom: returnsBasis },
    distributions: { frequency: frequency.frequency, paymentsPerYear: frequency.paymentsPerYear, headers: ['Ex-Date', 'Amount'], rows: distributionRows(dividends) },
    holdings: { ...holdingsOut.manifest, asOfDate: holdings.asOfDate, asOf: holdings.asOfDate ? formatEdgarDate(holdings.asOfDate) : '—', source: holdings.source, status: holdings.status },
    history: { ...historyOut.manifest, asOf: days.length ? formatEdgarDate(days.at(-1)!.date) : '—', source: historySource },
  };
  const metaChanged = await writeIfChanged(new URL('meta.json', dir), metaOut);
  const staleRemoved = (await removeStalePages(dir, 'holdings', new Set(holdingsOut.manifest.pages))) || (await removeStalePages(dir, 'history', new Set(historyOut.manifest.pages)));
  const row = {
    ticker, name: fundName, category: categoryName, status, fundPage, dataFile: `./funds/${ticker}/meta.json`,
    cusip: metaOut.identifiers.cusip, isin: metaOut.identifiers.isin, ter: metaOut.expenseRatio.display, terValue: ter, terGross: percent(null), terGrossValue: null,
    nav: metaOut.nav.display, navValue: nav, aum: metaOut.aum.display, aumValue: aum,
    asOfDate: metaOut.nav.asOfDate, inceptionDate: fundInception ? formatEdgarDate(fundInception) : '—',
    exchange, closePrice: metaOut.marketPrice.display, closePriceValue: price,
    premiumDiscount: metaOut.premiumDiscount.display, premiumDiscountValue: premium,
    distributions: { frequency: frequency.frequency, exDate: latest ? formatUsDate(latest.epoch) : '—', dividend: latest ? String(round(latest.amount, 6)) : '—' },
    returns: metaOut.returns, metrics, holdings: holdings.rows.length, history: history.length,
  };
  return {
    row, warnings,
    changed: metaChanged || holdingsOut.changed || historyOut.changed || staleRemoved || outputContentKey(previousIndex) !== outputContentKey(row),
    detail: {
      holdings: holdings.rows.length, history: history.length, yahooHistoryCount: chart ? chart.days.length : null,
      distributions: dividends, aum, dividendYield: metrics.dividendYield, secYield: metrics.secYield,
    },
  };
}

// ---------------------------------------------------------------------------
// Catalog and run
// ---------------------------------------------------------------------------
type RawCatalog = { all: Set<string>; active: CatalogFund[] };
async function loadCatalog(): Promise<RawCatalog> {
  const docs = await fetchFirestoreListAll(['fund_category'], 200);
  // Non-US listings (Samsung partner funds on HKEX and KRX, flagged isInternational, without an amplifyetfs.com fund
  // page or US market data) are not Amplify US ETFs: they stay out of the catalog, so a full run drops their old rows.
  const parsed = docs.map(doc => ({
    ticker: sanitizeTicker(doc.fields.ticker || doc.id),
    category: doc.fields.category || 'Unknown',
    active: doc.fields.isActive !== false,
    international: doc.fields.isInternational === true,
  })).filter(fund => fund.ticker && !fund.international);
  return {
    // Every ticker the provider still lists, active or not: only tickers absent from this set may ever be purged.
    all: new Set(parsed.map(fund => fund.ticker)),
    active: parsed.filter(fund => fund.active && fund.category !== 'Unknown').sort((a, b) => a.ticker.localeCompare(b.ticker)),
  };
}

// The run stops taking new funds at a soft deadline (workflow timeout is 30 min) and still writes the index.
let runDeadlineMs = 25 * 60_000;
export function setRunDeadlineMs(ms: number): void { runDeadlineMs = ms; }
/** A full run removes at most this many funds the provider no longer lists; a larger drop is refused and reported. */
export const dropCap = (published: number): number => Math.max(3, Math.ceil(published * 0.1));
const STATE_NAME = 'update-state.json';

export async function withDividendYieldBasis(row: JsonRecord): Promise<JsonRecord> {
  const metrics: JsonRecord = row.metrics ?? {};
  const divYield = numberOrNull(metrics.dividendYield);
  const current = metrics.dividendYieldBasis;
  const valid = typeof current === 'string' && (DIVIDEND_YIELD_BASES as readonly string[]).includes(current);
  let basis: DividendYieldBasis | null;
  if (divYield === null) basis = null;
  else if (valid) basis = current as DividendYieldBasis;
  else {
    const meta = await readJson(new URL(`funds/${row.ticker}/meta.json`, apiRoot));
    basis = dividendYieldBasisFromKind(meta?.yields?.dividendYieldKind, divYield);
  }
  if (metrics.dividendYieldBasis === basis && 'dividendYieldBasis' in metrics) return row;
  // Keep the key right after dividendYieldText and returnsBasis/performanceAsOf last.
  const next: JsonRecord = {};
  for (const [key, value] of Object.entries(metrics)) {
    if (key === 'dividendYieldBasis') continue;
    next[key] = value;
    if (key === 'dividendYieldText') next.dividendYieldBasis = basis;
  }
  if (!('dividendYieldBasis' in next)) {
    const { returnsBasis, performanceAsOf, ...rest } = next;
    return { ...row, metrics: { ...rest, dividendYieldBasis: basis, ...(returnsBasis !== undefined ? { returnsBasis } : {}), ...(performanceAsOf !== undefined ? { performanceAsOf } : {}) } };
  }
  return { ...row, metrics: next };
}

/** Index row of a catalog fund with nothing published (no meta.json): catalog headlines only, dataFile null, every metric unknown (null). */
export function catalogOnlyRow(fund: CatalogFund): JsonRecord {
  const returnsBasis = 'not published yet: no fund data was read for this fund';
  const metrics = buildMetrics(null, { ...EMPTY_PRICE_RETURNS }, null, null, 'computed');
  metrics.returnsBasis = returnsBasis;
  metrics.performanceAsOf = null;
  return {
    ticker: fund.ticker, name: fund.ticker, category: cleanText(fund.category) || 'ETF', status: 'active',
    fundPage: `${AMPLIFY_SITE}/${encodeURIComponent(fund.ticker)}/`, dataFile: null,
    cusip: null, isin: null, ter: percent(null), terValue: null, terGross: percent(null), terGrossValue: null,
    nav: money(null), navValue: null, aum: '—', aumValue: null, asOfDate: '—', inceptionDate: '—',
    exchange: '', closePrice: money(null), closePriceValue: null, premiumDiscount: percent(null), premiumDiscountValue: null,
    distributions: { frequency: '—', exDate: '—', dividend: '—' },
    returns: { monthEnd: null, quarterEnd: null, derivedFrom: returnsBasis }, metrics, holdings: 0, history: 0,
  };
}

export async function runUpdate(env: Record<string, string | undefined> = process.env): Promise<void> {
  const startedAt = Date.now();
  const controls = await runtimeControls(env);
  // Normalized so the shared outputVerbose (1/true/yes/on) agrees with this repo's wider boolean syntax (y, n, off).
  if (controls.VERBOSE !== undefined) process.env.VERBOSE = String(parseBooleanControl(controls.VERBOSE.trim(), 'VERBOSE', false));
  installSystemCa((controls.USE_SYSTEM_CA ?? 'auto').toLowerCase());
  const config = readConfig(controls);
  outputPrintConfig('Amplify', config);
  httpSettings = { maxRetries: config.maxRetries, requestSleepMs: config.requestSleepSeconds * 1000 };
  resetSecState();

  const previous = await readJson(indexFile());
  const oldFunds = new Map<string, JsonRecord>((previous?.funds ?? []).map((fund: JsonRecord) => [fund.ticker, fund]));
  const { all: rawTickers, active: activeCatalog } = await loadCatalog();
  if (!activeCatalog.length) throw new Error('Firestore returned no active funds; refusing an empty feed');
  console.log(`[ catalog  ] ${activeCatalog.length} Amplify ETFs (Firestore fund_category)`);
  // Q27: a TICKERS entry that is neither in the live catalog nor a published fund stops the run before any fund request
  const live = activeCatalog.map(fund => fund.ticker);
  const previousRows = Array.from(oldFunds.values());
  assertKnownTickers(config.tickers.length ? config.tickers : null, knownTickers(live, previousRows), 'the Amplify catalog or published feed');
  const stateFile = new URL(STATE_NAME, apiRoot);
  const state = await readJson(stateFile);
  // A closed fund leaves the run here, before any per-fund request and the MAX_FETCHES budget: never fetched, guarded or reported.
  const order = withoutClosedFunds(selectCatalog(activeCatalog, config, state?.cursor ?? null), fund => fund.ticker, CLOSED_FUNDS);
  outputPrintFilter(order.length, activeCatalog.length, outputHasOutputFilters(config));

  const limit = config.maxFetches;
  const total = limit && !outputHasOutputFilters({ ...config, maxFetches: 0 }) ? Math.min(limit, order.length) : order.length;
  // A catalog-only row (dataFile null) of a ticker the live catalog no longer lists is dropped; rows with published data stay.
  const result = new Map<string, JsonRecord>(withoutStalePlaceholders(previousRows, live).map(row => [String(row.ticker), row] as [string, JsonRecord]));
  const deadlineAt = startedAt + runDeadlineMs;
  const output = outputCreateReporter(apiRoot, total);
  let processed = 0, skipped = 0, kept = 0, failures = 0, examined = 0, truncated = false, position = 0;
  let lastExamined: CatalogFund | null = null;
  // A bounded batch counts funds that pass the filters: keep taking funds in cursor order until MAX_FETCHES of them were updated.
  while (position < order.length && !truncated && (!limit || processed < limit)) {
    const size = limit ? Math.min(order.length - position, limit - processed) : order.length - position;
    const chunk = order.slice(position, position + size);
    let done = 0;
    await runFundPool(chunk, config.concurrency, async fund => {
      if (Date.now() > deadlineAt) { truncated = true; return; }
      const before = await output.before(fund.ticker);
      try {
        const outcome = await processFund(fund, config, oldFunds.get(fund.ticker) ?? {});
        if (outcome.kept) kept++;
        else if (outcome.row) { result.set(fund.ticker, outcome.row); processed++; } else skipped++;
        await output.result(fund.ticker, before, outcome.kept ? 'kept' : outcome.row ? (outcome.changed ? 'updated' : 'unchanged') : 'skipped',
          [outcome.reason, ...(outcome.warnings.length ? [`partial refresh: ${outcome.warnings.join('; ')}`] : [])].filter(Boolean).join('; ') || undefined, outcome.detail);
      } catch (error) {
        failures++;
        // A fund with nothing published (new, or its first refresh failed or the guard rejected it) is still listed: no meta.json, so dataFile is null.
        if (!result.has(fund.ticker) && (await readJson(new URL(`funds/${fund.ticker}/meta.json`, apiRoot))) === null) result.set(fund.ticker, catalogOnlyRow(fund));
        await output.result(fund.ticker, before, 'failed', errorMessage(error));
      }
      done++;
    });
    examined += done;
    if (done === chunk.length) lastExamined = chunk.at(-1)!;
    position += size;
  }
  if (truncated) console.log(`[ deadline ] stopped taking new funds after ${Math.round(runDeadlineMs / 60_000)} min; ${order.length - examined} of ${order.length} not examined`);

  // A full unfiltered pass drops funds the provider no longer lists at all (absent from fund_category, not merely
  // inactive or "Unknown"), at most dropCap() per run; a larger drop is refused and reported.
  const dropped: string[] = [];
  let refusedDrops: string[] = [];
  if (!hasFilters(config) && !failures && !truncated) {
    // A closed fund keeps its published row and files after the provider stops listing it.
    const gone = [...result.keys()].filter(ticker => !rawTickers.has(ticker) && !closedFund(CLOSED_FUNDS, ticker)).sort();
    if (gone.length <= dropCap(result.size)) {
      for (const ticker of gone) {
        result.delete(ticker);
        await rm(new URL(`funds/${ticker}/`, apiRoot), { recursive: true, force: true });
        dropped.push(ticker);
      }
    } else refusedDrops = gone;
  }
  if (dropped.length) console.log(`DROPPED FUNDS: ${dropped.join(', ')}`);
  if (refusedDrops.length) console.log(`DROPPED FUNDS: refusing to remove ${refusedDrops.length} funds (cap ${dropCap(result.size)} per run): ${refusedDrops.join(', ')}`);
  if (!result.size) throw new Error('No publishable funds; not replacing the index');
  // Retained and unselected rows may predate dividendYieldBasis: every row carries the key, and the code always
  // describes the yield it sits next to (null yield -> null code; a missing or unknown code is read from meta.json).
  for (const [ticker, row] of result) result.set(ticker, await withDividendYieldBasis(row));
  // A closed fund keeps its published row, marked last (status 'closed' replaces the published status, plus closedDate and closedSource).
  const funds = markClosedFunds([...result.values()].sort((a, b) => a.ticker.localeCompare(b.ticker)), CLOSED_FUNDS);
  const counts = { funds: funds.length, holdings: funds.reduce((sum, fund) => sum + (fund.holdings ?? 0), 0), history: funds.reduce((sum, fund) => sum + (fund.history ?? 0), 0) };
  const now = isoSeconds();
  const indexWritten = await writeIfChanged(indexFile(), {
    generatedAt: now, catalogReadAt: now,
    source: { provider: 'Amplify ETFs', site: CATALOG_PAGE, catalog: `${FIRESTORE_BASE}/fund_category` },
    counts, funds,
  });
  // The cursor follows deterministic order and is advanced only by a run without a TICKERS allowlist, failures or truncation;
  // a TICKERS run never reads, moves or deletes it.
  if (!config.tickers.length && !failures && !truncated) {
    if (limit) { if (lastExamined) await writeIfChanged(stateFile, { cursor: lastExamined.ticker }); }
    else await rm(stateFile, { force: true });
  }
  // VERBOSE only: nothing but fund lines may appear between [ filter ] and [ done ]
  outputNote(indexWritten ? `[ index    ] wrote ${indexFile().pathname}` : '[ index    ] fetched data is unchanged; keeping api/amplify/index.json untouched');
  console.log(output.summary(startedAt));
  console.log(outputCounts(counts.funds, counts.holdings, counts.history));
  // Q28: a fund is announced on its first successful publish (a catalog-only row is not published), new catalog-only rows as pending
  const newFunds = newFundsLines(newFundsReport(previousRows, funds));
  for (const line of newFunds) console.log(line);
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY,
      `### Amplify update\n\n${processed} processed; ${skipped} skipped; ${kept} kept as published; ${failures} failed.\n${counts.funds} funds / ${counts.holdings} holdings / ${counts.history} history rows.\n` +
      `${newFunds.length ? `\n### NEW FUNDS\n\n${newFunds.join('\n')}\n` : ''}${dropped.length ? `\nDROPPED FUNDS: ${dropped.join(', ')}\n` : ''}` +
      `${refusedDrops.length ? `\nDROPPED FUNDS: refused to remove ${refusedDrops.length} funds (cap ${dropCap(result.size)}): ${refusedDrops.join(', ')}\n` : ''}${truncated ? '\nStopped at the soft deadline; remaining funds keep their published data.\n' : ''}`);
  }
  // Non-zero when anything failed, or when every examined fund was kept because a source failed.
  if (failures || (examined > 0 && kept === examined)) process.exitCode = 1;
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

// <holdings-guard> shared block of .claude/tools/etfs/etf-std/holdings-guard.block.ts, applied by apply-holdings-guard.ts: never edit it in one repo
/**
 * Sanity check of a fund's new holdings before they replace the published ones. Returns why they must be rejected
 * (the caller then keeps the fund's previous state and reports it as failed), or null when they may be written.
 * An empty sheet passes only when nothing was published before. Otherwise a Name and a weight column (Weight,
 * Weight (%) or Market Weight) are required, >= 80% of the rows carry a numeric weight, the weights add up to
 * 50..150 and the sheet keeps >= 50% of the previously published rows. `relax` switches off the checks a fund
 * legitimately fails: 'numeric' and 'sum' (geared, inverse, futures, look-through, top-N lists) and 'count'. No relax lets
 * a sheet without a single numeric weight replace a published sheet that had numeric weights (`previousWeights`: how many
 * rows of the published sheet carry a numeric weight, see holdingsWeightCount; open-items etfs Q24).
 * Rows are arrays in header order or objects keyed by the header text. A fund in the brand's CLOSED_FUNDS never reaches the guard.
 */
export function holdingsGuard(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>, previousRows: number | null | undefined, relax: ReadonlyArray<string> = [], previousWeights: number | null = null): string | null {
  const previous = Number(previousRows) > 0 ? Number(previousRows) : 0;
  if (!rows.length) return previous ? `no holdings rows (${previous} published)` : null;
  const names = headers.map((header) => String(header).trim().toLowerCase());
  const nameAt = names.indexOf('name');
  let weightAt = names.indexOf('weight');
  if (weightAt < 0) weightAt = names.indexOf('weight (%)');
  if (weightAt < 0) weightAt = names.indexOf('market weight');
  if (nameAt < 0 || weightAt < 0) return `no ${nameAt < 0 ? 'Name' : 'weight'} column (headers: ${headers.join(', ') || 'none'})`;
  const weights = holdingsGuardWeights(headers, rows, weightAt);
  const numeric = weights.count;
  const sum = weights.sum;
  if (numeric === 0 && Number(previousWeights) > 0) return `no row has a numeric weight, the published sheet had ${Number(previousWeights)}`;
  if (relax.indexOf('numeric') < 0 && numeric < rows.length * 0.8) return `only ${numeric} of ${rows.length} rows have a numeric weight`;
  if (relax.indexOf('sum') < 0 && (sum < 50 || sum > 150)) return `weights add up to ${sum.toFixed(2)}, outside 50..150`;
  if (relax.indexOf('count') < 0 && previous && rows.length < previous * 0.5) return `${rows.length} rows, less than half of the ${previous} published`;
  return null;
}

/** How many rows carry a numeric weight (Weight, Weight (%) or Market Weight column), 0 without such a column: pass it for the published sheet as holdingsGuard's previousWeights. */
export function holdingsWeightCount(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>): number {
  const names = headers.map((header) => String(header).trim().toLowerCase());
  let weightAt = names.indexOf('weight');
  if (weightAt < 0) weightAt = names.indexOf('weight (%)');
  if (weightAt < 0) weightAt = names.indexOf('market weight');
  return weightAt < 0 ? 0 : holdingsGuardWeights(headers, rows, weightAt).count;
}

/** Count and sum of the numeric weights in column weightAt; rows are arrays in header order or objects keyed by the header text. */
function holdingsGuardWeights(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>, weightAt: number): { count: number; sum: number } {
  let count = 0;
  let sum = 0;
  for (let i = 0; i < rows.length; i++) {
    const row: any = rows[i];
    const weight = holdingsGuardNumber(Array.isArray(row) ? row[weightAt] : row && typeof row === 'object' ? row[headers[weightAt]] : undefined);
    if (weight !== null) {
      count++;
      sum += weight;
    }
  }
  return { count, sum };
}

/** A weight cell as a number: %, $, commas and spaces are ignored, (x) is negative; null when it is no plain number (a zero-width character inside counts as broken). */
function holdingsGuardNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let text = String(value === null || value === undefined ? '' : value).replace(/[ \t ,%$]/g, '').replace(/−/g, '-');
  const negative = /^\(.*\)$/.test(text);
  if (negative) text = text.slice(1, -1);
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return null;
  return negative ? -Number(text) : Number(text);
}

/** A fund its issuer closed (liquidated, delisted or merged away), confirmed from an official source: an SEC filing or the issuer's notice. */
export type ClosedFund = { ticker: string; closed: string; source: string };

/**
 * The brand's CLOSED_FUNDS entry for a ticker, or null. A closed fund is never fetched, never guarded and never reported failed: it keeps
 * its last published data and its index row carries `status: 'closed'`, `closedDate` and `closedSource`. A malformed entry throws, so a
 * typo (no ISO date, no https source) never ships.
 */
export function closedFund(list: ReadonlyArray<ClosedFund>, ticker: unknown): ClosedFund | null {
  const wanted = String(ticker === null || ticker === undefined ? '' : ticker).trim().toUpperCase();
  let found: ClosedFund | null = null;
  for (let i = 0; i < list.length; i++) {
    const fund = list[i];
    if (!/^[A-Z0-9][A-Z0-9.-]{0,9}$/.test(fund.ticker) || !/^\d{4}-\d{2}-\d{2}$/.test(fund.closed) || !/^https:\/\/\S+$/.test(fund.source)) throw new Error(`CLOSED_FUNDS: ${fund.ticker} needs an upper-case ticker, an ISO closing date and an https source`);
    if (fund.ticker === wanted) found = fund;
  }
  return found;
}

/** The index rows with every closed fund marked (`status: 'closed'`, `closedDate`, `closedSource`); other rows are returned as they are. */
export function markClosedFunds<T extends object>(rows: ReadonlyArray<T>, list: ReadonlyArray<ClosedFund>): T[] {
  return rows.map((row) => {
    const fund = closedFund(list, (row as { ticker?: unknown }).ticker);
    return fund ? ({ ...row, status: 'closed', closedDate: fund.closed, closedSource: fund.source } as T) : row;
  });
}

/** A run's queue without the closed funds, which are named once in the log: they are neither fetched nor counted as failed. */
export function withoutClosedFunds<T>(queue: ReadonlyArray<T>, tickerOf: (item: T) => string, list: ReadonlyArray<ClosedFund>): T[] {
  const closed: string[] = [];
  const open: T[] = [];
  for (let i = 0; i < queue.length; i++) {
    if (closedFund(list, tickerOf(queue[i]))) closed.push(tickerOf(queue[i]));
    else open.push(queue[i]);
  }
  if (closed.length) console.log(`[ closed   ] ${closed.join(', ')}: closed by the issuer, published data kept`);
  return open;
}
// </holdings-guard>

// <nport-reader> shared block of .claude/tools/etfs/etf-std/nport-reader.block.ts, applied by apply-block.ts: never edit it in one repo
/**
 * SEC EDGAR Form N-PORT-P holdings reader (open-items etfs ETF-H2), one copy for every brand. Pure functions plus one reader
 * that takes the brand's own `getText(url, label)` (its SEC User-Agent, timeout, retries and pacing). Rules it enforces:
 * - identifiers come from the position itself: `<cusip>` text (or a `value` attribute), `<isin value>`, `<ticker value>`,
 *   `<other value>`; a derivative's reference instrument (inside `<derivativeInfo>`) never lends its identifiers to the position
 * - CUSIP `000000000` and `N/A` are missing; a missing weight or value is null (an empty cell), never 0
 * - a ticker only for a common-stock row (assetCat EC, not a CVR, right, warrant or escrow line) traded in USD with a U.S.
 *   ISIN or none, and never one ticker on two different securities (`nportTickers`)
 * - identity: the filing must name the fund's own series id, or, with no series id known, the fund's name (`nportIdentity`)
 * - freshness: the report period must be strictly newer than the published holdings (`nportIsFresh`)
 * - filings come newest report period first from the registrant's own archive folder, never from the filer agent's CIK
 *   (the accession number prefix)
 */
export type NportPosition = {
  name: string;
  title: string;
  lei: string;
  cusip: string;
  isin: string;
  ticker: string;
  other: string;
  otherDesc: string;
  balance: number | null;
  units: string;
  currency: string;
  /** valUSD, null when the filing has none */
  value: number | null;
  /** pctVal: percent of net assets (0.5 = 0.5%), null when the filing has none */
  weight: number | null;
  payoff: string;
  assetCat: string;
  issuerCat: string;
  country: string;
  /** derivCat of the position's derivativeInfo (FUT, FWD, SWP, OPT, ...), empty for a security */
  derivative: string;
  /** debtSec annualizedRt and maturityDt (ISO), null and '' for a non-debt row */
  coupon: number | null;
  maturity: string;
};

export type NportFiling = {
  seriesId: string;
  seriesName: string;
  regName: string;
  regCik: string;
  /** report period end (genInfo repPdDate) as ISO, '' when missing */
  repPdDate: string;
  netAssets: number | null;
  totalAssets: number | null;
  positions: NportPosition[];
};

export type NportCandidate = { accession: string; filed: string; period: string; cik: string };
export type NportSeriesRef = { cik: string; seriesId: string; classId: string };

/** XML text: entities decoded, tags dropped, whitespace collapsed. */
function nportText(raw: string): string {
  return String(raw)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_m: string, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m: string, dec: string) => String.fromCharCode(Number(dec)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[\s ]+/g, ' ')
    .trim();
}

/** Text of the first `<tag>` (any namespace prefix) in `xml`, '' when absent. */
function nportTag(xml: string, tag: string): string {
  const match = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${tag}>`, 'i').exec(xml);
  return match ? nportText(match[1]) : '';
}

/** The `attribute` of the first `<tag ...>` (any namespace prefix) in `xml`, '' when absent. */
function nportAttr(xml: string, tag: string, attribute: string): string {
  const match = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${tag}\\s[^>]*?\\b${attribute}\\s*=\\s*"([^"]*)"`, 'i').exec(xml);
  return match ? nportText(match[1]) : '';
}

/** A plain decimal or exponent number, null for an empty, N/A or broken cell. */
function nportNumber(raw: string): number | null {
  const text = String(raw).replace(/[\s,]/g, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** An identifier code, '' for N/A, NONE and all zeros (CUSIP 000000000 means "no CUSIP"). */
function nportCode(raw: string): string {
  const text = String(raw).trim().toUpperCase();
  return !text || /^(N\/?A|NONE|-+|0+)$/.test(text) ? '' : text;
}

/** ISO date of an N-PORT date (YYYY-MM-DD, possibly with a time), '' otherwise. */
function nportIso(raw: unknown): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw === null || raw === undefined ? '' : raw).trim());
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}

/** One N-PORT-P primary_doc.xml (or the full submission .txt that embeds it) as series facts and positions. */
export function parseNportFiling(xml: string): NportFiling {
  const text = String(xml === null || xml === undefined ? '' : xml);
  const genInfo = /<(?:[A-Za-z0-9_.-]+:)?genInfo\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?genInfo>/i.exec(text);
  const fundInfo = /<(?:[A-Za-z0-9_.-]+:)?fundInfo\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?fundInfo>/i.exec(text);
  const gen = genInfo ? genInfo[1] : '';
  const fund = fundInfo ? fundInfo[1].replace(/<(?:[A-Za-z0-9_.-]+:)?returnInfo\b[\s\S]*?<\/(?:[A-Za-z0-9_.-]+:)?returnInfo>/gi, ' ') : '';
  const positions: NportPosition[] = [];
  const blocks = /<(?:[A-Za-z0-9_.-]+:)?invstOrSec\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?invstOrSec>/gi;
  let block: RegExpExecArray | null;
  while ((block = blocks.exec(text)) !== null) {
    const raw = block[1];
    const derivativeInfo = /<(?:[A-Za-z0-9_.-]+:)?derivativeInfo\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?derivativeInfo>/i.exec(raw);
    // The reference instrument of a derivative (SPY for a SPY option, a bond for a CDS) is another security: drop it first.
    const own = raw.replace(/<(?:[A-Za-z0-9_.-]+:)?derivativeInfo\b[^>]*>[\s\S]*?<\/(?:[A-Za-z0-9_.-]+:)?derivativeInfo>/gi, ' ');
    const identifiers = /<(?:[A-Za-z0-9_.-]+:)?identifiers\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?identifiers>/i.exec(own);
    const ids = identifiers ? identifiers[1] : '';
    const debt = /<(?:[A-Za-z0-9_.-]+:)?debtSec\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?debtSec>/i.exec(own);
    const name = nportTag(own, 'name');
    positions.push({
      name: name && !/^N\/?A$/i.test(name) ? name : nportTag(own, 'title'),
      title: nportTag(own, 'title'),
      lei: nportCode(nportTag(own, 'lei')),
      cusip: nportCode(nportTag(own, 'cusip') || nportAttr(ids, 'cusip', 'value')),
      isin: nportCode(nportAttr(ids, 'isin', 'value')),
      ticker: nportCode(nportAttr(ids, 'ticker', 'value')),
      other: nportCode(nportAttr(ids, 'other', 'value')),
      otherDesc: nportAttr(ids, 'other', 'otherDesc'),
      balance: nportNumber(nportTag(own, 'balance')),
      units: nportTag(own, 'units'),
      currency: (nportTag(own, 'curCd') || nportAttr(own, 'currencyConditional', 'curCd')).toUpperCase(),
      value: nportNumber(nportTag(own, 'valUSD')),
      weight: nportNumber(nportTag(own, 'pctVal')),
      payoff: nportTag(own, 'payoffProfile'),
      assetCat: (nportTag(own, 'assetCat') || nportAttr(own, 'assetConditional', 'assetCat')).toUpperCase(),
      issuerCat: (nportTag(own, 'issuerCat') || nportAttr(own, 'issuerConditional', 'issuerCat')).toUpperCase(),
      country: nportTag(own, 'invCountry').toUpperCase(),
      derivative: derivativeInfo ? (/\bderivCat\s*=\s*"([^"]*)"/i.exec(derivativeInfo[1]) || ['', 'OTHER'])[1].toUpperCase() : '',
      coupon: debt ? nportNumber(nportTag(debt[1], 'annualizedRt')) : null,
      maturity: debt ? nportIso(nportTag(debt[1], 'maturityDt')) : '',
    });
  }
  return {
    seriesId: nportTag(gen, 'seriesId').toUpperCase(),
    seriesName: nportTag(gen, 'seriesName'),
    regName: nportTag(gen, 'regName'),
    regCik: nportTag(gen, 'regCik').replace(/\D/g, ''),
    repPdDate: nportIso(nportTag(gen, 'repPdDate')),
    netAssets: nportNumber(nportTag(fund, 'netAssets')),
    totalAssets: nportNumber(nportTag(fund, 'totAssets')),
    positions,
  };
}

/**
 * A number as sheet text: '' for null, no exponent, at most `digits` decimals (trailing zeros dropped), and no binary float
 * artifact: `115797518.01` stays `115797518.01`, not the `115797518.01000001` of `toFixed(8)`.
 */
export function nportCell(value: number | null, digits = 8): string {
  if (value === null || !Number.isFinite(value)) return '';
  const fixed = value.toFixed(digits);
  // the shortest text of the rounded number; toFixed only where that text would be an exponent (very small or large numbers)
  const shortest = String(Number(fixed));
  if (!/e/i.test(shortest)) return shortest;
  return fixed.indexOf('.') < 0 ? fixed : fixed.replace(/0+$/, '').replace(/\.$/, '');
}

/** The position's own identifier for a sheet: CUSIP, else ISIN, else the "other" code (a Bloomberg or internal id), else ''. */
export function nportIdentifier(position: NportPosition): string {
  return position.cusip || position.isin || position.other;
}

/**
 * A company name as a lookup key: upper case, punctuation and legal suffixes dropped, `CLASS A` -> `CL A`. Initials are one
 * word whether written with dots, spaces or a slash (`N.V.` = `N V` = `NV`, `C.H. ROBINSON` = `C H ROBINSON`, `A/S` = `A S`,
 * `S.A.B. de C.V.` = `SAB DE CV`), `PUBLIC LIMITED COMPANY` is `plc`, and a leading `US` stays (`U.S. BANCORP` is not
 * `BANCORP, INC.`), so both spellings of one issuer give one key.
 */
export function nportNameKey(value: unknown): string {
  // EDGAR adds a state or qualifier suffix to company titles ("COSTCO WHOLESALE CORP /NEW", "BANK OF AMERICA CORP /DE/",
  // "US BANCORP \DE\", "ACUITY INC. (DE)"): drop a trailing one
  const raw = String(value === null || value === undefined ? '' : value).replace(/(?:\s*(?:[\/\\]\s*[A-Za-z]{2,3}\s*[\/\\]?|\(\s*[A-Za-z]{2,3}\s*\)))+\s*$/, '');
  let text = nportText(raw).toUpperCase().replace(/['’]/g, '').replace(/&/g, ' AND ').replace(/[^A-Z0-9]+/g, ' ').trim();
  text = text.replace(/\bCLASS\s+([A-Z])\b/g, 'CL $1').replace(/\bCL\s+([A-Z])\b/g, 'CL $1');
  // a run of single letters is one word, never the class letter after CL
  const words: string[] = [];
  let joining = false;
  text.split(' ').forEach((word) => {
    const letter = /^[A-Z]$/.test(word);
    if (letter && joining) words[words.length - 1] += word;
    else words.push(word);
    joining = letter && (joining || words[words.length - 2] !== 'CL');
  });
  text = words.join(' ').replace(/\bPUBLIC (?:(?:LIMITED|LTD)(?: (?:COMP[A-Z]*|CO))?|(?:COMPANY|CO) (?:LIMITED|LTD))\b/g, 'PLC').replace(/\b(?:S DE RL )?DE CV\b/g, ' ');
  const share = /\bCL [A-Z]\b/.exec(text);
  text = text.replace(/\b(THE|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PLC|SA|SAB|NV|AG|SE|SPA|AS|ASA|ORDINARY|COMMON|STOCK|SHS|SHARES|ADR|DEPOSITARY|RECEIPT|USD|US|REG|REGISTERED)\b/g, (word: string, _name: string, at: number) => (word === 'US' && at === 0 ? word : ' ')).replace(/\s+/g, ' ').trim();
  if (share && !/\bCL [A-Z]\b/.test(text)) text = `${text} ${share[0]}`;
  return text;
}

/** SEC company_tickers.json -> name key -> ticker (the first, largest company wins a shared key; the class-less key is added too). */
export function parseSecCompanyNames(payload: unknown): Map<string, string> {
  const names = new Map<string, string>();
  const rows = payload && typeof payload === 'object' ? Object.keys(payload as object).map((key) => (payload as Record<string, unknown>)[key]) : [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as { ticker?: unknown; title?: unknown } | null;
    if (!row || typeof row !== 'object') continue;
    const ticker = String(row.ticker === null || row.ticker === undefined ? '' : row.ticker).trim().toUpperCase();
    const key = nportNameKey(row.title);
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker) || !key) continue;
    if (!names.has(key)) names.set(key, ticker);
    const core = key.replace(/ CL [A-Z]$/, '');
    if (core && !names.has(core)) names.set(core, ticker);
  }
  return names;
}

/** SEC company_tickers_mf.json -> fund ticker -> registrant CIK (10 digits), series id, class id. */
export function parseSecFundTickers(payload: unknown): Map<string, NportSeriesRef> {
  const map = new Map<string, NportSeriesRef>();
  const record = (payload && typeof payload === 'object' ? payload : {}) as { fields?: unknown; data?: unknown };
  const fields = Array.isArray(record.fields) ? record.fields.map(String) : [];
  const rows = Array.isArray(record.data) ? record.data : [];
  const at = (row: unknown[], field: string): string => (fields.indexOf(field) < 0 ? '' : String(row[fields.indexOf(field)] === null || row[fields.indexOf(field)] === undefined ? '' : row[fields.indexOf(field)]).trim());
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    const ticker = at(row, 'symbol').toUpperCase();
    const cik = at(row, 'cik').replace(/\D/g, '');
    const seriesId = at(row, 'seriesId').toUpperCase();
    if (!ticker || !Number(cik) || !/^S\d{9}$/.test(seriesId) || map.has(ticker)) continue;
    map.set(ticker, { cik: `0000000000${Number(cik)}`.slice(-10), seriesId, classId: at(row, 'classId').toUpperCase() });
  }
  return map;
}

/**
 * Is the row a contingent value right, a right, a warrant or an escrow line filed as equity? A placeholder CUSIP or ISIN
 * (`436CVR021`, `US009CVR0445`, `549ESC028`, `866CNT017`) says so; so does the name or title (`NOVO NORDISK A/S - CVR`,
 * `XYZ INC RIGHTS`, `... WARRANT FEB 2026`, `Luby's Inc Escrow`), except on a CUSIP with the common-stock issue number 10
 * (Schwab titles Enovix common stock 293594107 "Enovix Corp Warrants"). `CVR` as the first word is a company (CVR Energy).
 */
function nportIsRight(position: NportPosition): boolean {
  if (/^[0-9A-Z]{3}(?:CVR|ESC|CNT)/.test(position.cusip) || /^US[0-9A-Z]{3}(?:CVR|ESC|CNT)/.test(position.isin)) return true;
  if (/^[0-9A-Z]{6}10[0-9]$/.test(position.cusip)) return false;
  return [position.name, position.title].some((text) => /\S\s*\bCVRS?\b|\bCONTINGENT\b|\bRIGHTS?\b|\bRTS\b|\bWARRANTS?\b|\bWTS\b|\bESCROW\b/i.test(text));
}

/**
 * Exchange tickers for the positions, in their order ('' for none). A ticker is given only to a common-stock row (assetCat
 * EC; a preferred EP, a CVR, right, warrant or escrow line gets none, a name match would give it the issuer's common ticker)
 * traded in USD (or with no currency) whose ISIN is U.S. or missing: first the filer's own `<ticker value>`, else the
 * SEC issuer-name table (`names`) when the row has a CUSIP or a U.S. ISIN. A ticker that lands on two different securities
 * (Alphabet A and C, an ordinary share and its ADR) is dropped from the name-matched rows; when the filer itself gave it
 * to two securities it is dropped from all of them. Bonds, cash, funds and derivatives stay identifier-keyed.
 */
export function nportTickers(positions: ReadonlyArray<NportPosition>, names: Map<string, string> | null = null): string[] {
  const fromFiler: boolean[] = [];
  const tickers = positions.map((position, index) => {
    fromFiler[index] = false;
    const equity = position.assetCat === 'EC' && !position.derivative && !nportIsRight(position);
    const usd = !position.currency || position.currency === 'USD';
    if (!equity || !usd || (position.isin && position.isin.slice(0, 2) !== 'US')) return '';
    if (/^[A-Z][A-Z0-9.-]{0,9}$/.test(position.ticker)) {
      fromFiler[index] = true;
      return position.ticker;
    }
    if (!names || !(/^[0-9A-Z]{9}$/.test(position.cusip) || /^US[0-9A-Z]{10}$/.test(position.isin))) return '';
    const key = nportNameKey(position.name);
    return names.get(key) || names.get(key.replace(/ CL [A-Z]$/, '')) || '';
  });
  const securities = new Map<string, { keys: string[]; filer: string[] }>();
  tickers.forEach((ticker, index) => {
    if (!ticker) return;
    const position = positions[index];
    const key = position.cusip || position.isin || position.other || nportNameKey(position.name);
    const seen = securities.get(ticker) || { keys: [], filer: [] };
    if (seen.keys.indexOf(key) < 0) seen.keys.push(key);
    if (fromFiler[index] && seen.filer.indexOf(key) < 0) seen.filer.push(key);
    securities.set(ticker, seen);
  });
  return tickers.map((ticker, index) => {
    const seen = ticker ? securities.get(ticker) : undefined;
    if (!seen || seen.keys.length < 2) return ticker;
    return seen.filer.length === 1 && fromFiler[index] ? ticker : '';
  });
}

/** The browse-edgar Atom feed of one series' NPORT-P filings. */
export function nportSeriesFeedUrl(seriesId: string, count = 10): string {
  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(String(seriesId).toUpperCase())}&type=NPORT-P&dateb=&owner=include&count=${count}&output=atom`;
}

/** The registrant's submissions JSON (report periods of its recent filings). */
export function nportSubmissionsUrl(cik: string): string {
  return `https://data.sec.gov/submissions/CIK${`0000000000${Number(String(cik).replace(/\D/g, '')) || 0}`.slice(-10)}.json`;
}

/** primary_doc.xml of a filing in the registrant's own folder. Throws without a registrant CIK: the accession prefix is the filer agent. */
export function nportDocumentUrl(registrantCik: string, accession: string): string {
  const cik = Number(String(registrantCik).replace(/\D/g, ''));
  if (!cik) throw new Error(`N-PORT ${accession}: no registrant CIK (the accession prefix is the filer agent, never used as the folder)`);
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${String(accession).replace(/-/g, '')}/primary_doc.xml`;
}

/** NPORT-P entries of a browse-edgar Atom feed (amendments and other forms skipped), with the registrant CIK of the filing link. */
export function parseNportFeed(atom: string): NportCandidate[] {
  const out: NportCandidate[] = [];
  const entries = /<entry>([\s\S]*?)<\/entry>/gi;
  let entry: RegExpExecArray | null;
  while ((entry = entries.exec(String(atom === null || atom === undefined ? '' : atom))) !== null) {
    const body = entry[1];
    const form = (nportTag(body, 'filing-type') || nportAttr(body, 'category', 'term')).toUpperCase();
    const accession = nportTag(body, 'accession-number');
    if (form !== 'NPORT-P' || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) continue;
    const folder = /\/Archives\/edgar\/data\/(\d+)\//i.exec(nportTag(body, 'filing-href'));
    out.push({ accession, filed: nportIso(nportTag(body, 'filing-date')), period: nportIso(nportTag(body, 'period')), cik: folder ? folder[1] : '' });
  }
  return out;
}

/** NPORT-P filings of a registrant's submissions JSON (`filings.recent`), with report periods; the registrant is the JSON's own CIK. */
export function parseNportSubmissions(payload: unknown): NportCandidate[] {
  const record = (payload && typeof payload === 'object' ? payload : {}) as { cik?: unknown; filings?: { recent?: Record<string, unknown> } };
  const recent = record.filings && record.filings.recent ? record.filings.recent : {};
  const column = (name: string): unknown[] => (Array.isArray(recent[name]) ? (recent[name] as unknown[]) : []);
  const forms = column('form'), accessions = column('accessionNumber'), filed = column('filingDate'), periods = column('reportDate');
  const cik = String(record.cik === null || record.cik === undefined ? '' : record.cik).replace(/\D/g, '');
  const out: NportCandidate[] = [];
  for (let i = 0; i < forms.length; i++) {
    const accession = String(accessions[i] === null || accessions[i] === undefined ? '' : accessions[i]);
    if (String(forms[i]).toUpperCase() !== 'NPORT-P' || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) continue;
    out.push({ accession, filed: nportIso(filed[i]), period: nportIso(periods[i]), cik });
  }
  return out;
}

/**
 * Candidates newest report period first, then newest filing: a late filing for an older period never wins. A missing
 * period is taken from `known` (the registrant's submissions) by accession; candidates still without one go last.
 */
export function nportNewestFirst(candidates: ReadonlyArray<NportCandidate>, known: ReadonlyArray<NportCandidate> = []): NportCandidate[] {
  const periods = new Map<string, string>();
  for (let i = 0; i < known.length; i++) if (known[i].period) periods.set(known[i].accession, known[i].period);
  return candidates
    .map((candidate) => (candidate.period ? candidate : { ...candidate, period: periods.get(candidate.accession) || '' }))
    .sort((a, b) => (a.period && b.period ? b.period.localeCompare(a.period) : a.period ? -1 : b.period ? 1 : 0) || b.filed.localeCompare(a.filed));
}

/**
 * Does the filing belong to the fund? With a series id: only the same series id. Without one: the normalized series name
 * equals the fund name, or (`loose`, reported to the caller) one contains the other. Returns the problem, or null.
 */
export function nportIdentity(filing: Pick<NportFiling, 'seriesId' | 'seriesName'>, fund: { seriesId?: string | null; name?: string | null }): { problem: string | null; loose: boolean } {
  const wantedSeries = String(fund.seriesId || '').trim().toUpperCase();
  if (wantedSeries) return { problem: filing.seriesId === wantedSeries ? null : `names series ${filing.seriesId || 'none'}, not ${wantedSeries}`, loose: false };
  const filed = nportNameKey(filing.seriesName), wanted = nportNameKey(fund.name);
  if (!filed || !wanted) return { problem: 'no series id and no fund name to match', loose: false };
  if (filed === wanted) return { problem: null, loose: false };
  if (filed.indexOf(wanted) >= 0 || wanted.indexOf(filed) >= 0) return { problem: null, loose: true };
  return { problem: `names series "${filing.seriesName}", not "${String(fund.name)}"`, loose: false };
}

/**
 * May a filing replace the published holdings? Nothing published (no rows): any dated or undated report. Otherwise only a
 * report period strictly newer than the published holdings date; both must be ISO dates (convert the brand's display
 * date first), an unknown date on either side keeps the published sheet.
 */
export function nportIsFresh(repPdDate: unknown, publishedAsOf: unknown, publishedRows: unknown): boolean {
  if (!(Number(publishedRows) > 0)) return true;
  const report = nportIso(repPdDate), published = nportIso(publishedAsOf);
  return Boolean(report && published && String(publishedAsOf).trim().length === 10 && report > published);
}

export type NportRead = { filing: NportFiling; candidate: NportCandidate; url: string; loose: boolean } | { problem: string };

/**
 * The newest N-PORT-P filing of one fund, or why there is none. Candidates: the series' Atom feed (when a series id is known;
 * an empty feed means no filing yet) with periods from the registrant's submissions, else (no series id, or the feed failed)
 * the registrant's NPORT-P filings themselves; newest period first.
 * Documents are read until one passes the identity check (at most `maxDocuments`); that newest own filing is returned only
 * when it is fresh against the published holdings (`published.asOf` ISO, `published.rows`). Errors of the optional
 * submissions request are tolerated; others come back as `problem`. `cache` (one Map per run) keeps the submissions and
 * the parsed documents, so funds of one registrant share requests.
 */
export async function readNportHoldings(
  fund: { ticker: string; cik: string; seriesId?: string | null; name?: string | null },
  published: { asOf?: unknown; rows?: unknown },
  getText: (url: string, label: string) => Promise<string>,
  options: { maxDocuments?: number; cache?: Map<string, unknown> } = {},
): Promise<NportRead> {
  const cache = options.cache || new Map<string, unknown>();
  const once = async <T>(key: string, load: () => Promise<T>): Promise<T> => {
    if (!cache.has(key)) cache.set(key, load().catch((error: unknown) => { cache.delete(key); throw error; }));
    return (await cache.get(key)) as T;
  };
  const cik = String(fund.cik || '').replace(/\D/g, '');
  if (!Number(cik)) return { problem: `${fund.ticker}: no registrant CIK` };
  let known: NportCandidate[] = [];
  try {
    known = await once(`submissions:${Number(cik)}`, async () => parseNportSubmissions(JSON.parse(await getText(nportSubmissionsUrl(cik), `${fund.ticker} N-PORT periods`))));
  } catch {
    known = [];
  }
  // null: no series feed (no series id, or the feed failed), so the registrant's own NPORT-P filings are scanned instead
  let candidates: NportCandidate[] | null = null;
  try {
    if (fund.seriesId) candidates = parseNportFeed(await getText(nportSeriesFeedUrl(fund.seriesId), `${fund.ticker} N-PORT filings`));
  } catch (error) {
    if (!known.length) return { problem: `${fund.ticker}: N-PORT filings unavailable (${error instanceof Error ? error.message : String(error)})` };
  }
  const sorted = nportNewestFirst(candidates || known, known);
  if (!sorted.length) return { problem: `${fund.ticker}: no NPORT-P filing yet` };
  const limit = Math.max(1, options.maxDocuments || (candidates ? 3 : 12));
  const misses: string[] = [];
  for (let i = 0; i < sorted.length && i < limit; i++) {
    const candidate = sorted[i];
    const url = nportDocumentUrl(Number(candidate.cik) ? candidate.cik : cik, candidate.accession);
    let filing: NportFiling;
    try {
      filing = await once(`document:${url}`, async () => parseNportFiling(await getText(url, `${fund.ticker} N-PORT ${candidate.accession}`)));
    } catch (error) {
      misses.push(`${candidate.accession} unreadable (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const identity = nportIdentity(filing, fund);
    if (identity.problem) {
      misses.push(`${candidate.accession} ${identity.problem}`);
      continue;
    }
    if (!filing.positions.length) return { problem: `${fund.ticker}: ${candidate.accession} has no positions` };
    if (!nportIsFresh(filing.repPdDate, published.asOf, published.rows)) return { problem: `${fund.ticker}: N-PORT ${filing.repPdDate || 'undated'} is not newer than the published holdings (${String(published.asOf || 'undated')})` };
    return { filing, candidate, url, loose: identity.loose };
  }
  return { problem: `${fund.ticker}: no N-PORT-P filing of its own${misses.length ? `: ${misses.join('; ')}` : ''}` };
}
// </nport-reader>

// <calendar-dates> shared block of .claude/tools/etfs/etf-std/calendar-dates.block.ts, applied by apply-block.ts: never edit it in one repo
/**
 * A calendar date as ISO `YYYY-MM-DD`, or null. Pure text work, never `Date.parse` or local getters, so a run in Tokyo
 * publishes the same day as CI (open-items etfs ETF-H4). Accepts ISO (`2026-10-24`, with a time the date part is kept as
 * written), `2026/10/24`, U.S. `10/24/2026` and `10-24-26` (two-digit years up to 69 are 20xx), month names in either order
 * (`Oct 24, 2026`, `October 24 2026`, `Sept. 30, 2026`, `24 Oct 2026`, `24-Oct-26`), an optional weekday or `as of` in front.
 * A day that does not exist (`02/30/2026`) is null.
 */
export function calendarIso(value: unknown): string | null {
  const text = String(value === null || value === undefined ? '' : value).replace(/[\s ]+/g, ' ').trim()
    .replace(/^as of:? /i, '').replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,? /i, '');
  const year = (raw: string): number => (raw.length === 2 ? (Number(raw) <= 69 ? 2000 : 1900) + Number(raw) : Number(raw));
  const month = (raw: string): number => {
    const word = raw.toLowerCase();
    const names = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    for (let i = 0; i < names.length; i++) if (word.length >= 3 && names[i].indexOf(word) === 0) return i + 1;
    return 0;
  };
  let y = 0, m = 0, d = 0, match: RegExpExecArray | null;
  if ((match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(text)) || (match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(text))) {
    y = Number(match[1]); m = Number(match[2]); d = Number(match[3]);
  } else if ((match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})$/.exec(text))) {
    y = year(match[3]); m = Number(match[1]); d = Number(match[2]);
  } else if ((match = /^([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/.exec(text))) {
    y = Number(match[3]); m = month(match[1]); d = Number(match[2]);
  } else if ((match = /^(\d{1,2})(?:st|nd|rd|th)?[ -]([A-Za-z]{3,9})\.?,?[ -](\d{4}|\d{2})$/.exec(text))) {
    y = year(match[3]); m = month(match[2]); d = Number(match[1]);
  } else {
    return null;
  }
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y < 1900 || y > 2999 || m < 1 || m > 12 || d < 1 || d > days[m - 1]) return null;
  return `${y}-${m < 10 ? '0' : ''}${m}-${d < 10 ? '0' : ''}${d}`;
}

/**
 * Is the fund at least `years` old on `asOf`? Calendar anniversary, inclusive: a fund started 2025-10-24 is one year old on
 * 2026-10-24 (a 29 February start on 1 March). Unknown or unreadable dates answer true, so a value is never dropped for want
 * of a date. The shared "younger than one year" rule: since-inception returns are annualized only from one year on.
 */
export function fundAgeAtLeast(inception: unknown, asOf: unknown, years: number): boolean {
  const start = calendarIso(inception), end = calendarIso(asOf);
  if (!start || !end) return true;
  return end >= `${Number(start.slice(0, 4)) + years}${start.slice(4)}`;
}

/**
 * The returns with every horizon the fund is too young for set to null: `horizons` maps a key of `returns` to the years it
 * needs (`{ yr1: 1, cagr3y: 3, siAnn: 1 }`). Keys that are absent or already null stay as they are; the object is copied.
 */
export function withoutYoungReturns<T extends object>(returns: T, inception: unknown, asOf: unknown, horizons: Record<string, number>): T {
  const out: Record<string, unknown> = { ...(returns as Record<string, unknown>) };
  const keys = Object.keys(horizons);
  for (let i = 0; i < keys.length; i++) {
    if (out[keys[i]] !== undefined && out[keys[i]] !== null && !fundAgeAtLeast(inception, asOf, horizons[keys[i]])) out[keys[i]] = null;
  }
  return out as T;
}
// </calendar-dates>

// <windowed-chart> shared block of .claude/tools/etfs/etf-std/windowed-chart.block.ts, applied by apply-block.ts: never edit it in one repo
export type WindowedChartDay = { date: string; close: number; adjClose: number; volume: number; adjCloseRaw?: number };
export type WindowedChartDividend = { epoch: number; amount: number };

/**
 * A HISTORY_RANGE window (`period1` N years back) never shrinks the published history, and with it the 3y, 5y, 10y and
 * since-inception returns (open-items etfs Q25; was a byte-identical copy in Fidelity, Invesco and JPMorgan). The published
 * rows older than the first fresh day are put in front of the fresh days; their Adj Close is rescaled by the ratio measured on
 * the overlapping days (Yahoo re-adjusts the whole series after each distribution). Published distributions older than the
 * window are kept as well. Returns the chart unchanged when nothing published is older, and null when the window cannot be
 * joined safely (no overlap, Close changed, inconsistent or implausible ratio): the caller then keeps the fund as published.
 * `published` rows carry `Date` (any calendarIso form), `Close`, `Adj Close`, `Volume`; distribution rows are
 * [date, amount, ...] arrays. The chart's days must be sorted by ISO date.
 */
export function mergeWindowedChart<C extends { days: WindowedChartDay[]; dividends: WindowedChartDividend[] }>(chart: C, published: ReadonlyArray<Record<string, unknown>>, publishedDistributions: ReadonlyArray<unknown> = []): C | null {
  if (!chart.days.length || !published.length) return chart;
  const num = (value: unknown): number | null => {
    const text = String(value === null || value === undefined ? '' : value).replace(/[\s,$]/g, '');
    return text && Number.isFinite(Number(text)) ? Number(text) : null;
  };
  const firstFresh = chart.days[0].date;
  const rows: Array<{ date: string; close: number; adjClose: number; volume: number }> = [];
  for (let i = 0; i < published.length; i++) {
    const date = calendarIso(published[i].Date), close = num(published[i].Close), adjClose = num(published[i]['Adj Close']);
    if (date && close !== null && adjClose !== null && adjClose > 0) rows.push({ date, close, adjClose, volume: num(published[i].Volume) || 0 });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const older = rows.filter((row) => row.date < firstFresh);
  if (!older.length) return chart;
  const byDate = new Map<string, { close: number; adjClose: number }>();
  for (let i = 0; i < rows.length; i++) byDate.set(rows[i].date, rows[i]);
  const adjRatios: number[] = [];
  const closeRatios: number[] = [];
  for (let i = 0; i < chart.days.length; i++) {
    const day = chart.days[i];
    const prior = byDate.get(day.date);
    if (!prior) continue;
    adjRatios.push((day.adjCloseRaw === undefined ? day.adjClose : day.adjCloseRaw) / prior.adjClose);
    if (prior.close > 0) closeRatios.push(day.close / prior.close);
  }
  if (!adjRatios.length) return null;
  const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
  if (closeRatios.length && Math.abs(mean(closeRatios) - 1) > 1e-3) return null;
  if (Math.max.apply(null, adjRatios) / Math.min.apply(null, adjRatios) - 1 > 5e-3) return null;
  const measured = mean(adjRatios);
  if (measured < 0.5 || measured > 1.001) return null;
  const factor = Math.abs(measured - 1) < 1e-4 ? 1 : measured;
  const days: WindowedChartDay[] = older.map((row) => {
    const raw = row.adjClose * factor;
    return { date: row.date, close: row.close, adjClose: factor === 1 ? row.adjClose : Math.round(raw * 100) / 100, volume: row.volume, adjCloseRaw: raw };
  });
  const firstFreshEpoch = Date.UTC(Number(firstFresh.slice(0, 4)), Number(firstFresh.slice(5, 7)) - 1, Number(firstFresh.slice(8, 10))) / 1000;
  const kept: WindowedChartDividend[] = [];
  for (let i = 0; i < publishedDistributions.length; i++) {
    const cells = publishedDistributions[i];
    const date = Array.isArray(cells) ? calendarIso(cells[0]) : null;
    const amount = Array.isArray(cells) ? num(cells[1]) : null;
    if (!date || amount === null || amount <= 0) continue;
    const epoch = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 1000;
    if (epoch < firstFreshEpoch) kept.push({ epoch, amount });
  }
  kept.sort((a, b) => a.epoch - b.epoch);
  return { ...chart, days: days.concat(chart.days), dividends: kept.concat(chart.dividends.filter((dividend) => dividend.epoch >= firstFreshEpoch)) };
}
// </windowed-chart>

// <fund-selection> shared block of .claude/tools/etfs/etf-std/fund-selection.block.ts, applied by apply-block.ts: never edit it in one repo
/** An index row as far as these helpers read it: the ticker and whether it has published data (`dataFile`, null for a catalog-only row). */
export type FundSelectionRow = { ticker?: unknown; dataFile?: unknown };

function fundSelectionTicker(row: FundSelectionRow): string {
  return String(row.ticker === null || row.ticker === undefined ? '' : row.ticker).trim().toUpperCase();
}

/**
 * The tickers a TICKERS entry may name: the live catalog plus every fund with published data (closed funds included). When
 * the live catalog could not be read (`live` null) every previous index row counts, since nothing tells a real catalog-only
 * row from a stale one. A catalog-only row from an earlier mistyped TICKERS run is therefore not "known" (open-items etfs Q27).
 */
export function knownTickers(live: ReadonlyArray<string> | null, previous: ReadonlyArray<FundSelectionRow>): string[] {
  const out: string[] = [];
  const add = (ticker: string): void => { if (ticker && out.indexOf(ticker) < 0) out.push(ticker); };
  if (live) for (let i = 0; i < live.length; i++) add(String(live[i]).trim().toUpperCase());
  for (let i = 0; i < previous.length; i++) if (!live || previous[i].dataFile) add(fundSelectionTicker(previous[i]));
  return out;
}

/** Throws before any fund request when TICKERS names a fund outside `known` (see knownTickers): a clear error, nothing fetched or written. */
export function assertKnownTickers(selected: ReadonlyArray<string> | null, known: ReadonlyArray<string>, where: string): void {
  const unknown = (selected || []).map((ticker) => String(ticker).trim().toUpperCase()).filter((ticker) => ticker && known.indexOf(ticker) < 0);
  if (unknown.length) throw new Error(`TICKERS: ${unknown.join(', ')} not in ${where}; nothing was fetched or written`);
}

/**
 * The index rows without stale catalog-only rows: a row with no published data whose ticker the live catalog no longer lists
 * (an earlier mistyped TICKERS entry, a fund withdrawn before launch). Rows with data always stay; nothing is dropped when the
 * live catalog could not be read (`live` null).
 */
export function withoutStalePlaceholders<T extends FundSelectionRow>(rows: ReadonlyArray<T>, live: ReadonlyArray<string> | null): T[] {
  if (!live) return rows.slice();
  const listed = live.map((ticker) => String(ticker).trim().toUpperCase());
  return rows.filter((row) => Boolean(row.dataFile) || listed.indexOf(fundSelectionTicker(row)) >= 0);
}

/**
 * New funds of a run (open-items etfs Q28): `published` - first published in this run (the previous index had no row for it,
 * or only a catalog-only one), so a fund whose first read failed is announced when it finally succeeds; `pending` - new in the
 * catalog this run but not published yet. Nothing is reported on a first run (empty previous index).
 */
export function newFundsReport(previous: ReadonlyArray<FundSelectionRow>, next: ReadonlyArray<FundSelectionRow>): { published: string[]; pending: string[] } {
  const report = { published: [] as string[], pending: [] as string[] };
  if (!previous.length) return report;
  const before = new Map<string, boolean>();
  for (let i = 0; i < previous.length; i++) before.set(fundSelectionTicker(previous[i]), Boolean(previous[i].dataFile));
  for (let i = 0; i < next.length; i++) {
    const ticker = fundSelectionTicker(next[i]);
    if (!ticker || before.get(ticker)) continue;
    if (next[i].dataFile) report.published.push(ticker);
    else if (!before.has(ticker)) report.pending.push(ticker);
  }
  report.published.sort();
  report.pending.sort();
  return report;
}

/** The log and step-summary lines of a newFundsReport: `NEW FUNDS: A, B` and `NEW FUNDS (not published yet): C`; none when empty. */
export function newFundsLines(report: { published: ReadonlyArray<string>; pending: ReadonlyArray<string> }): string[] {
  const lines: string[] = [];
  if (report.published.length) lines.push(`NEW FUNDS: ${report.published.join(', ')}`);
  if (report.pending.length) lines.push(`NEW FUNDS (not published yet): ${report.pending.join(', ')}`);
  return lines;
}
// </fund-selection>
