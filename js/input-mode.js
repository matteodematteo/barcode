"use strict";

/* Input mode, quantity pad, and product info slider */

let quantitySubmissionPending = false;
let quantityProductLookup = null;

function renderQuantityProductDetails(request) {
  if (!state.quantityCaptureOpen || quantityProductLookup !== request || state.pendingQuantityCode !== request.code) return;
  const info = request.info;
  const summary = info ? getQuantityProductSummary(info.raw, request.sale) : null;
  const setValue = function (element, value) {
    element.textContent = value || "—";
    element.title = value || "";
  };
  setValue(state.els.quantityItalianName, summary?.italianName || (!info && !request.error ? "Loading…" : ""));
  setValue(state.els.quantitySupplierName, summary?.supplierName);
  setValue(state.els.quantityNetCost, summary?.netCost ? `€${summary.netCost}` : "");
  setValue(state.els.quantityCostIva, summary?.costWithIva ? `€${summary.costWithIva}` : "");
  const discountLabel = summary?.hasDiscount ? ` (${trimTrailingZeros(summary.saleDiscount)}%)` : "";
  setValue(state.els.quantitySellingPrice, summary?.sellingPrice ? `€${summary.sellingPrice}${discountLabel}` : "");
  state.els.quantitySellingPrice.classList.toggle("is-discount", Boolean(summary?.hasDiscount && summary.sellingPrice));
  state.els.quantityProductSummary.setAttribute("aria-busy", String(!request.error && (!info || !request.discountLoaded)));
  state.els.quantityProductStatus.textContent = request.error
    ? request.error.code === "NO_EXACT_MATCH" ? "Product not found. You can still add the barcode."
      : "Product details unavailable. You can still add the barcode."
    : !info ? "Loading product details…" : !request.discountLoaded ? "Checking discount…" : "";
}

function startQuantityProductLookup(code) {
  const request = { code, controller: new AbortController(), info: null, sale: null,
    discountLoaded: false, discountRevision: 0, discountPromise: Promise.resolve(null), error: null };
  quantityProductLookup = request;
  renderQuantityProductDetails(request);
  request.infoPromise = Promise.resolve().then(function () {
    return loadProductInfoResponse(code, function (cookie) {
      // A cookie retry replaces the earlier optional discount response too.
      const revision = ++request.discountRevision;
      request.discountLoaded = false;
      request.sale = null;
      request.discountPromise = Promise.resolve().then(function () {
        return request.controller.signal.aborted ? null
          : loadOptionalDiscount(code, cookie, { signal: request.controller.signal });
      }).catch(() => null);
      request.discountPromise.then(function (sale) {
        if (revision !== request.discountRevision) return;
        request.sale = sale;
        request.discountLoaded = true;
        renderQuantityProductDetails(request);
      });
    }, { signal: request.controller.signal, trackLoader: false, silent: true, retryMissing: true });
  }).then(function (info) {
    // Never display a similar or previous product for the captured barcode.
    const product = info.normalized || normalizeProductData(info.raw);
    if (!hasProductInDatabase(product, code) || String(product.goods_code || "").trim() !== code) {
      throw createNoExactMatchError();
    }
    return info;
  });
  request.infoPromise.then(function (info) {
    request.info = info;
    if (!request.discountRevision) request.discountLoaded = true;
    renderQuantityProductDetails(request);
  }, function (error) {
    request.error = error;
    renderQuantityProductDetails(request);
  });
  return request;
}

function canEnterQuantity() {
  return Boolean(state.quantityCaptureOpen && state.isQuantityEntryUnlocked &&
    !quantitySubmissionPending && state.pendingQuantityCode);
}

function updateQuantityPadAvailability() {
  const enabled = canEnterQuantity();
  if (state.els?.quantityInput) {
    state.els.quantityInput.setAttribute("aria-disabled", String(!enabled));
    state.els.quantityInput.tabIndex = -1;
  }
  if (!state.els?.quantityPad || !state.els?.quantityPadCard) return;
  state.els.quantityPad.querySelectorAll("button").forEach(button => {
    button.disabled = !enabled;
  });
  state.els.quantityPadCard.classList.toggle("is-disabled", !enabled);
  state.els.quantityPadCard.setAttribute("aria-disabled", String(!enabled));
}

function updateEntryModeControls() {
  if (!state.els?.entryModeBtn || !state.els?.entryModeLabel) {
    return;
  }

  const unlocked = Boolean(state.isQuantityEntryUnlocked);
  const label = unlocked ? "mode: Quantity" : "mode: Classic";
  state.els.entryModeBtn.setAttribute("aria-label", label);
  state.els.entryModeBtn.title = unlocked ? "Switch to Classic mode" : "Switch to Quantity mode";
  state.els.entryModeBtn.setAttribute("aria-pressed", String(unlocked));
  state.els.entryModeBtn.classList.toggle("btn-primary", unlocked);
  state.els.entryModeBtn.classList.toggle("btn-muted", !unlocked);
  updateQuantityPadAvailability();
  if (state.els.productInfoSection) {
    state.els.productInfoSection.hidden = false;
  }
  if (typeof syncSalesPerformanceRequests === "function") syncSalesPerformanceRequests();
  state.els.entryModeLabel.textContent = label;
}


function openQuantityCapture(barcode) {
  const code = String(barcode || "").trim();
  if (!code || !state.isQuantityEntryUnlocked || state.quantityCaptureOpen) return;
  state.quantityReturnFocus = document.activeElement;
  state.quantityCaptureOpen = true;
  if (typeof syncSalesPerformanceRequests === "function") syncSalesPerformanceRequests();
  captureDiagnostics.mark("quantity.open");
  state.pendingQuantityCode = code;
  state.quantityReplaceOnDigit = true;
  state.els.quantityInput.value = "1";
  state.els.quantityBarcode.textContent = code;
  state.els.quantityStatus.textContent = "";
  state.els.quantityPadCard.hidden = false;
  state.els.quantityPadCard.classList.add("is-open");
  state.els.quantityPadCard.setAttribute("aria-hidden", "false");
  document.querySelector("main").inert = true;
  state.els.capturePage.inert = true;
  state.els.capturePage.setAttribute("aria-modal", "false");
  document.body.classList.add("is-entering-quantity");
  if (state.capturePageOpen && captureEngineLoaded) {
    stopPreviewWatchdog();
    clearFocusRefreshTimers();
  }
  updateQuantityPadAvailability();
  setStatus("Choose quantity");
  state.els.quantityPad.querySelector('[data-key="1"]').focus({ preventScroll: true });
  startQuantityProductLookup(code);
}


function closeQuantityCapture(options = {}) {
  if (!state.quantityCaptureOpen) return;
  const request = quantityProductLookup;
  quantityProductLookup = null;
  if (!options.keepProductLookup) request?.controller.abort();
  state.quantityCaptureOpen = false;
  state.pendingQuantityCode = "";
  state.els.quantityPadCard.hidden = true;
  state.els.quantityPadCard.classList.remove("is-open");
  state.els.quantityPadCard.setAttribute("aria-hidden", "true");
  state.els.capturePage.inert = false;
  state.els.capturePage.setAttribute("aria-modal", "true");
  document.querySelector("main").inert = state.capturePageOpen;
  document.body.classList.remove("is-entering-quantity");
  updateQuantityPadAvailability();
  if (!options.keepProductLookup && typeof syncSalesPerformanceRequests === "function") syncSalesPerformanceRequests();
}


function cancelQuantityCapture() {
  const returnFocus = state.quantityReturnFocus;
  closeQuantityCapture();
  if (state.capturePageOpen) closeCapturePage();
  else if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  setStatus("Capture cancelled");
}


async function handleQuantityPadInput(key) {
  if (!canEnterQuantity() || !state.els?.quantityInput) {
    return;
  }

  const currentValue = String(state.els.quantityInput.value || "").replace(/[^\d]/g, "");
  if (key === "enter") {
    await addCurrentBarcodeWithQuantity();
    return;
  }

  if (key === "clear") {
    state.quantityReplaceOnDigit = false;
    state.els.quantityInput.value = "";
    return;
  }

  if (key === "backspace") {
    state.quantityReplaceOnDigit = false;
    const trimmed = currentValue.slice(0, -1);
    state.els.quantityInput.value = trimmed;
    return;
  }

  if (!/^\d$/.test(key)) {
    return;
  }

  const appended = `${state.quantityReplaceOnDigit ? "" : currentValue}${key}`;
  state.quantityReplaceOnDigit = false;
  state.els.quantityInput.value = sanitizeEditableQuantity(appended);
}


function setQuantityEntryMode(unlocked, options) {
  const nextUnlocked = Boolean(unlocked);
  const skipPersist = Boolean(options?.skipPersistIfUnchanged) && state.isQuantityEntryUnlocked === nextUnlocked;
  state.isQuantityEntryUnlocked = nextUnlocked;
  if (state.els?.quantityInput) {
    if (state.isQuantityEntryUnlocked) {
      state.els.quantityInput.value = "";
    } else {
      state.els.quantityInput.value = "1";
    }
  }
  updateEntryModeControls();

  // Skip the localStorage read + write entirely when the value already
  // matches what's on disk (e.g. the initial call from init(), which is
  // just re-applying the value it was just loaded from).
  if (skipPersist) {
    return;
  }

  const baseSettings = options?.baseSettings || readSavedSettings();
  saveSettings({
    ...baseSettings,
    displayMode: state.displayMode,
    quantityEntryUnlocked: state.isQuantityEntryUnlocked
  }, { silent: true });
}


async function addCurrentBarcodeWithQuantity() {
  if (!canEnterQuantity()) return;
  const code = state.pendingQuantityCode;
  if (!Number.isSafeInteger(Number(state.els.quantityInput.value)) || Number(state.els.quantityInput.value) < 1) {
    state.els.quantityStatus.textContent = "Enter a quantity of at least 1.";
    return;
  }

  const comparisonQty = sanitizeQuantity(state.els.quantityInput.value);
  const prefetchedLookup = quantityProductLookup;
  captureDiagnostics.mark("quantity.confirmed");
  state.els.quantityInput.value = String(comparisonQty);
  quantitySubmissionPending = true;
  closeQuantityCapture({ keepProductLookup: true });
  if (state.capturePageOpen) closeCapturePage({ captured: true });
  else moveFocusToInput(state.els.barcodeInput);
  quantitySubmissionPending = false;
  // Add the record and leave the camera immediately; network lookup continues
  // on the main screen. A later capture must not be cleared by this request.
  try {
    await fetchProductInfo(code, {
      allowClosestSearch: false,
      addToHistoryBeforeLookup: true,
      comparisonQty: comparisonQty,
      prefetchedLookup: prefetchedLookup
    });
  } finally {
    quantitySubmissionPending = false;
    updateQuantityPadAvailability();
  }
}


function syncDisplayModeDiscountLayout() {
  const hasDiscountFields = !document.getElementById("field_discount_price_card")?.hidden ||
    !document.getElementById("field_discount_percent_card")?.hidden;
  document.body.classList.toggle("has-discount-fields", hasDiscountFields);
}


function getResultCard(key) {
  return document.getElementById(`field_${key}_card`);
}


function clearResultCardLayout(card) {
  if (!card) {
    return;
  }

  card.style.display = "";
  card.style.order = "";
  card.style.flex = "";
  card.style.width = "";
  card.style.maxWidth = "";
}


function isDesktopProductLayout() {
  return typeof window.matchMedia === "function" && window.matchMedia("(min-width: 1024px)").matches;
}

function loadProductInfoSlideIndex() {
  try {
    const raw = localStorage.getItem(CONFIG.productInfoSlideStorageKey);
    const index = Number(raw);
    return Number.isInteger(index) && index >= 0 ? index : 0;
  } catch {
    return 0;
  }
}


function saveProductInfoSlideIndex(index) {
  try {
    localStorage.setItem(CONFIG.productInfoSlideStorageKey, String(index));
  } catch {
    // Ignore storage failures (e.g. private browsing quota).
  }
}


function initProductInfoSlider() {
  const slider = state.els.productInfoSlider;
  const dots = state.els.productInfoDots;
  if (!slider || !dots) {
    return;
  }

  const dotButtons = Array.prototype.slice.call(dots.querySelectorAll(".pi-dot"));
  desktopProductDetails.init();
  desktopProductDetails.setDesktop(isDesktopProductLayout());
  let targetIndex = null;
  let scrollFrame = 0;

  function setActiveDot(index, force = false) {
    const changed = state.productInfoSlideIndex !== index;
    state.productInfoSlideIndex = index;
    if (changed || force) {
      dotButtons.forEach(function (dot, dotIndex) {
        const isActive = dotIndex === index;
        dot.classList.toggle("is-active", isActive);
        dot.setAttribute("aria-selected", isActive ? "true" : "false");
      });
      if (changed) saveProductInfoSlideIndex(index);
    }
    if (typeof syncSalesPerformanceRequests === "function") {
      syncSalesPerformanceRequests({ refresh: changed });
    }
  }

  function goToSlide(index, behavior) {
    if (isDesktopProductLayout()) {
      targetIndex = null;
      slider.scrollTo({ left: 0, behavior: "instant" });
      return;
    }
    const width = slider.clientWidth;
    targetIndex = index;
    slider.scrollTo({ left: width * index, behavior: behavior || "smooth" });
  }

  dotButtons.forEach(function (dot) {
    dot.addEventListener("click", function () {
      const index = Number(dot.dataset.gotoSlide || 0);
      setActiveDot(index);
      goToSlide(index);
    });
  });

  function syncScrolledPage() {
    scrollFrame = 0;
    if (isDesktopProductLayout()) return;
    const width = slider.clientWidth;
    if (!width) return;
    // A tapped dot stays selected while smooth scrolling crosses other pages.
    if (targetIndex !== null) {
      if (Math.abs(slider.scrollLeft - width * targetIndex) > 1) return;
      targetIndex = null;
    }
    const index = Math.min(dotButtons.length - 1, Math.max(0, Math.round(slider.scrollLeft / width)));
    setActiveDot(index);
  }

  function queueScrollSync() {
    if (isDesktopProductLayout()) return;
    if (!scrollFrame) scrollFrame = window.requestAnimationFrame(syncScrolledPage);
  }
  slider.addEventListener("scroll", queueScrollSync, { passive: true });
  slider.addEventListener("scrollend", queueScrollSync, { passive: true });
  // A swipe, wheel, or keyboard action takes over any pending dot navigation.
  ["pointerdown", "touchstart", "wheel", "keydown"].forEach(function (eventName) {
    slider.addEventListener(eventName, function () {
      targetIndex = null;
      queueScrollSync();
    }, { passive: true });
  });

  document.addEventListener("visibilitychange", function () {
    if (typeof syncSalesPerformanceRequests === "function") syncSalesPerformanceRequests();
  });

  const savedIndex = Math.min(dotButtons.length - 1, Math.max(0, loadProductInfoSlideIndex()));
  setActiveDot(savedIndex, true);
  function syncProductLayout() {
    targetIndex = null;
    if (scrollFrame) window.cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
    const desktop = isDesktopProductLayout();
    desktopProductDetails.setDesktop(desktop);
    state.els.productActivitySlide?.setAttribute("role", desktop ? "group" : "tabpanel");
    if (desktop) slider.scrollTo({ left: 0, behavior: "instant" });
    else window.requestAnimationFrame(function () { goToSlide(state.productInfoSlideIndex, "instant"); });
    if (typeof syncSalesPerformanceRequests === "function") syncSalesPerformanceRequests();
  }
  const desktopQuery = typeof window.matchMedia === "function" ? window.matchMedia("(min-width: 1024px)") : null;
  desktopQuery?.addEventListener("change", syncProductLayout);
  if (isDesktopProductLayout()) syncProductLayout();
  else if (savedIndex > 0) {
    window.requestAnimationFrame(function () {
      goToSlide(savedIndex, "instant");
    });
  }
}


function applyDisplayMode() {
  state.displayMode = "full";
  document.body.classList.remove("display-mode-full", "display-mode-normal", "display-mode-compact", "is-compact");
  document.body.classList.add("display-mode-full");
  syncDisplayModeDiscountLayout();
}


