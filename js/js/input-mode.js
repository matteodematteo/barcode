"use strict";

/* Input mode, quantity pad, and product info slider */

function updateEntryModeControls() {
  if (!state.els?.entryModeBtn || !state.els?.quantityInput || !state.els?.addBarcodeBtn || !state.els?.entryModeIcon) {
    return;
  }

  const unlocked = Boolean(state.isQuantityEntryUnlocked);
  state.els.entryModeBtn.setAttribute("aria-label", unlocked ? "Unlocked barcode entry" : "Locked barcode entry");
  state.els.entryModeBtn.title = unlocked ? "Unlocked barcode entry" : "Locked barcode entry";
  state.els.entryModeBtn.classList.toggle("btn-primary", unlocked);
  state.els.entryModeBtn.classList.toggle("btn-muted", !unlocked);
  state.els.quantityInput.disabled = false;
  state.els.quantityInput.readOnly = true;
  state.els.quantityInput.tabIndex = unlocked ? 0 : -1;
  state.els.quantityInput.setAttribute("aria-disabled", unlocked ? "false" : "true");
  state.els.quantityInput.classList.toggle("is-locked", !unlocked);
  state.els.addBarcodeBtn.disabled = !unlocked;
  if (unlocked) {
    if (String(state.els.quantityInput.value || "") === "1") {
      state.els.quantityInput.value = "";
    } else {
      state.els.quantityInput.value = sanitizeEditableQuantity(state.els.quantityInput.value);
    }
  } else {
    state.els.quantityInput.value = "1";
  }
  if (state.els.quantityPad && state.els.quantityPadCard) {
    const padButtons = state.els.quantityPad.querySelectorAll("button");
    for (let index = 0; index < padButtons.length; index += 1) {
      padButtons[index].disabled = !unlocked;
    }
    state.els.quantityPadCard.classList.toggle("is-disabled", !unlocked);
    state.els.quantityPadCard.hidden = !unlocked;
  }
  if (state.els.productInfoSection) {
    state.els.productInfoSection.hidden = unlocked;
  }
  if (typeof syncSalesPerformanceRequests === "function") syncSalesPerformanceRequests();
  state.els.entryModeIcon.innerHTML = unlocked
    ? '<path d="M16 11V8a4 4 0 0 0-7.74-1.5"></path><rect x="5" y="11" width="14" height="10" rx="2"></rect>'
    : '<rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V8a4 4 0 1 1 8 0v3"></path>';
}


async function handleQuantityPadInput(key) {
  if (!state.isQuantityEntryUnlocked || !state.els?.quantityInput) {
    return;
  }

  const currentValue = String(state.els.quantityInput.value || "").replace(/[^\d]/g, "");
  if (key === "enter") {
    await addCurrentBarcodeWithQuantity();
    return;
  }

  if (key === "clear") {
    state.els.quantityInput.value = "";
    return;
  }

  if (key === "backspace") {
    const trimmed = currentValue.slice(0, -1);
    state.els.quantityInput.value = trimmed;
    return;
  }

  if (!/^\d$/.test(key)) {
    return;
  }

  const appended = `${currentValue}${key}`;
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
  const code = String(state.els.barcodeInput.value || "").trim();
  if (!code) {
    setStatus("Type or scan a barcode first");
    moveFocusToInput(state.els.barcodeInput);
    return;
  }

  const comparisonQty = sanitizeQuantity(state.els.quantityInput.value);
  state.els.quantityInput.value = String(comparisonQty);
  state.els.addBarcodeBtn.disabled = true;
  try {
    await fetchProductInfo(code, {
      allowClosestSearch: false,
      addToHistoryBeforeLookup: true,
      comparisonQty: comparisonQty
    });
  } finally {
    state.els.addBarcodeBtn.disabled = false;
    updateEntryModeControls();
    state.els.barcodeInput.value = "";
    state.els.quantityInput.value = "";
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

  function setActiveDot(index) {
    const changed = state.productInfoSlideIndex !== index;
    state.productInfoSlideIndex = index;
    if (typeof syncSalesPerformanceRequests === "function") {
      syncSalesPerformanceRequests({ refresh: changed });
    }
    dotButtons.forEach(function (dot, dotIndex) {
      const isActive = dotIndex === index;
      dot.classList.toggle("is-active", isActive);
      dot.setAttribute("aria-selected", isActive ? "true" : "false");
    });
  }

  function goToSlide(index, behavior) {
    const width = slider.clientWidth;
    slider.scrollTo({ left: width * index, behavior: behavior || "smooth" });
  }

  dotButtons.forEach(function (dot) {
    dot.addEventListener("click", function () {
      const index = Number(dot.dataset.gotoSlide || 0);
      goToSlide(index);
      setActiveDot(index);
      saveProductInfoSlideIndex(index);
    });
  });

  let scrollTimer = null;
  slider.addEventListener("scroll", function () {
    if (scrollTimer) {
      window.clearTimeout(scrollTimer);
    }
    scrollTimer = window.setTimeout(function () {
      const width = slider.clientWidth || 1;
      const index = Math.min(dotButtons.length - 1, Math.max(0, Math.round(slider.scrollLeft / width)));
      setActiveDot(index);
      saveProductInfoSlideIndex(index);
    }, 80);
  }, { passive: true });

  document.addEventListener("visibilitychange", function () {
    if (typeof syncSalesPerformanceRequests === "function") syncSalesPerformanceRequests();
  });

  const savedIndex = Math.min(dotButtons.length - 1, Math.max(0, loadProductInfoSlideIndex()));
  setActiveDot(savedIndex);
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


function loadInputMode() {
  try {
    const saved = localStorage.getItem(CONFIG.inputModeStorageKey);
    return saved === "scanner" ? "scanner" : "phone";
  } catch {
    return "phone";
  }
}


function saveInputMode(mode) {
  try {
    localStorage.setItem(CONFIG.inputModeStorageKey, mode);
  } catch {
    // Ignore storage failures (e.g. private browsing quota).
  }
}


function updateInputModeSwitchUi() {
  const switchEl = state.els?.inputModeSwitch;
  if (!switchEl) {
    return;
  }
  switchEl.querySelectorAll(".input-mode-option").forEach(function (btn) {
    const isActive = btn.dataset.inputMode === state.inputMode;
    btn.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
}


async function setInputMode(mode, options) {
  const nextMode = mode === "scanner" ? "scanner" : "phone";
  const changed = nextMode !== state.inputMode;
  state.inputMode = nextMode;
  document.body.classList.toggle("mode-scanner", nextMode === "scanner");
  updateInputModeSwitchUi();

  if (state.els?.barcodeInput) {
    state.els.barcodeInput.inputMode = nextMode === "scanner" ? "none" : "numeric";
  }

  if (!(options && options.silent)) {
    saveInputMode(nextMode);
  }

  if (!changed) {
    return;
  }

  if (nextMode === "scanner") {
    stopScanning(true);
    try {
      await stopTracks();
    } catch {
      // Ignore camera teardown errors when switching to scanner mode.
    }
    setStatus("Scanner mode: camera off, use an external scanner");
  } else {
    setStatus("Phone mode: camera preview back on");
    try {
      await startCamera(state.activeDeviceId);
    } catch (error) {
      setStatus(error.message || "Could not restart the camera");
    }
  }

  moveFocusToInput(state.els.barcodeInput);
}
