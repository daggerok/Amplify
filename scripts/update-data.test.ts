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
