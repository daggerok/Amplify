/// <reference types="bun" />


import { test as frequencyLabelTest, expect as frequencyLabelExpect } from 'bun:test';
frequencyLabelTest('empty frequency label is None without changing cadence inference', async () => {
  const text = await Bun.file(new URL('./update-data.ts', import.meta.url)).text();
  const start = text.indexOf('function distributionDateTs(');
  const end = text.indexOf('function normalizePerformanceDoc(', start);
  frequencyLabelExpect(start).toBeGreaterThan(-1);
  frequencyLabelExpect(end).toBeGreaterThan(start);
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(text.slice(start, end));
  const format = new Function(js + '; return deriveDistributionFrequency;')();
  frequencyLabelExpect(format([])).toBe('00 - None');
  frequencyLabelExpect(format([{ exDate: 'invalid' }])).toBe('00 - None');
  frequencyLabelExpect(format([{ exDate: '2026-01-01' }])).toBe('00 - None');
  for (const [dates, expected] of [
    [['2026-01-01', '2026-02-01', '2026-03-01'], '01 - Monthly'],
    [['2026-01-01', '2026-04-01', '2026-07-01'], '04 - Quarterly'],
    [['2025-01-01', '2025-07-01', '2026-01-01'], '06 - Semi-annually'],
    [['2024-01-01', '2025-01-01', '2026-01-01'], '12 - Annually'],
  ]) frequencyLabelExpect(format((dates as string[]).map(exDate => ({ exDate })))).toBe(expected);
});


import { test as headerTest, expect as headerExpect } from 'bun:test';
async function headerSummaryHarness() {
  const source = await Bun.file(new URL('../index.html', import.meta.url)).text();
  const match = /^([ \t]*)function renderHeaderSummary\(/m.exec(source);
  headerExpect(match).not.toBeNull();
  const tail = source.slice(match!.index);
  const end = new RegExp('^' + match![1] + '}', 'm').exec(tail)!;
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(tail.slice(0, end.index + end[0].length));
  const makeNode = (text = ''): any => {
    const node: any = { textContent: text, childNodes: [], dataset: {}, listeners: {} };
    node.replaceChildren = (...children: any[]) => { node.childNodes = children; };
    node.append = (...children: any[]) => { node.childNodes.push(...children); };
    node.addEventListener = (name: string, listener: any) => { node.listeners[name] = listener; };
    return node;
  };
  const panel = makeNode(), subtitle = makeNode(), details = makeNode('Data: source link and updated timestamp');
  subtitle.append(details);
  const document = { getElementById: () => panel, createTextNode: makeNode, createElement: () => makeNode() };
  const render = new Function('document', js + '; return renderHeaderSummary;')(document);
  const text = () => subtitle.childNodes.map((n: any) => n.textContent).join('');
  return { render, panel, subtitle, details, makeNode, text };
}
headerTest('header has no visible subtitle without selection; original details nodes are retained', async () => {
  const h = await headerSummaryHarness();
  h.render(h.subtitle, new Set(), null, () => {});
  headerExpect(h.text()).toBe('');
  headerExpect(h.panel.childNodes).toEqual([h.details]);
  headerExpect(h.panel.childNodes[0]).toBe(h.details);
});
headerTest('header shows sorted selected tickers only, preserving click activation and highlight', async () => {
  const h = await headerSummaryHarness(); const activated: string[] = [];
  h.render(h.subtitle, new Set(['ZZZ', 'AAA']), 'AAA', (ticker: string) => activated.push(ticker));
  headerExpect(h.text()).toBe('2 selected: AAA, ZZZ');
  const links = h.subtitle.childNodes.filter((n: any) => n.dataset.headerFund);
  headerExpect(links[0].className).toContain('underline');
  links[1].listeners.click({ preventDefault() {} });
  headerExpect(activated).toEqual(['ZZZ']);
  headerExpect(h.panel.childNodes[0]).toBe(h.details);
});
headerTest('all selected still lists tickers; clear replaces both summary and selection', async () => {
  const h = await headerSummaryHarness();
  h.render(h.subtitle, new Set(['CCC','AAA','BBB']), 'BBB', () => {});
  headerExpect(h.text()).toBe('3 selected: AAA, BBB, CCC');
  const next = h.makeNode('Fresh detail context'); h.subtitle.replaceChildren(next);
  h.render(h.subtitle, new Set(), null, () => {});
  headerExpect(h.text()).toBe(''); headerExpect(h.panel.childNodes).toEqual([next]);
});
headerTest('header markup supplies a focusable counter and hidden rich panel with dismissal', async () => {
  const html = await Bun.file(new URL('../index.html', import.meta.url)).text();
  headerExpect(html).toMatch(/<button[^>]*aria-controls="app-summary"[^>]*id="ticker-count"/);
  headerExpect(html).toContain('id="app-summary" role="region" aria-label="ETF catalog information" hidden');
  headerExpect(html).toContain("event.key !== 'Escape'");
  headerExpect(html).toContain("trigger.addEventListener('focus', show)");
  headerExpect(html).toContain("trigger.addEventListener('pointerenter'");
});
