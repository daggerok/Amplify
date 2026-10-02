/// <reference types="bun" />
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CONTROL_NAMES, HOLDINGS_HEADERS, USAGE, buildMetrics, chartUrl, decodeDocument, epochToIsoDate, fetchJson, fundFilterReasons,
  holdingsRowFromFirestore, inferDistributionFrequency, installSystemCa, isCertError, mergeDividends, mergeHistory, officialReturns,
  parseAumRange, parseChart, parseHistoryRange, parseNport, parsePercent, priceReturns, readConfig, resetSecCaches, resolveControls,
  resolveNportFiling, runFundPool, runUpdate, runtimeControls, selectCatalog, setApiRoot, setHttpSettings,
} from './update-data';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const file = () => JSON.parse(read('scripts/update-data.config.json'));
const metrics = (over: Record<string, any> = {}) => ({
  netAssetsValue: 1_000_000_000, expenseRatioPercent: 0.56, dividendYield: 5, secYield: 3, returns: { YTD: 10, '1Y': 20, '3Y': 10 }, ...over,
});

// ---- resolver -------------------------------------------------------------

test('configuration precedence: file < advanced < nonblank input < environment', () => {
  const c = resolveControls({ CONCURRENCY: 2, TICKERS: 'DIVO' }, { CONCURRENCY: 3, TICKERS: 'IDVO' }, { CONCURRENCY: '4', TICKERS: '' }, { AMPLIFY_CONCURRENCY: '5', CONCURRENCY: '6' });
  expect(c.CONCURRENCY).toBe('5'); expect(c.TICKERS).toBe('IDVO');
  expect(resolveControls({ CONCURRENCY: 2 }, {}, { CONCURRENCY: '4' }, {}).CONCURRENCY).toBe('4');
  expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }, { CONCURRENCY: '4' }, { CONCURRENCY: '7' }).CONCURRENCY).toBe('7');
  expect(resolveControls({ CONCURRENCY: 2 }, {}, {}, { AMPLIFY_DATA_CONCURRENCY: '8' }).CONCURRENCY).toBe('8');
});

test('blank input inherits the file value; advanced and explicit empty env clear a key deliberately', () => {
  expect(resolveControls({ TICKERS: 'DIVO' }, {}, { TICKERS: '' }).TICKERS).toBe('DIVO');
  expect(resolveControls({ TICKERS: 'DIVO' }, { TICKERS: '' }, { TICKERS: '' }).TICKERS).toBe('');
  expect(resolveControls({ TICKERS: 'DIVO' }, {}, {}, { TICKERS: '' }).TICKERS).toBe('');
  expect(resolveControls({ VERBOSE: true }, {}, {}, { VERBOSE: 'false' }).VERBOSE).toBe('false');
});

test('scheduled path (empty inputs and advanced) equals the config defaults', () => {
  const defaults = file();
  expect(resolveControls(defaults, JSON.parse('{}'), {}, {})).toEqual(defaults);
  const config = readConfig(resolveControls(defaults));
  expect(config.maxFetches).toBe(0); expect(config.requestSleepSeconds).toBe(0); expect(config.concurrency).toBe(6);
  expect(config.holdingsPageSize).toBe(250); expect(config.historyPageSize).toBe(1000); expect(config.maxRetries).toBe(2);
  expect(config.historyRange).toBe('max'); expect(config.skipYahoo).toBe(false); expect(config.edgarFallback).toBe(true);
  expect(config.secUa).toBe('daggerok ETF feed daggerok@gmail.com');
  expect(config.tickers).toEqual([]); expect(config.categories).toEqual([]);
  expect(config.aumRange).toBeUndefined(); expect(config.terRange).toBeUndefined();
  expect(config.dividendYieldRange).toBeUndefined(); expect(config.secYieldRange).toBeUndefined();
  expect(config.performanceRanges).toEqual({}); expect(config.totalReturnRanges).toEqual({});
  expect(defaults.VERBOSE).toBe('false');
  expect(defaults.USE_SYSTEM_CA).toBe('auto');
});

test('resolver rejects unknown, invalid, non-scalar and multiline values', () => {
  for (const value of [
    { UNKNOWN: 1 }, { OUTPUT_DIR: '/tmp' }, { CONCURRENCY: 0 }, { CONCURRENCY: 1.5 }, { MAX_RETRIES: 0 }, { MAX_RETRIES: 'x' },
    { MAX_FETCHES: -1 }, { MAX_FETCHES: 1.5 }, { REQUEST_SLEEP: -1 }, { REQUEST_SLEEP: 'fast' }, { HISTORY_PAGE_SIZE: 0 }, { HOLDINGS_PAGE_SIZE: 0 },
    { HISTORY_RANGE: 'forever' }, { HISTORY_RANGE: '0y' }, { SKIP_YAHOO: 'maybe' }, { EDGAR_FALLBACK: 'sometimes' },
    { VERBOSE: 'maybe' }, { USE_SYSTEM_CA: 'maybe' }, { AUM: '1:2:3' }, { TER: '1' }, { DIVIDEND_YIELD: '5' }, { PERFORMANCE_1Y: '9:1' },
    { TICKERS: ['DIVO'] }, { TICKERS: null }, { TICKERS: { a: 1 } }, null, [],
  ]) expect(() => resolveControls(value)).toThrow();
  expect(() => resolveControls({}, { TICKERS: 'DIVO\nEVIL=yes' })).toThrow();
  expect(() => resolveControls({}, {}, { TICKERS: 'DIVO\rx' })).toThrow();
  expect(() => resolveControls({}, {}, {}, { AMPLIFY_TICKERS: 'x\0bad' })).toThrow();
  expect(() => resolveControls({}, {}, {}, { MAX_RETRIES: '0' })).toThrow();
  expect(() => resolveControls({}, 'not an object')).toThrow();
  expect(() => resolveControls({}, [])).toThrow();
  expect(() => JSON.parse('{not json')).toThrow();
});

test('controls drive the parsed config', () => {
  const c = readConfig(resolveControls({ TICKERS: 'divo, idvo', CATEGORY: 'Income', AUM: 'mid:', TER: ':0.75', TOTAL_RETURN_1Y: '15:', MAX_FETCHES: '3', REQUEST_SLEEP: '0.5', HOLDINGS_PAGE_SIZE: '40', HISTORY_PAGE_SIZE: '50', MAX_RETRIES: '1', HISTORY_RANGE: '5Y', SKIP_YAHOO: 'true', EDGAR_FALLBACK: 'off', SEC_UA: 'ops contact' }));
  expect(c.tickers).toEqual(['DIVO', 'IDVO']); expect(c.categories).toEqual(['Income']);
  expect(c.aumRange?.min).toBe(2_000_000_000); expect(c.terRange).toEqual({ min: undefined, max: 0.75 });
  expect(c.totalReturnRanges['1Y']).toEqual({ min: 15, max: undefined });
  expect([c.maxFetches, c.requestSleepSeconds, c.holdingsPageSize, c.historyPageSize, c.maxRetries]).toEqual([3, 0.5, 40, 50, 1]);
  expect([c.historyRange, c.skipYahoo, c.edgarFallback, c.secUa]).toEqual(['5y', true, false, 'ops contact']);
  expect(resolveControls({}, {}, {}, { HISTORICAL_PAGE_SIZE: '77' }).HISTORY_PAGE_SIZE).toBe('77');
});

test('runtimeControls reads the config file and applies the environment', async () => {
  expect(await runtimeControls({})).toEqual(file());
  expect((await runtimeControls({ TICKERS: 'DIVO' })).TICKERS).toBe('DIVO');
});

// ---- docs, config, help and workflow parity ---------------------------------

test('config keys equal CONTROL_NAMES, README rows and --help', () => {
  expect(Object.keys(file()).sort()).toEqual([...CONTROL_NAMES].sort());
  for (const value of Object.values(file())) expect(typeof value).toBe('string');
  const doc = read('README.md');
  const help = USAGE;
  for (const name of CONTROL_NAMES) {
    const tenor = name.match(/^(PERFORMANCE|TOTAL_RETURN)_(1Y|3Y|5Y|10Y)$/);
    expect(doc).toContain(tenor ? '`_' + tenor[2] + '`' : '`' + name + '`');
    if (tenor) expect(doc).toContain('`' + tenor[1] + '_YTD`');
    expect(help).toContain(`  ${name}=`);
  }
  expect(doc).toContain('scripts/update-data.config.json');
});

test('README keeps the standard section order and verification commands', () => {
  const doc = read('README.md');
  const order = ['## Using Bun', '## Updating the static Amplify data', '### Data sources', '### Metrics and caveats', '### Update controls', '### Examples', '## TypeScript and verification', '## Brands table', '## Sibling applications', '## License'];
  let last = -1;
  for (const heading of order) { const at = doc.indexOf(`\n${heading}\n`); expect(at).toBeGreaterThan(last); last = at; }
  for (const cmd of ['bun install --frozen-lockfile', 'bun test', 'bun build --target=bun scripts/update-data.ts --outfile=/dev/null', 'git diff --check']) expect(doc).toContain(cmd);
});

test('scripts/ holds only the three standard files', () => {
  expect(readdirSync(new URL('.', import.meta.url)).sort()).toEqual(['update-data.config.json', 'update-data.test.ts', 'update-data.ts']);
});

test('workflow resolves controls with the shared resolver and writes only api/amplify', () => {
  const text = read('.github/workflows/update-data.yml');
  const y = (Bun as any).YAML.parse(text);
  const inputs = y.on.workflow_dispatch.inputs;
  const names = Object.keys(inputs);
  expect(names.length).toBeLessThanOrEqual(25);
  expect(inputs.advanced.default).toBe('{}');
  for (const name of names.filter(n => n !== 'advanced')) expect(CONTROL_NAMES).toContain(name.toUpperCase() as any);
  expect(y.on.schedule.some((s: any) => s.cron === '0 0 * * 0')).toBe(true);
  expect(text).toContain('resolveControls'); expect(text).toContain('toJSON(inputs)');
  expect(text).not.toMatch(/\$\{\{\s*(inputs|github\.event\.inputs)\./);
  expect(text).not.toMatch(/OUTPUT_DIR|OUT_DIR/);
  expect([...text.matchAll(/git add (\S+)/g)].map(m => m[1])).toEqual(['api/amplify']);
  expect(text).toContain('persist-credentials: false');
  expect(text).toContain('timeout-minutes: 30');
});

// ---- parsers and pipeline units (inline samples) ----------------------------

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
  expect(parsePercent('7.5%')).toBe(7.5); expect(parsePercent(0.0628)).toBeCloseTo(6.28); expect(parsePercent('')).toBeNull(); expect(parsePercent('n/a')).toBeNull();
  expect(parseAumRange('300M:2B')).toMatchObject({ min: 300_000_000, max: 2_000_000_000, maxExclusive: false });
  expect(parseAumRange('nano:micro')).toMatchObject({ min: 0, max: 300_000_000, maxExclusive: true });
  expect(parseAumRange(':')).toBeUndefined();
  expect(() => parseAumRange('5B:1B')).toThrow();
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
  expect(pick({ MAX_FETCHES: '2' })).toEqual(['AAA', 'BBB']);
  expect(pick({ MAX_FETCHES: '9', CATEGORY: 'Core' })).toEqual(['AAA', 'BBB']);
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

test('metrics: official values win, Yahoo derived values fill gaps, TR is (1+CAGR)^n - 1, missing stays null', () => {
  const none = priceReturns([]);
  const m = buildMetrics({ ytd: 8.25, yr1: 11.43, yr3: 10, yr5: null, yr10: null, sinceInception: 12.4 }, { ...none, cagr5y: 7, ytd: 1 }, 1.4, null);
  expect(m).toMatchObject({ ytd: 8.25, tr1y: 11.43, cagr3y: 10, tr3y: 33.1, cagr5y: 7, tr5y: 40.26, cagr10y: null, tr10y: null, siAnn: 12.4, secYield: 1.4, dividendYield: null, dividendYieldText: '—' });
  expect(inferDistributionFrequency([])).toEqual({ frequency: 'None', paymentsPerYear: null });
  const monthly = [1, 2, 3, 4].map(i => ({ epoch: Date.UTC(2026, i, 1) / 1000, amount: 0.2 }));
  expect(inferDistributionFrequency(monthly)).toEqual({ frequency: 'Monthly', paymentsPerYear: 12 });
});

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

// ---- pipeline on a stubbed network: layout, shapes, fallbacks, stability -------------------

const fv = (value: any): any =>
  typeof value === 'string' ? { stringValue: value } : typeof value === 'number' ? { doubleValue: value } : typeof value === 'boolean' ? { booleanValue: value }
    : Array.isArray(value) ? { arrayValue: { values: value.map(fv) } } : { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fv(v)])) } };
const fdoc = (path: string, fields: Record<string, any>) => ({ name: `projects/p/databases/(default)/documents/${path}`, fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, fv(v)])) });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, statusText: String(status) });
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

test('SEC resolver never accepts another series: a mismatching N-PORT yields no holdings', async () => {
  resetSecCaches();
  stubWeb();
  const config = readConfig(resolveControls({}, {}, {}, {}));
  const realFetch2 = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input);
    if (url.endsWith('primary_doc.xml')) return new Response('<edgarSubmission><genInfo><regCik>0001234</regCik><seriesName>Other</seriesName><seriesId>S999999</seriesId><repPdDate>2026-07-31</repPdDate></genInfo><invstOrSec><name>X</name><cusip>1</cusip></invstOrSec></edgarSubmission>');
    return realFetch2(input, init);
  }) as any;
  expect(await resolveNportFiling({ ticker: 'NOHOLD', category: 'Core', active: true, name: 'NOHOLD ETF' }, config)).toBeNull();
});

test('every request kind (Firestore, Yahoo, SEC) runs inside the per-worker lane: peak in flight equals CONCURRENCY', async () => {
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

// ---- request layer: retries and pacing --------------------------------------

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; setHttpSettings({ maxRetries: 2, requestSleepMs: 0 }); });
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, statusText: String(status) });

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

test('REQUEST_SLEEP spaces request starts across concurrent callers', async () => {
  const starts: number[] = [];
  globalThis.fetch = (async () => { starts.push(Date.now()); return reply(200, {}); }) as any;
  setHttpSettings({ maxRetries: 1, requestSleepMs: 60 });
  await Promise.all([fetchJson('https://x.test/1'), fetchJson('https://x.test/2'), fetchJson('https://x.test/3')]);
  starts.sort((a, b) => a - b);
  expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(50); expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(50);
});

test('CONCURRENCY bounds in-flight requests per worker lanes, with REQUEST_SLEEP pacing per lane', async () => {
  const peaks: Record<number, number> = {};
  for (const [concurrency, sleepMs] of [[1, 0], [1, 20], [3, 20], [3, 0]]) {
    let inFlight = 0, peak = 0;
    globalThis.fetch = (async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise(resolve => setTimeout(resolve, 15));
      inFlight--;
      return reply(200, {});
    }) as any;
    setHttpSettings({ maxRetries: 1, requestSleepMs: sleepMs });
    const started = Date.now();
    // 6 funds, each issuing 3 parallel requests like the real per-fund Promise.all
    await runFundPool([1, 2, 3, 4, 5, 6], concurrency, async n => {
      await Promise.all([1, 2, 3].map(i => fetchJson(`https://x.test/${n}/${i}`)));
    });
    peaks[concurrency * 1000 + sleepMs] = peak;
    expect(peak).toBe(concurrency);
    if (sleepMs && concurrency === 3) expect(Date.now() - started).toBeLessThan(18 * sleepMs * 0.6 + 100);
  }
});

// ---- TLS trust store -------------------------------------------------------

test('USE_SYSTEM_CA accepts auto/true/false case-insensitively and rejects anything else', () => {
  for (const value of ['auto', 'TRUE', 'False', 'Auto']) expect(resolveControls({}, {}, {}, { USE_SYSTEM_CA: value }).USE_SYSTEM_CA).toBe(value);
  expect(() => resolveControls({}, {}, {}, { USE_SYSTEM_CA: 'maybe' })).toThrow();
  expect(() => resolveControls({ USE_SYSTEM_CA: 'yes' })).toThrow();
});

test('isCertError recognizes untrusted-certificate errors, also through cause', () => {
  expect(isCertError({ code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' })).toBe(true);
  expect(isCertError(new Error('unable to get local issuer certificate'))).toBe(true);
  expect(isCertError(Object.assign(new Error('fetch failed'), { cause: new Error('unable to get local issuer certificate') }))).toBe(true);
  expect(isCertError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBe(false);
  expect(isCertError(new Error('HTTP 403 Forbidden'))).toBe(false);
  expect(isCertError(null)).toBe(false);
});

test('installSystemCa wraps globalThis.fetch only in auto mode and restarts once on cert errors', async () => {
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
