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
      if (typeof desktopProductDetails !== "undefined") desktopProductDetails.fieldChanged(key);
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
  const compactSavedField = document.getElementById("field_create_time_compact");
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
  if (key === "create_time") {
    // The ERP appends a millisecond placeholder (`.0`) to saved timestamps.
    normalizedValue = normalizedValue.replace(/\.0$/, "");
  }
  const element = state.fieldEls[key];
  if (element) {
    element.textContent = normalizedValue;
    if (typeof desktopProductDetails !== "undefined") desktopProductDetails.fieldChanged(key);
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
  if (key === "create_time") {
    const compactSavedField = document.getElementById("field_create_time_compact");
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
      return {
        ...item,
        create_time: item.store_time || item.create_time
      };
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

  // The dedicated endpoint can wrap its row in sale/discount, named collections,
  // or arrays. Find the actual row before reading its percentage or price.
  const queue = [saleSource];
  const visited = new Set();
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item || typeof item !== "object" || visited.has(item)) continue;
    visited.add(item);
    if (!Array.isArray(item) && ("sdiscount" in item || "discountPrice" in item)) {
      return item;
    }
    for (const value of Object.values(item)) {
      if (value && typeof value === "object") queue.push(value);
    }
  }

  return null;
}


function normalizeSaleDiscountPercent(value) {
  const discount = numberFromValue(String(value ?? "").replace(",", ".").replace("%", ""));
  // Discount responses can express 50% as 0.5; ERP percentage fields use 50.
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
    productData.p_discount ?? productData.p_discount1,
    productData.p_discount2,
    productData.p_discount3,
    productData.p_discount4
  ]
    .map(function (value) {
      return numberFromValue(String(value ?? "").replace(",", ".").replace("%", ""));
    })
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

  const pPrice = productPriceNumber(productData.p_price);
  const discountedCost = pPrice === null ? null : percents.reduce(function (price, percent) {
    return price * (1 - percent / 100);
  }, pPrice);
  const discCost = discountedCost === null ? "" : formatPrice(discountedCost) || "0";
  // Apply IVA to the full precision cost, then round each displayed value once.
  const discIva = discountedCost === null ? "" : formatPrice(discountedCost * 1.22) || "0";

  return {
    discountPercent: discountPercent,
    discCost: discCost,
    discIva: discIva
  };
}


function productPriceNumber(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const numeric = Number(String(value).trim().replace(",", "."));
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
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

  const sPrice = productPriceNumber(productData.s_price);
  const calculatedPrice = sPrice === null ? "" : formatPrice(sPrice * (1 - activeDiscountValue / 100)) || "0";

  let discountPrice = "";
  if (usingSaleDiscount && saleData.discountPrice !== undefined) {
    const suppliedPrice = productPriceNumber(saleData.discountPrice);
    const staleFractionPrice = suppliedPrice !== null && rawSaleDiscount > 0 && rawSaleDiscount < 1 && sPrice > 0
      && Math.abs(suppliedPrice - sPrice * (1 - rawSaleDiscount / 100)) < 0.011;
    const placeholderZero = suppliedPrice === 0 && sPrice > 0 && activeDiscountValue < 100;
    discountPrice = staleFractionPrice || suppliedPrice === null || placeholderZero
      ? calculatedPrice
      : formatPrice(suppliedPrice) || "0";
  } else if (hasDiscount && sPrice !== null) {
    discountPrice = calculatedPrice;
  }

  return {
    discountPrice: discountPrice,
    saleDiscount: hasDiscount ? activeDiscountValue : 0,
    discountPercent: hasDiscount ? formatPercent(activeDiscountValue) : "",
    hasDiscount: hasDiscount
  };
}


function getQuantityProductSummary(productPayload, discountPayload) {
  const product = normalizeProductData(productPayload);
  const discountFields = getLegacyDiscountFields({ sale: discountPayload }, product);
  const purchasePrice = productPriceNumber(product.p_price);
  const discountedCost = purchasePrice === null ? null : getDiscountPercentList(product).reduce(function (price, percent) {
    return price * (1 - percent / 100);
  }, purchasePrice);
  const sellingPrice = productPriceNumber(discountFields.hasDiscount ? discountFields.discountPrice : product.s_price);
  const displayPrice = function (value) { return value === null ? "" : value.toFixed(2); };

  return {
    italianName: String(product.italian_name ?? ""),
    supplierName: String(product.supplier_name ?? ""),
    netCost: displayPrice(discountedCost),
    costWithIva: displayPrice(discountedCost === null ? null : discountedCost * 1.22),
    sellingPrice: displayPrice(sellingPrice),
    saleDiscount: discountFields.saleDiscount,
    hasDiscount: discountFields.hasDiscount
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
    supplier_name: String(normalized.supplier_name || ""),
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
  updateQuantityPadAvailability();
  clearResultFields();
  const comparisonQty = sanitizeQuantity(lookupOptions.comparisonQty);
  const lookupSequence = state.lookupSequence + 1;
  state.lookupSequence = lookupSequence;
  const createdHistoryId = lookupOptions.addToHistoryBeforeLookup ? addHistoryItem(code, comparisonQty) : "";
  const updateConfirmedRow = function (record) {
    const row = state.history.find(item => item.id === createdHistoryId);
    if (row) updateHistoryItem(row.id, { ...record, id: row.id, comparison_qty: row.comparison_qty });
  };
  setStatus("Requesting product info...");
  try {
    const prefetched = lookupOptions.prefetchedLookup?.code === code ? lookupOptions.prefetchedLookup : null;
    let discountPromise = Promise.resolve(null);
    let info;
    if (prefetched) {
      // The popup protected this silent request from updates while it was open.
      // After Enter, keep the usual request guard until product info arrives.
      showApiLoader();
      try { info = await prefetched.infoPromise; }
      finally { hideApiLoader(); }
      discountPromise = prefetched.discountPromise;
    } else {
      info = await loadProductInfoResponse(code, function (cookie) {
        // Restart the optional discount lookup with the refreshed session too.
        discountPromise = loadOptionalDiscount(code, cookie);
      }, { retryMissing: !lookupOptions.allowClosestSearch });
    }
    const isCurrentLookup = lookupSequence === state.lookupSequence;
    if (!isCurrentLookup && !createdHistoryId) return "cancelled";
    const parsedProduct = info.raw;
    if (!hasProductInDatabase(info.normalized, code) ||
        (lookupOptions.allowClosestSearch && String(info.normalized.goods_code || "").trim() !== code)) {
      throw createNoExactMatchError();
    }

    const initialSale = prefetched?.discountLoaded ? prefetched.sale : null;
    // Enrich earlier confirmed rows even when a newer lookup owns the screen.
    if (!isCurrentLookup) {
      if (lookupOptions.persistToHistory) updateConfirmedRow(buildHistoryItemFromLookupData(
        parsedProduct?.product || parsedProduct, initialSale, code, comparisonQty));
    } else {
      // Product info first (discount filled later in background).
      renderProductData({ product: parsedProduct?.product || parsedProduct, sale: initialSale });
      if (state.currentProductRecord && lookupOptions.persistToHistory) {
        state.currentProductRecord.comparison_qty = comparisonQty;
        if (createdHistoryId) {
          updateHistoryItem(createdHistoryId, state.currentProductRecord);
        } else {
          addHistoryRecord(state.currentProductRecord, code, comparisonQty);
        }
        // Sync product fields to matching rows while preserving each quantity.
        syncHistoryRowsWithRecord(state.currentProductRecord, code);
      }
      setStatus("Product info loaded");
    }

    // Always request discount in background; update UI + all matching history rows.
    discountPromise.then(function (parsedDiscount) {
        const updatedRecord = buildHistoryItemFromLookupData(
          parsedProduct?.product || parsedProduct,
          parsedDiscount,
          code,
          comparisonQty
        );

        if (lookupSequence !== state.lookupSequence && createdHistoryId) {
          if (lookupOptions.persistToHistory) updateConfirmedRow(updatedRecord);
          return;
        }

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
