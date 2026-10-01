/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CONTROL_NAMES, readConfig, resolveControls, runtimeControls } from './update-data';
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const file = () => JSON.parse(read('scripts/update-data.config.json'));

test('configuration precedence: file < advanced < nonblank input < environment', () => {
  const c = resolveControls({ CONCURRENCY: 2, TICKERS: 'DIVO' }, { CONCURRENCY: 3, TICKERS: 'IDVO' }, { CONCURRENCY: '4', TICKERS: '' }, { AMPLIFY_CONCURRENCY: '5', CONCURRENCY: '6' });
  expect(c.CONCURRENCY).toBe('5'); expect(c.TICKERS).toBe('IDVO');
  expect(resolveControls({ CONCURRENCY: 2 }, {}, { CONCURRENCY: '4' }, {}).CONCURRENCY).toBe('4');
  expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }, { CONCURRENCY: '4' }, { CONCURRENCY: '7' }).CONCURRENCY).toBe('7');
  expect(resolveControls({ CONCURRENCY: 2 }, {}, {}, { AMPLIFY_DATA_CONCURRENCY: '8' }).CONCURRENCY).toBe('8');
});

test('blank input inherits the file value; advanced may blank a key deliberately', () => {
  expect(resolveControls({ TICKERS: 'DIVO' }, {}, { TICKERS: '' }).TICKERS).toBe('DIVO');
  expect(resolveControls({ TICKERS: 'DIVO' }, { TICKERS: '' }, { TICKERS: '' }).TICKERS).toBe('');
  expect(resolveControls({ VERBOSE: true }, {}, {}, { VERBOSE: 'false' }).VERBOSE).toBe('false');
});

test('scheduled path (empty inputs and advanced) equals the config defaults', () => {
  const defaults = file();
  expect(resolveControls(defaults, JSON.parse('{}'), {}, {})).toEqual(defaults);
  const config = readConfig(resolveControls(defaults));
  expect(config.concurrency).toBe(6); expect(config.tickers).toEqual([]); expect(config.categories).toEqual([]);
  expect(config.aumRange).toBeUndefined(); expect(config.dividendYieldRange).toBeUndefined(); expect(config.secYieldRange).toBeUndefined();
  expect(config.performanceRanges).toEqual({}); expect(config.totalReturnRanges).toEqual({});
  expect(defaults.VERBOSE).toBe('false');
});

test('resolver rejects unknown, invalid, non-scalar and multiline values', () => {
  for (const value of [{ UNKNOWN: 1 }, { OUTPUT_DIR: '/tmp' }, { CONCURRENCY: 0 }, { CONCURRENCY: 1.5 }, { VERBOSE: 'maybe' }, { AUM: '1:2:3' }, { DIVIDEND_YIELD: '5' }, { PERFORMANCE_1Y: '9:1' }, { TICKERS: ['DIVO'] }, { TICKERS: null }, { TICKERS: { a: 1 } }, null, []]) {
    expect(() => resolveControls(value)).toThrow();
  }
  expect(() => resolveControls({}, { TICKERS: 'DIVO\nEVIL=yes' })).toThrow();
  expect(() => resolveControls({}, {}, { TICKERS: 'DIVO\rx' })).toThrow();
  expect(() => resolveControls({}, {}, {}, { AMPLIFY_TICKERS: 'x\0bad' })).toThrow();
  expect(() => resolveControls({}, 'not an object')).toThrow();
  expect(() => resolveControls({}, [])).toThrow();
});

test('existing filters keep working through the resolver', () => {
  const c = readConfig(resolveControls({ TICKERS: 'divo, idvo', CATEGORY: 'Income', AUM: 'mid:', TOTAL_RETURN_1Y: '15:' }));
  expect(c.tickers).toEqual(['DIVO', 'IDVO']); expect(c.categories).toEqual(['Income']);
  expect(c.aumRange?.min).toBe(2_000_000_000); expect(c.totalReturnRanges['1Y']).toEqual({ min: 15, max: undefined });
});

test('runtimeControls reads the config file and applies the environment', async () => {
  expect(await runtimeControls({})).toEqual(file());
  expect((await runtimeControls({ TICKERS: 'DIVO' })).TICKERS).toBe('DIVO');
});

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
  expect(text).toContain('git add api/data.json');
  expect([...text.matchAll(/git add (\S+)/g)].map(m => m[1])).toEqual(['api/data.json']);
});
