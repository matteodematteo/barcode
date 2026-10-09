"use strict";

/* On-demand sales quantity and product activity lookups */

const SALES_REQUEST_CACHE_KEYS = {
  custom: "web_barcode_scanner_sales_request_custom_v1",
  summarySales: "web_barcode_scanner_sales_request_summary_sales_v1",
  summaryInventory: "web_barcode_scanner_sales_request_summary_inventory_v1"
};


function salesRequestParams(barcode, type, beginDate, endDate) {
  return {
    barcode,
    type,
    beginDate: formatSalesDateForRequest(beginDate),
    endDate: formatSalesEndDateForRequest(endDate)
  };
}


function readSalesRequestCache(kind, params) {
  try {
    const cached = JSON.parse(localStorage.getItem(SALES_REQUEST_CACHE_KEYS[kind]));
    if (!cached || cached.barcode !== params.barcode || cached.type !== params.type ||
        cached.beginDate !== params.beginDate || cached.endDate !== params.endDate) return null;
    const value = cached.result;
    if (kind === "custom") return typeof value === "number" && Number.isFinite(value) ? value : null;
    return Array.isArray(value) && value.length === 4 &&
      value.every(number => typeof number === "number" && Number.isFinite(number)) ? value : null;
  } catch {
    return null;
  }
}


function saveSalesRequestCache(kind, params, result) {
  try {
    localStorage.setItem(SALES_REQUEST_CACHE_KEYS[kind], JSON.stringify({ ...params, result }));
  } catch {
    // Browsing still works when local storage is blocked or full.
  }
}

function formatSalesQuantity(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "0";
  }
  return numeric.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}


function formatSalesDateForRequest(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  if (text.length === 10) {
    return `${text} 00:00:00`;
  }
  return text.replace("T", " ") + (text.length === 16 ? ":00" : "");
}


function formatSalesEndDateForRequest(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  if (text.length === 10) {
    return `${text} 23:59:59`;
  }
  return text.replace("T", " ") + (text.length === 16 ? ":59" : "");
}


function parseSalesDate(value, endOfDay) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const dateOnly = new Date(`${text}T00:00:00`);
    if (Number.isNaN(dateOnly.getTime())) {
      return null;
    }
    if (endOfDay) {
      dateOnly.setHours(23, 59, 59, 999);
    }
    return dateOnly;
  }
  const normalized = text.replace(" ", "T").replace(/\.0+$/, "");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}


function hasSalesQuantityField(item) {
  return Boolean(item && typeof item === "object" && Object.prototype.hasOwnProperty.call(item, "quantity"));
}


function extractSalesRows(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("Activity response did not contain quantity rows. Refresh your login and retry.");
  }

  const queue = [payload];
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item || typeof item !== "object") {
      continue;
    }

    if (Array.isArray(item)) {
      if (item.length === 0 || item.some(hasSalesQuantityField)) {
        return item;
      }
      continue;
    }

    const values = Object.values(item);
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      if (Array.isArray(value)) {
        if (value.length === 0 || value.some(hasSalesQuantityField)) {
          return value;
        }
      } else if (value && typeof value === "object") {
        queue.push(value);
      }
    }
  }
  throw new Error("Activity response did not contain quantity rows. Refresh your login and retry.");
}


function isSalesRowInSelectedPeriod(row) {
  const beginDate = parseSalesDate(state.salesBeginDate, false);
  const endDate = parseSalesDate(state.salesEndDate, true);
  if (!beginDate && !endDate) {
    return true;
  }

  const rowDate = parseSalesDate(row?.operatortime);
  if (!rowDate) {
    return false;
  }
  if (beginDate && rowDate < beginDate) {
    return false;
  }
  if (endDate && rowDate > endDate) {
    return false;
  }
  return true;
}


function getSalesRowQuantity(row) {
  const rawQuantity = row?.quantity;
  if (typeof rawQuantity === "string") {
    const normalized = rawQuantity.trim().replace(",", ".");
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const parsed = Number(rawQuantity);
  return Number.isFinite(parsed) ? parsed : 0;
}


function sumSalesQuantity(rows) {
  return rows
    .filter(isSalesRowInSelectedPeriod)
    .reduce(function (total, row) {
      return total + getSalesRowQuantity(row);
    }, 0);
}


function renderSalesQuantity() {
  const valueEl = state.els?.salesQuantityField;
  const loaderEl = state.els?.salesQuantityLoader;
  const periodBtn = state.els?.salesPeriodBtn;
  if (!valueEl || !loaderEl) {
    return;
  }

  loaderEl.hidden = !state.isSalesLoading;
  if (state.isSalesLoading) {
    valueEl.textContent = "";
  } else if (!state.salesBarcode) {
    valueEl.textContent = "";
  } else if (state.salesError || !state.hasSalesResult) {
    valueEl.textContent = "—";
  } else {
    valueEl.textContent = formatSalesQuantity(state.salesQuantityTotal ?? sumSalesQuantity(state.salesRows));
  }

  if (periodBtn) {
    const hasPeriod = Boolean(state.salesBeginDate || state.salesEndDate);
    periodBtn.classList.toggle("has-period", hasPeriod);
    periodBtn.title = hasPeriod ? "Sales period active" : "Sales period";
  }
}


function clearSalesData() {
  state.salesAbortController?.abort();
  state.productActivityAbortController?.abort();
  state.salesLookupSequence += 1;
  state.salesBarcode = "";
  state.salesRows = [];
  state.salesQuantityTotal = null;
  state.isSalesLoading = false;
  state.hasSalesResult = false;
  state.salesError = false;
  state.salesRefreshAllInFlight = false;
  state.productActivityLookupSequence += 1;
  state.productActivityTotals = null;
  state.productActivityDate = "";
  state.isProductActivityLoading = false;
  state.productActivityError = "";
  state.productActivityRefreshAllInFlight = false;
  renderSalesQuantity();
  renderProductActivity();
}


function getDisplayedGoodsCode() {
  return String(state.fieldEls?.goods_code?.textContent || "").trim();
}


function restoreSalesPeriodFromSavedRequest() {
  try {
    const saved = JSON.parse(localStorage.getItem(SALES_REQUEST_CACHE_KEYS.custom));
    if (!saved || !saved.barcode || saved.type !== "sales" ||
        !/^(?:|\d{4}-\d{2}-\d{2} 00:00:00)$/.test(saved.beginDate) ||
        !/^(?:|\d{4}-\d{2}-\d{2} 23:59:59)$/.test(saved.endDate)) return;
    state.salesBeginDate = saved.beginDate.slice(0, 10);
    state.salesEndDate = saved.endDate.slice(0, 10);
  } catch {
    // Use the default period if saved request settings are unavailable.
  }
}


function isSalesTabActive(index) {
  if (state.productInfoSlideIndex !== index || state.isQuantityEntryUnlocked ||
      state.els?.productInfoSection?.hidden ||
      (typeof document !== "undefined" && document.hidden)) return false;
  const slider = state.els?.productInfoSlider;
  // A clicked dot can change selection before the slide finishes moving.
  // Mobile scroll snapping and fractional slide widths need a visual-page
  // check instead of requiring an exact pixel offset.
  return !slider || (slider.clientWidth > 0 &&
    Math.round(slider.scrollLeft / slider.clientWidth) === index);
}


function isEitherSalesTabActive() {
  return isSalesTabActive(2) || isSalesTabActive(3);
}


function cancelSalesPerformanceLookup() {
  if (!state.isSalesLoading) return;
  state.salesLookupSequence += 1;
  state.salesAbortController?.abort();
  state.isSalesLoading = false;
  state.salesRefreshAllInFlight = false;
  renderSalesQuantity();
}


function cancelProductActivityLookup() {
  if (!state.isProductActivityLoading) return;
  state.productActivityLookupSequence += 1;
  state.productActivityAbortController?.abort();
  state.isProductActivityLoading = false;
  state.productActivityRefreshAllInFlight = false;
  renderProductActivity();
}


function syncSalesPerformanceRequests(options = {}) {
  const code = getDisplayedGoodsCode();
  if (code !== state.salesBarcode) {
    clearSalesData();
    state.salesBarcode = code;
    renderSalesQuantity();
  }
  // Keep failures visible on tab re-entry; only Apply or explicit Refresh retries.
  if (options.refresh && state.productInfoSlideIndex === 2 && !state.salesError) {
    state.hasSalesResult = false;
    state.salesError = false;
    state.salesQuantityTotal = null;
  }
  if (options.refresh && state.productInfoSlideIndex === 3 && !state.productActivityError) {
    state.productActivityTotals = null;
    state.productActivityError = "";
  }
  const salesActive = isSalesTabActive(2);
  const activityActive = isSalesTabActive(3);
  const eitherActive = salesActive || activityActive;
  if (!code || (!salesActive && !(state.salesRefreshAllInFlight && eitherActive))) {
    cancelSalesPerformanceLookup();
  }
  if (!code || (!activityActive && !(state.productActivityRefreshAllInFlight && eitherActive))) {
    cancelProductActivityLookup();
  }
  if (!code) return;
  if (salesActive && !state.isSalesLoading && !state.hasSalesResult && !state.salesError) {
    return startSalesPerformanceLookup(code);
  }
  if (activityActive) return startProductActivityLookup();
}


function refreshSalesPerformanceAfterLogin(cookie) {
  const code = getDisplayedGoodsCode();
  if (!cookie || !code || !isEitherSalesTabActive()) return;
  if (code !== state.salesBarcode) {
    clearSalesData();
    state.salesBarcode = code;
  }
  // The explicit refresh replaces all three saved results, including the
  // result for the other sales tab. Normal tab changes still use the cache.
  return Promise.all([
    startSalesPerformanceLookup(code, { force: true, cookie }),
    startProductActivityLookup({ force: true, cookie })
  ]);
}


function setSalesProduct() {
  // Product rendering has already updated tab 1's Goods Code.
  return syncSalesPerformanceRequests();
}


async function fetchSalesPerformance(code, cookie, options) {
  const beginDate = formatSalesDateForRequest(options.beginDate);
  const endDate = formatSalesEndDateForRequest(options.endDate);
  const proxyEndpoint = String(CONFIG.salesPerformanceProxyEndpoint || "").trim();

  if (!proxyEndpoint) {
    throw new Error("Sales performance Cloudflare Worker endpoint is not configured.");
  }

  const response = await fetch(proxyEndpoint, {
    method: "POST",
    signal: options.signal,
    body: JSON.stringify({
      goodsCode: code,
      barcode: code,
      cookie: cookie,
      type: options.type,
      beginDate: beginDate,
      endDate: endDate
    }),
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Sales request failed with status ${response.status}`);
  }
  const responseType = response.headers.get("X-Activity-Type");
  const responseSource = response.headers.get("X-Activity-Source");
  const expectedSource = options.type === "inventory"
    ? "/stock/findGoodsAnalyze" : "/sellAccountCode/findGoodsAnalyze";
  if ((responseType && responseType !== options.type) ||
      (responseSource && responseSource !== expectedSource)) {
    throw new Error("Activity request returned the wrong source. Deploy the updated salesperformance Worker.");
  }
  // The original sales-only Worker ignores type and can return sales rows
  // for an inventory request. Require the stock source before counting inserts.
  if (options.type === "inventory" &&
      (responseType !== "inventory" || responseSource !== expectedSource)) {
    throw new Error("Insert source could not be verified. Deploy the updated salesperformance Worker for stock data.");
  }
  return response.text();
}


async function loadSalesPerformanceRows(code, options = {}) {
  // Snapshot the period before awaiting the session or activity response.
  const requestOptions = {
    type: "sales",
    beginDate: state.salesBeginDate,
    endDate: state.salesEndDate,
    ...options
  };
  // Activity requests use only the current session. A failed or missing
  // session waits for the user's explicit Refresh instead of logging in here.
  const cookie = requestOptions.cookie || state.authCookie;
  if (!cookie) throw new Error("No login cookie. Press Refresh to log in.");
  const activeTabs = Array.isArray(requestOptions.activeTab)
    ? requestOptions.activeTab : [requestOptions.activeTab];
  if (requestOptions.signal?.aborted || (requestOptions.activeTab !== undefined &&
      (!activeTabs.some(isSalesTabActive) || getDisplayedGoodsCode() !== code))) {
    throw new Error("Activity tab is no longer active for this barcode.");
  }
  const responseText = await fetchSalesPerformance(code, cookie, requestOptions);
  let parsed;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    throw new Error("Activity response was not valid JSON. Refresh your login and retry.");
  }
  const rows = extractSalesRows(parsed);
  if (requestOptions.type === "inventory" && rows.some(function (row) {
    return String(row?.invoicesType || "").trim() === "结算记录";
  })) {
    throw new Error("Insert request returned sales records. Deploy the updated salesperformance Worker.");
  }
  return rows;
}


function startSalesPerformanceLookup(barcode, lookupOptions = {}) {
  const code = String(barcode || "").trim();
  if (!code || code !== getDisplayedGoodsCode() ||
      !(lookupOptions.force ? isEitherSalesTabActive() : isSalesTabActive(2))) return;
  const params = salesRequestParams(code, "sales", state.salesBeginDate, state.salesEndDate);
  const lookupSequence = state.salesLookupSequence + 1;
  state.salesLookupSequence = lookupSequence;
  state.salesBarcode = code;
  state.salesRows = [];
  state.salesQuantityTotal = null;
  state.salesAbortController?.abort();
  state.salesRefreshAllInFlight = false;
  state.hasSalesResult = false;
  state.salesError = false;
  const cachedTotal = lookupOptions.force ? null : readSalesRequestCache("custom", params);
  if (cachedTotal !== null) {
    state.salesQuantityTotal = cachedTotal;
    state.hasSalesResult = true;
    state.isSalesLoading = false;
    renderSalesQuantity();
    return;
  }
  saveSalesRequestCache("custom", params, null);
  state.salesAbortController = new AbortController();
  state.isSalesLoading = true;
  state.salesRefreshAllInFlight = Boolean(lookupOptions.force);
  renderSalesQuantity();

  return loadSalesPerformanceRows(code, {
    signal: state.salesAbortController.signal,
    activeTab: lookupOptions.force ? [2, 3] : 2,
    cookie: lookupOptions.cookie
  })
    .then(function (rows) {
      if (lookupSequence !== state.salesLookupSequence) {
        return;
      }
      state.salesRows = rows;
      state.salesQuantityTotal = sumSalesQuantity(rows);
      saveSalesRequestCache("custom", params, state.salesQuantityTotal);
      state.hasSalesResult = true;
      state.isSalesLoading = false;
      state.salesRefreshAllInFlight = false;
      renderSalesQuantity();
    })
    .catch(function () {
      if (lookupSequence !== state.salesLookupSequence) {
        return;
      }
      state.salesRows = [];
      state.isSalesLoading = false;
      state.salesRefreshAllInFlight = false;
      state.salesError = true;
      renderSalesQuantity();
    });
}


function openSalesPeriodDialog() {
  state.els.salesPeriodStartInput.value = state.salesBeginDate;
  state.els.salesPeriodEndInput.value = state.salesEndDate;
  state.els.salesPeriodStatus.textContent = "";
  state.els.salesPeriodDialog.classList.add("is-open");
  state.els.salesPeriodDialog.setAttribute("aria-hidden", "false");
}


function closeSalesPeriodDialog() {
  state.els.salesPeriodDialog.classList.remove("is-open");
  state.els.salesPeriodDialog.setAttribute("aria-hidden", "true");
}


function getSalesQuickPeriod(preset, today = new Date()) {
  const year = today.getFullYear();
  const month = today.getMonth();
  let start;
  const end = today;
  if (preset === "this-month") {
    start = new Date(year, month, 1);
  } else if (preset === "last-3-months") {
    start = new Date(year, month - 2, 1);
  } else if (preset === "this-year") {
    start = new Date(year, 0, 1);
  } else {
    return null;
  }
  const localDate = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return { beginDate: localDate(start), endDate: localDate(end) };
}


function applySalesPeriod(beginDate, endDate) {
  const nextBeginDate = String(beginDate || "").trim();
  const nextEndDate = String(endDate || "").trim();

  if (nextBeginDate && nextEndDate) {
    const begin = parseSalesDate(nextBeginDate);
    const end = parseSalesDate(nextEndDate);
    if (begin && end && begin > end) {
      state.els.salesPeriodStatus.textContent = "Start must be before end.";
      return false;
    }
  }

  state.salesBeginDate = nextBeginDate;
  state.salesEndDate = nextEndDate;
  cancelSalesPerformanceLookup();
  state.hasSalesResult = false;
  state.salesError = false;
  state.salesQuantityTotal = null;
  renderSalesQuantity();
  syncSalesPerformanceRequests();
  return true;
}


function isUnapprovedInventoryRow(row) {
  // billStatusDesc describes the current state. The other status strings
  // label actions (approve/unapprove) and can show the opposite state.
  const status = String(row?.billStatusDesc || "").replace(/<[^>]*>/g, "").trim();
  if (status.includes("未审核")) return true;
  if (status.includes("已审核")) return false;
  // The ERP also represents unapproved stock entries with bill_status 1.
  return String(row?.bill_status ?? "").trim() === "1";
}


function sumActivityPeriods(rows, today) {
  const end = parseSalesDate(today, true);
  return [1, 7, 30, 90].map(function (days) {
    const begin = parseSalesDate(today);
    begin.setDate(begin.getDate() - (days - 1));
    return rows.reduce(function (total, row) {
      const date = parseSalesDate(row?.operatortime);
      return date && date >= begin && date <= end ? total + getSalesRowQuantity(row) : total;
    }, 0);
  });
}


function renderProductActivity() {
  const slide = state.els?.productActivitySlide;
  if (!slide) return;
  slide.setAttribute("aria-busy", state.isProductActivityLoading ? "true" : "false");
  state.els.productActivityLoader.hidden = !state.isProductActivityLoading;
  const status = state.els.productActivityStatus;
  status.textContent = state.productActivityError;
  status.hidden = !state.productActivityError;
  state.els.productActivityRetryBtn.hidden = !state.productActivityError;
  slide.querySelectorAll("[data-activity-type]").forEach(function (element) {
    const totals = state.productActivityTotals?.[element.dataset.activityType];
    element.textContent = totals ? formatSalesQuantity(totals[Number(element.dataset.periodIndex)]) : "—";
  });
}


function startProductActivityLookup(lookupOptions = {}) {
  const code = state.salesBarcode;
  const today = getSalesPeriodDate(0);
  if (!(lookupOptions.force ? isEitherSalesTabActive() : isSalesTabActive(3)) ||
      !code || code !== getDisplayedGoodsCode() ||
      (state.isProductActivityLoading && !lookupOptions.force) ||
      (state.productActivityError && !lookupOptions.retry && !lookupOptions.force) ||
      (state.productActivityTotals && state.productActivityDate === today && !lookupOptions.force)) return;
  const beginDate = getSalesPeriodDate(89);
  const salesParams = salesRequestParams(code, "sales", beginDate, today);
  const inventoryParams = salesRequestParams(code, "inventory", beginDate, today);
  const cachedSales = lookupOptions.force ? null : readSalesRequestCache("summarySales", salesParams);
  const cachedInventory = lookupOptions.force ? null : readSalesRequestCache("summaryInventory", inventoryParams);
  const sequence = ++state.productActivityLookupSequence;
  state.productActivityAbortController?.abort();
  state.productActivityRefreshAllInFlight = false;
  state.productActivityError = "";
  if (cachedSales && cachedInventory) {
    state.productActivityTotals = { sales: cachedSales, inventory: cachedInventory };
    state.productActivityDate = today;
    state.isProductActivityLoading = false;
    renderProductActivity();
    return;
  }
  if (!cachedSales) saveSalesRequestCache("summarySales", salesParams, null);
  if (!cachedInventory) saveSalesRequestCache("summaryInventory", inventoryParams, null);
  const controller = new AbortController();
  state.productActivityAbortController = controller;
  state.isProductActivityLoading = true;
  state.productActivityRefreshAllInFlight = Boolean(lookupOptions.force);
  state.productActivityTotals = null;
  renderProductActivity();
  const options = {
    beginDate, endDate: today, signal: controller.signal,
    activeTab: lookupOptions.force ? [2, 3] : 3,
    cookie: lookupOptions.cookie
  };
  return Promise.all([
    cachedSales ? Promise.resolve(cachedSales) :
      loadSalesPerformanceRows(code, { ...options, type: "sales" }).then(function (rows) {
        const totals = sumActivityPeriods(rows, today);
        if (sequence === state.productActivityLookupSequence && !controller.signal.aborted) {
          saveSalesRequestCache("summarySales", salesParams, totals);
        }
        return totals;
      }),
    cachedInventory ? Promise.resolve(cachedInventory) :
      loadSalesPerformanceRows(code, { ...options, type: "inventory" }).then(function (rows) {
        const totals = sumActivityPeriods(rows.filter(function (row) {
          return !isUnapprovedInventoryRow(row);
        }), today);
        if (sequence === state.productActivityLookupSequence && !controller.signal.aborted) {
          saveSalesRequestCache("summaryInventory", inventoryParams, totals);
        }
        return totals;
      })
  ]).then(function ([sales, inventory]) {
    if (sequence !== state.productActivityLookupSequence) return;
    state.productActivityTotals = { sales, inventory };
    state.productActivityDate = today;
  }).catch(function (error) {
    if (sequence !== state.productActivityLookupSequence) return;
    controller.abort();
    state.productActivityError = error.message || "Could not load sales and inventory. Try again.";
  }).finally(function () {
    if (sequence !== state.productActivityLookupSequence) return;
    state.isProductActivityLoading = false;
    state.productActivityRefreshAllInFlight = false;
    renderProductActivity();
  });
}
