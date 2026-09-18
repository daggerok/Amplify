/**
 * UI-contract regression suite for the Amplify single-file app (index.html).
 *
 * Boots the real application markup + inline TypeScript in happy-dom, serves
 * the real generated feed (api/data.json) through a mocked fetch, and drives
 * the DOM exactly like a user (tab clicks, checkbox changes, sort-header
 * clicks, search typing, Clear/Blacklist/Theme buttons). Expected values are
 * computed independently from the feed in this file — nothing is copied from
 * a sibling provider app.
 *
 * The "reload" helper re-boots a fresh window seeded with the previous
 * window's localStorage, which is exactly what a browser reload restores.
 */
import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import ts from 'typescript';
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const HTML = readFileSync(`${ROOT}index.html`, 'utf8');
const DATA_TEXT = readFileSync(`${ROOT}api/data.json`, 'utf8');
const FEED = JSON.parse(DATA_TEXT) as Feed;

type Position = {
  id?: string;
  fundTicker?: string;
  fundName?: string;
  asOfDate?: string;
  symbol?: string;
  rawSymbol?: string;
  name?: string;
  cusip?: string;
  weight?: number | null;
  marketValue?: number | null;
  shares?: number | null;
  price?: number | null;
  flags?: string[];
};
type Fund = { ticker: string; name: string; category: string; rank: number; holdingsCount?: number; [k: string]: unknown };
type Feed = {
  generatedAt?: string;
  counts?: { funds?: number; holdings?: number; distributions?: number };
  funds: Fund[];
  holdings: Record<string, { ticker: string; asOfDate?: string; positions: Position[] }>;
  details: Record<string, {
    distributions?: unknown[];
    performance?: {
      monthly?: { returns?: Array<{ type?: string; returns?: Record<string, number | null> }>; asOfDate?: string };
      quarterly?: { returns?: Array<{ type?: string; returns?: Record<string, number | null> }> };
    };
  }>;
};

// ---------------------------------------------------------------------------
// Extraction + transpile of the inline app script (index.html is single-file
// by design; we transpile the same source Babel would compile in the browser).
// ---------------------------------------------------------------------------
const SCRIPT_SOURCE = (() => {
  const match = /<script type="text\/babel" data-presets="typescript">([\s\S]*?)<\/script>/.exec(HTML);
  if (!match) throw new Error('Could not find the inline babel script in index.html');
  return match[1];
})();
const APP_JS = ts.transpileModule(SCRIPT_SOURCE, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const BODY_MARKUP = (() => {
  const match = /<body[^>]*>([\s\S]*)<\/body>/.exec(HTML);
  if (!match) throw new Error('Could not find <body> in index.html');
  return match[1];
})();

// ---------------------------------------------------------------------------
// Independent expected-value helpers (computed from the feed, not from the app)
// ---------------------------------------------------------------------------
const MISSING_VALUES = new Set(['', '-', '—', 'n/a', 'na', 'null', 'none']);
function usable(value: unknown): string {
  const text = String(value ?? '').trim();
  return MISSING_VALUES.has(text.toLowerCase()) ? '' : text;
}
/**
 * Watchlist identity fallback chain for this provider's payload:
 * Ticker/Symbol -> CUSIP -> published security name.
 * (The Amplify feed publishes symbol, rawSymbol, cusip and name per position;
 * it does not publish ISIN/SEDOL/FIGI per position.)
 */
function positionIdentity(position: Position): string {
  return (usable(position.symbol) || usable(position.cusip) || usable(position.name)).toUpperCase();
}
type ExpectedRow = {
  key: string;
  names: Set<string>;
  cusips: Set<string>;
  flags: Set<string>;
  funds: Set<string>;
  weightSum: number;
  maxWeight: number | null;
  marketValueSum: number;
};
function expectedWatchlist(data: Feed, tickers: string[]): ExpectedRow[] {
  const map = new Map<string, ExpectedRow>();
  for (const ticker of tickers) {
    for (const position of data.holdings[ticker]?.positions || []) {
      const key = positionIdentity(position);
      if (!key) continue;
      let row = map.get(key);
      if (!row) {
        row = { key, names: new Set(), cusips: new Set(), flags: new Set(), funds: new Set(), weightSum: 0, maxWeight: null, marketValueSum: 0 };
        map.set(key, row);
      }
      row.names.add(usable(position.name) || key);
      const cusip = usable(position.cusip);
      if (cusip) row.cusips.add(cusip);
      (position.flags || []).forEach(flag => row.flags.add(flag));
      row.funds.add((position.fundTicker || ticker).toUpperCase());
      if (typeof position.weight === 'number' && Number.isFinite(position.weight)) {
        row.weightSum += position.weight;
        row.maxWeight = row.maxWeight === null ? position.weight : Math.max(row.maxWeight, position.weight);
      }
      if (typeof position.marketValue === 'number' && Number.isFinite(position.marketValue)) {
        row.marketValueSum += position.marketValue;
      }
    }
  }
  return [...map.values()];
}
function expectedYtd(ticker: string): number | null {
  for (const item of FEED.details[ticker]?.performance?.monthly?.returns || []) {
    if (String(item.type || '').toUpperCase() === 'NAV') {
      const ytd = item.returns?.YTD;
      return typeof ytd === 'number' ? ytd : null;
    }
  }
  return null;
}
const ALL_TICKERS = FEED.funds.map(fund => fund.ticker);

// ---------------------------------------------------------------------------
// Boot harness
// ---------------------------------------------------------------------------
type BootOptions = {
  data?: Feed;
  localStorageSeed?: Record<string, string>;
  fetchError?: boolean;
};
type Ctx = {
  window: any;
  doc: any;
  sleep: (ms?: number) => Promise<void>;
  ready: () => Promise<void>;
  click: (element: any) => void;
  setChecked: (element: any, checked: boolean) => void;
  reload: (options?: BootOptions) => Promise<Ctx>;
};

function makeCtx(window: any, options: BootOptions): Ctx {
  return {
    window,
    doc: window.document,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms ?? 15)),
    async ready() {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const counter = window.document.getElementById('ticker-count');
        const text = String(counter?.textContent || '');
        if (text && !text.includes('Loading')) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error(`App did not become ready (ticker-count: "${window.document.getElementById('ticker-count')?.textContent}")`);
    },
    click(element: any) {
      if (!element) throw new Error('click(): element not found');
      element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    },
    setChecked(element: any, checked: boolean) {
      if (!element) throw new Error('setChecked(): element not found');
      element.checked = checked;
      element.dispatchEvent(new window.Event('change', { bubbles: true }));
    },
    async reload(reloadOptions = {}) {
      const seed: Record<string, string> = {};
      const storage = window.localStorage;
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (key !== null) seed[key] = storage.getItem(key);
      }
      return boot({ ...options, ...reloadOptions, localStorageSeed: seed });
    },
  };
}

const STYLE_MATCH = /<style>[\s\S]*?<\/style>/g.exec(HTML);
const STYLE_MARKUP = STYLE_MATCH ? STYLE_MATCH[0] : '';
async function boot(options: BootOptions = {}): Promise<Ctx> {
  const window: any = new Window({ url: 'https://amplify.test/' });
  const doc = window.document;
  doc.body.innerHTML = BODY_MARKUP;
  if (STYLE_MARKUP) doc.head.innerHTML += STYLE_MARKUP;
  const payload = options.data ?? JSON.parse(DATA_TEXT);
  window.fetch = async () => {
    if (options.fetchError) throw new Error('network down');
    // Deep copy so the app cannot mutate the shared feed fixture.
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => JSON.parse(JSON.stringify(payload)),
    };
  };
  if (options.localStorageSeed) {
    for (const [key, value] of Object.entries(options.localStorageSeed)) window.localStorage.setItem(key, value);
  }
  window.eval(APP_JS);
  const ctx = makeCtx(window, options);
  await ctx.ready();
  return ctx;
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
function tabButton(doc: any, id: string): any {
  return doc.querySelector(`[data-tab="${id}"]`);
}
function activeTabId(doc: any): string {
  // Regular tabs carry the active class on the button; the All ETFs pill
  // carries it on its wrapper div.
  const active = [...doc.querySelectorAll('[data-tab]')].find((b: any) =>
    b.classList?.contains('bg-blue-600') || b.closest?.('.bg-blue-600') !== null);
  return active ? active.getAttribute('data-tab') : '';
}
function catalogRowTickers(doc: any): string[] {
  return [...doc.querySelectorAll('#table-body tr[data-ticker]')].map((row: any) => row.getAttribute('data-ticker'));
}
function watchlistDataRows(doc: any): any[] {
  return [...doc.querySelectorAll('#table-body tr:not(#load-more-row)')];
}
function watchlistTabCount(doc: any): number {
  const button = tabButton(doc, 'watchlist');
  const match = /Watchlist \(([\d,]+)\)/.exec(button?.textContent || '');
  return match ? Number(match[1].replace(/,/g, '')) : NaN;
}
function sortButton(doc: any, key: string): any {
  return doc.querySelector(`#table-head button[data-sort="${key}"]`);
}
function sortArrow(doc: any, key: string): string {
  const text = sortButton(doc, key)?.textContent || '';
  if (text.includes('↑')) return 'asc';
  if (text.includes('↓')) return 'desc';
  return '';
}
function selectedTickers(window: any): string[] {
  const saved = JSON.parse(window.localStorage.getItem('amplify-selected-etfs') || '[]');
  return Array.isArray(saved) ? saved : [];
}
function watchlistRowByKey(doc: any, key: string): any {
  return watchlistDataRows(doc).find((row: any) => {
    const cells = row.querySelectorAll('td');
    return cells[1]?.textContent?.trim() === key;
  });
}

const sleep = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// A. Generated feed integrity
// ---------------------------------------------------------------------------
describe('generated feed integrity', () => {
  test('counts, holdingsCount, ranks and detail blocks all agree', () => {
    const totalPositions = Object.values(FEED.holdings).reduce((sum, entry) => sum + entry.positions.length, 0);
    const totalDistributions = Object.values(FEED.details).reduce((sum, entry) => sum + (entry.distributions?.length || 0), 0);
    expect(FEED.counts?.funds).toBe(FEED.funds.length);
    expect(FEED.counts?.holdings).toBe(totalPositions);
    expect(FEED.counts?.distributions).toBe(totalDistributions);
    for (const fund of FEED.funds) {
      expect(FEED.holdings[fund.ticker], `holdings entry for ${fund.ticker}`).toBeTruthy();
      expect(FEED.details[fund.ticker], `details entry for ${fund.ticker}`).toBeTruthy();
      expect(FEED.holdings[fund.ticker].positions.length).toBe(fund.holdingsCount);
    }
    const ranks = FEED.funds.map(fund => fund.rank).sort((a, b) => a - b);
    expect(ranks).toEqual(FEED.funds.map((_, index) => index + 1));
    for (const position of Object.values(FEED.holdings).flatMap(entry => entry.positions)) {
      expect(position.fundTicker).toBeTruthy();
      expect(position.symbol !== undefined).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// B. Per-tab sort persistence
// ---------------------------------------------------------------------------
describe('sort persistence (per tab, localStorage)', () => {
  test('sorts survive tab round trips, every button/checkbox, Clear and reload', async () => {
    const ctx = await boot();
    const { doc } = ctx;

    // Sort All ETFs by YTD Return (first click on a numeric column = desc).
    ctx.click(sortButton(doc, 'ytdReturn'));
    await ctx.sleep();
    expect(sortArrow(doc, 'ytdReturn')).toBe('desc');
    const topYtd = catalogRowTickers(doc)[0];
    const expectedTop = ALL_TICKERS.map(t => [expectedYtd(t), t] as const)
      .filter(([value]) => value !== null)
      .sort((a, b) => (b[0] as number) - (a[0] as number))[0][1];
    expect(topYtd).toBe(expectedTop);

    // Select an ETF and round-trip through Watchlist, sorting there too.
    ctx.click(doc.querySelector('#table-body tr[data-ticker="DIVO"]'));
    await ctx.sleep();
    ctx.click(tabButton(doc, 'watchlist'));
    await ctx.sleep();
    ctx.click(sortButton(doc, 'fundCount'));
    await ctx.sleep();
    expect(sortArrow(doc, 'fundCount')).toBe('desc'); // numeric columns start desc

    // Back to All ETFs: the remembered YTD sort must be restored.
    ctx.click(tabButton(doc, 'All'));
    await ctx.sleep();
    expect(sortArrow(doc, 'ytdReturn')).toBe('desc');
    expect(catalogRowTickers(doc)[0]).toBe(expectedTop);

    const savedSorts = JSON.parse(ctx.window.localStorage.getItem('amplify-tab-sorts') || '{}');
    expect(savedSorts.All).toEqual({ key: 'ytdReturn', dir: 'desc' });
    expect(savedSorts.watchlist).toEqual({ key: 'fundCount', dir: 'desc' });

    // Every other control must leave the sort untouched.
    ctx.click(doc.getElementById('theme-toggle'));
    ctx.click(doc.getElementById('blacklist-btn'));
    ctx.click(doc.getElementById('blacklist-btn'));
    const search = doc.getElementById('search-input');
    search.value = 'cwp';
    search.dispatchEvent(new ctx.window.Event('input', { bubbles: true }));
    await ctx.sleep();
    search.value = '';
    search.dispatchEvent(new ctx.window.Event('input', { bubbles: true }));
    await ctx.sleep();
    ctx.setChecked(doc.getElementById('select-all-checkbox'), true);
    await ctx.sleep();
    ctx.setChecked(doc.getElementById('select-all-checkbox'), false);
    await ctx.sleep();
    ctx.click(doc.getElementById('reset-btn')); // Clear
    await ctx.sleep();
    expect(sortArrow(doc, 'ytdReturn')).toBe('desc');
    expect(catalogRowTickers(doc)[0]).toBe(expectedTop);

    // Full reload: remembered sorts come back without any interaction.
    const reloaded = await ctx.reload();
    expect(sortArrow(reloaded.doc, 'ytdReturn')).toBe('desc');
    expect(catalogRowTickers(reloaded.doc)[0]).toBe(expectedTop);
    reloaded.doc.getElementById('search-input').value = '';
    reloaded.doc.getElementById('search-input').dispatchEvent(new reloaded.window.Event('input', { bubbles: true }));
    await reloaded.sleep();
  });

  test('a never-sorted tab keeps its existing default', async () => {
    const ctx = await boot();
    const { doc } = ctx;
    ctx.click(doc.querySelector('#table-body tr[data-ticker="DIVO"]'));
    await ctx.sleep();
    ctx.click(tabButton(doc, 'watchlist'));
    await ctx.sleep();
    expect(sortArrow(doc, 'weightSum')).toBe('desc'); // watchlist default, untouched memory
    expect(JSON.parse(ctx.window.localStorage.getItem('amplify-tab-sorts') || '{}')).toEqual({});
  });

  test('fallback to All (invalid tab) restores All\'s remembered sort, not the default', async () => {
    const ctx = await boot();
    const { doc } = ctx;
    ctx.click(sortButton(doc, 'ytdReturn'));
    await ctx.sleep();
    expect(sortArrow(doc, 'ytdReturn')).toBe('desc');
    // Select two ETFs, activate one, then open Watchlist and clear the whole
    // catalog selection from the pill: Watchlist/detail tabs vanish and the
    // app must fall back to All with its remembered sort.
    ctx.click(doc.querySelector('#table-body tr[data-ticker="DIVO"]'));
    await ctx.sleep();
    ctx.click(doc.querySelector('#table-body tr[data-ticker="AIEQ"]'));
    await ctx.sleep();
    ctx.click(tabButton(doc, 'watchlist'));
    await ctx.sleep();
    ctx.setChecked(doc.getElementById('select-all-toggle'), false);
    await ctx.sleep();
    expect(activeTabId(doc)).toBe('All');
    expect(sortArrow(doc, 'ytdReturn')).toBe('desc');
  });
});

// ---------------------------------------------------------------------------
// C. Exact selection scopes
// ---------------------------------------------------------------------------
describe('selection scopes', () => {
  test('header Use with a filter selects exactly the visible rows', async () => {
    const ctx = await boot();
    const { doc } = ctx;
    const search = doc.getElementById('search-input');
    search.value = 'cwp'; // 3 funds: DIVO, IDVO, QDVO
    search.dispatchEvent(new ctx.window.Event('input', { bubbles: true }));
    await ctx.sleep();
    const visible = catalogRowTickers(doc);
    expect(visible).toHaveLength(3);

    ctx.setChecked(doc.getElementById('select-all-checkbox'), true);
    await ctx.sleep();
    expect([...selectedTickers(ctx.window)].sort()).toEqual([...visible].sort());
  });

  test('header Use uncheck removes only visible rows; hidden selections survive', async () => {
    const ctx = await boot();
    const { doc } = ctx;
    // Select AIVC, then filter it out.
    ctx.click(doc.querySelector('#table-body tr[data-ticker="AIVC"]'));
    await ctx.sleep();
    const search = doc.getElementById('search-input');
    search.value = 'cwp';
    search.dispatchEvent(new ctx.window.Event('input', { bubbles: true }));
    await ctx.sleep();
    const visible = catalogRowTickers(doc);
    ctx.setChecked(doc.getElementById('select-all-checkbox'), true);
    await ctx.sleep();
    expect(selectedTickers(ctx.window).includes('AIVC')).toBe(true);
    expect(selectedTickers(ctx.window).length).toBe(visible.length + 1);

    ctx.setChecked(doc.getElementById('select-all-checkbox'), false);
    await ctx.sleep();
    expect(selectedTickers(ctx.window)).toEqual(['AIVC']);
  });

  test('header checked state reflects visible rows only (.every, not size comparison)', async () => {
    const ctx = await boot();
    const { doc } = ctx;
    // Select exactly the rows a filter will leave visible: the header must be
    // checked even though the rest of the catalog is not selected (a
    // whole-catalog size comparison would leave it unchecked here).
    ctx.click(doc.querySelector('#table-body tr[data-ticker="DIVO"]'));
    await ctx.sleep();
    ctx.click(doc.querySelector('#table-body tr[data-ticker="IDVO"]'));
    await ctx.sleep();
    ctx.click(doc.querySelector('#table-body tr[data-ticker="QDVO"]'));
    await ctx.sleep();
    const search = doc.getElementById('search-input');
    search.value = 'cwp';
    search.dispatchEvent(new ctx.window.Event('input', { bubbles: true }));
    await ctx.sleep();
    expect(doc.getElementById('select-all-checkbox').checked).toBe(true);
    // Unchecking one visible row must immediately uncheck the header.
    ctx.click(doc.querySelector('#table-body tr[data-ticker="QDVO"]'));
    await ctx.sleep();
    expect(doc.getElementById('select-all-checkbox').checked).toBe(false);
  });

  test('All ETFs pill selects the whole catalog from a category tab without navigating', async () => {
    const ctx = await boot();
    const { doc } = ctx;
    ctx.click(tabButton(doc, 'Income'));
    await ctx.sleep();
    ctx.setChecked(doc.getElementById('select-all-toggle'), true);
    await ctx.sleep();
    expect(selectedTickers(ctx.window).length).toBe(ALL_TICKERS.length);
    expect(activeTabId(doc)).toBe('Income'); // no navigation
    ctx.setChecked(doc.getElementById('select-all-toggle'), false);
    await ctx.sleep();
    expect(selectedTickers(ctx.window)).toEqual([]);
  });

  test('All ETFs pill selects the whole catalog from a detail tab without navigating', async () => {
    const ctx = await boot();
    const { doc } = ctx;
    ctx.click(doc.querySelector('#table-body tr[data-ticker="DIVO"]'));
    await ctx.sleep();
    ctx.click(tabButton(doc, 'detail:holdings'));
    await ctx.sleep();
    ctx.setChecked(doc.getElementById('select-all-toggle'), true);
    await ctx.sleep();
    expect(selectedTickers(ctx.window).length).toBe(ALL_TICKERS.length);
    expect(activeTabId(doc)).toBe('detail:holdings');
    expect(doc.getElementById('selected-tabs-panel').classList.contains('is-visible')).toBe(true);
  });

  test('pill checked state covers non-blacklisted catalog exactly', async () => {
    const ctx = await boot();
    const { doc } = ctx;
    const input = doc.getElementById('blacklist-input');
    input.value = 'SILJ';
    ctx.click(doc.getElementById('blacklist-add-btn'));
    await ctx.sleep();
    ctx.setChecked(doc.getElementById('select-all-toggle'), true);
    await ctx.sleep();
    const selected = selectedTickers(ctx.window);
    expect(selected.length).toBe(ALL_TICKERS.length - 1);
    expect(selected).not.toContain('SILJ');
    expect(doc.getElementById('select-all-toggle').checked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D. Selection reactivity
// ---------------------------------------------------------------------------
describe('selection reactivity', () => {
  test('selecting an ETF immediately shows the exact deduplicated Watchlist count', async () => {
    const ctx = await boot();
    const { doc } = ctx;
    const expected = expectedWatchlist(FEED, ['DIVO']).length;
    expect(watchlistTabCount(doc)).toBeNaN(); // no selection yet
    ctx.click(doc.querySelector('#table-body tr[data-ticker="DIVO"]'));
    await ctx.sleep();
    const label = (tabButton(doc, 'watchlist')?.textContent || '').replace(/\s+/g, ' ').trim();
    expect(label).toBe(`Watchlist (${expected})`);
    expect(label).not.toContain('Loading');
    // Deselecting immediately recomputes back to no watchlist tab.
    ctx.click(doc.querySelector('#table-body tr[data-ticker="DIVO"]'));
    await ctx.sleep();
    expect(tabButton(doc, 'watchlist')).toBeNull();
  });

  test('subtitle badges are clickable and open the fund detail view', async () => {
    const ctx = await boot();
    const { doc } = ctx;
    ctx.click(doc.querySelector('#table-body tr[data-ticker="DIVO"]'));
    await ctx.sleep();
    ctx.click(doc.querySelector('#table-body tr[data-ticker="AIEQ"]'));
    await ctx.sleep();
    const badge = doc.querySelector('#app-subtitle [data-selected-fund="AIEQ"]');
    expect(badge).toBeTruthy();
    ctx.click(badge);
    await ctx.sleep();
    expect(activeTabId(doc)).toBe('detail:overview');
    expect(doc.getElementById('selected-tabs-panel').classList.contains('is-visible')).toBe(true);
  });

  test('catalog ticker opens the fund detail view (and selects it)', async () => {
    const ctx = await boot();
    const { doc } = ctx;
    const ticker = doc.querySelector('#table-body tr[data-ticker="DIVO"] [data-open-fund="DIVO"]');
    expect(ticker).toBeTruthy();
    ctx.click(ticker);
    await ctx.sleep();
    expect(selectedTickers(ctx.window)).toContain('DIVO');
    expect(activeTabId(doc)).toBe('detail:overview');
  });

  test('Watchlist ETF badges open the fund detail view', async () => {
    const ctx = await boot();
    const { doc } = ctx;
    ctx.click(doc.querySelector('#table-body tr[data-ticker="DIVO"]'));
    await ctx.sleep();
    ctx.click(doc.querySelector('#table-body tr[data-ticker="AIEQ"]'));
    await ctx.sleep();
    ctx.click(tabButton(doc, 'watchlist'));
    await ctx.sleep();
    const row = watchlistRowByKey(doc, 'MSFT');
    expect(row).toBeTruthy();
    const badge = row.querySelector('[data-watchlist-fund="DIVO"]');
    expect(badge).toBeTruthy();
    ctx.click(badge);
    await ctx.sleep();
    expect(activeTabId(doc)).toBe('detail:overview');
    expect(doc.querySelector('#selected-tabs-bar [data-tab="detail:overview"]')?.textContent).toContain('DIVO');
  });

  test('deselecting an ETF immediately recomputes subtitle, tabs and Watchlist', async () => {
    const ctx = await boot();
    const { doc } = ctx;
    ctx.click(doc.querySelector('#table-body tr[data-ticker="DIVO"]'));
    await ctx.sleep();
    ctx.click(doc.querySelector('#table-body tr[data-ticker="AIEQ"]'));
    await ctx.sleep();
    ctx.click(tabButton(doc, 'watchlist'));
    await ctx.sleep();
    const overlap = expectedWatchlist(FEED, ['DIVO', 'AIEQ']).filter(row => row.funds.size === 2).length;
    expect(watchlistTabCount(doc)).toBe(expectedWatchlist(FEED, ['DIVO', 'AIEQ']).length);
    expect(watchlistDataRows(doc).length).toBeGreaterThan(0);

    // Deselect DIVO while on the Watchlist tab.
    ctx.click(tabButton(doc, 'All'));
    await ctx.sleep();
    ctx.click(doc.querySelector('#table-body tr[data-ticker="DIVO"]'));
    await ctx.sleep();
    // Subtitle: only AIEQ remains.
    expect(doc.getElementById('app-subtitle').textContent).toContain('AIEQ');
    expect(doc.querySelector('#app-subtitle [data-selected-fund="DIVO"]')).toBeNull();
    // Active fund falls back to AIEQ; its detail tabs are visible.
    expect(doc.getElementById('selected-tabs-panel').classList.contains('is-visible')).toBe(true);
    expect(doc.querySelector('#selected-tabs-bar [data-tab="detail:overview"]')?.textContent).toContain('AIEQ');
    // Watchlist recomputed to AIEQ alone.
    expect(watchlistTabCount(doc)).toBe(expectedWatchlist(FEED, ['AIEQ']).length);
    // The overlapping MSFT row now belongs to a single ETF.
    ctx.click(tabButton(doc, 'watchlist'));
    await ctx.sleep();
    const msft = watchlistRowByKey(doc, 'MSFT');
    expect(msft).toBeTruthy();
    expect(msft.querySelectorAll('td')[4]?.textContent).toBe('1');
    expect(overlap).toBeGreaterThan(0);
  });

  test('reload restores selection, active fund and Watchlist without any interaction', async () => {
    const ctx = await boot({
      localStorageSeed: {
        'amplify-selected-etfs': JSON.stringify(['DIVO', 'AIEQ']),
        'amplify-active-fund': 'DIVO',
      },
    });
    const { doc } = ctx;
    expect(selectedTickers(ctx.window).sort()).toEqual(['AIEQ', 'DIVO']);
    expect(doc.getElementById('selected-tabs-panel').classList.contains('is-visible')).toBe(true);
    expect(doc.querySelector('#selected-tabs-bar [data-tab="detail:overview"]')?.textContent).toContain('DIVO');
    expect(watchlistTabCount(doc)).toBe(expectedWatchlist(FEED, ['DIVO', 'AIEQ']).length);
  });
});

// ---------------------------------------------------------------------------
// E. Watchlist aggregation
// ---------------------------------------------------------------------------
describe('watchlist aggregation', () => {
  test('all-catalog selection produces the exact expected deduplicated count', async () => {
    const ctx = await boot();
    const { doc } = ctx;
    ctx.setChecked(doc.getElementById('select-all-toggle'), true);
    await ctx.sleep();
    const expected = expectedWatchlist(FEED, ALL_TICKERS).length;
    expect(watchlistTabCount(doc)).toBe(expected);
  });

  test('two overlapping ETFs: unique count, # ETFs, Weight Sum and Max Weight', async () => {
    const ctx = await boot();
    const { doc } = ctx;
    ctx.click(doc.querySelector('#table-body tr[data-ticker="DIVO"]'));
    await ctx.sleep();
    ctx.click(doc.querySelector('#table-body tr[data-ticker="AIEQ"]'));
    await ctx.sleep();
    ctx.click(tabButton(doc, 'watchlist'));
    await ctx.sleep();

    const expected = expectedWatchlist(FEED, ['DIVO', 'AIEQ']);
    const expectedOverlap = expected.filter(row => row.funds.size === 2);
    expect(watchlistDataRows(doc).length).toBe(expected.length);
    const overlapCells = watchlistDataRows(doc).filter((row: any) => row.querySelectorAll('td')[4]?.textContent === '2');
    expect(overlapCells.length).toBe(expectedOverlap.length);
    expect(expectedOverlap.length).toBeGreaterThan(0);

    const msft = expected.find(row => row.key === 'MSFT');
    expect(msft).toBeTruthy();
    expect(msft!.funds.size).toBe(2);
    const row = watchlistRowByKey(doc, 'MSFT');
    const cells = row.querySelectorAll('td');
    const weightSum = Number(cells[5]?.textContent.replace('%', ''));
    const maxWeight = Number(cells[6]?.textContent.replace('%', ''));
    expect(Math.abs(weightSum - msft!.weightSum)).toBeLessThan(0.005);
    expect(Math.abs(maxWeight - (msft!.maxWeight as number))).toBeLessThan(0.005);
  });

  test('rapid toggle bursts end in a consistent state', async () => {
    const ctx = await boot();
    const { doc } = ctx;
    ctx.click(doc.querySelector('#table-body tr[data-ticker="AIEQ"]'));
    await ctx.sleep();
    // on / off / on in a row, no waits in between.
    const checkbox = () => doc.querySelector('input[data-checkbox="DIVO"]');
    checkbox()?.dispatchEvent(new ctx.window.MouseEvent('click', { bubbles: true }));
    checkbox()?.dispatchEvent(new ctx.window.MouseEvent('click', { bubbles: true }));
    checkbox()?.dispatchEvent(new ctx.window.MouseEvent('click', { bubbles: true }));
    await ctx.sleep(60);
    expect(selectedTickers(ctx.window).sort()).toEqual(['AIEQ', 'DIVO']);
    expect(watchlistTabCount(doc)).toBe(expectedWatchlist(FEED, ['DIVO', 'AIEQ']).length);
    // And one more burst ending deselected.
    checkbox()?.dispatchEvent(new ctx.window.MouseEvent('click', { bubbles: true }));
    await ctx.sleep(60);
    expect(selectedTickers(ctx.window)).toEqual(['AIEQ']);
    expect(watchlistTabCount(doc)).toBe(expectedWatchlist(FEED, ['AIEQ']).length);
  });

  test('cash, option, derivative, treasury and zero-weight rows are retained', async () => {
    const ctx = await boot();
    const { doc } = ctx;
    // DIVO holds cash (CASH&OTHER), put options (weight 0) and plain equities.
    const divoPositions = FEED.holdings.DIVO.positions;
    const cash = divoPositions.find(p => (p.flags || []).includes('cash'));
    const option = divoPositions.find(p => (p.flags || []).includes('option') && p.weight === 0);
    expect(cash).toBeTruthy();
    expect(option).toBeTruthy();
    ctx.click(doc.querySelector('#table-body tr[data-ticker="DIVO"]'));
    await ctx.sleep();
    ctx.click(tabButton(doc, 'watchlist'));
    await ctx.sleep();
    const expected = expectedWatchlist(FEED, ['DIVO']);
    expect(watchlistTabCount(doc)).toBe(expected.length);
    expect(watchlistRowByKey(doc, positionIdentity(cash!))).toBeTruthy();
    expect(watchlistRowByKey(doc, positionIdentity(option!))).toBeTruthy();
    // SILJ holds a zero-weight GBP position and foreign-suffix symbols.
    const ctx2 = await boot();
    ctx2.click(ctx2.doc.querySelector('#table-body tr[data-ticker="SILJ"]'));
    await ctx2.sleep();
    ctx2.click(tabButton(ctx2.doc, 'watchlist'));
    await ctx2.sleep();
    const siljPositions = FEED.holdings.SILJ.positions;
    const gbp = siljPositions.find(p => p.weight === 0);
    expect(gbp).toBeTruthy();
    expect(watchlistTabCount(ctx2.doc)).toBe(expectedWatchlist(FEED, ['SILJ']).length);
    expect(watchlistRowByKey(ctx2.doc, positionIdentity(gbp!))).toBeTruthy();
  });

  test('a literal "-" ticker falls back to its CUSIP instead of being dropped', async () => {
    const data: Feed = JSON.parse(JSON.stringify(FEED));
    const apple = data.holdings.DIVO.positions.find(p => p.symbol === 'AAPL');
    expect(apple).toBeTruthy();
    const originalCusip = apple!.cusip;
    apple!.symbol = '-';
    expect(usable(apple!.symbol)).toBe('');

    const ctx = await boot({ data });
    const { doc } = ctx;
    ctx.click(doc.querySelector('#table-body tr[data-ticker="DIVO"]'));
    await ctx.sleep();
    ctx.click(tabButton(doc, 'watchlist'));
    await ctx.sleep();
    const expected = expectedWatchlist(data, ['DIVO']);
    expect(watchlistTabCount(doc)).toBe(expected.length);
    expect(watchlistRowByKey(doc, originalCusip!.toUpperCase())).toBeTruthy();
    expect(watchlistRowByKey(doc, '-')).toBeFalsy();
  });

  test('positions with no ticker and no identifier keep the published name as key', async () => {
    const data: Feed = JSON.parse(JSON.stringify(FEED));
    data.holdings.DIVO.positions.push({
      id: 'DIVO-X-GOLD',
      fundTicker: 'DIVO',
      fundName: 'Amplify CWP Enhanced Dividend Income ETF',
      asOfDate: '2026-09-17',
      symbol: 'N/A',
      rawSymbol: 'N/A',
      name: 'Gold Futures',
      cusip: '',
      weight: 1.5,
      marketValue: 1000000,
      shares: null,
      price: null,
      flags: ['derivative'],
    });
    const ctx = await boot({ data });
    const { doc } = ctx;
    ctx.click(doc.querySelector('#table-body tr[data-ticker="DIVO"]'));
    await ctx.sleep();
    ctx.click(tabButton(doc, 'watchlist'));
    await ctx.sleep();
    const expected = expectedWatchlist(data, ['DIVO']);
    expect(watchlistTabCount(doc)).toBe(expected.length);
    expect(watchlistRowByKey(doc, 'GOLD FUTURES')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// F. Empty / failure states
// ---------------------------------------------------------------------------
describe('empty and failure states', () => {
  test('Watchlist with a search that matches nothing shows a search-specific state', async () => {
    const ctx = await boot();
    const { doc } = ctx;
    ctx.click(doc.querySelector('#table-body tr[data-ticker="DIVO"]'));
    await ctx.sleep();
    ctx.click(tabButton(doc, 'watchlist'));
    await ctx.sleep();
    const search = doc.getElementById('search-input');
    search.value = 'zzzznope';
    search.dispatchEvent(new ctx.window.Event('input', { bubbles: true }));
    await ctx.sleep();
    expect(doc.getElementById('table-body').textContent).toContain('match your search');
  });

  test('selected funds without holdings get the refresh-workflow explanation, not a search message', async () => {
    const data: Feed = JSON.parse(JSON.stringify(FEED));
    data.holdings.ETHO.positions = [];
    const ctx = await boot({ data });
    const { doc } = ctx;
    ctx.click(doc.querySelector('#table-body tr[data-ticker="ETHO"]'));
    await ctx.sleep();
    ctx.click(tabButton(doc, 'watchlist'));
    await ctx.sleep();
    const text = doc.getElementById('table-body').textContent || '';
    expect(text).toContain('not available yet');
    expect(text).toContain('update-data');
    expect(text).not.toContain('match your search');
  });

  test('a detail dataset with no data shows an explanatory state (not "no search matches")', async () => {
    const ctx = await boot();
    const { doc } = ctx;
    ctx.click(doc.querySelector('#table-body tr[data-ticker="DIVO"]'));
    await ctx.sleep();
    ctx.click(tabButton(doc, 'detail:distributions'));
    await ctx.sleep();
    const text = doc.getElementById('table-body').textContent || '';
    expect(text).toContain('not available');
    expect(text).toContain('update-data');
    expect(text).not.toContain('match your search');
  });

  test('detail tables never keep the previous fund\'s rows', async () => {
    const ctx = await boot();
    const { doc } = ctx;
    // Select both; the last row click leaves DIVO active, so bring ETHO
    // forward through its subtitle badge before opening its Holdings tab.
    ctx.click(doc.querySelector('#table-body tr[data-ticker="DIVO"]'));
    await ctx.sleep();
    ctx.click(doc.querySelector('#table-body tr[data-ticker="ETHO"]'));
    await ctx.sleep();
    ctx.click(doc.querySelector('#app-subtitle [data-selected-fund="ETHO"]'));
    await ctx.sleep();
    ctx.click(tabButton(doc, 'detail:holdings'));
    await ctx.sleep();
    const ethoRows = FEED.holdings.ETHO.positions.length;
    expect(watchlistDataRows(doc).length).toBe(ethoRows);
    // Switch the active fund through the subtitle badge (DIVO), same tab.
    ctx.click(doc.querySelector('#app-subtitle [data-selected-fund="DIVO"]'));
    await ctx.sleep();
    ctx.click(tabButton(doc, 'detail:holdings'));
    await ctx.sleep();
    expect(watchlistDataRows(doc).length).toBe(FEED.holdings.DIVO.positions.length);
    expect(doc.getElementById('table-body').textContent).not.toContain('ETHO Holdings');
  });

  test('feed load failure shows a failure state, not "no search matches"', async () => {
    const ctx = await boot({ fetchError: true });
    const { doc } = ctx;
    expect(doc.getElementById('ticker-count').textContent).toBe('Error');
    const text = doc.getElementById('table-body').textContent || '';
    expect(text).toContain('Unable to load api/data.json');
    expect(text).not.toContain('No ETFs match your search');
  });
});

// ---------------------------------------------------------------------------
// G. Detail tabs
// ---------------------------------------------------------------------------
describe('detail tabs', () => {
  test('data-rich fund renders real rows in Holdings/Performance/Overview and keeps them when switching', async () => {
    const ctx = await boot();
    const { doc } = ctx;
    ctx.click(doc.querySelector('#table-body tr[data-ticker="ETHO"]'));
    await ctx.sleep();
    ctx.click(tabButton(doc, 'detail:holdings'));
    await ctx.sleep();
    expect(watchlistDataRows(doc).length).toBe(FEED.holdings.ETHO.positions.length);
    expect(doc.getElementById('table-body').textContent).toContain('AAPL');

    ctx.click(tabButton(doc, 'detail:performance'));
    await ctx.sleep();
    const perfRows = (FEED.details.ETHO.performance?.monthly?.returns || []).length
      + (FEED.details.ETHO.performance?.quarterly?.returns || []).length;
    expect(watchlistDataRows(doc).length).toBe(perfRows);

    ctx.click(tabButton(doc, 'detail:overview'));
    await ctx.sleep();
    expect(watchlistDataRows(doc).length).toBeGreaterThan(10);

    ctx.click(tabButton(doc, 'detail:holdings'));
    await ctx.sleep();
    expect(watchlistDataRows(doc).length).toBe(FEED.holdings.ETHO.positions.length);
  });

  test('distribution rows use the ex-date column when present', async () => {
    const data: Feed = JSON.parse(JSON.stringify(FEED));
    data.details.DIVO.distributions = [
      { exDate: '2026-08-14', recordDate: '2026-08-17', payableDate: '2026-08-21', amount: 0.21, currency: 'USD', type: 'Income', note: null, year: 2026 },
      { exDate: '2026-05-14', recordDate: '2026-05-19', payableDate: '2026-05-21', amount: 0.2, currency: 'USD', type: 'Income', note: null, year: 2026 },
    ];
    const ctx = await boot({ data });
    const { doc } = ctx;
    ctx.click(doc.querySelector('#table-body tr[data-ticker="DIVO"]'));
    await ctx.sleep();
    ctx.click(tabButton(doc, 'detail:distributions'));
    await ctx.sleep();
    const body = doc.getElementById('table-body');
    expect(watchlistDataRows(doc).length).toBe(2);
    // Default sort is exDate desc, so the newest ex-date renders first.
    expect(body.textContent).toContain('2026-08-14');
    const firstRow = watchlistDataRows(doc)[0];
    expect(firstRow.querySelectorAll('td')[1]?.textContent).toBe('2026-08-14');
  });
});

// ---------------------------------------------------------------------------
// H. Large Watchlist rendering
// ---------------------------------------------------------------------------
describe('large watchlist rendering', () => {
  test('all-catalog watchlist is chunked, the count stays exact, and export stays complete', async () => {
    const ctx = await boot();
    const { doc } = ctx;
    ctx.setChecked(doc.getElementById('select-all-toggle'), true);
    await ctx.sleep();
    const expected = expectedWatchlist(FEED, ALL_TICKERS).length;
    expect(expected).toBeGreaterThan(1000);
    expect(watchlistTabCount(doc)).toBe(expected);

    ctx.click(tabButton(doc, 'watchlist'));
    await ctx.sleep();
    const firstChunk = watchlistDataRows(doc).length;
    expect(firstChunk).toBeLessThanOrEqual(500);
    expect(firstChunk).toBeGreaterThan(0);
    // A sentinel offers the remaining rows.
    expect(doc.getElementById('load-more-rows')).toBeTruthy();
    expect(doc.getElementById('table-body').textContent).toContain(`of ${expected.toLocaleString('en-US')}`);

    let guard = 0;
    while (doc.getElementById('load-more-rows') && guard < 20) {
      ctx.click(doc.getElementById('load-more-rows'));
      await ctx.sleep();
      guard += 1;
    }
    expect(watchlistDataRows(doc).length).toBe(expected);
    expect(doc.getElementById('load-more-rows')).toBeNull();
    // Copy/export operate on the full filtered result, not the rendered chunk.
    expect(doc.getElementById('copy-btn').disabled).toBe(false);
    expect(doc.getElementById('export-csv-btn').disabled).toBe(false);
    expect(doc.getElementById('export-txt-btn').disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// I. Sticky columns
// ---------------------------------------------------------------------------
describe('sticky columns', () => {
  test('catalog Use + Ticker header and body cells carry the sticky classes', async () => {
    const ctx = await boot();
    const { doc } = ctx;
    expect(doc.getElementById('table-scroll')).toBeTruthy();
    const headCells = [...doc.querySelectorAll('#table-head th')];
    const useTh = headCells.find((th: any) => th.textContent.includes('Use'));
    const tickerTh = headCells.find((th: any) => th.textContent.trim().startsWith('Ticker'));
    expect(useTh?.classList.contains('catalog-sticky-col')).toBe(true);
    expect(useTh?.classList.contains('catalog-sticky-use')).toBe(true);
    expect(tickerTh?.classList.contains('catalog-sticky-col')).toBe(true);
    expect(tickerTh?.classList.contains('catalog-sticky-ticker')).toBe(true);
    const row = doc.querySelector('#table-body tr[data-ticker]');
    const bodyCells = row.querySelectorAll('td');
    expect(bodyCells[1].classList.contains('catalog-sticky-col')).toBe(true);
    expect(bodyCells[1].classList.contains('catalog-sticky-use')).toBe(true);
    expect(bodyCells[2].classList.contains('catalog-sticky-col')).toBe(true);
    expect(bodyCells[2].classList.contains('catalog-sticky-ticker')).toBe(true);
    // The # index column must not be pinned.
    expect(bodyCells[0].classList.contains('catalog-sticky-col')).toBe(false);

    const css = [...doc.querySelectorAll('style')].map(s => s.textContent).join('\n');
    expect(css).toMatch(/\.catalog-sticky-col\{position:sticky/);
    expect(css).toMatch(/\.catalog-sticky-use\{left:0/);
    expect(css).toMatch(/\.catalog-sticky-ticker\{left:5rem/);
    expect(css).toMatch(/\.watchlist-sticky-ticker\{position:sticky;left:0/);
  });

  test('Watchlist Ticker header and body cells are pinned at the left edge', async () => {
    const ctx = await boot();
    const { doc } = ctx;
    ctx.click(doc.querySelector('#table-body tr[data-ticker="DIVO"]'));
    await ctx.sleep();
    ctx.click(tabButton(doc, 'watchlist'));
    await ctx.sleep();
    const headCells = [...doc.querySelectorAll('#table-head th')];
    const tickerTh = headCells.find((th: any) => th.textContent.trim().startsWith('Ticker'));
    expect(tickerTh?.classList.contains('watchlist-sticky-ticker')).toBe(true);
    const row = doc.querySelector('#table-body tr');
    expect(row.querySelectorAll('td')[1].classList.contains('watchlist-sticky-ticker')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// J. localStorage resilience
// ---------------------------------------------------------------------------
describe('localStorage resilience', () => {
  test('malformed localStorage cannot crash boot', async () => {
    const ctx = await boot({
      localStorageSeed: {
        'amplify-tab-sorts': 'not-json{{{',
        'amplify-selected-etfs': '"garbage',
        'amplify-blacklisted-etfs': '5',
        'amplify-searches': '[1,2,3]',
        'amplify-active-fund': '   ',
      },
    });
    expect(catalogRowTickers(ctx.doc).length).toBe(ALL_TICKERS.length);
  });

  test('malformed tab-sort entries are sanitized; well-formed ones survive', async () => {
    const ctx = await boot({
      localStorageSeed: {
        'amplify-tab-sorts': JSON.stringify({
          All: { key: '', dir: 'up' },
          watchlist: { key: 5, dir: 'desc' },
          Income: { key: 'navValue', dir: 'asc' },
        }),
      },
    });
    const saved = JSON.parse(ctx.window.localStorage.getItem('amplify-tab-sorts') || '{}');
    expect(saved.All).toBeUndefined();
    expect(saved.watchlist).toBeUndefined();
    expect(saved.Income).toEqual({ key: 'navValue', dir: 'asc' });
    expect(catalogRowTickers(ctx.doc).length).toBe(ALL_TICKERS.length);
  });

  test('a stale sort key for a missing column is a stable no-op', async () => {
    const ctx = await boot({
      localStorageSeed: {
        'amplify-tab-sorts': JSON.stringify({ All: { key: 'columnThatDoesNotExist', dir: 'desc' } }),
      },
    });
    expect(catalogRowTickers(ctx.doc).length).toBe(ALL_TICKERS.length);
    // Rows are still renderable in a stable order (original rank order).
    expect(catalogRowTickers(ctx.doc)[0]).toBe(FEED.funds[0].ticker);
  });
});
