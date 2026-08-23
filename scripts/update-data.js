#!/usr/bin/env bun

import { mkdir, writeFile } from 'node:fs/promises';

const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1/projects/amplify-etfs-data-feed/databases/(default)/documents';
const OUT_FILE = new URL('../api/data.json', import.meta.url);
const CONCURRENCY = Number(process.env.AMPLIFY_DATA_CONCURRENCY || 6);

async function main() {
  console.log('Fetching Amplify ETF catalog...');
  const categoryDocs = await fetchFirestoreList(['fund_category'], 'pageSize=200');
  const catalog = categoryDocs
    .map(doc => ({
      ticker: sanitizeTicker(doc.fields.ticker || doc.id),
      category: doc.fields.category || 'Unknown',
      active: doc.fields.isActive !== false,
    }))
    .filter(fund => fund.ticker && fund.active && fund.category !== 'Unknown');

  console.log(`Found ${catalog.length} active Amplify ETFs.`);

  const funds = [];
  const holdingsByTicker = {};

  await promisePool(catalog, CONCURRENCY, async ({ ticker, category }) => {
    console.log(`Fetching ${ticker}...`);
    const [metaDoc, dailyDoc, holdingsDoc] = await Promise.all([
      fetchFirestoreDoc(['funds', ticker, 'fund_metadata', 'overview']).catch(error => ({ error })),
      fetchLatestCollectionDoc(['funds', ticker, 'daily']).catch(error => ({ error })),
      fetchLatestCollectionDoc(['funds', ticker, 'holdings']).catch(error => ({ error })),
    ]);

    const meta = metaDoc?.fields || {};
    const daily = dailyDoc?.fields || {};
    const holdingsFields = holdingsDoc?.fields || {};
    const asOfDate = holdingsFields.asOfDate || holdingsDoc?.id || '';
    const fundName = meta.DisplayName || meta.FundName || meta.Name || ticker;
    const rawHoldings = Array.isArray(holdingsFields.holdings) ? holdingsFields.holdings : [];
    const positions = rawHoldings
      .map((holding, index) => normalizePosition(holding, { ticker, fundName, asOfDate, index }))
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
      expenseRatio: Number.isFinite(expenseRatioValue) ? formatPercent(expenseRatioValue * 100) : '—',
      expenseRatioValue: Number.isFinite(expenseRatioValue) ? expenseRatioValue : null,
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
      error: holdingsDoc?.error ? String(holdingsDoc.error.message || holdingsDoc.error) : undefined,
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
    },
    funds,
    holdings: holdingsByTicker,
  };

  await mkdir(new URL('../api/', import.meta.url), { recursive: true });
  await writeFile(OUT_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${OUT_FILE.pathname}`);
  console.log(`Funds: ${payload.counts.funds}; normalized positions: ${payload.counts.holdings}`);
}

async function fetchLatestCollectionDoc(pathParts) {
  const docs = await fetchFirestoreList(pathParts, 'pageSize=1&orderBy=__name__%20desc');
  return docs[0] || null;
}

async function fetchFirestoreDoc(pathParts) {
  const url = `${FIRESTORE_BASE}/${pathParts.map(encodeURIComponent).join('/')}`;
  const json = await fetchJson(url);
  return decodeDocument(json);
}

async function fetchFirestoreList(pathParts, query = '') {
  const url = `${FIRESTORE_BASE}/${pathParts.map(encodeURIComponent).join('/')}${query ? `?${query}` : ''}`;
  const json = await fetchJson(url);
  return (json.documents || []).map(decodeDocument);
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  const text = await response.text();
  let json = {};
  if (text) json = JSON.parse(text);
  if (!response.ok || json.error) {
    const message = json.error?.message || `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return json;
}

function decodeDocument(doc) {
  const id = doc.name ? doc.name.split('/').pop() : '';
  const fields = {};
  Object.entries(doc.fields || {}).forEach(([key, value]) => { fields[key] = decodeFirestoreValue(value); });
  return { id, name: doc.name, fields };
}

function decodeFirestoreValue(value) {
  if (!value || typeof value !== 'object') return value;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('booleanValue' in value) return Boolean(value.booleanValue);
  if ('timestampValue' in value) return value.timestampValue;
  if ('nullValue' in value) return null;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decodeFirestoreValue);
  if ('mapValue' in value) {
    const out = {};
    Object.entries(value.mapValue.fields || {}).forEach(([key, inner]) => { out[key] = decodeFirestoreValue(inner); });
    return out;
  }
  return value;
}

function normalizePosition(raw, ctx) {
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

function classifyHolding({ symbol, name, cusip, raw }) {
  const compact = symbol.replace(/\s+/g, '');
  const upperName = name.toUpperCase();
  const flags = [];
  const isCash = /CASH/.test(symbol) || /CASH\s*&\s*OTHER|CASH COLLATERAL|CASH AND OTHER/.test(upperName) || symbol === 'USD';
  const isMoneyMarket = raw.MoneyMarketFlag === true || /GOVERNMENT\s*&\s*AGENCY PORTFOLIO|MONEY MARKET|TREASURY PORTFOLIO/.test(upperName) || /^[A-Z]{3,5}XX$/.test(symbol);
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

async function promisePool(items, limit, worker) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(workers);
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePercent(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value > 0 && value < 1 ? value * 100 : value;
  const parsed = Number.parseFloat(String(value).replace('%', '').trim());
  if (!Number.isFinite(parsed)) return null;
  return parsed > 0 && parsed < 1 && !String(value).includes('%') ? parsed * 100 : parsed;
}

function formatMoney(value, { decimals = 0 } = {}) {
  if (!Number.isFinite(Number(value))) return '—';
  return Number(value).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals,
  });
}

function formatPercent(value) {
  if (!Number.isFinite(Number(value))) return '—';
  return `${Number(value).toFixed(2)}%`;
}

function sanitizeTicker(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9._-]/g, '');
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
