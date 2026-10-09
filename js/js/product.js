"use strict";

/* Product data normalization and rendering */

function hasProductInDatabase(normalizedProduct, barcode) {
  if (!normalizedProduct || typeof normalizedProduct !== "object") {
    return false;
  }

  const goodsCode = String(normalizedProduct.goods_code || "").trim();
  const italianName = String(normalizedProduct.italian_name || "").trim();
  const pPrice = String(normalizedProduct.p_price || "").trim();
  const sPrice = String(normalizedProduct.s_price || "").trim();
  const inventory = String(normalizedProduct.real_inventory || "").trim();
  const supplierName = String(normalizedProduct.supplier_name || "").trim();
  const id = String(normalizedProduct.id || "").trim();

  if (!goodsCode) {
    return false;
  }

  if (!italianName) {
    return false;
  }

  return Boolean(pPrice || sPrice || inventory || supplierName || id);
}


function shouldFallbackToClosestSearch(normalizedProduct, barcode, allowClosestSearch) {
  return Boolean(allowClosestSearch) && !hasProductInDatabase(normalizedProduct, barcode);
}


function clearResultFields(options) {
  for (let index = 0; index < CONFIG.resultFields.length; index += 1) {
    const key = CONFIG.resultFields[index];
    const element = state.fieldEls[key];
    if (element) {
      element.textContent = "";
    }
  }
  const compactSupplierField = document.getElementById("field_supplier_name_compact");
  if (compactSupplierField) {
    compactSupplierField.textContent = "";
  }
  const compactInventoryField = document.getElementById("field_real_inventory_compact");
  if (compactInventoryField) {
    compactInventoryField.textContent = "";
  }
  const compactSavedField = document.getElementById("field_store_time_compact");
  if (compactSavedField) {
    compactSavedField.textContent = "";
  }
  if (!options?.keepSales && typeof clearSalesData === "function") {
    clearSalesData();
  }
  state.currentProductRecord = null;
  setDiscountVisibility();
  setLegacyDiscountVisibility(false);
}


function setResultField(key, value) {
  let normalizedValue = value === undefined || value === null ? "" : String(value);
  if (key === "store_time") {
    // The ERP appends a millisecond placeholder (`.0`) to saved timestamps.
    normalizedValue = normalizedValue.replace(/\.0$/, "");
  }
  const element = state.fieldEls[key];
  if (element) {
    element.textContent = normalizedValue;
  }
  if (key === "supplier_name") {
    const compactSupplierField = document.getElementById("field_supplier_name_compact");
    if (compactSupplierField) {
      compactSupplierField.textContent = normalizedValue;
    }
    return;
  }
  if (key === "real_inventory") {
    const compactInventoryField = document.getElementById("field_real_inventory_compact");
    if (compactInventoryField) {
      compactInventoryField.textContent = normalizedValue;
    }
    return;
  }
  if (key === "store_time") {
    const compactSavedField = document.getElementById("field_store_time_compact");
    if (compactSavedField) {
      compactSavedField.textContent = normalizedValue;
    }
  }
}


function setDiscountVisibility() {
  const costCard = document.getElementById("field_disc_cost_card");
  const percentCard = document.getElementById("field_discount_percent_card");
  const discIvaCard = document.getElementById("field_disc_iva_card");
  if (costCard) {
    costCard.hidden = false;
  }
  if (percentCard) {
    percentCard.hidden = false;
  }
  if (discIvaCard) {
    discIvaCard.hidden = false;
  }
  syncDisplayModeDiscountLayout();
}


function setLegacyDiscountVisibility(visible) {
  const priceCard = document.getElementById("field_discount_price_card");
  const pricePercentCard = document.getElementById("field_disc_price_percent_card");
  if (priceCard) {
    priceCard.hidden = !visible;
  }
  if (pricePercentCard) {
    pricePercentCard.hidden = !visible;
  }
  syncDisplayModeDiscountLayout();
}


function normalizeProductData(rawData) {
  const queue = [rawData?.product || rawData];
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item || typeof item !== "object") continue;

    if (item.goods_code || item.italian_name || item.real_inventory) {
      return item;
    }

    const values = Object.values(item);
    for (let index = 0; index < values.length; index += 1) {
      if (values[index] && typeof values[index] === "object") {
        queue.push(values[index]);
      }
    }
  }
  return rawData || {};
}


function normalizeSaleData(rawData) {
  const saleSource = rawData?.sale || rawData?.discount;
  if (!saleSource) {
    return null;
  }

  if (Array.isArray(saleSource)) {
    return saleSource.length > 0 ? saleSource[0] : null;
  }

  if (typeof saleSource === "object") {
    const values = Object.values(saleSource);
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      if (Array.isArray(value) && value.length > 0) {
        return value[0];
      }
    }
    return Object.keys(saleSource).length > 0 ? saleSource : null;
  }

  return null;
}


function normalizeSaleDiscountPercent(value) {
  const discount = numberFromValue(String(value ?? "").replace(",", ".").replace("%", ""));
  return discount > 0 && discount < 1 ? discount * 100 : discount;
}

function calculateDiscountPrice(sPriceValue, sDiscountValue) {
  const sPrice = numberFromValue(sPriceValue);
  const sDiscount = normalizeSaleDiscountPercent(sDiscountValue);
  if (!sPrice || !sDiscount) return "";
  return formatPrice(sPrice * (1 - (sDiscount / 100)));
}


function getDiscountPercentList(productData) {
  return [
    productData.p_discount,
    productData.p_discount2,
    productData.p_discount3,
    productData.p_discount4
  ]
    .map(numberFromValue)
    .filter(function (value) {
      return value > 0;
    });
}


function formatDiscountPercentSummary(percents) {
  if (!percents.length) return "0%";
  return percents
    .map(function (value) {
      return trimTrailingZeros(value);
    })
    .join("%, ") + "%";
}


function getDiscountFields(rawData, productData) {
  const percents = getDiscountPercentList(productData);
  const discountPercent = formatDiscountPercentSummary(percents);

  const pPrice = numberFromValue(productData.p_price);
  const discCost = percents.length > 0 && pPrice
    ? formatPrice(percents.reduce(function (price, percent) {
      return price * (1 - percent / 100);
    }, pPrice))
    : formatPrice(pPrice);

  const discIva = discCost
    ? formatPrice(numberFromValue(discCost) * 1.22)
    : "";

  return {
    discountPercent: discountPercent,
    discCost: discCost,
    discIva: discIva
  };
}


function getLegacyDiscountFields(rawData, productData) {
  const saleData = normalizeSaleData(rawData);
  const hasSaleData = Boolean(saleData) && saleData !== "" && (!Array.isArray(saleData) || saleData.length > 0);
  const rawSaleDiscount = hasSaleData ? numberFromValue(String(saleData.sdiscount ?? "").replace(",", ".").replace("%", "")) : 0;
  const saleDiscountValue = normalizeSaleDiscountPercent(rawSaleDiscount);
  const productDiscountValue = normalizeSaleDiscountPercent(productData.s_discount);

  const usingSaleDiscount = saleDiscountValue > 0;
  const activeDiscountValue = usingSaleDiscount ? saleDiscountValue : productDiscountValue;
  const hasDiscount = activeDiscountValue > 0;

  const sPrice = numberFromValue(productData.s_price);

  let discountPrice = "";
  if (usingSaleDiscount && saleData.discountPrice !== undefined) {
    const suppliedPrice = numberFromValue(String(saleData.discountPrice ?? "").replace(",", "."));
    const staleFractionPrice = rawSaleDiscount > 0 && rawSaleDiscount < 1 && sPrice > 0
      && Math.abs(suppliedPrice - sPrice * (1 - rawSaleDiscount / 100)) < 0.011;
    discountPrice = staleFractionPrice || suppliedPrice <= 0
      ? calculateDiscountPrice(sPrice, activeDiscountValue)
      : formatPrice(suppliedPrice);
  } else if (hasDiscount && sPrice) {
    discountPrice = formatPrice(sPrice * (1 - activeDiscountValue / 100));
  }

  return {
    discountPrice: discountPrice,
    saleDiscount: hasDiscount ? activeDiscountValue : 0,
    discountPercent: hasDiscount ? formatPercent(activeDiscountValue) : "",
    hasDiscount: hasDiscount
  };
}


function renderProductData(data) {
  const normalized = normalizeProductData(data);
  for (let index = 0; index < CONFIG.resultFields.length; index += 1) {
    const key = CONFIG.resultFields[index];
    setResultField(key, normalized[key]);
  }

  const discountFields = getDiscountFields(data, normalized);
  const legacyFields = getLegacyDiscountFields(data, normalized);

  setDiscountVisibility();
  setLegacyDiscountVisibility(legacyFields.hasDiscount);
  setResultField("discount_price", legacyFields.discountPrice);
  setResultField("disc_price_percent", legacyFields.discountPercent);
  setResultField("discount_percent", discountFields.discountPercent);
  setResultField("disc_cost", discountFields.discCost);
  setResultField("disc_iva", discountFields.discIva);

  state.currentProductRecord = {
    goods_id: String(normalized.id || ""),
    barcode: String(normalized.goods_code || state.els.barcodeInput.value || "").trim(),
    italian_name: String(normalized.italian_name || ""),
    p_price: String(normalized.p_price || ""),
    s_price: String(normalized.s_price || ""),
    s_discount: String(legacyFields.saleDiscount),
    discount_price: legacyFields.hasDiscount ? String(legacyFields.discountPrice || "") : "",
    has_discount: legacyFields.hasDiscount,
    comparison_qty: 1
  };
  if (typeof setSalesProduct === "function") {
    setSalesProduct();
  }
}


async function fetchProductInfo(barcode, options) {
  const code = String(barcode || "").trim();
  const lookupOptions = {
    allowClosestSearch: false,
    addToHistoryBeforeLookup: true,
    comparisonQty: 1,
    persistToHistory: true,
    ...options
  };
  if (!code) {
    setStatus("Type or scan a barcode first");
    return "empty";
  }

  state.els.barcodeInput.value = code;
  clearResultFields();
  const comparisonQty = sanitizeQuantity(lookupOptions.comparisonQty);
  const lookupSequence = state.lookupSequence + 1;
  state.lookupSequence = lookupSequence;
  const createdHistoryId = lookupOptions.addToHistoryBeforeLookup ? addHistoryItem(code, comparisonQty) : "";

  setStatus("Requesting product info...");
  try {
    let discountPromise;
    const info = await loadProductInfoResponse(code, function (cookie) {
      // Restart the optional discount lookup with the refreshed session too.
      discountPromise = loadOptionalDiscount(code, cookie);
    }, { retryMissing: !lookupOptions.allowClosestSearch });
    if (lookupSequence !== state.lookupSequence) return "cancelled";
    const parsedProduct = info.raw;
    if (!hasProductInDatabase(info.normalized, code) ||
        (lookupOptions.allowClosestSearch && String(info.normalized.goods_code || "").trim() !== code)) {
      throw createNoExactMatchError();
    }

    // Product info first (discount filled later in background).
    renderProductData({
      product: parsedProduct?.product || parsedProduct,
      sale: null
    });
    if (state.currentProductRecord && lookupOptions.persistToHistory) {
      state.currentProductRecord.comparison_qty = comparisonQty;
      if (createdHistoryId) {
        updateHistoryItem(createdHistoryId, state.currentProductRecord);
      } else {
        addHistoryRecord(state.currentProductRecord, code, comparisonQty);
      }
      // Sync name/cost/price/discount to EVERY history row with this barcode.
      syncHistoryRowsWithRecord(state.currentProductRecord, code);
    }
    setStatus("Product info loaded");

    // Always request discount in background; update UI + all matching history rows.
    discountPromise.then(function (parsedDiscount) {
        const updatedRecord = buildHistoryItemFromLookupData(
          parsedProduct?.product || parsedProduct,
          parsedDiscount,
          code,
          comparisonQty
        );

        // Push product + discount fields to all rows with this barcode (qty preserved per row).
        syncHistoryRowsWithRecord(updatedRecord, code);

        if (lookupSequence === state.lookupSequence && String(state.els.barcodeInput.value || "").trim() === code) {
          renderProductData({
            product: parsedProduct?.product || parsedProduct,
            sale: parsedDiscount
          });
        }
      });
    return "exact";
  } catch (error) {
    if (lookupSequence !== state.lookupSequence) return "cancelled";
    // Explicit Search can use the independent closest-search endpoint even
    // when the exact lookup or its session refresh fails. Scans retain their
    // existing exact-lookup retry and offline behavior.
    if (error?.code === "NO_EXACT_MATCH" ||
        (lookupOptions.allowClosestSearch && navigator.onLine !== false)) {
      if (lookupOptions.allowClosestSearch) {
        try {
          openClosestSearchLoadingDialog(code, createdHistoryId);
          const closestMatches = await fetchClosestSearchResults(code);
          if (lookupSequence !== state.lookupSequence) return "cancelled";
          openClosestSearchDialog(code, closestMatches, createdHistoryId);
          setStatus("Exact barcode not found. Select one of the closest matches.");
          return "closest";
        } catch (closestError) {
          if (lookupSequence !== state.lookupSequence) return "cancelled";
          const message = closestError.message || "No similar products found.";
          state.isClosestSearchLoading = false;
          state.els.closestSearchBackBtn.disabled = false;
          state.closestSearchResults = [];
          state.els.closestSearchStatus.textContent = message;
          renderClosestSearchResults();
          setStatus(`No exact product match found. ${message}`);
          return "no-match";
        }
      }

      setStatus("No exact product match found. Barcode added to list.");
      return "no-match";
    }

    // Offline / network failure: keep barcode in history.
    if (!createdHistoryId && lookupOptions.persistToHistory) {
      addHistoryItem(code, comparisonQty);
    }
    const offlineHint = !navigator.onLine
      ? "Offline — barcode saved to list."
      : (error?.message || "Could not load product info. Barcode saved to list.");
    setStatus(offlineHint);
    showToast(navigator.onLine ? "Request failed — saved locally" : "Offline — saved locally");
    return "offline";
  }
}
