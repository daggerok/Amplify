/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  CONTROL_NAMES, HOLDINGS_HEADERS, buildMetrics, chartUrl, decodeDocument, epochToIsoDate, fetchJson, fundFilterReasons,
  holdingsRowFromFirestore, inferDistributionFrequency, installSystemCa, isCertError, mergeDividends, mergeHistory, officialReturns,
  parseAumRange, parseChart, parseHistoryRange, parseNport, parsePercent, performanceAsOfDate, priceReturns, readConfig, resetSecCaches, resolveControls,
  resolveNportFiling, runFundPool, runUpdate, runtimeControls, selectCatalog, setApiRoot, setHttpSettings,
  dropCap, fetchText, isNotFound, setClock, setFetchTimeoutMs, setRunDeadlineMs, setSecInterval, trailingYield,
} from './update-data';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const file = () => JSON.parse(read('scripts/update-data.config.json'));
const metrics = (over: Record<string, any> = {}) => ({
  netAssetsValue: 1_000_000_000, expenseRatioPercent: 0.56, dividendYield: 5, secYield: 3, returns: { YTD: 10, '1Y': 20, '3Y': 10 }, ...over,
});

// Clean, portable baseline for every test: no control variable from the shell or the workflow, a pinned zone,
// and fetch, exit code, env and the injectable settings restored afterwards.
const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };
beforeEach(() => {
  for (const key of Object.keys(process.env)) if ((CONTROL_NAMES as readonly string[]).includes(key) || /^AMPLIFY_|^HISTORICAL_|^GITHUB_STEP_SUMMARY$/.test(key)) delete process.env[key];
  process.env.TZ = 'UTC';
  // an advancing fake clock: every stamp differs between runs, so a zero-diff rerun proves stamps are ignored, not merely equal
  let tick = 0;
  setClock(() => Date.parse('2026-10-03T12:00:00Z') + 1000 * tick++);
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  process.exitCode = 0;
  setHttpSettings({ maxRetries: 2, requestSleepMs: 0 });
  setClock(() => Date.now()); setRunDeadlineMs(25 * 60_000); setFetchTimeoutMs(45_000); setSecInterval(150);
});
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, statusText: String(status) });

const fv = (value: any): any =>
  typeof value === 'string' ? { stringValue: value } : typeof value === 'number' ? { doubleValue: value } : typeof value === 'boolean' ? { booleanValue: value }
    : Array.isArray(value) ? { arrayValue: { values: value.map(fv) } } : { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fv(v)])) } };
const fdoc = (path: string, fields: Record<string, any>) => ({ name: `projects/p/databases/(default)/documents/${path}`, fields: Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => [k, fv(v)])) });
const json = reply;
const DAY = 86400;
const T0 = Date.UTC(2026, 8, 28) / 1000;
function stubWeb(options: { yahoo?: boolean; holdings?: boolean; sec?: boolean } = {}) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    calls.push(url);
    const m = /\/documents\/(.+?)(?:\?|$)/.exec(decodeURIComponent(url));
    const path = m ? m[1] : '';
    if (path === 'fund_category') {
      return json(200, { documents: [
        fdoc('fund_category/TEST', { ticker: 'TEST', category: 'Income', isActive: true }),
        fdoc('fund_category/NOHOLD', { ticker: 'NOHOLD', category: 'Core', isActive: true }),
        fdoc('fund_category/OLD', { ticker: 'OLD', category: 'Unknown', isActive: false }),
      ] });
    }
    const fund = /^funds\/([^/]+)\/(.+)$/.exec(path);
    if (fund) {
      const [, ticker, rest] = fund;
      if (rest === 'distributions') return json(403, { error: { code: 403, message: 'Missing or insufficient permissions.' } });
      if (rest === 'fund_metadata/overview') return json(200, fdoc(`funds/${ticker}/fund_metadata/overview`, { Ticker: ticker, DisplayName: `${ticker} Fund`, ExpenseRatio: 0.0056, CUSIP: '111111111', PrimaryExchange: 'NYSE Arca', InceptionDate: '2016-12-13' }));
      if (rest === 'daily') return json(200, { documents: [fdoc(`funds/${ticker}/daily/2026-09-30`, { asOfDate: '2026-09-30', NAV: 10.4, MarketPrice: 10.5, PremiumDiscount: 0.96, NetAssets: 2_500_000_000 })] });
      if (rest === 'yields') return json(200, { documents: [fdoc(`funds/${ticker}/yields/2026-09-30`, { asOfDate: '2026-09-30', '30_Day_SECYield': '1.40%', Distribution_Yield: '4.88%' })] });
      if (rest === 'performance_monthly' || rest === 'performance_quarterly') {
        return json(200, { documents: [fdoc(`funds/${ticker}/${rest}/2026-09-30`, { asOfDate: '2026-09-30', returns: [{ type: 'NAV', returns: { YTD: 8.25, '1Y': 11.43, '3Y': 16.38, '5Y': 11.55, SI_Ann: 12.4, '1M': -3.34 } }] })] });
      }
      if (rest === 'holdings') {
        if (ticker !== 'TEST' || options.holdings === false) return json(200, {});
        return json(200, { documents: [fdoc('funds/TEST/holdings/2026-10-02', { asOfDate: '2026-10-02', source: 'XL_Holdings.csv', holdings: [
          { StockTicker: 'LOW', SecurityName: 'Low Inc', CUSIP: '222222222', Weightings: '1.5%', MarketValue: 150, Shares: 3 },
          { StockTicker: 'TOP', SecurityName: 'Top Corp', CUSIP: '333333333', Weightings: '8.5%', MarketValue: 850, Shares: 7 },
        ] })] });
      }
    }
    if (url.includes('query1.finance.yahoo.com')) {
      if (options.yahoo === false) return json(404, { chart: { result: null, error: { code: 'Not Found' } } });
      return json(200, { chart: { result: [{ meta: { fullExchangeName: 'NYSEArca', regularMarketPrice: 10.5, firstTradeDate: T0 - 400 * DAY }, timestamp: [T0, T0 + DAY, T0 + 2 * DAY],
        indicators: { quote: [{ close: [10, 10.2, 10.5], volume: [100, 200, 300] }], adjclose: [{ adjclose: [9.9, 10.1, 10.4] }] },
        events: { dividends: { a: { date: T0 + DAY, amount: 0.2 } } } }] } });
    }
    if (url.includes('company_tickers_mf.json')) return json(200, { fields: ['cik', 'seriesId', 'classId', 'symbol'], data: [[1234, 'S000001', 'C000001', 'NOHOLD']] });
    if (url.includes('company_tickers.json')) return json(200, { 0: { cik_str: 1, ticker: 'ALFA', title: 'Alpha Corp' } });
    if (url.includes('browse-edgar')) return new Response('<feed><entry><filing-type>NPORT-P</filing-type><accession-number>0001234-26-000001</accession-number><filing-date>2026-08-28</filing-date><period>2026-07-31</period><filing-href>https://www.sec.gov/Archives/edgar/data/1234/000123426000001/0001234-26-000001-index.htm</filing-href></entry></feed>');
    if (url.endsWith('primary_doc.xml')) {
      return new Response(`<edgarSubmission><genInfo><regCik>0001234</regCik><seriesName>NOHOLD ETF</seriesName><seriesId>S000001</seriesId><repPdDate>2026-07-31</repPdDate></genInfo>
        <invstOrSec><name>Alpha Corp</name><cusip>444444444</cusip><valUSD>300</valUSD><pctVal>30.0</pctVal><balance>5</balance></invstOrSec>
        <invstOrSec><name>Zeta Corp</name><cusip>555555555</cusip><valUSD>700</valUSD><pctVal>70.0</pctVal><balance>9</balance></invstOrSec></edgarSubmission>`);
    }
    return json(404, { error: { message: `unexpected ${url}` } });
  }) as any;
  return calls;
}

function snapshot(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(out, snapshot(full, base));
    else out[full.slice(base.length + 1)] = readFileSync(full, 'utf8');
  }
  return out;
}

async function runInTemp(env: Record<string, string>, root?: string) {
  const dir = root ?? mkdtempSync(join(tmpdir(), 'amplify-feed-'));
  setApiRoot(pathToFileURL(`${dir}/`));
  const log = console.log, warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { await runUpdate({ USE_SYSTEM_CA: 'false', MAX_RETRIES: '1', CONCURRENCY: '2', ...env }); }
  finally { console.log = log; console.warn = warn; }
  return dir;
}
// ---- fix contract: a configurable multi-fund Firestore/Yahoo world --------------------------

type Tweak = Record<string, any>;
type World = {
  catalog: Array<{ ticker: string; category?: string; isActive?: boolean }>;
  asOf: string; nav: number; price: number; perfDate: string | null; ytd: number;
  yahoo: { from: string; to: string; divs: Array<[string, number]> } | number;
  fail: (url: string) => number;
  fund: Record<string, { meta?: Tweak | null; daily?: Tweak | null; yields?: Tweak | null; noPerf?: boolean; yahoo?: World['yahoo']; holdings?: boolean }>;
};
const baseWorld = (): World => ({
  catalog: [{ ticker: 'AAA', category: 'Income' }, { ticker: 'BBB', category: 'Core' }, { ticker: 'CCC', category: 'Thematic' }],
  asOf: '2026-09-30', nav: 10.4, price: 10.5, perfDate: '2026-09-30', ytd: 8.25,
  yahoo: { from: '2024-01-02', to: '2026-09-30', divs: [['2025-12-15', 0.5], ['2026-03-16', 0.5], ['2026-06-15', 0.5], ['2026-09-14', 0.5]] },
  fail: () => 0, fund: {},
});
const epochOf = (day: string) => Date.parse(`${day}T14:30:00Z`) / 1000;
function stubWorld(w: World) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    calls.push(url);
    const failing = w.fail(url);
    if (failing) return json(failing, { error: { code: failing, message: 'boom' } });
    const m = /\/documents\/(.+?)(?:\?|$)/.exec(decodeURIComponent(url));
    const path = m ? m[1] : '';
    if (path === 'fund_category') return json(200, { documents: w.catalog.map(f => fdoc(`fund_category/${f.ticker}`, { ticker: f.ticker, category: f.category ?? 'Income', isActive: f.isActive ?? true })) });
    const fund = /^funds\/([^/]+)\/(.+)$/.exec(path);
    if (fund) {
      const [, ticker, rest] = fund;
      const t = w.fund[ticker] ?? {};
      if (rest === 'distributions') return json(403, { error: { code: 403, message: 'Missing or insufficient permissions.' } });
      if (rest === 'fund_metadata/overview') {
        if (t.meta === null) return json(404, { error: { code: 404, message: 'Document not found' } });
        return json(200, fdoc(`funds/${ticker}/fund_metadata/overview`, { Ticker: ticker, DisplayName: `${ticker} Fund`, ExpenseRatio: 0.0056, CUSIP: '111111111', PrimaryExchange: 'NYSE Arca', InceptionDate: '2016-12-13', ...(t.meta ?? {}) }));
      }
      if (rest === 'daily') {
        if (t.daily === null) return json(200, {});
        const fields = { asOfDate: w.asOf, NAV: w.nav, MarketPrice: w.price, PremiumDiscount: 0.96, NetAssets: 2_500_000_000, ...(t.daily ?? {}) };
        return json(200, { documents: [fdoc(`funds/${ticker}/daily/${fields.asOfDate}`, fields)] });
      }
      if (rest === 'yields') {
        if (t.yields === null) return json(200, {});
        return json(200, { documents: [fdoc(`funds/${ticker}/yields/${w.asOf}`, t.yields ?? { asOfDate: w.asOf, '30_Day_SECYield': '1.40%', Distribution_Yield: '4.88%' })] });
      }
      if (rest === 'performance_monthly' || rest === 'performance_quarterly') {
        if (t.noPerf || w.perfDate === null) return json(200, {});
        return json(200, { documents: [fdoc(`funds/${ticker}/${rest}/${w.perfDate}`, { asOfDate: w.perfDate, returns: [{ type: 'NAV', returns: { YTD: w.ytd, '1Y': 11.43, '3Y': 16.38, '5Y': 11.55, SI_Ann: 12.4, '1M': -3.34 } }] })] });
      }
      if (rest === 'holdings') {
        if (t.holdings === false) return json(200, {});
        return json(200, { documents: [fdoc(`funds/${ticker}/holdings/${w.asOf}`, { asOfDate: w.asOf, source: 'XL.csv', holdings: [
          { StockTicker: 'LOW', SecurityName: 'Low Inc', CUSIP: '222222222', Weightings: '1.5%', MarketValue: 150, Shares: 3 },
          { StockTicker: 'TOP', SecurityName: 'Top Corp', CUSIP: '333333333', Weightings: '8.5%', MarketValue: 850, Shares: 7 },
        ] })] });
      }
    }
    if (url.includes('company_tickers_mf.json')) return json(200, { fields: ['cik', 'seriesId', 'classId', 'symbol'], data: [] });
    if (url.includes('company_tickers.json')) return json(200, {});
    if (url.includes('efts.sec.gov')) return json(200, { hits: { hits: [] } });
    if (url.includes('query1.finance.yahoo.com')) {
      const ticker = decodeURIComponent(url.split('/chart/')[1].split('?')[0]);
      const y = w.fund[ticker]?.yahoo ?? w.yahoo;
      if (typeof y === 'number') return json(y, { chart: { result: null, error: { code: y === 404 ? 'Not Found' : 'Server', description: 'x' } } });
      const ts: number[] = [], close: number[] = [];
      for (let x = epochOf(y.from), i = 0; x <= epochOf(y.to); x += DAY, i++) { ts.push(x); close.push(Math.round((10 + i * 0.001) * 10000) / 10000); }
      const dividends = Object.fromEntries(y.divs.map(([day, amount]) => [`d${day}`, { date: epochOf(day), amount }]));
      return json(200, { chart: { result: [{ meta: { fullExchangeName: 'NYSEArca', regularMarketPrice: w.price, regularMarketTime: epochOf(y.to), firstTradeDate: epochOf(y.from) }, timestamp: ts,
        indicators: { quote: [{ close, volume: close.map(() => 100) }], adjclose: [{ adjclose: close }] }, events: { dividends } }] } });
    }
    return json(404, { error: { message: `unexpected ${url}` } });
  }) as any;
  return calls;
}

async function runLogged(env: Record<string, string>, root?: string, extra: { summary?: string } = {}) {
  const dir = root ?? mkdtempSync(join(tmpdir(), 'amplify-world-'));
  setApiRoot(pathToFileURL(`${dir}/`));
  const lines: string[] = [];
  const log = console.log, warn = console.warn;
  console.log = (...a: any[]) => { lines.push(a.join(' ')); }; console.warn = (...a: any[]) => { lines.push(a.join(' ')); };
  let error: unknown = null;
  try { await runUpdate({ USE_SYSTEM_CA: 'false', MAX_RETRIES: '1', CONCURRENCY: '2', ...(extra.summary ? { GITHUB_STEP_SUMMARY: extra.summary } : {}), ...env }); }
  catch (e) { error = e; }
  finally { console.log = log; console.warn = warn; }
  const code = process.exitCode ?? 0; process.exitCode = 0;
  return { dir, lines, code, error };
}
const readIndex = (dir: string) => JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
const readMeta = (dir: string, ticker: string) => JSON.parse(readFileSync(join(dir, `funds/${ticker}/meta.json`), 'utf8'));
const rowOf = (dir: string, ticker: string) => readIndex(dir).funds.find((f: any) => f.ticker === ticker);
const only = (files: Record<string, string>, ticker: string) => Object.fromEntries(Object.entries(files).filter(([k]) => k.startsWith(`funds/${ticker}/`)));

describe('controls', () => {
  test('precedence file < advanced < nonblank input < env < brand alias; blank inherits, explicit empty env and advanced clear', () => {
    const c = resolveControls({ CONCURRENCY: 2, TICKERS: 'DIVO' }, { CONCURRENCY: 3, TICKERS: 'IDVO' }, { CONCURRENCY: '4', TICKERS: '' }, { AMPLIFY_CONCURRENCY: '5', CONCURRENCY: '6' });
    expect(c.CONCURRENCY).toBe('5'); expect(c.TICKERS).toBe('IDVO');
    expect(resolveControls({ CONCURRENCY: 2 }, {}, { CONCURRENCY: '4' }, {}).CONCURRENCY).toBe('4');
    expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }, { CONCURRENCY: '4' }, { CONCURRENCY: '7' }).CONCURRENCY).toBe('7');
    expect(resolveControls({ CONCURRENCY: 2 }, {}, {}, { AMPLIFY_DATA_CONCURRENCY: '8' }).CONCURRENCY).toBe('8');
    expect(resolveControls({}, {}, {}, { HISTORICAL_PAGE_SIZE: '77' }).HISTORY_PAGE_SIZE).toBe('77');
    expect(resolveControls({ TICKERS: 'DIVO' }, {}, { TICKERS: '' }).TICKERS).toBe('DIVO');
    expect(resolveControls({ CONCURRENCY: 3 }, {}, { CONCURRENCY: '   ' }).CONCURRENCY).toBe('3');
    expect(resolveControls({ TICKERS: 'DIVO' }, { TICKERS: '' }, { TICKERS: '' }).TICKERS).toBe('');
    expect(resolveControls({ TICKERS: 'DIVO' }, {}, {}, { TICKERS: '' }).TICKERS).toBe('');
    expect(resolveControls({ VERBOSE: true }, {}, {}, { VERBOSE: 'false' }).VERBOSE).toBe('false');
  });

  test('scheduled path equals the config defaults; config keys equal CONTROL_NAMES; runtimeControls applies env', async () => {
    const defaults = file();
    expect(Object.keys(defaults).sort()).toEqual([...CONTROL_NAMES].sort());
    for (const value of Object.values(defaults)) expect(typeof value).toBe('string');
    expect(resolveControls(defaults, {}, {}, {})).toEqual(defaults);
    const config = readConfig(resolveControls(defaults));
    expect([config.maxFetches, config.requestSleepSeconds, config.concurrency, config.holdingsPageSize, config.historyPageSize, config.maxRetries]).toEqual([0, 0, 6, 250, 1000, 2]);
    expect([config.historyRange, config.skipYahoo, config.edgarFallback, config.secUa]).toEqual(['max', false, true, 'daggerok ETF feed daggerok@gmail.com']);
    expect(config.tickers).toEqual([]); expect(config.categories).toEqual([]);
    expect([config.aumRange, config.terRange, config.dividendYieldRange, config.secYieldRange]).toEqual([undefined, undefined, undefined, undefined]);
    expect(config.performanceRanges).toEqual({}); expect(config.totalReturnRanges).toEqual({});
    expect(defaults.USE_SYSTEM_CA).toBe('auto');
    expect(await runtimeControls({})).toEqual(defaults);
    expect((await runtimeControls({ TICKERS: 'DIVO' })).TICKERS).toBe('DIVO');
  });

  test('strict validation: unknown, invalid, non-scalar, multiline and bad enum values throw', () => {
    for (const value of [
      { UNKNOWN: 1 }, { OUTPUT_DIR: '/tmp' }, { CONCURRENCY: 0 }, { CONCURRENCY: 1.5 }, { MAX_RETRIES: 0 }, { MAX_RETRIES: 'x' },
      { MAX_FETCHES: -1 }, { MAX_FETCHES: 1.5 }, { REQUEST_SLEEP: -1 }, { REQUEST_SLEEP: 'fast' }, { HISTORY_PAGE_SIZE: 0 }, { HOLDINGS_PAGE_SIZE: 0 },
      { HISTORY_RANGE: 'forever' }, { HISTORY_RANGE: '0y' }, { SKIP_YAHOO: 'maybe' }, { EDGAR_FALLBACK: 'sometimes' },
      { VERBOSE: 'maybe' }, { USE_SYSTEM_CA: 'maybe' }, { USE_SYSTEM_CA: 'yes' }, { AUM: '1:2:3' }, { TER: '1' }, { DIVIDEND_YIELD: '5' }, { PERFORMANCE_1Y: '9:1' },
      { TICKERS: ['DIVO'] }, { TICKERS: null }, { TICKERS: { a: 1 } }, null, [],
    ]) expect(() => resolveControls(value)).toThrow();
    expect(() => resolveControls({}, { TICKERS: 'DIVO\nEVIL=yes' })).toThrow();
    expect(() => resolveControls({}, {}, { TICKERS: 'DIVO\rx' })).toThrow();
    expect(() => resolveControls({}, {}, {}, { AMPLIFY_TICKERS: 'x\0bad' })).toThrow();
    expect(() => resolveControls({}, {}, {}, { MAX_RETRIES: '0' })).toThrow();
    expect(() => resolveControls({}, 'not an object')).toThrow();
    expect(() => resolveControls({}, [])).toThrow();
    for (const value of ['auto', 'TRUE', 'False']) expect(resolveControls({}, {}, {}, { USE_SYSTEM_CA: value }).USE_SYSTEM_CA).toBe(value);
    for (const value of ['y', 'n', 'on', 'off']) expect(resolveControls({}, {}, {}, { VERBOSE: value }).VERBOSE).toBe(value);
  });

  test('controls drive the parsed config', () => {
    const c = readConfig(resolveControls({ TICKERS: 'divo, idvo', CATEGORY: 'Income', AUM: 'mid:', TER: ':0.75', TOTAL_RETURN_1Y: '15:', MAX_FETCHES: '3', REQUEST_SLEEP: '0.5', HOLDINGS_PAGE_SIZE: '40', HISTORY_PAGE_SIZE: '50', MAX_RETRIES: '1', HISTORY_RANGE: '5Y', SKIP_YAHOO: 'true', EDGAR_FALLBACK: 'off', SEC_UA: 'ops contact' }));
    expect(c.tickers).toEqual(['DIVO', 'IDVO']); expect(c.categories).toEqual(['Income']);
    expect(c.aumRange?.min).toBe(2_000_000_000); expect(c.terRange).toEqual({ min: undefined, max: 0.75 });
    expect(c.totalReturnRanges['1Y']).toEqual({ min: 15, max: undefined });
    expect([c.maxFetches, c.requestSleepSeconds, c.holdingsPageSize, c.historyPageSize, c.maxRetries]).toEqual([3, 0.5, 40, 50, 1]);
    expect([c.historyRange, c.skipYahoo, c.edgarFallback, c.secUa]).toEqual(['5y', true, false, 'ops contact']);
  });

  test('filters: unavailable is never zero, TER uses percent, ranges are inclusive', () => {
    const cfg = (env: Record<string, string>) => readConfig(resolveControls(env));
    expect(fundFilterReasons(metrics(), cfg({}))).toEqual([]);
    expect(fundFilterReasons(metrics(), cfg({ TER: ':0.56' }))).toEqual([]);
    expect(fundFilterReasons(metrics(), cfg({ TER: ':0.5' }))).toEqual(['TER range (:0.5)']);
    expect(fundFilterReasons(metrics({ expenseRatioPercent: null }), cfg({ TER: ':1' }))).toEqual(['expense ratio unavailable']);
    expect(fundFilterReasons(metrics({ netAssetsValue: null }), cfg({ AUM: ':' }))).toEqual([]);
    expect(fundFilterReasons(metrics({ netAssetsValue: null }), cfg({ AUM: 'small:' }))).toEqual(['net assets unavailable']);
    expect(fundFilterReasons(metrics(), cfg({ DIVIDEND_YIELD: '6:' }))).toEqual(['dividend yield range (6:)']);
    expect(fundFilterReasons(metrics({ secYield: null }), cfg({ SEC_YIELD: '1:' }))).toEqual(['SEC yield unavailable']);
    expect(fundFilterReasons(metrics(), cfg({ PERFORMANCE_1Y: '25:' }))).toEqual(['1Y performance range (25:)']);
    expect(fundFilterReasons(metrics(), cfg({ PERFORMANCE_5Y: '1:' }))).toEqual(['5Y performance unavailable']);
    expect(fundFilterReasons(metrics(), cfg({ TOTAL_RETURN_3Y: '30:' }))).toEqual([]); // (1.10)^3 - 1 = 33.1%
    expect(fundFilterReasons(metrics(), cfg({ TOTAL_RETURN_3Y: '34:' }))).toEqual(['3Y total return range (34:)']);
  });

  test('catalog selection: tickers, categories and MAX_FETCHES', () => {
    const catalog = ['ZZZ', 'AAA', 'MMM', 'BBB'].map((ticker, i) => ({ ticker, category: i % 2 ? 'Core' : 'Income', active: true }));
    const pick = (env: Record<string, string>) => selectCatalog(catalog, readConfig(resolveControls(env))).map(f => f.ticker);
    expect(pick({})).toEqual(['ZZZ', 'AAA', 'MMM', 'BBB']);
    expect(pick({ TICKERS: 'aaa mmm' })).toEqual(['AAA', 'MMM']);
    expect(pick({ CATEGORY: 'income' })).toEqual(['ZZZ', 'MMM']);
    // a bounded batch is a resumable window over the alphabetical filter set: the caller takes N funds that pass, from the cursor, wrapping around
    expect(pick({ MAX_FETCHES: '2' })).toEqual(['AAA', 'BBB', 'MMM', 'ZZZ']);
    expect(pick({ MAX_FETCHES: '9', CATEGORY: 'Core' })).toEqual(['AAA', 'BBB']);
    const after = (cursor: string | null, env: Record<string, string>) => selectCatalog(catalog, readConfig(resolveControls(env)), cursor).map(f => f.ticker);
    expect(after('BBB', { MAX_FETCHES: '2' })).toEqual(['MMM', 'ZZZ', 'AAA', 'BBB']);
    expect(after('ZZZ', { MAX_FETCHES: '2' })).toEqual(['AAA', 'BBB', 'MMM', 'ZZZ']);
    expect(after('MMM', { MAX_FETCHES: '2', CATEGORY: 'Income' })).toEqual(['ZZZ', 'MMM']);
    expect(after('BBB', {})).toEqual(['ZZZ', 'AAA', 'MMM', 'BBB']); // MAX_FETCHES=0 ignores the cursor
    expect(() => pick({ TICKERS: 'AAA NOPE' })).toThrow('Unknown TICKERS: NOPE');
  });
});

describe('parsing', () => {
  test('Firestore documents decode typed values in sorted key order', () => {
    const doc = decodeDocument({
      name: 'projects/p/databases/(default)/documents/funds/DIVO/daily/2026-09-25',
      fields: {
        NAV: { doubleValue: 47.26 }, Ticker: { stringValue: 'DIVO' }, Shares: { integerValue: '166300000' }, Live: { booleanValue: true },
        Gone: { nullValue: null }, Tags: { arrayValue: { values: [{ stringValue: 'a' }] } },
        Nested: { mapValue: { fields: { z: { integerValue: '1' }, a: { integerValue: '2' } } } },
      },
    });
    expect(doc.id).toBe('2026-09-25');
    expect(Object.keys(doc.fields)).toEqual(['Gone', 'Live', 'NAV', 'Nested', 'Shares', 'Tags', 'Ticker']);
    expect(doc.fields.Shares).toBe(166300000); expect(doc.fields.Gone).toBeNull(); expect(doc.fields.Tags).toEqual(['a']);
    expect(Object.keys(doc.fields.Nested)).toEqual(['a', 'z']);
  });

  test('percent and AUM parsing', () => {
    expect(parsePercent('7.5%')).toBe(7.5); expect(parsePercent(0.0628)).toBe(0.0628); expect(parsePercent('0.5')).toBe(0.5); expect(parsePercent(0.5)).toBe(0.5); expect(parsePercent('0.00%')).toBe(0); expect(parsePercent('')).toBeNull(); expect(parsePercent('n/a')).toBeNull();
    expect(parseAumRange('300M:2B')).toMatchObject({ min: 300_000_000, max: 2_000_000_000, maxExclusive: false });
    expect(parseAumRange('nano:micro')).toMatchObject({ min: 0, max: 300_000_000, maxExclusive: true });
    expect(parseAumRange(':')).toBeUndefined();
    expect(() => parseAumRange('5B:1B')).toThrow();
  });

  test('holdings rows keep published text and never turn missing values into zero', () => {
    expect(HOLDINGS_HEADERS).toEqual(['Name', 'Ticker', 'Identifier', 'Weight', 'Market Value', 'Shares Held', 'SEDOL']);
    expect(holdingsRowFromFirestore({ StockTicker: ' aapl ', SecurityName: 'Apple  Inc', CUSIP: '037833100', Weightings: '5.38%', MarketValue: 416404695.2, Shares: 1260610 }))
      .toEqual({ Name: 'Apple Inc', Ticker: 'AAPL', Identifier: '037833100', Weight: '5.38', 'Market Value': '416404695.2', 'Shares Held': '1260610', SEDOL: '' });
    expect(holdingsRowFromFirestore({ SecurityName: 'Cash & Other', StockTicker: 'Cash&Other', Weightings: '-0.01%' })).toMatchObject({ Weight: '-0.01', 'Market Value': '', 'Shares Held': '' });
    expect(holdingsRowFromFirestore({ SecurityName: 'Tiny', Weightings: '0.5' })).toMatchObject({ Weight: '0.5' });
    expect(holdingsRowFromFirestore({})).toBeNull();
  });

  test('official NAV returns come from the NAV row, qtd is never taken from the trailing 3M figure', () => {
    const doc = decodeDocument({ name: 'x/performance_monthly/2026-09-30', fields: { returns: { arrayValue: { values: [
      { mapValue: { fields: { type: { stringValue: 'INDEX' }, returns: { mapValue: { fields: { YTD: { doubleValue: 99 } } } } } } },
      { mapValue: { fields: { type: { stringValue: 'NAV' }, returns: { mapValue: { fields: { YTD: { doubleValue: 8.25 }, '1Y': { doubleValue: 11.43 }, '3Y': { doubleValue: 16.38 }, '1M': { doubleValue: -3.34 }, '3M': { doubleValue: 2.89 }, SI_Ann: { doubleValue: 12.4 } } } } } } },
    ] } } } });
    expect(officialReturns(doc)).toEqual({ asOfDate: 'Sep 30 2026', ytd: 8.25, yr1: 11.43, yr3: 16.38, yr5: null, yr10: null, sinceInception: 12.4, mo1: -3.34, qtd: null });
    expect(officialReturns(null)).toBeNull();
    expect(officialReturns(decodeDocument({ name: 'x/y/2026-09-30', fields: {} }))).toBeNull();
  });

  test('Yahoo chart payload: daily closes, adjusted closes, volume, dividends; rows merge by date', () => {
    const payload = { chart: { result: [{ meta: { fullExchangeName: 'NYSEArca', regularMarketPrice: 46.47, firstTradeDate: 1481812200 }, timestamp: [1790553600, 1790640000, 1790726400],
      indicators: { quote: [{ close: [10, null, 10.5], volume: [100, 0, 300] }], adjclose: [{ adjclose: [9.9, null, 10.4] }] },
      events: { dividends: { a: { date: 1790640000, amount: 0.2 }, b: { date: 1790726400, amount: 0 } } } }] } };
    const chart = parseChart(payload);
    expect(chart.days).toEqual([{ date: '2026-09-28', close: 10, adjClose: 9.9, volume: 100 }, { date: '2026-09-30', close: 10.5, adjClose: 10.4, volume: 300 }]);
    expect(chart.dividends).toEqual([{ epoch: 1790640000, amount: 0.2 }]);
    expect(() => parseChart({ chart: { result: null } })).toThrow();
    const previous = [{ Date: 'Sep 28 2026', Close: '10', 'Adj Close': '9.89', Volume: '100' }, { Date: 'Sep 01 2026', Close: '9', 'Adj Close': '8.9', Volume: '5' }];
    const merged = mergeHistory(previous, chart.days);
    expect(merged.map(r => r.Date)).toEqual(['Sep 01 2026', 'Sep 28 2026', 'Sep 30 2026']);
    expect(merged[1]['Adj Close']).toBe('9.89'); // sub-two-cent Yahoo jitter keeps the published cent
    expect(mergeHistory([{ Date: 'Sep 28 2026', Close: '10', 'Adj Close': '9', Volume: '1' }], chart.days)[0]['Adj Close']).toBe('9.9');
    expect(mergeDividends({ distributions: { rows: [['09/30/2026', '0.1'], ['08/31/2026', '0.3']] } }, chart, [{ epoch: 1790640000, amount: 0.25 }]))
      .toEqual([{ epoch: Date.parse('2026-08-31') / 1000, amount: 0.3 }, { epoch: 1790640000, amount: 0.25 }, { epoch: Date.parse('2026-09-30') / 1000, amount: 0.1 }]);
  });

  test('N-PORT-P parser keeps missing weights and values empty, not zero', () => {
    const xml = `<edgarSubmission><genInfo><regName>Amplify ETF Trust</regName><regCik>0001</regCik><seriesName>Test ETF</seriesName><seriesId>S1</seriesId><repPdDate>2026-06-30</repPdDate></genInfo>
      <fundInfo><netAssets>1000.5</netAssets></fundInfo><invstOrSec><name>Alpha Corp</name><cusip>111111111</cusip><valUSD>500</valUSD><pctVal>50.0</pctVal><balance>10</balance></invstOrSec>
      <invstOrSec><name>Beta Inc</name><identifiers><isin value="US2222222222"/></identifiers></invstOrSec></edgarSubmission>`;
    const parsed = parseNport(xml);
    expect(parsed).toMatchObject({ seriesId: 'S1', repPdDate: '2026-06-30', netAssets: 1000.5 });
    expect(parsed.holdings[0]).toMatchObject({ Name: 'Alpha Corp', Identifier: '111111111', Weight: '50', 'Market Value': '500', 'Shares Held': '10' });
    expect(parsed.holdings[1]).toMatchObject({ Name: 'Beta Inc', Identifier: 'US2222222222', Weight: '', 'Market Value': '', 'Shares Held': '-' });
  });
});

describe('metrics', () => {
  test('metrics: official values win, Yahoo derived values fill gaps, TR is (1+CAGR)^n - 1, missing stays null', () => {
    const none = priceReturns([]);
    const m = buildMetrics({ ytd: 8.25, yr1: 11.43, yr3: 10, yr5: null, yr10: null, sinceInception: 12.4 }, { ...none, cagr5y: 7, ytd: 1 }, 1.4, null);
    expect(m).toMatchObject({ ytd: 8.25, tr1y: 11.43, cagr3y: 10, tr3y: 33.1, cagr5y: 7, tr5y: 40.26, cagr10y: null, tr10y: null, siAnn: 12.4, secYield: 1.4, dividendYield: null, dividendYieldText: '—' });
    expect(inferDistributionFrequency([])).toEqual({ frequency: 'None', paymentsPerYear: null });
    const monthly = [1, 2, 3, 4].map(i => ({ epoch: Date.UTC(2026, i, 1) / 1000, amount: 0.2 }));
    expect(inferDistributionFrequency(monthly)).toEqual({ frequency: 'Monthly', paymentsPerYear: 12 });
    expect(performanceAsOfDate('Sep 30 2026')).toBe('2026-09-30');
    expect(performanceAsOfDate('2026-10-01')).toBe('2026-10-01');
    expect([performanceAsOfDate(null), performanceAsOfDate('—'), performanceAsOfDate('')]).toEqual([null, null, null]);
  });

  test('an official table that is absent now is not replaced by the old one under a new date; returns and performanceAsOf move together', async () => {
    const w = baseWorld();
    stubWorld(w);
    const { dir } = await runLogged({ TICKERS: 'AAA' });
    try {
      expect(rowOf(dir, 'AAA').metrics).toMatchObject({ performanceAsOf: '2026-09-30', ytd: 8.25 });
      w.perfDate = null; w.yahoo = { from: '2024-01-02', to: '2026-10-02', divs: [] }; w.asOf = '2026-10-02';
      stubWorld(w);
      await runLogged({ TICKERS: 'AAA' }, dir);
      const m = rowOf(dir, 'AAA').metrics;
      expect(m.performanceAsOf).toBe('2026-10-02');
      expect(m.returnsBasis).toMatch(/^Yahoo adjusted/);
      expect(m.ytd).not.toBe(8.25);
      expect(readMeta(dir, 'AAA').returns.monthEnd.asOfDate).toBe('Oct 02 2026');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('expense ratio is the net figure, gross only when published; a published 0.00% yield stays an official zero, others are trailing 12 months or null', async () => {
    const w = baseWorld();
    w.fund = { AAA: { yields: { asOfDate: w.asOf, Distribution_Yield: '0.00%', '30_Day_SECYield': '0.13%' } }, BBB: { yields: { asOfDate: w.asOf } }, CCC: { yields: { asOfDate: w.asOf }, yahoo: { from: '2026-03-02', to: '2026-09-30', divs: [['2026-06-15', 1]] } } };
    stubWorld(w);
    const { dir } = await runLogged({});
    try {
      expect(rowOf(dir, 'AAA')).toMatchObject({ terValue: 0.56, ter: '0.56%', terGrossValue: null, terGross: '—' });
      expect(readMeta(dir, 'AAA').expenseRatio).toEqual({ display: '0.56%', value: 0.56, gross: null, net: 0.56 });
      expect(rowOf(dir, 'AAA').metrics.dividendYield).toBe(0);
      expect(readMeta(dir, 'AAA').yields.dividendYieldKind).toMatch(/official zero/);
      expect(rowOf(dir, 'BBB').metrics.dividendYield).toBe(19.05); // 4 x 0.5 over the 10.5 price in the trailing 12 months
      expect(readMeta(dir, 'BBB').yields.dividendYieldKind).toMatch(/^trailing 12 months/);
      expect(rowOf(dir, 'CCC').metrics.dividendYield).toBeNull(); // under 12 months of history
      expect(trailingYield([{ epoch: epochOf('2026-03-16'), amount: 1 }, { epoch: epochOf('2025-03-16'), amount: 5 }], 50, '2026-09-30', '2024-01-02')).toBe(2);
      expect(trailingYield([], 50, '2026-09-30', '2024-01-02')).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('siAnn needs a year of life; zero is never invented for missing values', async () => {
    const w = baseWorld();
    w.fund = { BBB: { meta: { InceptionDate: '2026-03-01' } }, CCC: { meta: { InceptionDate: '2016-12-13' } } };
    stubWorld(w);
    const { dir } = await runLogged({});
    try {
      expect(rowOf(dir, 'BBB').metrics.siAnn).toBeNull();
      expect(readMeta(dir, 'BBB').returns.monthEnd.sinceInception).toBeNull();
      expect(rowOf(dir, 'CCC').metrics.siAnn).toBe(12.4);
      for (const f of readIndex(dir).funds) for (const k of ['ytd', 'tr1y', 'siAnn', 'secYield']) expect(f.metrics[k]).not.toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('pre-launch placeholders, delisted and aum-only funds are marked, never published as real values', async () => {
    const w = baseWorld();
    w.catalog = [{ ticker: 'CPU', category: 'Thematic' }, { ticker: 'HKX', category: 'International' }, { ticker: 'SMP', category: 'Core' }, { ticker: 'OK1', category: 'Income' }];
    w.fund = {
      CPU: { meta: { InceptionDate: '2026-10-06', LaunchDate: '2026-10-07', ExpenseRatio: 0.0049 }, daily: { asOfDate: '2026-10-05', NAV: 25, MarketPrice: 25, NetAssets: 25, PremiumDiscount: 0, isPlaceholder: true, bootstrapSource: 'pre-inception-guard' }, yields: null, noPerf: true, holdings: false, yahoo: 404 },
      HKX: { meta: { Ticker: 'HKX', DisplayName: 'Partner Fund', ExpenseRatio: undefined, CUSIP: undefined, InceptionDate: undefined }, daily: { asOfDate: '2026-09-30', NAV: undefined, MarketPrice: undefined, PremiumDiscount: undefined, NetAssets: 11_301_170, Currency: 'USD' }, yields: null, noPerf: true, holdings: false, yahoo: 404 },
      SMP: { meta: { DelistDate: '2026-06-04' }, daily: { asOfDate: '2026-06-04', NAV: 26.5, MarketPrice: 26.5 }, yahoo: 404 },
    };
    setClock(() => Date.parse('2026-10-03T12:00:00Z'));
    stubWorld(w);
    const { dir, code } = await runLogged({});
    try {
      expect(code).toBe(0);
      const cpu = rowOf(dir, 'CPU');
      expect(cpu).toMatchObject({ status: 'pre-launch', navValue: null, closePriceValue: null, aumValue: null, premiumDiscountValue: null, asOfDate: '—', inceptionDate: '—', terValue: 0.49 });
      expect(cpu.metrics).toMatchObject({ ytd: null, tr1y: null, siAnn: null, dividendYield: null, secYield: null, performanceAsOf: null });
      expect(typeof cpu.metrics.returnsBasis).toBe('string');
      expect(readMeta(dir, 'CPU').inception).toMatchObject({ fundInceptionDate: null, expectedInceptionDate: '2026-10-06', shareClassInceptionDate: null });
      expect(JSON.stringify(readIndex(dir))).not.toMatch(/Oct 0[5-7] 2026|2026-10-0[5-7]T/);
      const hk = rowOf(dir, 'HKX');
      expect(hk).toMatchObject({ status: 'aum-only', navValue: null, closePriceValue: null, aumValue: 11_301_170, terValue: null });
      // the AUM keeps moving (Yahoo "not found" is an honest absence, not a failure that freezes the fund)
      w.fund.HKX.daily = { ...w.fund.HKX.daily, NetAssets: 12_000_000 };
      stubWorld(w);
      await runLogged({}, dir);
      expect(rowOf(dir, 'HKX').aumValue).toBe(12_000_000);
      expect(rowOf(dir, 'SMP')).toMatchObject({ status: 'delisted', navValue: 26.5 });
      expect(readMeta(dir, 'SMP').inception.delistDate).toBe('2026-06-04');
      expect(rowOf(dir, 'OK1').status).toBe('active');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('dates are UTC: a run east of UTC gives the same output as UTC (history, as-of, returns)', async () => {
    const previousTz = process.env.TZ;
    const results: string[] = [];
    try {
      for (const tz of ['UTC', 'Pacific/Kiritimati', 'Europe/Berlin', 'Pacific/Auckland', 'America/Los_Angeles']) {
        process.env.TZ = tz;
        const w = baseWorld(); w.perfDate = null; // Yahoo-derived returns: every date comes from text history rows
        stubWorld(w);
        const first = await runLogged({ TICKERS: 'AAA' });
        w.yahoo = { from: '2024-01-02', to: '2026-10-02', divs: [] }; w.asOf = '2026-10-02';
        stubWorld(w);
        const dir = (await runLogged({ TICKERS: 'AAA' }, first.dir)).dir;
        const row = rowOf(dir, 'AAA'), meta = readMeta(dir, 'AAA');
        results.push(JSON.stringify([row.metrics.performanceAsOf, meta.history.asOf, meta.returns.monthEnd.asOfDate, row.metrics.ytd, row.metrics.tr1y, row.history]));
        rmSync(dir, { recursive: true, force: true });
      }
    } finally { if (previousTz === undefined) delete process.env.TZ; else process.env.TZ = previousTz; }
    expect(results[0]).toContain('"2026-10-02","Oct 02 2026","Oct 02 2026"');
    expect(new Set(results).size).toBe(1);
    // the text-date parsers themselves, under a zone east of UTC
    process.env.TZ = 'Europe/Berlin';
    try {
      expect(mergeHistory([{ Date: 'Jun 30 2026', Close: '1', 'Adj Close': '1', Volume: '1' }], [{ date: '2026-06-30', close: 2, adjClose: 2, volume: 2 }]).map(r => [r.Date, r.Close])).toEqual([['Jun 30 2026', '2']]);
      expect(performanceAsOfDate('Jun 30 2026')).toBe('2026-06-30');
    } finally { if (previousTz === undefined) delete process.env.TZ; else process.env.TZ = previousTz; }
  });
});

describe('pipeline', () => {
  test('feed layout: index.json + funds/<TICKER>/meta.json + paginated holdings/history, stable on a second run', async () => {
    stubWeb();
    const dir = await runInTemp({ TICKERS: 'TEST', HOLDINGS_PAGE_SIZE: '1', HISTORY_PAGE_SIZE: '2' });
    try {
      const files = snapshot(dir);
      expect(Object.keys(files).sort()).toEqual(['funds/TEST/history/001.json', 'funds/TEST/history/002.json', 'funds/TEST/holdings/001.json', 'funds/TEST/holdings/002.json', 'funds/TEST/meta.json', 'index.json']);
      const index = JSON.parse(files['index.json']);
      expect(Object.keys(index)).toEqual(['generatedAt', 'catalogReadAt', 'source', 'counts', 'funds']);
      expect(index.counts).toEqual({ funds: 1, holdings: 2, history: 3 });
      expect(index.funds[0]).toMatchObject({
        ticker: 'TEST', name: 'TEST Fund', category: 'Income', dataFile: './funds/TEST/meta.json', terValue: 0.56, ter: '0.56%', navValue: 10.4, aumValue: 2_500_000_000,
        closePriceValue: 10.5, premiumDiscountValue: 0.96, asOfDate: 'Sep 30 2026', inceptionDate: 'Dec 13 2016', exchange: 'NYSE Arca', holdings: 2, history: 3,
        distributions: { frequency: 'Unknown', exDate: epochToIsoDate(T0 + DAY).replace(/(\d+)-(\d+)-(\d+)/, '$2/$3/$1'), dividend: '0.2' },
      });
      expect(index.funds[0].metrics).toMatchObject({ ytd: 8.25, tr1y: 11.43, cagr3y: 16.38, tr3y: 57.63, cagr10y: null, tr10y: null, siAnn: 12.4, secYield: 1.4, dividendYield: 4.88 });
      const keys = Object.keys(index.funds[0].metrics);
      expect(keys.slice(-2)).toEqual(['returnsBasis', 'performanceAsOf']);
      expect(index.funds[0].metrics.returnsBasis).toMatch(/official Amplify NAV/);
      expect(index.funds[0].metrics.performanceAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(index.funds[0].metrics.performanceAsOf).toBe(performanceAsOfDate(index.funds[0].returns.monthEnd.asOfDate));
      const meta = JSON.parse(files['funds/TEST/meta.json']);
      expect(meta.holdings).toMatchObject({ pages: ['holdings/001.json', 'holdings/002.json'], pageSize: 1, totalRows: 2, asOfDate: '2026-10-02', asOf: 'Oct 02 2026', status: 'available' });
      expect(meta.history).toMatchObject({ pages: ['history/001.json', 'history/002.json'], pageSize: 2, totalRows: 3, asOf: 'Sep 30 2026' });
      expect(meta.history.source).toContain('Yahoo Finance');
      expect(meta.distributions).toMatchObject({ headers: ['Ex-Date', 'Amount'], rows: [[expect.stringMatching(/^\d\d\/\d\d\/2026$/), '0.2']] });
      expect(meta.returns.monthEnd).toMatchObject({ asOfDate: 'Sep 30 2026', ytd: 8.25, yr1: 11.43, yr3: 16.38, yr5: 11.55, yr10: null, mo1: -3.34 });
      const page = JSON.parse(files['funds/TEST/holdings/001.json']);
      expect(page).toMatchObject({ ticker: 'TEST', page: 1, pageSize: 1, totalRows: 2, headers: HOLDINGS_HEADERS });
      expect(page.rows[0]).toMatchObject({ Name: 'Top Corp', Ticker: 'TOP', Weight: '8.5' }); // sorted by weight, not by Firestore order
      expect(JSON.parse(files['funds/TEST/history/001.json']).rows[0]).toEqual({ Date: 'Sep 28 2026', Close: '10', 'Adj Close': '9.9', Volume: '100' });
      // A second identical run changes no file at all, not even generatedAt.
      stubWeb();
      await runInTemp({ TICKERS: 'TEST', HOLDINGS_PAGE_SIZE: '1', HISTORY_PAGE_SIZE: '2' }, dir);
      expect(snapshot(dir)).toEqual(files);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('SKIP_YAHOO keeps published history; a failing Yahoo never wipes it; filters skip without touching files', async () => {
    stubWeb();
    const dir = await runInTemp({ TICKERS: 'TEST' });
    try {
      const before = snapshot(dir);
      const calls = stubWeb();
      await runInTemp({ TICKERS: 'TEST', SKIP_YAHOO: 'true' }, dir);
      expect(calls.some(url => url.includes('finance.yahoo.com'))).toBe(false);
      expect(snapshot(dir)).toEqual(before);
      stubWeb({ yahoo: false });
      await runInTemp({ TICKERS: 'TEST' }, dir);
      expect(snapshot(dir)).toEqual(before);
      stubWeb();
      await runInTemp({ TICKERS: 'TEST', AUM: '10B:' }, dir); // filtered out: files stay as published
      expect(snapshot(dir)).toEqual(before);
      await expect(runInTemp({ TICKERS: 'TEST', AUM: '10B:' }, mkdtempSync(join(tmpdir(), 'amplify-empty-')))).rejects.toThrow('No publishable funds');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('without Firestore holdings the SEC N-PORT-P series fills the sheet (EDGAR_FALLBACK); without it the sheet stays empty', async () => {
    resetSecCaches();
    const calls = stubWeb();
    const dir = await runInTemp({ TICKERS: 'NOHOLD' });
    try {
      const meta = JSON.parse(readFileSync(join(dir, 'funds/NOHOLD/meta.json'), 'utf8'));
      expect(meta.holdings).toMatchObject({ totalRows: 2, asOfDate: '2026-07-31', status: 'available' });
      expect(meta.holdings.source).toContain('primary_doc.xml');
      const rows = JSON.parse(readFileSync(join(dir, 'funds/NOHOLD/holdings/001.json'), 'utf8')).rows;
      expect(rows.map((r: any) => [r.Name, r.Ticker, r.Weight])).toEqual([['Zeta Corp', '', '70'], ['Alpha Corp', 'ALFA', '30']]);
      expect(calls.some(url => url.includes('sec.gov'))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
    resetSecCaches();
    const calls2 = stubWeb();
    const dir2 = await runInTemp({ TICKERS: 'NOHOLD', EDGAR_FALLBACK: 'false' });
    try {
      const meta = JSON.parse(readFileSync(join(dir2, 'funds/NOHOLD/meta.json'), 'utf8'));
      expect(meta.holdings).toMatchObject({ pages: [], totalRows: 0, asOfDate: null, status: 'unavailable' });
      expect(calls2.some(url => url.includes('sec.gov'))).toBe(false);
    } finally { rmSync(dir2, { recursive: true, force: true }); }
  });

  test('SEC resolver never accepts another series and never replaces holdings that are as fresh or fresher; a transport failure is an error, not an empty result', async () => {
    const config = readConfig(resolveControls({}, {}, {}, {}));
    const fund = { ticker: 'NOHOLD', category: 'Core', active: true, name: 'NOHOLD ETF' };
    resetSecCaches(); stubWeb();
    expect((await resolveNportFiling(fund, config, '2026-03-31'))?.asOfDate).toBe('2026-07-31');
    expect(await resolveNportFiling(fund, config, '2026-07-31')).toBeNull();
    expect(await resolveNportFiling(fund, config, '2026-09-30')).toBeNull();
    resetSecCaches(); stubWeb();
    const stub = globalThis.fetch;
    globalThis.fetch = (async (input: any, init: any) => (String(input).endsWith('primary_doc.xml')
      ? new Response('<edgarSubmission><genInfo><regCik>0001234</regCik><seriesName>Other</seriesName><seriesId>S999999</seriesId><repPdDate>2026-07-31</repPdDate></genInfo><invstOrSec><name>X</name><cusip>1</cusip></invstOrSec></edgarSubmission>')
      : stub(input, init))) as any;
    expect(await resolveNportFiling(fund, config)).toBeNull();
    resetSecCaches(); stubWeb();
    const ok = globalThis.fetch;
    globalThis.fetch = (async (input: any, init: any) => (String(input).includes('browse-edgar') || String(input).endsWith('primary_doc.xml') ? reply(500, { error: { message: 'down' } }) : ok(input, init))) as any;
    setHttpSettings({ maxRetries: 0, requestSleepMs: 0 });
    await expect(resolveNportFiling(fund, config)).rejects.toThrow();
  });

  test('a failed source keeps the whole fund as published; an honest null from an answering source is never replaced', async () => {
    const w = baseWorld();
    stubWorld(w);
    const first = await runLogged({});
    const dir = first.dir;
    try {
      const before = snapshot(dir);
      // Yahoo breaks for AAA only while the NAV moved everywhere
      w.nav = 11; w.fail = url => (url.includes('/chart/AAA') ? 500 : 0);
      stubWorld(w);
      const second = await runLogged({}, dir);
      expect(second.code).toBe(0);
      const after = snapshot(dir);
      expect(only(after, 'AAA')).toEqual(only(before, 'AAA'));
      expect(rowOf(dir, 'AAA').navValue).toBe(10.4);
      expect(rowOf(dir, 'BBB').navValue).toBe(11);
      // every examined fund kept: non-zero exit, no file changes
      const snap2 = snapshot(dir);
      w.fail = url => (url.includes('/chart/') ? 500 : 0); w.nav = 12;
      stubWorld(w);
      const third = await runLogged({}, dir);
      expect(third.code).toBe(1);
      expect(snapshot(dir)).toEqual(snap2);
      // an answering yields document without a SEC yield: null, not the previous 1.40
      w.fail = () => 0; w.fund.AAA = { yields: { asOfDate: w.asOf, Distribution_Yield: '4.88%' } };
      stubWorld(w);
      await runLogged({}, dir);
      expect(rowOf(dir, 'AAA').metrics.secYield).toBeNull();
      expect(rowOf(dir, 'AAA').metrics.secYieldText).toBe('—');
      expect(rowOf(dir, 'BBB').metrics.secYield).toBe(1.4);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a TICKERS run on a multi-fund index keeps every row and file and never touches the cursor; an unknown ticker is an error', async () => {
    const w = baseWorld();
    stubWorld(w);
    const { dir } = await runLogged({});
    try {
      expect(readIndex(dir).funds).toHaveLength(3);
      expect(new Set(readIndex(dir).funds.map((f: any) => Object.keys(f.metrics).join())).size).toBe(1); // same metrics key set on every row
      for (const f of readIndex(dir).funds) expect(f.dataFile).toBe(`./funds/${f.ticker}/meta.json`);
      await runLogged({ MAX_FETCHES: '2' }, dir);
      const cursor = readFileSync(join(dir, 'update-state.json'), 'utf8');
      expect(JSON.parse(cursor)).toEqual({ cursor: 'BBB' });
      const before = snapshot(dir);
      w.nav = 11;
      stubWorld(w);
      await runLogged({ TICKERS: 'AAA' }, dir);
      const after = snapshot(dir);
      expect(readIndex(dir).funds.map((f: any) => f.ticker)).toEqual(['AAA', 'BBB', 'CCC']);
      expect(only(after, 'BBB')).toEqual(only(before, 'BBB'));
      expect(only(after, 'CCC')).toEqual(only(before, 'CCC'));
      expect(rowOf(dir, 'AAA').navValue).toBe(11);
      expect(after['update-state.json']).toBe(cursor);
      await runLogged({ TICKERS: 'AAA', MAX_FETCHES: '1' }, dir);
      expect(readFileSync(join(dir, 'update-state.json'), 'utf8')).toBe(cursor);
      const unknown = await runLogged({ TICKERS: 'AAA NOPE' }, dir);
      expect(String(unknown.error)).toContain('Unknown TICKERS: NOPE');
      expect(snapshot(dir)).toEqual(after);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('MAX_FETCHES counts funds that pass the filters, resumes after the cursor and wraps around', async () => {
    const w = baseWorld();
    w.fund = { AAA: { meta: { ExpenseRatio: 0.0009 } } }; // TER 0.09: excluded by TER=0.2:
    stubWorld(w);
    const { dir } = await runLogged({});
    try {
      w.nav = 11;
      stubWorld(w);
      await runLogged({ MAX_FETCHES: '2', TER: '0.2:' }, dir);
      expect(rowOf(dir, 'AAA').navValue).toBe(10.4); // excluded, untouched, not counted
      expect(rowOf(dir, 'BBB').navValue).toBe(11); expect(rowOf(dir, 'CCC').navValue).toBe(11);
      expect(JSON.parse(readFileSync(join(dir, 'update-state.json'), 'utf8'))).toEqual({ cursor: 'CCC' });
      w.nav = 12;
      stubWorld(w);
      await runLogged({ MAX_FETCHES: '1', TER: '0.2:' }, dir);
      // wraps after CCC: AAA is excluded, BBB passes and takes the single slot
      expect(rowOf(dir, 'BBB').navValue).toBe(12); expect(rowOf(dir, 'CCC').navValue).toBe(11);
      expect(JSON.parse(readFileSync(join(dir, 'update-state.json'), 'utf8'))).toEqual({ cursor: 'BBB' });
      await runLogged({}, dir);
      expect(() => readFileSync(join(dir, 'update-state.json'))).toThrow(); // a full pass removes the cursor
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('NEW FUNDS, ISO seconds stamp, rerun writes nothing, soft deadline keeps published data', async () => {
    const w = baseWorld();
    w.catalog = w.catalog.slice(0, 2);
    stubWorld(w);
    const first = await runLogged({});
    const dir = first.dir;
    try {
      expect(readIndex(dir).generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(readIndex(dir).catalogReadAt).toBe(readIndex(dir).generatedAt);
      const before = snapshot(dir);
      stubWorld(w);
      await runLogged({}, dir);
      expect(snapshot(dir)).toEqual(before); // identical upstream data: zero diff, stamps included
      w.catalog = baseWorld().catalog;
      stubWorld(w);
      const summary = join(dir, 'summary.md');
      const second = await runLogged({}, dir, { summary });
      expect(readFileSync(summary, 'utf8')).toContain('NEW FUNDS: CCC');
      const snap = snapshot(dir);
      w.nav = 13;
      stubWorld(w);
      setRunDeadlineMs(-1);
      const late = await runLogged({}, dir);
      expect(late.code).toBe(0);
      expect(snapshot(dir)).toEqual(snap);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a fund missing from the active list is not purged unless the provider no longer lists it; capped and reported', async () => {
    const w = baseWorld();
    w.catalog = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'B1'].map(ticker => ({ ticker, category: 'Income' }));
    stubWorld(w);
    const { dir } = await runLogged({});
    try {
      expect(readIndex(dir).funds).toHaveLength(10);
      // A1 becomes inactive and A2 gets category "Unknown": still listed by the provider -> kept, files untouched
      w.catalog = w.catalog.map(f => (f.ticker === 'A1' ? { ...f, isActive: false } : f.ticker === 'A2' ? { ...f, category: 'Unknown' } : f));
      const before = snapshot(dir);
      stubWorld(w);
      await runLogged({}, dir);
      expect(readIndex(dir).funds.map((f: any) => f.ticker)).toContain('A1');
      expect(readIndex(dir).funds.map((f: any) => f.ticker)).toContain('A2');
      expect(only(snapshot(dir), 'A1')).toEqual(only(before, 'A1'));
      // one fund disappears from the provider's list entirely: purged, with a DROPPED FUNDS line and in the step summary
      w.catalog = w.catalog.filter(f => f.ticker !== 'B1');
      stubWorld(w);
      const summary = join(dir, 'summary.md');
      await runLogged({}, dir, { summary });
      expect(readIndex(dir).funds.map((f: any) => f.ticker)).not.toContain('B1');
      expect(() => readFileSync(join(dir, 'funds/B1/meta.json'))).toThrow();
      expect(readFileSync(summary, 'utf8')).toContain('DROPPED FUNDS: B1');
      // more than the cap vanish at once (a broken catalog read): nothing is purged
      expect(dropCap(9)).toBe(3);
      w.catalog = w.catalog.slice(0, 4);
      stubWorld(w);
      await runLogged({}, dir);
      expect(readIndex(dir).funds).toHaveLength(9);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('stale pages are removed only after the new meta.json is written', async () => {
    const w = baseWorld();
    stubWorld(w);
    const { dir } = await runLogged({ TICKERS: 'AAA', HOLDINGS_PAGE_SIZE: '1' });
    try {
      expect(readdirSync(join(dir, 'funds/AAA/holdings')).sort()).toEqual(['001.json', '002.json']);
      await runLogged({ TICKERS: 'AAA', HOLDINGS_PAGE_SIZE: '250' }, dir);
      expect(readdirSync(join(dir, 'funds/AAA/holdings')).sort()).toEqual(['001.json']);
      expect(readMeta(dir, 'AAA').holdings.pages).toEqual(['holdings/001.json']);
      expect(readdirSync(join(dir, 'funds/AAA')).filter(f => f.endsWith('.tmp'))).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('network', () => {
  test('fetchJson retries 429/5xx and network errors, never 4xx, and stops after MAX_RETRIES', async () => {
    let calls = 0;
    globalThis.fetch = (async () => (++calls === 1 ? reply(503, {}) : calls === 2 ? Promise.reject(new TypeError('network')) : reply(200, { ok: true }))) as any;
    setHttpSettings({ maxRetries: 2, requestSleepMs: 0 });
    expect(await fetchJson('https://x.test/a')).toEqual({ ok: true }); expect(calls).toBe(3);

    calls = 0; globalThis.fetch = (async () => { calls++; return reply(404, { error: { message: 'missing' } }); }) as any;
    await expect(fetchJson('https://x.test/b')).rejects.toThrow('missing'); expect(calls).toBe(1);

    calls = 0; globalThis.fetch = (async () => { calls++; return reply(500, {}); }) as any;
    setHttpSettings({ maxRetries: 1, requestSleepMs: 0 });
    await expect(fetchJson('https://x.test/c')).rejects.toThrow(); expect(calls).toBe(2);
  });

  test('timeout covers the response body and a stalled request is retried, then fails instead of hanging', async () => {
    let calls = 0;
    setFetchTimeoutMs(60); setHttpSettings({ maxRetries: 1, requestSleepMs: 0 });
    // without a working abort signal these mocks hang, so removing the timeout fails the test instead of passing by accident
    const never = (init: any) => new Promise<never>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal.reason)));
    globalThis.fetch = (async (_url: any, init: any) => {
      calls++;
      if (calls === 1) return { ok: true, status: 200, statusText: 'OK', text: () => never(init) } as any;
      return new Response('{"ok":true}');
    }) as any;
    expect(await fetchJson('https://x.test/slow-body')).toEqual({ ok: true });
    expect(calls).toBe(2);
    calls = 0;
    globalThis.fetch = ((_url: any, init: any) => { calls++; return never(init); }) as any;
    await expect(fetchJson('https://x.test/never')).rejects.toThrow();
    expect(calls).toBe(2);
  }, 8000);

  test('in-flight requests: peak 1 at CONCURRENCY=1 and N at N, for pool lanes and for the full run', async () => {
    for (const [concurrency, sleepMs] of [[1, 0], [1, 20], [3, 20], [3, 0]]) {
      let inFlight = 0, peak = 0;
      globalThis.fetch = (async () => {
        peak = Math.max(peak, ++inFlight);
        await new Promise(resolve => setTimeout(resolve, 15));
        inFlight--;
        return reply(200, {});
      }) as any;
      setHttpSettings({ maxRetries: 1, requestSleepMs: sleepMs });
      // 6 funds, each issuing 3 parallel requests like the real per-fund Promise.all
      await runFundPool([1, 2, 3, 4, 5, 6], concurrency, async n => {
        await Promise.all([1, 2, 3].map(i => fetchJson(`https://x.test/${n}/${i}`)));
      });
      expect(peak).toBe(concurrency);
    }
    for (const concurrency of [1, 3]) {
      let inFlight = 0, peak = 0;
      const inner = stubWeb();
      const stub = globalThis.fetch;
      globalThis.fetch = (async (input: any, init: any) => {
        peak = Math.max(peak, ++inFlight);
        await new Promise(resolve => setTimeout(resolve, 5));
        try { return await stub(input, init); } finally { inFlight--; }
      }) as any;
      resetSecCaches();
      const dir = await runInTemp({ CONCURRENCY: String(concurrency) });
      rmSync(dir, { recursive: true, force: true });
      expect(inner.length).toBeGreaterThan(10);
      expect(peak).toBeLessThanOrEqual(concurrency + 1); // +1: the catalog listing runs on the default lane before the workers start
      expect(peak).toBeGreaterThanOrEqual(Math.min(concurrency, 2));
    }
  });

  test('REQUEST_SLEEP and the SEC gate space request starts (lower bounds only); a SEC 403 is retried, other 403s are not', async () => {
    const starts: number[] = [];
    globalThis.fetch = (async () => { starts.push(Date.now()); return reply(200, {}); }) as any;
    setHttpSettings({ maxRetries: 1, requestSleepMs: 60 });
    await Promise.all([fetchJson('https://x.test/1'), fetchJson('https://x.test/2'), fetchJson('https://x.test/3')]);
    starts.sort((a, b) => a - b);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(50); expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(50);
    starts.length = 0;
    setSecInterval(70); setHttpSettings({ maxRetries: 2, requestSleepMs: 0 });
    await runFundPool([1, 2, 3], 3, async n => { await fetchJson(`https://data.sec.gov/submissions/${n}.json`); });
    starts.sort((a, b) => a - b);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(60); expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(60);
    let calls = 0;
    globalThis.fetch = (async () => (++calls === 1 ? reply(403, { error: { message: 'Undeclared Automated Tool' } }) : reply(200, { ok: 1 }))) as any;
    expect(await fetchJson('https://www.sec.gov/files/company_tickers.json')).toEqual({ ok: 1 });
    expect(calls).toBe(2);
    calls = 0;
    globalThis.fetch = (async () => { calls++; return reply(403, { error: { message: 'denied' } }); }) as any;
    await expect(fetchText('https://firestore.googleapis.com/v1/x')).rejects.toThrow('denied');
    expect(calls).toBe(1);
  }, 15000);

  test('HISTORY_RANGE really narrows the Yahoo request with explicit period1/period2', () => {
    const now = Date.UTC(2026, 9, 2);
    const period1 = (range: string) => Number(new URL(chartUrl('DIVO', { historyRange: range }, now)).searchParams.get('period1'));
    expect(parseHistoryRange('')).toBe('max'); expect(parseHistoryRange('5Y')).toBe('5y'); expect(() => parseHistoryRange('1m')).toThrow();
    expect(period1('max')).toBe(0);
    expect(period1('5y')).toBe(Math.floor(now / 1000 - 5 * 365.25 * 86400));
    expect(period1('1y')).toBeGreaterThan(period1('5y'));
    expect(new URL(chartUrl('K-DIVO', { historyRange: 'max' }, now)).searchParams.get('period2')).toBe(String(now / 1000));
    expect(new URL(chartUrl('DIVO', { historyRange: 'max' }, now)).searchParams.get('interval')).toBe('1d');
  });

  test('TLS trust store: certificate errors are recognized and the fetch wrapper restarts once, only in auto mode', async () => {
    expect(isCertError({ code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' })).toBe(true);
    expect(isCertError(new Error('unable to get local issuer certificate'))).toBe(true);
    expect(isCertError(Object.assign(new Error('fetch failed'), { cause: new Error('unable to get local issuer certificate') }))).toBe(true);
    expect(isCertError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBe(false);
    expect(isCertError(new Error('HTTP 403 Forbidden'))).toBe(false);
    expect(isCertError(null)).toBe(false);
    const original = globalThis.fetch;
    try {
      let calls = 0;
      const reexec = (() => { calls++; return undefined as never; }) as () => never;
      installSystemCa('false', reexec, false);
      expect(globalThis.fetch).toBe(original);
      installSystemCa('auto', reexec, true);
      expect(globalThis.fetch).toBe(original);
      installSystemCa('true', reexec, true);
      expect(calls).toBe(0);
      installSystemCa('true', reexec, false);
      expect(calls).toBe(1);
      globalThis.fetch = original; // a real reexec never returns; the mock does

      calls = 0;
      globalThis.fetch = (async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } }); }) as any;
      const certFetch = globalThis.fetch;
      installSystemCa('auto', reexec, false);
      expect(globalThis.fetch).not.toBe(certFetch);
      await globalThis.fetch('https://x.test/');
      expect(calls).toBe(1);

      calls = 0;
      globalThis.fetch = (async () => { throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }); }) as any;
      installSystemCa('auto', reexec, false);
      await expect(globalThis.fetch('https://x.test/')).rejects.toThrow('ECONNRESET');
      expect(calls).toBe(0);

      globalThis.fetch = (async () => new Response('ok')) as any;
      installSystemCa('auto', reexec, false);
      expect(await (await globalThis.fetch('https://x.test/')).text()).toBe('ok');
      expect(calls).toBe(0);
    } finally { globalThis.fetch = original; }
  });
});
