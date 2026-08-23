// src/main.ts
var DATA_API_URL = "./api/data.json";
var THEME_KEY = "amplify-theme";
var SELECTED_KEY = "amplify-selected-etfs";
var state = {
  data: null,
  funds: [],
  holdings: {},
  selected: /* @__PURE__ */ new Set(),
  activeTab: "All",
  query: "",
  sortKey: "rank",
  sortDir: "asc"
};
var el = {
  themeToggle: byId("theme-toggle"),
  tickerCount: byId("ticker-count"),
  subtitle: byId("app-subtitle"),
  searchInput: byId("search-input"),
  tabsBar: byId("tabs-bar"),
  copyBtn: byId("copy-btn"),
  exportCsvBtn: byId("export-csv-btn"),
  exportTxtBtn: byId("export-txt-btn"),
  resetBtn: byId("reset-btn"),
  statusLine: byId("status-line"),
  tableHead: byId("table-head"),
  tableBody: byId("table-body")
};
init();
function init() {
  restoreSelectedEtfs();
  applyTheme(localStorage.getItem(THEME_KEY) === "dark");
  bindEvents();
  void loadData();
}
function bindEvents() {
  el.themeToggle.addEventListener("click", () => {
    const dark = !document.documentElement.classList.contains("dark");
    localStorage.setItem(THEME_KEY, dark ? "dark" : "light");
    applyTheme(dark);
  });
  el.searchInput.addEventListener("input", () => {
    state.query = el.searchInput.value.trim();
    render();
  });
  el.copyBtn.addEventListener("click", copyTickers);
  el.exportCsvBtn.addEventListener("click", exportCsv);
  el.exportTxtBtn.addEventListener("click", exportTxt);
  el.resetBtn.addEventListener("click", clearSelectionAndSearch);
}
async function loadData() {
  try {
    setStatus("Loading Amplify ETF data from api/data.json\u2026", "info");
    const response = await fetch(DATA_API_URL, { headers: { Accept: "application/json" }, cache: "no-cache" });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const data = await response.json();
    const holdings = data.holdings || {};
    state.data = data;
    state.holdings = holdings;
    state.funds = (data.funds || []).map((fund, index) => normalizeFundRow(fund, holdings, index)).sort((a, b) => (a.rank ?? 9999) - (b.rank ?? 9999) || a.ticker.localeCompare(b.ticker));
    el.searchInput.disabled = false;
    ensureValidTab();
    render();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    el.tickerCount.textContent = "Error";
    setStatus(`Unable to load api/data.json: ${message}. Run bun ./scripts/update-data.ts and serve with bunx parcel ./index.html.`, "error");
    el.tableBody.innerHTML = `<tr><td colspan="10" class="py-12 text-center text-rose-500 dark:text-rose-300">Unable to load api/data.json</td></tr>`;
  }
}
function normalizeFundRow(fund, holdings, index) {
  const ticker = sanitizeTicker(fund.ticker);
  const positions = holdings[ticker]?.positions || [];
  const holdingsText = positions.map((position) => [position.symbol, position.name, position.cusip, position.flags?.join(" ")].filter(Boolean).join(" ")).join(" ");
  return {
    ...fund,
    ticker,
    name: fund.name || ticker,
    category: normalizeCategory(fund.category),
    holdingsCount: numberOrNull(fund.holdingsCount) ?? positions.length,
    rank: numberOrNull(fund.rank) ?? index + 1,
    searchIndex: normalizeSearchText([
      ticker,
      fund.name,
      normalizeCategory(fund.category),
      categoryLabel(normalizeCategory(fund.category)),
      fund.nav,
      fund.netAssets,
      fund.expenseRatio,
      fund.holdingsAsOfDate,
      holdingsText
    ].join(" "))
  };
}
function render() {
  if (!state.data) return;
  ensureValidTab();
  renderTabs();
  if (state.activeTab === "watchlist") renderWatchlistTable();
  else renderFundsTable();
  renderControls();
}
function ensureValidTab() {
  const tabIds = getTabs().map((tab) => tab.id);
  if (!tabIds.includes(state.activeTab)) {
    state.activeTab = tabIds.includes("All") ? "All" : tabIds[0] || "All";
  }
}
function getTabs() {
  const categories = uniqueCategories();
  const tabs = [];
  if (state.selected.size > 0) {
    tabs.push({ id: "watchlist", label: "Watchlist", count: getVisibleWatchlistRows().length });
  }
  tabs.push({ id: "All", label: "All ETFs", count: state.funds.length });
  categories.forEach((category) => {
    tabs.push({
      id: category,
      label: categoryLabel(category),
      count: state.funds.filter((fund) => fund.category === category).length
    });
  });
  return tabs;
}
function uniqueCategories() {
  const preferred = ["Income", "Thematic", "Core"];
  const categories = [...new Set(state.funds.map((fund) => fund.category).filter(Boolean))];
  return categories.sort((a, b) => {
    const ai = preferred.indexOf(a);
    const bi = preferred.indexOf(b);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    return categoryLabel(a).localeCompare(categoryLabel(b));
  });
}
function renderTabs() {
  const tabs = getTabs();
  el.tabsBar.classList.toggle("hidden", tabs.length <= 1);
  el.tabsBar.innerHTML = tabs.map((tab) => {
    const isActive = tab.id === state.activeTab;
    const activeClasses = "bg-blue-600 text-white font-medium border-blue-500 shadow-sm";
    const inactiveClasses = "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-200 dark:hover:bg-slate-700 border-slate-200 dark:border-slate-700";
    return `
      <button
        data-tab="${escapeHtml(tab.id)}"
        class="px-3.5 py-1.5 rounded-full text-xs transition border whitespace-nowrap ${isActive ? activeClasses : inactiveClasses}">
        ${escapeHtml(tab.label)} (${tab.count})
      </button>
    `;
  }).join("");
  el.tabsBar.querySelectorAll("button[data-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeTab = button.dataset.tab || "All";
      state.sortKey = state.activeTab === "watchlist" ? "weightSum" : "rank";
      state.sortDir = state.activeTab === "watchlist" ? "desc" : "asc";
      render();
    });
  });
}
function renderFundsTable() {
  const rows = sortRows(getVisibleFunds());
  el.tableHead.innerHTML = `
    <tr>
      <th class="py-3.5 px-4 w-12 text-center">#</th>
      <th class="py-3.5 px-4 w-20 text-center">Use</th>
      ${sortHeader("Ticker", "ticker")}
      ${sortHeader("Fund Name", "name")}
      ${sortHeader("Type", "category")}
      ${sortHeader("NAV", "navValue", true)}
      ${sortHeader("Net Assets", "netAssetsValue", true)}
      ${sortHeader("Expense", "expenseRatio")}
      ${sortHeader("Holdings", "holdingsCount", true)}
      ${sortHeader("As Of", "holdingsAsOfDate")}
    </tr>
  `;
  bindSortHeaders();
  if (!rows.length) {
    el.tableBody.innerHTML = `<tr><td colspan="10" class="py-12 text-center text-slate-400 dark:text-slate-500">No ETFs match your search.</td></tr>`;
  } else {
    el.tableBody.innerHTML = rows.map((fund, index) => {
      const selected2 = state.selected.has(fund.ticker);
      return `
        <tr data-ticker="${escapeHtml(fund.ticker)}" class="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/30 transition border-b border-slate-100 dark:border-slate-700/30 ${selected2 ? "selected-row" : ""}">
          <td class="py-2.5 px-4 text-slate-400 dark:text-slate-500 text-xs text-center font-mono">${index + 1}</td>
          <td class="py-2.5 px-4 text-center">
            <input data-checkbox="${escapeHtml(fund.ticker)}" type="checkbox" ${selected2 ? "checked" : ""} class="w-4 h-4 accent-blue-600" aria-label="Use ${escapeHtml(fund.ticker)}" />
          </td>
          <td class="py-2.5 px-4 font-mono font-semibold text-blue-600 dark:text-blue-400">${escapeHtml(fund.ticker)}</td>
          <td class="py-2.5 px-4 text-slate-700 dark:text-slate-300 font-medium">${escapeHtml(fund.name)}</td>
          <td class="py-2.5 px-4 text-slate-600 dark:text-slate-300">${escapeHtml(categoryLabel(fund.category))}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${escapeHtml(fund.nav || "\u2014")}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${escapeHtml(fund.netAssets || "\u2014")}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${escapeHtml(fund.expenseRatio || "\u2014")}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatInteger(fund.holdingsCount)}</td>
          <td class="py-2.5 px-4 font-mono text-slate-600 dark:text-slate-400">${escapeHtml(fund.holdingsAsOfDate || "\u2014")}</td>
        </tr>
      `;
    }).join("");
  }
  el.tableBody.querySelectorAll("tr[data-ticker]").forEach((row) => {
    row.addEventListener("click", (event) => {
      const target = event.target;
      if (target.closest("a")) return;
      toggleFund(row.dataset.ticker || "");
    });
  });
  const selected = state.selected.size;
  const queryText = state.query ? ` matching \u201C${state.query}\u201D` : "";
  setStatus(`Showing ${rows.length} ETF${rows.length === 1 ? "" : "s"}${queryText}. Click rows to select ETFs. ${selected ? `${selected} selected \u2014 open the Watchlist tab to inspect holdings.` : "No ETFs selected yet."}`, selected ? "success" : "info");
  el.tickerCount.textContent = `${rows.length} ETFs`;
}
function renderWatchlistTable() {
  const rows = sortRows(getVisibleWatchlistRows());
  el.tableHead.innerHTML = `
    <tr>
      <th class="py-3.5 px-4 w-12 text-center">#</th>
      ${sortHeader("Ticker", "symbol")}
      ${sortHeader("Name", "name")}
      ${sortHeader("ETFs", "fundCount", true)}
      ${sortHeader("Weight Sum", "weightSum", true)}
      ${sortHeader("Max Weight", "maxWeight", true)}
      ${sortHeader("Market Value", "marketValueSum", true)}
      ${sortHeader("Flags", "flags")}
    </tr>
  `;
  bindSortHeaders();
  if (!rows.length) {
    el.tableBody.innerHTML = `<tr><td colspan="8" class="py-12 text-center text-slate-400 dark:text-slate-500">No watchlist tickers match your search. Select ETFs on an ETF tab first.</td></tr>`;
  } else {
    el.tableBody.innerHTML = rows.map((row, index) => `
      <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/30 transition border-b border-slate-100 dark:border-slate-700/30">
        <td class="py-2.5 px-4 text-slate-400 dark:text-slate-500 text-xs text-center font-mono">${index + 1}</td>
        <td class="py-2.5 px-4 font-mono font-semibold text-blue-600 dark:text-blue-400">${escapeHtml(row.symbol)}</td>
        <td class="py-2.5 px-4 text-slate-700 dark:text-slate-300 font-medium">${escapeHtml(row.name)}</td>
        <td class="py-2.5 px-4 text-slate-700 dark:text-slate-300">
          <div class="flex flex-wrap gap-1 max-w-md">
            ${row.fundTickers.map((ticker) => `<span class="font-mono text-xs bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-100 dark:border-blue-800 rounded-full px-2 py-0.5">${escapeHtml(ticker)}</span>`).join("")}
          </div>
        </td>
        <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(row.weightSum)}</td>
        <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(row.maxWeight)}</td>
        <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatMoney(row.marketValueSum)}</td>
        <td class="py-2.5 px-4 text-slate-600 dark:text-slate-400">${renderFlags(row.flags)}</td>
      </tr>
    `).join("");
  }
  const queryText = state.query ? ` matching \u201C${state.query}\u201D` : "";
  setStatus(`Watchlist built from ${state.selected.size} selected ETF${state.selected.size === 1 ? "" : "s"}: ${rows.length} ticker${rows.length === 1 ? "" : "s"}${queryText}.`, "success");
  el.tickerCount.textContent = `${rows.length} tickers`;
}
function renderControls() {
  const hasData = Boolean(state.data);
  const visibleRows = state.activeTab === "watchlist" ? getVisibleWatchlistRows() : getVisibleFunds();
  const watchlistRows = getVisibleWatchlistRows();
  const selected = state.selected.size;
  el.copyBtn.disabled = watchlistRows.length === 0;
  el.exportCsvBtn.disabled = !hasData || visibleRows.length === 0;
  el.exportTxtBtn.disabled = !hasData || visibleRows.length === 0;
  el.resetBtn.disabled = !hasData || !selected && !state.query;
  const generated = state.data?.generatedAt ? ` \xB7 data ${state.data.generatedAt.slice(0, 10)}` : "";
  const selectedText = selected ? `${selected} selected ETF${selected === 1 ? "" : "s"}` : "select ETFs by clicking rows";
  el.subtitle.innerHTML = `Search Amplify ETFs, select rows, then use the Watchlist tab (${selectedText}${generated}). Data: <a href="./api/data.json" target="_blank" rel="noopener noreferrer" class="font-semibold text-blue-600 dark:text-blue-400 hover:underline">api/data.json</a>`;
}
function getVisibleFunds() {
  const query = normalizeSearchText(state.query);
  return state.funds.filter((fund) => {
    const tabMatch = state.activeTab === "All" || state.activeTab === fund.category;
    const queryMatch = !query || fund.searchIndex.includes(query);
    return tabMatch && queryMatch;
  });
}
function getSelectedPositions() {
  return [...state.selected].flatMap((ticker) => state.holdings[ticker]?.positions || []).map((position) => ({
    ...position,
    fundTicker: sanitizeTicker(position.fundTicker),
    flags: position.flags?.length ? position.flags : ["symbol"]
  }));
}
function getVisibleWatchlistRows() {
  const query = normalizeSearchText(state.query);
  return getDedupedWatchlistRows().filter((row) => !query || row.searchIndex.includes(query));
}
function getDedupedWatchlistRows() {
  const map = /* @__PURE__ */ new Map();
  for (const position of getSelectedPositions()) {
    const symbol = sanitizeWatchlistSymbol(position.symbol);
    if (!symbol || !passesWatchlistDefault(position)) continue;
    if (!map.has(symbol)) {
      map.set(symbol, {
        symbol,
        names: /* @__PURE__ */ new Set(),
        cusips: /* @__PURE__ */ new Set(),
        flags: /* @__PURE__ */ new Set(),
        funds: /* @__PURE__ */ new Set(),
        weightSum: 0,
        maxWeight: null,
        marketValueSum: 0
      });
    }
    const row = map.get(symbol);
    row.names.add(position.name || symbol);
    if (position.cusip) row.cusips.add(position.cusip);
    (position.flags || []).forEach((flag) => row.flags.add(flag));
    row.funds.add(position.fundTicker);
    if (Number.isFinite(position.weight)) {
      const weight = Number(position.weight);
      row.weightSum += weight;
      row.maxWeight = row.maxWeight === null ? weight : Math.max(row.maxWeight, weight);
    }
    if (Number.isFinite(position.marketValue)) row.marketValueSum += Number(position.marketValue);
  }
  return [...map.values()].map((row) => {
    const names = [...row.names];
    const fundTickers = [...row.funds].sort();
    const flags = [...row.flags].sort();
    const cusips = [...row.cusips].sort();
    const name = names[0] || row.symbol;
    return {
      symbol: row.symbol,
      name,
      names,
      cusips,
      flags,
      fundTickers,
      fundCount: fundTickers.length,
      weightSum: row.weightSum,
      maxWeight: row.maxWeight,
      marketValueSum: row.marketValueSum,
      searchIndex: normalizeSearchText([row.symbol, name, names.join(" "), cusips.join(" "), flags.join(" "), fundTickers.join(" ")].join(" "))
    };
  });
}
function passesWatchlistDefault(position) {
  const symbol = sanitizeWatchlistSymbol(position.symbol);
  const flags = new Set(position.flags || []);
  if (!symbol) return false;
  if (["cash", "money-market", "treasury", "option", "derivative", "cusip-like"].some((flag) => flags.has(flag))) return false;
  return /[A-Z]/.test(symbol);
}
function toggleFund(ticker) {
  const cleanTicker = sanitizeTicker(ticker);
  if (!cleanTicker) return;
  if (state.selected.has(cleanTicker)) state.selected.delete(cleanTicker);
  else state.selected.add(cleanTicker);
  localStorage.setItem(SELECTED_KEY, JSON.stringify([...state.selected]));
  if (state.selected.size && state.activeTab !== "watchlist") {
  }
  render();
}
function clearSelectionAndSearch() {
  state.selected.clear();
  state.query = "";
  state.activeTab = "All";
  state.sortKey = "rank";
  state.sortDir = "asc";
  el.searchInput.value = "";
  localStorage.removeItem(SELECTED_KEY);
  render();
}
function copyTickers() {
  const tickers = getVisibleWatchlistRows().map((row) => row.symbol).sort((a, b) => a.localeCompare(b, void 0, { numeric: true }));
  if (!tickers.length) return;
  void copyText(tickers.join(", ")).then(() => {
    const oldText = el.copyBtn.textContent;
    el.copyBtn.textContent = "Copied!";
    setTimeout(() => {
      el.copyBtn.textContent = oldText || "Copy Tickers";
    }, 1e3);
  });
}
function exportCsv() {
  if (state.activeTab === "watchlist") {
    const headers2 = ["Ticker", "Name", "ETFs", "Weight Sum (%)", "Max Weight (%)", "Market Value ($)", "Flags"];
    const rows2 = getVisibleWatchlistRows().map((row) => [
      row.symbol,
      row.name,
      row.fundTickers.join("|"),
      numberCell(row.weightSum),
      numberCell(row.maxWeight),
      numberCell(row.marketValueSum),
      row.flags.join("|")
    ]);
    downloadText(toCsv([headers2, ...rows2]), exportFileName("watchlist", "csv"), "text/csv;charset=utf-8;");
    return;
  }
  const headers = ["Selected", "Ticker", "Fund Name", "Type", "NAV", "Net Assets", "Expense Ratio", "Holdings", "Holdings As Of"];
  const rows = getVisibleFunds().map((fund) => [
    state.selected.has(fund.ticker) ? "yes" : "no",
    fund.ticker,
    fund.name,
    categoryLabel(fund.category),
    fund.nav || "",
    fund.netAssets || "",
    fund.expenseRatio || "",
    numberCell(fund.holdingsCount),
    fund.holdingsAsOfDate || ""
  ]);
  downloadText(toCsv([headers, ...rows]), exportFileName("etfs", "csv"), "text/csv;charset=utf-8;");
}
function exportTxt() {
  const values = state.activeTab === "watchlist" ? getVisibleWatchlistRows().map((row) => row.symbol).sort((a, b) => a.localeCompare(b, void 0, { numeric: true })) : getVisibleFunds().map((fund) => fund.ticker);
  downloadText(values.join("\n"), exportFileName(state.activeTab === "watchlist" ? "watchlist" : "etfs", "txt"), "text/plain;charset=utf-8;");
}
function sortHeader(label, key, numeric = false) {
  const active = state.sortKey === key;
  const arrow = active ? state.sortDir === "asc" ? " \u2191" : " \u2193" : "";
  const align = numeric ? " text-right" : "";
  return `<th class="py-3.5 px-4${align}"><button data-sort="${escapeHtml(key)}" class="uppercase tracking-wider hover:text-blue-600 dark:hover:text-blue-400">${escapeHtml(label)}${arrow}</button></th>`;
}
function bindSortHeaders() {
  el.tableHead.querySelectorAll("button[data-sort]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.sort || "rank";
      if (state.sortKey === key) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      else {
        state.sortKey = key;
        state.sortDir = ["ticker", "name", "category", "symbol"].includes(key) ? "asc" : "desc";
      }
      render();
    });
  });
}
function sortRows(rows) {
  const direction = state.sortDir === "asc" ? 1 : -1;
  const key = state.sortKey;
  return [...rows].sort((a, b) => compareValues(sortValue(a, key), sortValue(b, key)) * direction);
}
function sortValue(row, key) {
  if (key === "flags") return Array.isArray(row.flags) ? row.flags.join(",") : "";
  return row[key];
}
function compareValues(a, b) {
  if (typeof a === "number" || typeof b === "number") {
    const an = typeof a === "number" && Number.isFinite(a) ? a : -Infinity;
    const bn = typeof b === "number" && Number.isFinite(b) ? b : -Infinity;
    return an === bn ? 0 : an > bn ? 1 : -1;
  }
  return String(a ?? "").localeCompare(String(b ?? ""), void 0, { numeric: true, sensitivity: "base" });
}
function restoreSelectedEtfs() {
  try {
    const saved = JSON.parse(localStorage.getItem(SELECTED_KEY) || "[]");
    state.selected = new Set(saved.map(sanitizeTicker).filter(Boolean));
  } catch {
    state.selected = /* @__PURE__ */ new Set();
  }
}
function applyTheme(dark) {
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.backgroundColor = dark ? "#020617" : "#f8fafc";
  el.themeToggle.textContent = dark ? "\u2600\uFE0F" : "\u{1F319}";
  el.themeToggle.title = dark ? "Switch to light theme" : "Switch to dark theme";
}
function setStatus(message, tone) {
  const toneClasses = {
    info: "bg-blue-50 dark:bg-blue-950/30 border-blue-100 dark:border-blue-800/50 text-blue-700 dark:text-blue-300",
    success: "bg-emerald-50 dark:bg-emerald-950/30 border-emerald-100 dark:border-emerald-800/50 text-emerald-700 dark:text-emerald-300",
    error: "bg-rose-50 dark:bg-rose-950/30 border-rose-100 dark:border-rose-800/50 text-rose-700 dark:text-rose-300"
  };
  el.statusLine.className = `rounded-xl px-4 py-3 text-sm border ${toneClasses[tone]}`;
  el.statusLine.textContent = message;
}
function categoryLabel(category) {
  return category === "Thematic" ? "Growth" : category || "Other";
}
function normalizeCategory(category) {
  return (category || "Other").trim() || "Other";
}
function sanitizeTicker(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9._-]/g, "");
}
function sanitizeWatchlistSymbol(value) {
  return String(value || "").trim().toUpperCase();
}
function normalizeSearchText(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}
function numberOrNull(value) {
  if (value === null || value === void 0 || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}
function numberCell(value) {
  const parsed = numberOrNull(value);
  return parsed === null ? "" : parsed;
}
function formatInteger(value) {
  const parsed = numberOrNull(value);
  return parsed === null ? "\u2014" : parsed.toLocaleString("en-US", { maximumFractionDigits: 0 });
}
function formatPercent(value) {
  const parsed = numberOrNull(value);
  return parsed === null ? "\u2014" : `${parsed.toFixed(2)}%`;
}
function formatMoney(value) {
  const parsed = numberOrNull(value);
  if (parsed === null) return "\u2014";
  return parsed.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0, minimumFractionDigits: 0 });
}
function renderFlags(flags) {
  return `<div class="flex flex-wrap gap-1 max-w-sm">${flags.map((flag) => {
    const tone = flag === "symbol" || flag === "exchange-suffix" ? "bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 border-emerald-100 dark:border-emerald-800" : "bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 border-amber-100 dark:border-amber-800";
    return `<span class="text-xs border rounded-full px-2 py-0.5 ${tone}">${escapeHtml(flag)}</span>`;
  }).join("")}</div>`;
}
function toCsv(rows) {
  return rows.map((row) => row.map(csvEscape).join(",")).join("\r\n");
}
function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function exportFileName(kind, extension) {
  const suffix = state.query ? "_filtered" : "";
  return `Amplify_${kind}_${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}${suffix}.${extension}`;
}
function downloadText(text, filename, mimeType) {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 250);
}
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char] || char);
}
function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element;
}
