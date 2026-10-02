/// <reference types="bun" />
import { afterEach, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import {
  CONTROL_NAMES, classifyHolding, decodeDocument, deriveDistributionFrequency, fetchJson, fundFilterReasons,
  normalizePosition, parseAumRange, parsePercent, preserveUnchangedBlock, readConfig, resolveControls,
  runtimeControls, selectCatalog, setHttpSettings,
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
  expect(config.historyPageSize).toBe(300); expect(config.maxRetries).toBe(2);
  expect(config.tickers).toEqual([]); expect(config.categories).toEqual([]);
  expect(config.aumRange).toBeUndefined(); expect(config.terRange).toBeUndefined();
  expect(config.dividendYieldRange).toBeUndefined(); expect(config.secYieldRange).toBeUndefined();
  expect(config.performanceRanges).toEqual({}); expect(config.totalReturnRanges).toEqual({});
  expect(defaults.VERBOSE).toBe('false');
});

test('resolver rejects unknown, invalid, non-scalar and multiline values', () => {
  for (const value of [
    { UNKNOWN: 1 }, { OUTPUT_DIR: '/tmp' }, { CONCURRENCY: 0 }, { CONCURRENCY: 1.5 }, { MAX_RETRIES: 0 }, { MAX_RETRIES: 'x' },
    { MAX_FETCHES: -1 }, { MAX_FETCHES: 1.5 }, { REQUEST_SLEEP: -1 }, { REQUEST_SLEEP: 'fast' }, { HISTORY_PAGE_SIZE: 0 },
    { VERBOSE: 'maybe' }, { AUM: '1:2:3' }, { TER: '1' }, { DIVIDEND_YIELD: '5' }, { PERFORMANCE_1Y: '9:1' },
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
  const c = readConfig(resolveControls({ TICKERS: 'divo, idvo', CATEGORY: 'Income', AUM: 'mid:', TER: ':0.75', TOTAL_RETURN_1Y: '15:', MAX_FETCHES: '3', REQUEST_SLEEP: '0.5', HISTORY_PAGE_SIZE: '50', MAX_RETRIES: '1' }));
  expect(c.tickers).toEqual(['DIVO', 'IDVO']); expect(c.categories).toEqual(['Income']);
  expect(c.aumRange?.min).toBe(2_000_000_000); expect(c.terRange).toEqual({ min: undefined, max: 0.75 });
  expect(c.totalReturnRanges['1Y']).toEqual({ min: 15, max: undefined });
  expect([c.maxFetches, c.requestSleepSeconds, c.historyPageSize, c.maxRetries]).toEqual([3, 0.5, 50, 1]);
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
  const help = read('scripts/update-data.ts');
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

test('workflow resolves controls with the shared resolver and writes only api/data.json', () => {
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
  expect([...text.matchAll(/git add (\S+)/g)].map(m => m[1])).toEqual(['api/data.json']);
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

test('holdings are normalized and classified', () => {
  const ctx = { ticker: 'DIVO', fundName: 'Divo', asOfDate: '2026-09-28', index: 0 };
  const row = normalizePosition({ StockTicker: ' aapl ', SecurityName: 'Apple  Inc', Weightings: '4.2%', MarketValue: '1,000', Shares: 5 }, ctx)!;
  expect(row).toMatchObject({ symbol: 'AAPL', name: 'Apple Inc', weight: 4.2, marketValue: 1000, shares: 5, price: null, flags: ['symbol'] });
  expect(classifyHolding({ symbol: 'CASH', name: 'Cash & Other', cusip: '', raw: {} })).toContain('cash');
  expect(classifyHolding({ symbol: '912797XX1', name: 'United States Treasury Bill', cusip: '', raw: {} })).toContain('treasury');
  expect(classifyHolding({ symbol: 'SPY260116C00600000', name: 'SPY Call', cusip: '', raw: {} })).toContain('option');
});

test('distribution frequency labels, empty history is None', () => {
  expect(deriveDistributionFrequency([])).toBe('00 - None');
  expect(deriveDistributionFrequency([{ exDate: 'invalid' }])).toBe('00 - None');
  expect(deriveDistributionFrequency([{ exDate: '2026-01-01' }])).toBe('00 - None');
  for (const [dates, expected] of [
    [['2026-01-01', '2026-02-01', '2026-03-01'], '01 - Monthly'],
    [['2026-01-01', '2026-04-01', '2026-07-01'], '04 - Quarterly'],
    [['2025-01-01', '2025-07-01', '2026-01-01'], '06 - Semi-annually'],
    [['2024-01-01', '2025-01-01', '2026-01-01'], '12 - Annually'],
  ] as const) expect(deriveDistributionFrequency(dates.map(exDate => ({ exDate })))).toBe(expected);
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

test('vendor stamp-only refreshes keep the committed block', () => {
  const previous = { UpdatedAt: '1', rows: [{ a: 1, updatedAt: 'x' }] };
  expect(preserveUnchangedBlock(previous, { UpdatedAt: '2', rows: [{ a: 1, updatedAt: 'y' }] })).toBe(previous);
  const changed = { UpdatedAt: '2', rows: [{ a: 2 }] };
  expect(preserveUnchangedBlock(previous, changed)).toBe(changed);
  expect(preserveUnchangedBlock(undefined, changed)).toBe(changed);
});

// ---- request layer: retries and pacing --------------------------------------

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; setHttpSettings({ maxRetries: 2, requestSleepMs: 0, historyPageSize: 300 }); });
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, statusText: String(status) });

test('fetchJson retries 429/5xx and network errors, never 4xx, and stops after MAX_RETRIES', async () => {
  let calls = 0;
  globalThis.fetch = (async () => (++calls === 1 ? reply(503, {}) : calls === 2 ? Promise.reject(new TypeError('network')) : reply(200, { ok: true }))) as any;
  setHttpSettings({ maxRetries: 2, requestSleepMs: 0, historyPageSize: 300 });
  expect(await fetchJson('https://x.test/a')).toEqual({ ok: true }); expect(calls).toBe(3);

  calls = 0; globalThis.fetch = (async () => { calls++; return reply(404, { error: { message: 'missing' } }); }) as any;
  await expect(fetchJson('https://x.test/b')).rejects.toThrow('missing'); expect(calls).toBe(1);

  calls = 0; globalThis.fetch = (async () => { calls++; return reply(500, {}); }) as any;
  setHttpSettings({ maxRetries: 1, requestSleepMs: 0, historyPageSize: 300 });
  await expect(fetchJson('https://x.test/c')).rejects.toThrow(); expect(calls).toBe(2);
});

test('REQUEST_SLEEP spaces request starts across concurrent callers', async () => {
  const starts: number[] = [];
  globalThis.fetch = (async () => { starts.push(Date.now()); return reply(200, {}); }) as any;
  setHttpSettings({ maxRetries: 1, requestSleepMs: 60, historyPageSize: 300 });
  await Promise.all([fetchJson('https://x.test/1'), fetchJson('https://x.test/2'), fetchJson('https://x.test/3')]);
  starts.sort((a, b) => a - b);
  expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(50); expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(50);
});
