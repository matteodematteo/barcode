"use strict";

/* Application bootstrap — offline-safe, fast start */

async function init() {
  state.els = queryElements();
  requireElements(state.els);
  setHistoryDetailsVisible(false);
  state.isIOS = isIOSDevice();
  state.isMobileUi = detectMobileUi();
  cacheResultFieldElements();

  const savedSettings = readSavedSettings();
  const scrollLockState = loadScrollLockState();

  loadCookieState();
  loadHistoryState();
  loadPrintRequestHistory();
  loadPrintTunnelPreference();
  restoreSalesPeriodFromSavedRequest();

  fillSettingsForm(savedSettings);
  applyDisplayMode();
  // This is the value we just loaded from storage, so applying it here is
  // never a change — skip the redundant settings read + write that would
  // otherwise happen on every single init.
  setQuantityEntryMode(savedSettings.quantityEntryUnlocked, {
    skipPersistIfUnchanged: true,
    baseSettings: savedSettings
  });
  clearResultFields();
  initCapturePage();
  bindEvents();
  scheduleIdleWork(renderHistory);

  initProductInfoSlider();

  state.els.barcodeInput.inputMode = "numeric";

  state.manualScrollLocked = scrollLockState.isLocked;
  state.manualScrollLockY = 0;
  updateLockScreenScrollButton();
  if (state.manualScrollLocked) {
    state.manualScrollLockY = window.scrollY || 0;
    document.body.style.top = `-${state.manualScrollLockY}px`;
    document.body.classList.add("is-scroll-locked");
  }

  // No permissions, camera, WASM compilation, or automatic login on boot.
  // Authentication refresh is already shared and handled on demand by api.js.
  state.activeDeviceId = readSavedCameraId() || "";
  state.els.scanBtn.disabled = false;
  setStatus("Ready to capture");
  performance.mark("webscanner-ready");
  window.requestAnimationFrame(function () {
    scheduleIdleWork(warmCaptureEngine, 500);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", function () {
    init().catch(function (error) {
      if (state.els?.statusText) {
        setStatus(error.message || "The app could not start");
      }
      // Never leave the main button dead after a failed init.
      if (state.els?.scanBtn) {
        state.els.scanBtn.disabled = false;
      }
    });
  });
} else {
  init().catch(function (error) {
    if (state.els?.statusText) {
      setStatus(error.message || "The app could not start");
    }
    if (state.els?.scanBtn) {
      state.els.scanBtn.disabled = false;
    }
  });
}
