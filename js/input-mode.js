"use strict";

/* Input mode, quantity pad, and product info slider */

let quantitySubmissionPending = false;

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
}


function closeQuantityCapture() {
  if (!state.quantityCaptureOpen) return;
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
  state.els.quantityInput.value = String(comparisonQty);
  quantitySubmissionPending = true;
  closeQuantityCapture();
  if (state.capturePageOpen) closeCapturePage({ captured: true });
  else moveFocusToInput(state.els.barcodeInput);
  quantitySubmissionPending = false;
  // Add the record and leave the camera immediately; network lookup continues
  // on the main screen. A later capture must not be cleared by this request.
  try {
    await fetchProductInfo(code, {
      allowClosestSearch: false,
      addToHistoryBeforeLookup: true,
      comparisonQty: comparisonQty
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
  if (savedIndex > 0) {
    window.requestAnimationFrame(function () {
      goToSlide(savedIndex, "auto");
    });
  }
}


function applyDisplayMode() {
  state.displayMode = "full";
  document.body.classList.remove("display-mode-full", "display-mode-normal", "display-mode-compact", "is-compact");
  document.body.classList.add("display-mode-full");
  syncDisplayModeDiscountLayout();
}


