"use strict";

/* Closest-match product search */

async function fetchClosestSearchResults(barcode) {
  const code = String(barcode || "").trim();
  if (!code) {
    throw new Error("Barcode is empty");
  }

  // The closest-search Worker can use its own ERP_COOKIE when the browser
  // has no saved session. An unavailable login must not block that fallback.
  let cookie = "";
  try {
    cookie = await getCookieForRequests();
  } catch {
    // Leave cookie empty so the Worker can use its configured ERP session.
  }
  const response = await apiFetch(CONFIG.closestSearchProxyEndpoint, {
    method: "POST",
    body: JSON.stringify({
      supplierId: -1,
      symbol: "combination",
      contain: "bh",
      content: code,
      page: 1,
      rows: 5,
      cookie: cookie
    }),
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json"
    }
  }, { trackLoader: false });

  if (!response.ok) {
    throw new Error(`Closest search request failed with status ${response.status}`);
  }

  const responseText = await response.text();
  let parsedResponse;
  try {
    parsedResponse = JSON.parse(responseText);
  } catch {
    throw new Error("Closest search response was not valid JSON.");
  }

  const results = collectClosestSearchResults(parsedResponse);
  if (results.length === 0) {
    throw new Error("No similar products found");
  }

  return results;
}


async function handleClosestSearchLookup() {
  const code = String(state.els.barcodeInput.value || "").trim();
  if (!code) {
    setStatus("Type a barcode first");
    return;
  }

  state.els.barcodeInput.value = code;
  state.isClosestSearchLoading = true;
  state.closestSearchCode = code;
  state.closestSearchPendingHistoryId = "";
  state.closestSearchResults = [];
  state.els.closestSearchBackBtn.disabled = true;
  state.els.closestSearchTitle.textContent = "Closest Matches";
  state.els.closestSearchStatus.textContent = `Searching matches for ${code}...`;
  renderClosestSearchResults();
  lockPageScroll();
  state.els.closestSearchDialog.classList.add("is-open");
  state.els.closestSearchDialog.setAttribute("aria-hidden", "false");

  try {
    const closestMatches = await fetchClosestSearchResults(code);
    openClosestSearchDialog(code, closestMatches, "");
    setStatus("Select one of the closest matches.");
  } catch (error) {
    state.isClosestSearchLoading = false;
    state.els.closestSearchBackBtn.disabled = false;
    state.closestSearchResults = [];
    state.els.closestSearchStatus.textContent = error?.message || "No similar products found.";
    renderClosestSearchResults();
    setStatus(error?.message || "No similar products found.");
  }
}


function normalizeClosestSearchResult(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  const barcode = String(
    item.bh ||
    item.goods_bh ||
    item.goodsBh ||
    item.goods_code ||
    item.goodsCode ||
    item.bar_code ||
    item.barCode ||
    item.barcode ||
    item.code ||
    item.ean ||
    item.ean13 ||
    item.upc ||
    item.upcA ||
    item.upc_a ||
    item.content ||
    ""
  ).trim();
  const italianName = String(
    item.italian_name ||
    item.italianName ||
    item.goods_name ||
    item.name ||
    ""
  ).trim();
  const goodsId = String(item.id || item.goods_id || item.goodsId || "").trim();
  const pPrice = String(item.p_price || item.pPrice || item.purchase_price || item.buying_price || item.cost || "").trim();
  const sPrice = String(item.s_price || item.sPrice || item.sale_price || item.price || "").trim();

  if (!barcode) {
    return null;
  }

  return {
    goods_id: goodsId,
    barcode: barcode,
    italian_name: italianName,
    p_price: pPrice,
    s_price: sPrice
  };
}


function collectClosestSearchResults(rawData) {
  const queue = [rawData];
  const results = [];
  const seen = new Set();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        queue.push(current[index]);
      }
      continue;
    }

    if (typeof current !== "object") {
      continue;
    }

    const normalizedResult = normalizeClosestSearchResult(current);
    if (normalizedResult) {
      const key = `${normalizedResult.barcode}|${normalizedResult.goods_id}|${normalizedResult.italian_name}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push(normalizedResult);
      }
    }

    const values = Object.values(current);
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      if (value && typeof value === "object") {
        queue.push(value);
      }
    }
  }

  return results.slice(0, 25);
}


function renderClosestSearchResults() {
  if (state.els.closestSearchProgress) {
    state.els.closestSearchProgress.hidden = !state.isClosestSearchLoading;
  }
  if (!state.els.closestSearchList) {
    return;
  }

  if (state.closestSearchResults.length === 0) {
    const emptyMessage = document.createElement("p");
    emptyMessage.className = "history-empty";
    if (state.isClosestSearchLoading) {
      emptyMessage.textContent = "Searching for similar products...";
    } else {
      emptyMessage.textContent = "No similar products found.";
    }
    state.els.closestSearchList.replaceChildren(emptyMessage);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (let index = 0; index < state.closestSearchResults.length; index += 1) {
    const item = state.closestSearchResults[index];
    const article = document.createElement("article");
    article.className = "closest-search-item";

    const info = document.createElement("div");
    info.className = "closest-search-info";

    const nameLine = document.createElement("div");
    nameLine.className = "closest-search-name";
    nameLine.textContent = item.italian_name || item.barcode || "Unnamed product";
    nameLine.title = item.italian_name || item.barcode || "";

    const metaLine = document.createElement("div");
    metaLine.className = "closest-search-meta";
    metaLine.innerHTML =
      `<span class="closest-search-barcode">${escapeHtml(item.barcode)}</span>` +
      `<span>Cost: ${escapeHtml(formatPrice(item.p_price) || "-")}</span>` +
      `<span>Price: ${escapeHtml(formatPrice(item.s_price) || "-")}</span>`;

    const selectButton = document.createElement("button");
    selectButton.className = "btn btn-muted history-detail-btn closest-search-select-btn";
    selectButton.type = "button";
    selectButton.textContent = "Select";
    selectButton.dataset.action = "select-closest";
    selectButton.dataset.index = String(index);
    selectButton.disabled = state.isClosestSearchLoading;

    info.appendChild(nameLine);
    info.appendChild(metaLine);
    article.appendChild(info);
    article.appendChild(selectButton);
    fragment.appendChild(article);
  }

  state.els.closestSearchList.replaceChildren(fragment);
}


function openClosestSearchDialog(barcode, results, pendingHistoryId) {
  state.closestSearchCode = String(barcode || "").trim();
  state.closestSearchResults = Array.isArray(results) ? results.slice() : [];
  state.closestSearchPendingHistoryId = String(pendingHistoryId || "").trim();
  state.isClosestSearchLoading = false;
  state.els.closestSearchBackBtn.disabled = false;
  state.els.closestSearchTitle.textContent = `Closest Matches`;
  state.els.closestSearchStatus.textContent = "";
  renderClosestSearchResults();
  lockPageScroll();
  state.els.closestSearchDialog.classList.add("is-open");
  state.els.closestSearchDialog.setAttribute("aria-hidden", "false");
}


function openClosestSearchLoadingDialog(barcode, pendingHistoryId) {
  state.closestSearchCode = String(barcode || "").trim();
  state.closestSearchResults = [];
  state.closestSearchPendingHistoryId = String(pendingHistoryId || "").trim();
  state.isClosestSearchLoading = true;
  state.els.closestSearchBackBtn.disabled = true;
  state.els.closestSearchTitle.textContent = "Closest Matches";
  state.els.closestSearchStatus.textContent = state.closestSearchCode
    ? `Searching closest matches for ${state.closestSearchCode}...`
    : "Searching closest matches...";
  renderClosestSearchResults();
  lockPageScroll();
  state.els.closestSearchDialog.classList.add("is-open");
  state.els.closestSearchDialog.setAttribute("aria-hidden", "false");
}


function closeClosestSearchDialog() {
  state.closestSearchResults = [];
  state.closestSearchCode = "";
  state.closestSearchPendingHistoryId = "";
  state.isClosestSearchLoading = false;
  state.els.closestSearchBackBtn.disabled = false;
  state.els.closestSearchStatus.textContent = "";
  if (state.els.closestSearchProgress) {
    state.els.closestSearchProgress.hidden = true;
  }
  state.els.closestSearchDialog.classList.remove("is-open");
  state.els.closestSearchDialog.setAttribute("aria-hidden", "true");
  window.setTimeout(function () {
    unlockPageScroll();
  }, 60);
}


async function handleClosestSearchSelection(index) {
  if (index < 0 || index >= state.closestSearchResults.length || state.isClosestSearchLoading) {
    return;
  }

  const selectedItem = state.closestSearchResults[index];
  const barcode = String(selectedItem?.barcode || "").trim();
  if (!barcode) {
    return;
  }

  if (state.isQuantityEntryUnlocked) {
    state.els.barcodeInput.value = barcode;
    clearResultFields();
    closeClosestSearchDialog();
    setStatus(`Selected ${barcode}. Tap Enter / Add to send request.`);
    moveFocusToInput(state.els.quantityInput);
    selectEntireInputValue({ target: state.els.quantityInput });
    return;
  }

  state.isClosestSearchLoading = true;
  state.els.closestSearchBackBtn.disabled = true;
  state.els.closestSearchStatus.textContent = `Loading ${barcode}...`;
  renderClosestSearchResults();
  const pendingComparisonQty = state.closestSearchPendingHistoryId
    ? state.history.find((item) => item.id === state.closestSearchPendingHistoryId)?.comparison_qty || 1
    : 1;
  clearSalesData();

  try {
    // Product data is the critical response: render it as soon as it arrives.
    // Discount is best-effort and is applied in a follow-up request below.
    const selectedData = await loadProductInfoResponse(barcode);
    state.els.barcodeInput.value = barcode;
    clearResultFields();
    renderProductData({
      product: selectedData.raw?.product || selectedData.raw,
      sale: null
    });
    if (state.currentProductRecord) {
      state.currentProductRecord.comparison_qty = pendingComparisonQty;
      if (state.closestSearchPendingHistoryId) {
        updateHistoryItem(state.closestSearchPendingHistoryId, state.currentProductRecord);
      } else if (!state.isQuantityEntryUnlocked) {
        addHistoryRecord(state.currentProductRecord, barcode, pendingComparisonQty);
      } else {
        state.els.quantityInput.value = sanitizeEditableQuantity(state.els.quantityInput.value);
      }
      // Sync product details to every history row with this barcode.
      syncHistoryRowsWithRecord(state.currentProductRecord, barcode);
    }

    // Do not hold the selection dialog (or product UI) open for discount data.
    fetchDiscountInfoThroughProxy(barcode, selectedData.cookie)
      .then(function (discountResponseText) {
        let parsedDiscount = null;
        try {
          parsedDiscount = discountResponseText ? JSON.parse(discountResponseText) : null;
        } catch {
          parsedDiscount = null;
        }

        const updatedRecord = buildHistoryItemFromLookupData(
          selectedData.raw?.product || selectedData.raw,
          parsedDiscount,
          barcode,
          pendingComparisonQty
        );
        syncHistoryRowsWithRecord(updatedRecord, barcode);

        if (String(state.els.barcodeInput.value || "").trim() === barcode) {
          renderProductData({
            product: selectedData.raw?.product || selectedData.raw,
            sale: parsedDiscount
          });
        }
      })
      .catch(function () {
        // Product data is already visible; discount is optional.
      });

    closeClosestSearchDialog();
    setStatus(`Selected ${barcode}`);
    if (state.isQuantityEntryUnlocked) {
      moveFocusToInput(state.els.quantityInput);
      selectEntireInputValue({ target: state.els.quantityInput });
    }
  } catch (error) {
    state.els.closestSearchStatus.textContent = error.message || "Could not load selected product.";
    state.isClosestSearchLoading = false;
    state.els.closestSearchBackBtn.disabled = false;
    renderClosestSearchResults();
    throw error;
  }
}
