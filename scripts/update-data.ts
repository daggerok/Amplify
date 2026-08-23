#!/usr/bin/env bun

// Bun provides Node-compatible fs/promises and process globals for this script.
// @ts-expect-error node types are intentionally not installed in this no-dependency repo.
import { mkdir, writeFile } from 'node:fs/promises';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };

const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1/projects/amplify-etfs-data-feed/databases/(default)/documents';
const OUT_FILE = new URL('../api/data.json', import.meta.url);
const CONCURRENCY = Number(process.env.AMPLIFY_DATA_CONCURRENCY || 6);

type JsonRecord = Record<string, any>;

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
  console.log('Fetching Amplify ETF catalog...');
  const categoryDocs = await fetchFirestoreList(['fund_category'], 'pageSize=200');
  const catalog: CatalogFund[] = categoryDocs
    .map(doc => ({
      ticker: sanitizeTicker(doc.fields.ticker || doc.id),
      category: doc.fields.category || 'Unknown',
      active: doc.fields.isActive !== false,
    }))
    .filter(fund => fund.ticker && fund.active && fund.category !== 'Unknown');

  console.log(`Found ${catalog.length} active Amplify ETFs.`);

  const funds: JsonRecord[] = [];
  const holdingsByTicker: Record<string, JsonRecord> = {};
  const detailsByTicker: Record<string, JsonRecord> = {};

  await promisePool(catalog, CONCURRENCY, async ({ ticker, category }) => {
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

  const payload = {
    generatedAt: new Date().toISOString(),
    source: {
      site: 'https://amplifyetfs.com/our-etfs/',
      firestoreProject: 'amplify-etfs-data-feed',
      firestoreRestBase: FIRESTORE_BASE,
    },
    counts: {
      funds: funds.length,
      holdings: Object.values(holdingsByTicker).reduce((sum, item) => sum + item.positions.length, 0),
      distributions: Object.values(detailsByTicker).reduce((sum, item) => sum + (item.distributions?.length || 0), 0),
    },
    funds,
    holdings: holdingsByTicker,
    details: detailsByTicker,
  };

  await mkdir(new URL('../api/', import.meta.url), { recursive: true });
  await writeFile(OUT_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${OUT_FILE.pathname}`);
  console.log(`Funds: ${payload.counts.funds}; normalized positions: ${payload.counts.holdings}; distributions: ${payload.counts.distributions}`);
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
  Object.entries(doc.fields || {}).forEach(([key, value]) => { fields[key] = decodeFirestoreValue(value); });
  return { id, name: doc.name, fields };
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
    Object.entries(value.mapValue.fields || {}).forEach(([key, inner]) => { out[key] = decodeFirestoreValue(inner); });
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
