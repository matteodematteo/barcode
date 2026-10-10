"use strict";

/* Barcode history list and editing */

// Max items rendered synchronously during init. The rest are deferred to
// idle time so a large list doesn't block first paint.
var HISTORY_INITIAL_BATCH = 25;
let historyRenderGeneration = 0;

// Build a single history <article> DOM node for the given item/index.
function buildHistoryArticle(item, index) {
  const article = document.createElement("article");
  article.className = "history-item";
  if (index === state.selectedHistoryIndex) {
    article.classList.add("is-selected");
  }
  const primary = document.createElement("div");
  primary.className = "history-primary";
  primary.innerHTML = `<span class="history-code">${escapeHtml(item.barcode || "")}</span><span class="history-qty">Qty ${escapeHtml(String(item.comparison_qty || 1))}</span>`;

  const name = document.createElement("div");
  name.className = "history-name";
  name.textContent = item.italian_name || "No name loaded";

  const meta = document.createElement("div");
  meta.className = "history-meta";
  const priceClass = isHistoryPriceDiscounted(item) ? "history-price is-discount" : "history-price";
  meta.innerHTML = `<span class="history-cost">Cost: ${escapeHtml(formatPrice(item.p_price) || "-")}</span><span>Price: <span class="${priceClass}">${escapeHtml(getHistoryDisplayPrice(item))}</span></span><span class="history-supplier">Supplier: ${escapeHtml(item.supplier_name || "-")}</span>`;

  const footer = document.createElement("div");
  footer.className = "history-footer";
  footer.appendChild(meta);

  const detailButton = document.createElement("button");
  detailButton.className = "btn btn-muted history-detail-btn";
  detailButton.type = "button";
  detailButton.textContent = "Detail";
  detailButton.dataset.action = "detail";
  detailButton.dataset.index = String(index);
  footer.appendChild(detailButton);

  article.appendChild(primary);
  article.appendChild(name);
  article.appendChild(footer);
  article.dataset.index = String(index);
  article.setAttribute("tabindex", "0");
  return article;
}

function renderHistory() {
  const generation = ++historyRenderGeneration;
  if (typeof syncSalesPerformanceRequests === "function") syncSalesPerformanceRequests();
  state.els.clearAllBtn.disabled = state.history.length === 0;
  state.els.sendTxtBtn.disabled = state.history.length === 0;
  state.els.printBtn.disabled = state.history.length === 0 && state.printRequests.length === 0;
  if (state.els.historyCountBadge) {
    const countText = `Count: ${state.history.length}`;
    state.els.historyCountBadge.textContent = countText;
    state.els.historyCountBadge.setAttribute("aria-label", countText);
  }
  if (state.history.length === 0) {
    state.selectedHistoryIndex = -1;
    state.els.clearSelectedBtn.disabled = true;
    state.els.historyList.replaceChildren(state.els.historyEmpty);
    return;
  }

  // Render the first batch synchronously so the user sees items immediately.
  const initialCount = Math.min(state.history.length, HISTORY_INITIAL_BATCH);
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < initialCount; index += 1) {
    fragment.appendChild(buildHistoryArticle(state.history[index], index));
  }

  state.els.clearSelectedBtn.disabled = state.selectedHistoryIndex < 0;
  state.els.historyList.replaceChildren(fragment);

  // Append remaining items in idle time — avoids blocking paint on large lists.
  if (state.history.length > initialCount) {
    let nextIndex = initialCount;
    const appendBatch = function () {
      if (generation !== historyRenderGeneration) return;
      if (state.capturePageOpen) {
        window.setTimeout(function () { scheduleIdleWork(appendBatch, 200); }, 250);
        return;
      }
      // Bound every batch, including browsers without requestIdleCallback.
      // A large saved list must leave time for input and the first camera frame.
      const started = performance.now();
      const end = Math.min(nextIndex + HISTORY_INITIAL_BATCH, state.history.length);
      const remaining = document.createDocumentFragment();
      while (nextIndex < end) {
        remaining.appendChild(buildHistoryArticle(state.history[nextIndex], nextIndex));
        nextIndex += 1;
        if (performance.now() - started >= 4) break;
      }
      state.els.historyList.appendChild(remaining);
      if (nextIndex < state.history.length) scheduleIdleWork(appendBatch, 200);
    };
    scheduleIdleWork(appendBatch, 200);
  }
}


function setHistoryDetailsVisible(visible) {
  state.showHistoryDetails = Boolean(visible);
  document.body.classList.toggle("show-history-details", state.showHistoryDetails);
  const toggle = state.els.historyDetailsSwitch;
  toggle.setAttribute("aria-checked", String(state.showHistoryDetails));
  toggle.setAttribute("aria-label", state.showHistoryDetails
    ? "Hide cost and supplier in history"
    : "Show cost and supplier in history");
  toggle.title = toggle.getAttribute("aria-label");
  toggle.classList.toggle("btn-primary", state.showHistoryDetails);
  toggle.classList.toggle("btn-muted", !state.showHistoryDetails);
}


function saveHistoryState() {
  localStorage.setItem(CONFIG.historyStorageKey, JSON.stringify(state.history));
}


function loadHistoryState() {
  try {
    const raw = localStorage.getItem(CONFIG.historyStorageKey);
    const parsed = raw ? JSON.parse(raw) : [];
    state.history = Array.isArray(parsed)
      ? parsed
          .map(normalizeHistoryItem)
          .filter((item) => item.barcode)
      : [];
  } catch {
    state.history = [];
  }
}


function normalizeHistoryItem(item) {
  if (typeof item === "string") {
    return {
      id: `history_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      goods_id: "",
      barcode: item.trim(),
      italian_name: "",
      comparison_qty: 1,
      supplier_name: "",
      p_price: "",
      s_price: "",
      s_discount: "",
      discount_price: "",
      has_discount: false
    };
  }

  const barcode = String(item?.barcode || "").trim();
  const rawDiscount = numberFromValue(String(item?.s_discount ?? "").replace(",", ".").replace("%", ""));
  const normalizedDiscount = normalizeSaleDiscountPercent(rawDiscount);
  const sPrice = numberFromValue(item?.s_price);
  let discountPrice = String(item?.discount_price || "");
  if (rawDiscount > 0 && rawDiscount < 1 && sPrice > 0) {
    const stalePrice = sPrice * (1 - rawDiscount / 100);
    if (!discountPrice || Math.abs(numberFromValue(discountPrice) - stalePrice) < 0.011) {
      discountPrice = calculateDiscountPrice(sPrice, normalizedDiscount);
    }
  }
  return {
    id: String(item?.id || `history_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`),
    goods_id: String(item?.goods_id || item?.id_value || ""),
    barcode: barcode,
    italian_name: String(item?.italian_name || ""),
    comparison_qty: Math.max(1, Number(item?.comparison_qty || 1) || 1),
    supplier_name: String(item?.supplier_name || ""),
    p_price: String(item?.p_price || ""),
    s_price: String(item?.s_price || ""),
    s_discount: rawDiscount > 0 && rawDiscount < 1 ? String(normalizedDiscount) : String(item?.s_discount || ""),
    discount_price: discountPrice,
    has_discount: Boolean(item?.has_discount) || normalizedDiscount > 0
  };
}


function createHistoryEntry(barcode, comparisonQty) {
  return normalizeHistoryItem({
    id: `history_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    barcode: barcode,
    comparison_qty: comparisonQty
  });
}


function addHistoryItem(barcode, comparisonQty) {
  const entry = createHistoryEntry(barcode, comparisonQty);
  if (!entry.barcode) return null;
  state.history.unshift(entry);
  state.selectedHistoryIndex = 0;
  saveHistoryState();
  renderHistory();
  return entry.id;
}


function addHistoryRecord(record, fallbackBarcode, comparisonQty) {
  const entry = normalizeHistoryItem({
    ...record,
    barcode: String(record?.barcode || fallbackBarcode || "").trim(),
    comparison_qty: comparisonQty ?? record?.comparison_qty
  });
  if (!entry.barcode) {
    return "";
  }

  state.history.unshift(entry);
  state.selectedHistoryIndex = 0;
  saveHistoryState();
  renderHistory();
  return entry.id;
}


function createNoExactMatchError() {
  const error = new Error("No exact product match found.");
  error.code = "NO_EXACT_MATCH";
  return error;
}


function updateHistoryItem(entryId, updates) {
  const index = state.history.findIndex((item) => item.id === entryId);
  if (index < 0) return;
  state.history[index] = normalizeHistoryItem({
    ...state.history[index],
    ...updates
  });
  saveHistoryState();
  renderHistory();
}


function updateHistoryItemsByBarcode(barcode, updates) {
  const normalizedBarcode = String(barcode || "").trim();
  if (!normalizedBarcode) return;

  let didChange = false;
  state.history = state.history.map(function (item) {
    if (String(item.barcode || "").trim() !== normalizedBarcode) {
      return item;
    }
    const nextItem = normalizeHistoryItem({
      ...item,
      ...updates,
      barcode: normalizedBarcode
    });
    const changed =
      nextItem.goods_id !== item.goods_id ||
      nextItem.barcode !== item.barcode ||
      nextItem.italian_name !== item.italian_name ||
      nextItem.supplier_name !== item.supplier_name ||
      nextItem.comparison_qty !== item.comparison_qty ||
      nextItem.p_price !== item.p_price ||
      nextItem.s_price !== item.s_price ||
      nextItem.s_discount !== item.s_discount ||
      nextItem.discount_price !== item.discount_price ||
      nextItem.has_discount !== item.has_discount;
    if (changed) {
      didChange = true;
      return nextItem;
    }
    return item;
  });

  if (!didChange) return;
  saveHistoryState();
  renderHistory();
}


function buildSharedHistoryFields(item) {
  const normalized = normalizeHistoryItem(item);
  return {
    goods_id: normalized.goods_id,
    barcode: normalized.barcode,
    italian_name: normalized.italian_name,
    supplier_name: normalized.supplier_name,
    p_price: normalized.p_price,
    s_price: normalized.s_price,
    s_discount: normalized.s_discount,
    discount_price: normalized.discount_price,
    has_discount: normalized.has_discount
  };
}


function syncHistoryRowsWithRecord(record, fallbackBarcode) {
  const sharedFields = buildSharedHistoryFields(record);
  const barcodes = [
    String(fallbackBarcode || "").trim(),
    String(sharedFields.barcode || "").trim()
  ].filter(Boolean);
  const uniqueBarcodes = [...new Set(barcodes)];

  for (let index = 0; index < uniqueBarcodes.length; index += 1) {
    updateHistoryItemsByBarcode(uniqueBarcodes[index], sharedFields);
  }
}


function buildHistoryItemFromLookupData(productPayload, discountPayload, fallbackBarcode, comparisonQty) {
  const normalizedProduct = normalizeProductData(productPayload?.product || productPayload);
  const discountFields = getLegacyDiscountFields({
    product: productPayload?.product || productPayload,
    sale: discountPayload
  }, normalizedProduct);
  const hasVisibleDiscount = discountFields.hasDiscount;

  return normalizeHistoryItem({
    goods_id: String(normalizedProduct.id || ""),
    barcode: String(normalizedProduct.goods_code || fallbackBarcode || "").trim(),
    italian_name: String(normalizedProduct.italian_name || ""),
    supplier_name: String(normalizedProduct.supplier_name || ""),
    p_price: String(normalizedProduct.p_price || ""),
    s_price: String(normalizedProduct.s_price || ""),
    s_discount: String(discountFields.saleDiscount),
    discount_price: hasVisibleDiscount ? String(discountFields.discountPrice || "") : "",
    has_discount: hasVisibleDiscount,
    comparison_qty: comparisonQty || 1
  });
}


function historyItemNeedsInfo(item) {
  return Boolean(String(item?.barcode || "").trim()) &&
    (!String(item?.italian_name || "").trim() ||
      !String(item?.p_price ?? "").trim() || !String(item?.s_price ?? "").trim());
}


async function refreshMissingHistoryInfo(cookie) {
  const codes = [...new Set(state.history.filter(historyItemNeedsInfo)
    .map((item) => String(item.barcode).trim()))];
  if (!cookie || !codes.length) return;

  setStatus(`Refreshing info for ${codes.length} history barcode${codes.length === 1 ? "" : "s"}...`);
  let nextIndex = 0;
  let refreshed = 0;
  let failed = 0;

  async function refreshNext() {
    while (nextIndex < codes.length) {
      const code = codes[nextIndex++];
      if (!state.history.some((item) => String(item.barcode || "").trim() === code && historyItemNeedsInfo(item))) {
        continue;
      }
      try {
        const { product, discountPrice, hasDiscount, saleDiscount } =
          await loadProductAndDiscountResponse(code, { cookie, retry: false });
        if (!hasProductInDatabase(product, code) || String(product.goods_code || "").trim() !== code) {
          throw new Error("No exact product info found");
        }
        let changed = false;
        state.history = state.history.map(function (item) {
          if (String(item.barcode || "").trim() !== code || !historyItemNeedsInfo(item)) return item;
          const activeDiscount = saleDiscount > 0 ? saleDiscount : numberFromValue(product.s_discount || item.s_discount);
          changed = true;
          return normalizeHistoryItem({
            ...item,
            goods_id: String(product.id || item.goods_id || ""),
            italian_name: String(product.italian_name || item.italian_name || ""),
            supplier_name: String(product.supplier_name || item.supplier_name || ""),
            p_price: String(product.p_price ?? item.p_price ?? ""),
            s_price: String(product.s_price ?? item.s_price ?? ""),
            s_discount: String(activeDiscount),
            discount_price: discountPrice || calculateDiscountPrice(product.s_price ?? item.s_price, activeDiscount),
            has_discount: hasDiscount || activeDiscount > 0
          });
        });
        if (changed) {
          saveHistoryState();
          renderHistory();
          refreshed += 1;
        }
      } catch {
        failed += 1;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(3, codes.length) }, refreshNext));
  setStatus(failed
    ? `Refreshed ${refreshed} history barcode${refreshed === 1 ? "" : "s"}; ${failed} failed.`
    : `Refreshed ${refreshed} history barcode${refreshed === 1 ? "" : "s"}.`);
}


function selectHistoryItem(index) {
  if (index < 0 || index >= state.history.length) return;
  state.selectedHistoryIndex = index;
  renderHistory();
}


function clearSelectedHistory() {
  if (state.selectedHistoryIndex < 0 || !state.history[state.selectedHistoryIndex]) return;
  state.history.splice(state.selectedHistoryIndex, 1);
  if (state.history.length === 0) {
    state.selectedHistoryIndex = -1;
  } else if (state.selectedHistoryIndex >= state.history.length) {
    state.selectedHistoryIndex = state.history.length - 1;
  }
  saveHistoryState();
  renderHistory();
  setStatus("Selected barcode removed");
}


function clearAllHistory() {
  state.history = [];
  state.selectedHistoryIndex = -1;
  saveHistoryState();
  renderHistory();
  setStatus("Barcode list cleared");
}


function fillHistoryEditForm(item) {
  const entry = normalizeHistoryItem(item);
  state.els.historyEditIdInput.value = entry.goods_id || "";
  state.els.historyEditBarcodeInput.value = entry.barcode || "";
  state.els.historyEditItalianNameInput.value = entry.italian_name || "";
  state.els.historyEditPPriceInput.value = entry.p_price || "";
  state.els.historyEditSPriceInput.value = entry.s_price || "";
  state.els.historyEditSDiscountInput.value = entry.s_discount || "";
  state.els.historyEditQtyInput.value = String(entry.comparison_qty || 1);
  refreshHistoryEditDiscountPrice();
}


function openHistoryEditDialog(item) {
  fillHistoryEditForm(item);
  clearHistoryEditFeedbackTimers();
  clearHistoryEditSaveNote();
  lockPageScroll();
  state.els.historyEditDialog.classList.add("is-open");
  state.els.historyEditDialog.setAttribute("aria-hidden", "false");
}


function closeHistoryEditDialog() {
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement && state.els.historyEditDialog.contains(activeElement)) {
    activeElement.blur();
  }
  clearHistoryEditFeedbackTimers();
  state.editingHistoryId = "";
  clearHistoryEditSaveNote();
  state.els.historyEditDialog.classList.remove("is-open");
  state.els.historyEditDialog.setAttribute("aria-hidden", "true");
  window.setTimeout(function () {
    unlockPageScroll();
  }, 60);
}


function buildHistoryPayloadItem(item) {
  const entry = normalizeHistoryItem(item);
  const sPrice = numberFromValue(entry.s_price);
  const discountPrice = numberFromValue(entry.discount_price);
  const hasDiscountPrice = entry.has_discount && discountPrice > 0 && (!sPrice || discountPrice < sPrice);
  const selectedPrice = hasDiscountPrice ? discountPrice : sPrice;

  return {
    barcode: entry.barcode,
    italian_name: entry.italian_name || "",
    comparison_qty: entry.comparison_qty || 1,
    s_price: formatPrice(selectedPrice)
  };
}


async function sendTxtList() {
  if (state.history.length === 0) {
    setStatus("Barcode list is empty");
    return;
  }

  const sentItems = state.history.map(copyPrintRequestItem);
  const payload = {
    session_id: formatSessionId(),
    session_cost: "$0.00",
    timestamp: state.els.printTimestampCheckbox.checked,
    data: [
      {
        stack: "full_tickets",
        items: sentItems.map(buildHistoryPayloadItem)
      }
    ]
  };

  setStatus("Sending TXT...");
  const response = await apiFetch(CONFIG.sendTxtEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Send TXT failed with status ${response.status}`);
  }

  const saved = recordSentPrintRequest("TXT", sentItems, payload.timestamp, "");
  state.history = [];
  state.selectedHistoryIndex = -1;
  saveHistoryState();
  renderHistory();
  setStatus(saved ? "TXT sent successfully" : "TXT sent, but recent request could not be saved on this device");
}


function buildDirectPrintPayloadItem(item) {
  const entry = normalizeHistoryItem(item);
  const sPrice = numberFromValue(entry.s_price);
  const sDiscount = normalizeSaleDiscountPercent(entry.s_discount);
  const discountPrice = Math.max(0, sPrice * (1 - sDiscount / 100));

  return {
    barcode: entry.barcode,
    italian_name: entry.italian_name || "",
    comparison_qty: entry.comparison_qty || 1,
    s_price: formatPrice(sPrice) || "0",
    s_discount: String(sDiscount),
    discount_price: formatPrice(discountPrice) || "0"
  };
}


async function runDirectPrint(printType, confirmedSignature) {
  state.els.printBigBtn.disabled = true;
  state.els.printStickerBtn.disabled = true;
  state.els.printBtn.disabled = true;
  try {
    const printed = await printHistoryList(printType, confirmedSignature);
    if (printed !== false) {
      closePrintDialog();
      moveFocusToInput(state.els.barcodeInput);
    }
  } catch (error) {
    setStatus(error.message || "Print failed");
  } finally {
    state.els.printBigBtn.disabled = state.history.length === 0;
    state.els.printStickerBtn.disabled = state.history.length === 0;
    state.els.printBtn.disabled = state.history.length === 0 && state.printRequests.length === 0;
  }
}


async function printHistoryList(printType, confirmedSignature) {
  if (state.history.length === 0) {
    setStatus("Barcode list is empty");
    return;
  }

  const tunnelId = state.els.printTunnelSelect.value;
  if (!["gate1", "gate2"].includes(tunnelId)) {
    throw new Error("Choose Gate 1 or Gate 2 before printing.");
  }
  const normalizedType = printType === "40*25" ? "40*25" : "60*38";
  const sentItems = state.history.map(copyPrintRequestItem);
  const payload = {
    session_id: `directPrint_${normalizedType}_${formatTimestamp()}`,
    session_cost: "$1.00",
    print_type: normalizedType,
    tunnel_id: tunnelId,
    timestamp: state.els.printTimestampCheckbox.checked,
    data: [
      {
        stack: normalizedType === "40*25" ? "sticker_tickets" : "big_tickets",
        items: sentItems.map(buildDirectPrintPayloadItem)
      }
    ]
  };

  const problems = [];
  sentItems.forEach(function (item, index) {
    const reasons = [];
    if (numberFromValue(item.s_price) <= 0) reasons.push("price missing or 0.00");
    if (!String(item.italian_name || "").trim()) reasons.push("name missing");
    if (reasons.length) problems.push(`Record ${index + 1} (${item.barcode || "no barcode"}): ${reasons.join(", ")}`);
  });
  // Reconfirm if the list or any print option changes while the dialog is open.
  const signature = JSON.stringify([tunnelId, normalizedType, payload.timestamp, payload.data]);
  if (problems.length && confirmedSignature !== signature) {
    closePrintDialog();
    openConfirmDialog(
      problems.join("\n") + `\n\nPrint all records to ${tunnelId} (${normalizedType}) anyway?`,
      function () { return runDirectPrint(printType, signature); }
    );
    state.els.confirmDialogCancelBtn.focus({ preventScroll: true });
    return false;
  }

  setStatus(`Sending print ${normalizedType} to ${tunnelId}...`);
  const response = await apiFetch(CONFIG.sendTxtEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const details = (await response.text()).trim();
    throw new Error(details || `Print failed with status ${response.status}`);
  }

  const saved = recordSentPrintRequest(normalizedType, sentItems, payload.timestamp, tunnelId);
  state.history = [];
  state.selectedHistoryIndex = -1;
  saveHistoryState();
  renderHistory();
  setStatus(saved ? `Print ${normalizedType} sent to ${tunnelId}` : `Print ${normalizedType} sent; recent request could not be saved on this device`);
}


function isHistoryPriceDiscounted(item) {
  const entry = normalizeHistoryItem(item);
  const sPrice = numberFromValue(entry.s_price);
  const discountPrice = numberFromValue(entry.discount_price);
  return Boolean(entry.has_discount && discountPrice > 0 && (!sPrice || discountPrice < sPrice));
}


function getHistoryDisplayPrice(item) {
  const entry = normalizeHistoryItem(item);
  const sPrice = numberFromValue(entry.s_price);
  const discountPrice = numberFromValue(entry.discount_price);
  const showDiscountPrice = entry.has_discount && discountPrice > 0 && (!sPrice || discountPrice < sPrice);
  const value = showDiscountPrice ? discountPrice : sPrice;
  return value ? `EUR ${formatPrice(value)}` : "EUR -";
}


function refreshHistoryEditDiscountPrice() {
  const discountPrice = calculateDiscountPrice(
    state.els.historyEditSPriceInput.value,
    state.els.historyEditSDiscountInput.value
  );
  state.els.historyEditDiscountPriceInput.value = discountPrice;
}


function clearHistoryEditFeedbackTimers() {
  if (state.historyEditSuccessTimer) {
    window.clearTimeout(state.historyEditSuccessTimer);
    state.historyEditSuccessTimer = 0;
  }
  if (state.historyEditCloseTimer) {
    window.clearTimeout(state.historyEditCloseTimer);
    state.historyEditCloseTimer = 0;
  }
}


function clearHistoryEditSaveNote() {
  if (!state.els?.historyEditSaveNote) {
    return;
  }

  state.els.historyEditSaveNote.classList.remove("show-success");
  state.els.historyEditSaveNote.textContent = "";
}


function showHistoryEditSuccessMessage(message) {
  if (!state.els?.historyEditSaveNote) {
    return;
  }

  clearHistoryEditFeedbackTimers();
  state.els.historyEditSaveNote.textContent = message;
  state.els.historyEditSaveNote.classList.add("show-success");
  state.historyEditSuccessTimer = window.setTimeout(function () {
    clearHistoryEditSaveNote();
  }, 1800);
}


async function openHistoryEditor(index) {
  if (index < 0 || index >= state.history.length) return;

  const item = state.history[index];
  state.editingHistoryId = item.id;
  selectHistoryItem(index);
  openHistoryEditDialog(item);
  state.els.historyEditSaveNote.textContent = "Loading latest info...";

  try {
    const { product, discountPrice, hasDiscount, saleDiscount } = await loadProductAndDiscountResponse(item.barcode);
    const updatedItem = normalizeHistoryItem({
      ...item,
      goods_id: product.id || item.goods_id,
      barcode: product.goods_code || item.barcode,
      italian_name: product.italian_name || item.italian_name,
      supplier_name: product.supplier_name || item.supplier_name,
      p_price: product.p_price || item.p_price,
      s_price: product.s_price || item.s_price,
      s_discount: String(saleDiscount),
      discount_price: discountPrice || calculateDiscountPrice(product.s_price || item.s_price, product.s_discount || item.s_discount),
      has_discount: hasDiscount || Boolean(numberFromValue(product.s_discount || item.s_discount))
    });
    syncHistoryRowsWithRecord(updatedItem, item.barcode);
    const refreshedSelectedItem =
      state.history.find((historyItem) => historyItem.id === item.id) || updatedItem;
    fillHistoryEditForm(refreshedSelectedItem);
    state.els.historyEditSaveNote.textContent = "";
    setStatus(`Latest info loaded for ${updatedItem.barcode}`);
  } catch (error) {
    state.els.historyEditSaveNote.textContent = error.message || "Could not refresh item info.";
  }
}


async function saveHistoryEditorChanges() {
  if (!state.editingHistoryId) {
    throw new Error("No barcode row selected");
  }

  const index = state.history.findIndex((item) => item.id === state.editingHistoryId);
  if (index < 0) {
    throw new Error("Selected barcode row was not found");
  }

  const currentItem = state.history[index];
  const rawPPrice = normalizeDecimalInput(state.els.historyEditPPriceInput.value);
  const normalizedSPrice = normalizeDecimalInput(state.els.historyEditSPriceInput.value);
  const normalizedSDiscount = normalizeDecimalInput(state.els.historyEditSDiscountInput.value);
  const effectiveSDiscount = normalizedSDiscount === "" ? "0" : normalizedSDiscount;
  const payload = {
    id: state.els.historyEditIdInput.value.trim(),
    barcode: state.els.historyEditBarcodeInput.value.trim(),
    italian_name: sanitizeItalianName(state.els.historyEditItalianNameInput.value),
    p_price: rawPPrice || "0",
    s_price: normalizedSPrice,
    s_discount: effectiveSDiscount
  };
  const comparisonQty = Math.max(1, Number(state.els.historyEditQtyInput.value || 1) || 1);
  const originalItalianName = state.els.historyEditItalianNameInput.value.trim();
  state.els.historyEditItalianNameInput.value = payload.italian_name;
  state.els.historyEditPPriceInput.value = rawPPrice;
  state.els.historyEditSPriceInput.value = normalizedSPrice;
  state.els.historyEditSDiscountInput.value = normalizedSDiscount;
  if (originalItalianName !== payload.italian_name) {
    showToast("Unsupported symbols removed from name");
  }

  const currentId = String(currentItem.goods_id || "").trim();
  const currentBarcode = String(currentItem.barcode || "").trim();
  const currentItalianName = String(currentItem.italian_name || "").trim();
  const currentPPrice = String(currentItem.p_price || "").trim();
  const currentSPrice = String(currentItem.s_price || "").trim();
  const currentSDiscount = String(currentItem.s_discount || "").trim();
  const currentComparisonQty = Number(currentItem.comparison_qty || 1);

  const hasSameId = String(payload.id || currentId).trim() === currentId;
  const hasSameBarcode = payload.barcode === currentBarcode;
  const hasSameItalianName = payload.italian_name === currentItalianName;
  const hasSameCostValue = rawPPrice === ""
    ? currentPPrice === "" || currentPPrice === "0"
    : payload.p_price === currentPPrice;
  const hasSameSalePrice = payload.s_price === currentSPrice;
  const hasSameSaleDiscount = payload.s_discount === (currentSDiscount === "" ? "0" : currentSDiscount);
  const hasOnlyQuantityChanged =
    hasSameId &&
    hasSameBarcode &&
    hasSameItalianName &&
    hasSameCostValue &&
    hasSameSalePrice &&
    hasSameSaleDiscount &&
    comparisonQty !== currentComparisonQty;
  const hasNoChanges =
    hasSameId &&
    hasSameBarcode &&
    hasSameItalianName &&
    hasSameCostValue &&
    hasSameSalePrice &&
    hasSameSaleDiscount &&
    comparisonQty === currentComparisonQty;

  if (hasNoChanges) {
    closeHistoryEditDialog();
    moveFocusToInput(state.els.barcodeInput);
    return;
  }

  if (hasOnlyQuantityChanged) {
    updateHistoryItem(currentItem.id, {
      comparison_qty: comparisonQty
    });
    setStatus(`Saved quantity for ${currentItem.barcode}`);
    closeHistoryEditDialog();
    moveFocusToInput(state.els.barcodeInput);
    return;
  }

  let cookie = await getCookieForRequests();
  state.els.historyEditSaveNote.textContent = originalItalianName !== payload.italian_name
    ? "Italian name cleaned before save."
    : "Checking product...";
  let updatedItem;
  let existingProduct = null;

  try {
    const latestInfo = await loadProductInfoResponse(payload.barcode);
    cookie = latestInfo.cookie;
    if (hasProductInDatabase(latestInfo.normalized, payload.barcode)) {
      existingProduct = latestInfo.normalized;
    }
  } catch (error) {
    throw new Error(`Could not load current product values. Nothing was saved. ${error.message || "Please retry."}`);
  }

  const shouldAddNewProduct = !existingProduct;

  if (shouldAddNewProduct) {
    if (!payload.italian_name || !payload.s_price) {
      throw new Error("Italian name and price are required for a new barcode.");
    }
  } else {
    payload.id = String(existingProduct.id || payload.id || currentItem.goods_id || "").trim();
    if (!payload.id) {
      throw new Error("ID is missing");
    }
  }

  if (shouldAddNewProduct) {
    state.els.historyEditSaveNote.textContent = "Adding new product...";
    try {
      const addResponseText = await fetchAddProductThroughProxy(payload, cookie);
      let addResponse = null;
      try {
        addResponse = addResponseText ? JSON.parse(addResponseText) : null;
      } catch {
        addResponse = null;
      }

      if (addResponse?.msg !== "新增商品成功！") {
        throw new Error(addResponse?.msg || "Add product failed");
      }

      const addedProduct = normalizeProductData(addResponse?.product || addResponse);
      updatedItem = normalizeHistoryItem({
        ...currentItem,
        goods_id: String(addedProduct.id || currentItem.goods_id || ""),
        barcode: String(addedProduct.goods_code || payload.barcode || currentItem.barcode || ""),
        italian_name: String(addedProduct.italian_name || payload.italian_name),
        supplier_name: String(addedProduct.supplier_name || currentItem.supplier_name || ""),
        p_price: String(addedProduct.p_price || payload.p_price),
        s_price: String(addedProduct.s_price || payload.s_price),
        s_discount: String(addedProduct.s_discount || payload.s_discount),
        discount_price: calculateDiscountPrice(addedProduct.s_price || payload.s_price, addedProduct.s_discount || payload.s_discount),
        has_discount: Boolean(numberFromValue(addedProduct.s_discount || payload.s_discount)),
        comparison_qty: comparisonQty
      });
    } catch (error) {
      showToast("Add product failed");
      error.toastShown = true;
      throw error;
    }
  } else {
    state.els.historyEditSaveNote.textContent = "Saving changes...";
    try {
      const updateResponseText = await fetchUpdateItemThroughProxy(payload, cookie, existingProduct);
      let updateResponse = null;
      try {
        updateResponse = updateResponseText ? JSON.parse(updateResponseText) : null;
      } catch {
        updateResponse = null;
      }

      if (updateResponse?.success !== true) {
        throw new Error(updateResponse?.msg || "Update product failed");
      }
    } catch (error) {
      showToast("Update product failed");
      error.toastShown = true;
      throw error;
    }
    updatedItem = normalizeHistoryItem({
      ...currentItem,
      goods_id: payload.id,
      barcode: payload.barcode || currentItem.barcode,
      italian_name: payload.italian_name,
      p_price: payload.p_price,
      s_price: payload.s_price,
      s_discount: payload.s_discount,
      discount_price: calculateDiscountPrice(payload.s_price, payload.s_discount),
      has_discount: Boolean(numberFromValue(payload.s_discount)),
      comparison_qty: comparisonQty
    });
  }

  if (shouldAddNewProduct) {
    try {
      const latestItemData = await loadProductAndDiscountResponse(updatedItem.barcode);
      updatedItem = normalizeHistoryItem({
        ...updatedItem,
        goods_id: String(latestItemData.product.id || updatedItem.goods_id || ""),
        barcode: String(latestItemData.product.goods_code || updatedItem.barcode || ""),
        italian_name: String(latestItemData.product.italian_name || updatedItem.italian_name || ""),
        supplier_name: String(latestItemData.product.supplier_name || updatedItem.supplier_name || ""),
        p_price: String(latestItemData.product.p_price || updatedItem.p_price || ""),
        s_price: String(latestItemData.product.s_price || updatedItem.s_price || ""),
        s_discount: String(latestItemData.saleDiscount),
        discount_price: latestItemData.discountPrice || calculateDiscountPrice(
          latestItemData.product.s_price || updatedItem.s_price,
          latestItemData.product.s_discount || updatedItem.s_discount
        ),
        has_discount: latestItemData.hasDiscount || Boolean(numberFromValue(latestItemData.product.s_discount || updatedItem.s_discount)),
        comparison_qty: comparisonQty
      });
    } catch {
      // Keep the saved values if the refresh-after-save request fails.
    }
  }

  updateHistoryItemsByBarcode(updatedItem.barcode, {
    goods_id: updatedItem.goods_id,
    barcode: updatedItem.barcode,
    italian_name: updatedItem.italian_name,
    supplier_name: updatedItem.supplier_name,
    p_price: updatedItem.p_price,
    s_price: updatedItem.s_price,
    s_discount: updatedItem.s_discount,
    discount_price: updatedItem.discount_price,
    has_discount: updatedItem.has_discount
  });
  updateHistoryItem(currentItem.id, {
    goods_id: updatedItem.goods_id,
    barcode: updatedItem.barcode,
    italian_name: updatedItem.italian_name,
    p_price: updatedItem.p_price,
    s_price: updatedItem.s_price,
    s_discount: updatedItem.s_discount,
    discount_price: updatedItem.discount_price,
    has_discount: updatedItem.has_discount,
    comparison_qty: updatedItem.comparison_qty
  });
  if (state.currentProductRecord?.barcode === updatedItem.barcode) {
    state.currentProductRecord = {
      ...state.currentProductRecord,
      goods_id: updatedItem.goods_id,
      italian_name: updatedItem.italian_name,
      p_price: updatedItem.p_price,
      s_price: updatedItem.s_price,
      s_discount: updatedItem.s_discount,
      discount_price: updatedItem.discount_price,
      has_discount: updatedItem.has_discount,
      comparison_qty: updatedItem.comparison_qty
    };
    setResultField("id", updatedItem.goods_id);
    setResultField("italian_name", updatedItem.italian_name);
    setResultField("p_price", updatedItem.p_price);
    setResultField("s_price", updatedItem.s_price);
    setResultField("discount_price", updatedItem.discount_price);
    setResultField("disc_price_percent", updatedItem.s_discount ? formatPercent(updatedItem.s_discount) : "");
    setLegacyDiscountVisibility(Boolean(numberFromValue(updatedItem.discount_price)) && numberFromValue(updatedItem.discount_price) < numberFromValue(updatedItem.s_price));
  }

  setStatus(`Saved ${updatedItem.barcode}`);
  showToast("Saved successfully");
  closeHistoryEditDialog();
  moveFocusToInput(state.els.barcodeInput);
}
