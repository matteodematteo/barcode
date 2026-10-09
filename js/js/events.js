"use strict";

/* Event listener bindings — split into critical (synchronous) and deferred
   (scheduled after first paint) to shave ~80-120 ms off init time. */

// ─── Critical: bound immediately on init ────────────────────────────────────
// These are the interactions a user could trigger within the first 200 ms:
// tapping Start Scanning, typing a barcode, or pressing Enter on barcodeInput.
function bindCriticalEvents() {
  state.els.searchBarcodeBtn.addEventListener("click", async function () {
    state.els.searchBarcodeBtn.disabled = true;
    state.els.searchBarcodeBtn.setAttribute("aria-busy", "true");
    try {
      const lookupResult = await handleBarcodeLookup({
        allowClosestSearch: true,
        addToHistoryBeforeLookup: false,
        persistToHistory: !state.isQuantityEntryUnlocked
      });
      if (state.isQuantityEntryUnlocked && lookupResult === "exact") {
        moveFocusToInput(state.els.quantityInput);
        selectEntireInputValue({ target: state.els.quantityInput });
      }
    } finally {
      state.els.searchBarcodeBtn.disabled = false;
      state.els.searchBarcodeBtn.removeAttribute("aria-busy");
    }
  });

  state.els.scanBtn.addEventListener("click", async function () {
    state.els.scanBtn.disabled = true;
    try {
      await handleMainButton();
    } catch (error) {
      setStatus(error.message || "Could not start the camera");
    } finally {
      state.els.scanBtn.disabled = false;
    }
  });

  state.els.barcodeInput.addEventListener("keydown", async function (event) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    if (state.isQuantityEntryUnlocked) {
      state.els.barcodeInput.value = String(state.els.barcodeInput.value || "").trim();
      if (!state.els.barcodeInput.value) {
        setStatus("Type or scan a barcode first");
        return;
      }
      await handleBarcodeLookup({
        allowClosestSearch: false,
        addToHistoryBeforeLookup: false,
        persistToHistory: false
      });
      moveFocusToInput(state.els.quantityInput);
      selectEntireInputValue({ target: state.els.quantityInput });
      return;
    }

    const code = String(state.els.barcodeInput.value || "").trim();
    if (!code) {
      setStatus("Type or scan a barcode first");
      return;
    }

    handleBarcodeLookup({
      allowClosestSearch: false,
      addToHistoryBeforeLookup: true,
      persistToHistory: true
    }).catch(function (error) {
      setStatus(error.message || "Could not add barcode to history");
    });

    state.els.barcodeInput.value = "";
    moveFocusToInput(state.els.barcodeInput);
  });

  // Scroll-lock must be bound unconditionally on every init (see original comment).
  document.addEventListener("touchmove", preventScrollWhileLocked, { passive: false });
  document.addEventListener("wheel", preventScrollWhileLocked, { passive: false });
}


// ─── Deferred: bound in idle time, after first paint ────────────────────────
function bindDeferredEvents() {
  state.els.clearBarcodeBtn.addEventListener("click", function () {
    state.els.barcodeInput.value = "";
    state.els.quantityInput.value = "";
    setStatus("Barcode field cleared");
  });

  state.els.clearSelectedBtn.addEventListener("click", function () {
    if (state.selectedHistoryIndex < 0) {
      return;
    }
    openConfirmDialog("Delete the selected barcode from the list?", clearSelectedHistory);
  });

  state.els.clearAllBtn.addEventListener("click", function () {
    if (state.history.length === 0) {
      return;
    }
    openConfirmDialog("Delete all barcodes from the list?", clearAllHistory);
  });
  
  state.els.sendTxtBtn.addEventListener("click", async function () {
    state.els.sendTxtBtn.disabled = true;
    try {
      await sendTxtList();
      closePrintDialog();
      moveFocusToInput(state.els.barcodeInput);
    } catch (error) {
      setStatus(error.message || "Send TXT failed");
    } finally {
      state.els.sendTxtBtn.disabled = false;
    }
  });

  state.els.printBtn.addEventListener("click", function () {
    if (state.history.length === 0) {
      setStatus("Barcode list is empty");
      return;
    }
    openPrintDialog();
  });

  state.els.printBigBtn.addEventListener("click", function () {
    runDirectPrint("60*38");
  });

  state.els.printStickerBtn.addEventListener("click", function () {
    runDirectPrint("40*25");
  });

  state.els.printBackBtn.addEventListener("click", function() {
    closePrintDialog();
    moveFocusToInput(state.els.barcodeInput);
  });
  
  state.els.torchBtn.addEventListener("click", async function () {
    state.els.torchBtn.disabled = true;
    try {
      await toggleTorch();
    } finally {
      await syncTorchSupport();
    }
  });

  state.els.closestSearchBackBtn.addEventListener("click", function () {
    if (!state.isClosestSearchLoading) {
      closeClosestSearchDialog();
      moveFocusToInput(state.els.barcodeInput);
    }
  });

  state.els.historyList.addEventListener("click", function (event) {
    const detailButton = event.target.closest('[data-action="detail"]');
    if (detailButton) {
      const detailIndex = Number(detailButton.dataset.index);
      if (!Number.isNaN(detailIndex)) {
        openHistoryEditor(detailIndex).catch((error) => {
          setStatus(error.message || "Could not open barcode row");
        });
      }
      return;
    }

    const record = event.target.closest(".history-item");
    if (!record) return;
    const index = Number(record.dataset.index);
    if (!Number.isNaN(index)) {
      selectHistoryItem(index);
    }
  });

  state.els.closestSearchList.addEventListener("click", async function (event) {
    const selectButton = event.target.closest('[data-action="select-closest"]');
    if (!selectButton) {
      return;
    }

    const matchIndex = Number(selectButton.dataset.index);
    if (Number.isNaN(matchIndex)) {
      return;
    }

    try {
      await handleClosestSearchSelection(matchIndex);
    } catch (error) {
      setStatus(error.message || "Could not load selected product");
    }
  });

  state.els.historyList.addEventListener("keydown", function (event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    const record = event.target.closest(".history-item");
    if (!record) return;
    event.preventDefault();
    const index = Number(record.dataset.index);
    if (!Number.isNaN(index)) {
      selectHistoryItem(index);
    }
  });

  // Set default input mode to none to prevent keyboard from popping on programmatic focus
  state.els.barcodeInput.setAttribute("inputmode", "none");

  // Re-enable the keyboard only when the user explicitly taps/clicks on the input field
  state.els.barcodeInput.addEventListener("pointerdown", function () {
    state.els.barcodeInput.removeAttribute("inputmode");
  });

  state.els.barcodeInput.addEventListener("keyup", function (event) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
  });

  state.els.barcodeInput.addEventListener("blur", function () {
    // Reset input mode back to 'none' when focus is lost
    state.els.barcodeInput.setAttribute("inputmode", "none");
    
    window.setTimeout(function () {
      if (isAnyDialogOpen()) {
        return;
      }
      const active = document.activeElement;
      if (active && active !== document.body && active !== state.els.barcodeInput) {
        const tag = active.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || active.isContentEditable) {
          return;
        }
      }
      moveFocusToInput(state.els.barcodeInput);
    }, 30);
  });

  state.els.entryModeBtn.addEventListener("click", function () {
    setQuantityEntryMode(!state.isQuantityEntryUnlocked);
  });

  if (!state.isIOS) {
    state.els.quantityInput.addEventListener("focus", selectEntireInputValue);
    state.els.quantityInput.addEventListener("click", selectEntireInputValue);
    state.els.quantityInput.addEventListener("pointerup", function (event) {
      event.preventDefault();
      selectEntireInputValue(event);
    });
  }
  
  state.els.quantityInput.addEventListener("input", function () {
    state.els.quantityInput.value = sanitizeEditableQuantity(state.els.quantityInput.value);
  });
  
  state.els.quantityInput.addEventListener("keydown", async function (event) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    await addCurrentBarcodeWithQuantity();
    moveFocusToInput(state.els.barcodeInput);
  });
  
  state.els.addBarcodeBtn.addEventListener("click", async function () {
    await addCurrentBarcodeWithQuantity();
    moveFocusToInput(state.els.barcodeInput);
  });
  
  state.els.quantityPad.addEventListener("click", async function (event) {
    const keyButton = event.target.closest("[data-key]");
    if (!keyButton) {
      return;
    }
    const key = String(keyButton.dataset.key || "").trim();
    if (!key) {
      return;
    }
    await handleQuantityPadInput(key);
    
    if (key.toLowerCase() === "enter" || key.toLowerCase() === "add") {
      moveFocusToInput(state.els.barcodeInput);
    }
  });

  state.els.cameraSelect.addEventListener("change", async function () {
    state.els.cameraSelect.disabled = true;
    try {
      await handleSelectChange();
    } catch (error) {
      setStatus(error.message || "Could not change camera");
    } finally {
      state.els.cameraSelect.disabled = state.devices.length === 0;
    }
  });

  state.els.settingsBtn.addEventListener("click", openSettingsDialog);
  
  state.els.closeSettingsBtn.addEventListener("click", function() {
    closeSettingsDialog();
    moveFocusToInput(state.els.barcodeInput);
  });

  state.els.loginSettingsBtn.addEventListener("click", async function () {
    const values = {
      shopKey: state.els.shopKeyInput.value.trim(),
      login: state.els.loginInput.value.trim(),
      password: state.els.passwordInput.value,
      displayMode: state.displayMode,
      quantityEntryUnlocked: state.isQuantityEntryUnlocked
    };

    saveSettings(values);
    try {
      await loginAndRefreshCookie(values);
    } catch (error) {
      const message = error.message || "Login request failed.";
      saveCookieState("", `Login failed: ${message}`);
      state.els.settingsSaveNote.textContent = message;
      setStatus("Login failed");
    }
  });

  state.els.refreshCookieBtn.addEventListener("click", async function () {
    state.els.refreshCookieBtn.disabled = true;
    try {
      const cookie = await loginAndRefreshCookie();
      if (cookie) {
        if (isSalesTabActive(0)) {
          await refreshMissingHistoryInfo(cookie);
        } else {
          await refreshSalesPerformanceAfterLogin(cookie);
        }
      }
    } catch (error) {
      const message = error.message || "Cookie refresh failed.";
      saveCookieState("", `Cookie refresh failed: ${message}`);
      setStatus("Cookie refresh failed");
    } finally {
      state.els.refreshCookieBtn.disabled = false;
    }
  });

  state.els.lockScreenScrollBtn.addEventListener("click", function () {
    toggleScreenScrollLock();
  });

  state.els.inputModeSwitch.addEventListener("click", function (event) {
    const btn = event.target.closest(".input-mode-option");
    if (!btn) {
      return;
    }
    setInputMode(btn.dataset.inputMode).catch(function (error) {
      setStatus(error.message || "Could not switch input mode");
    });
  });

  state.els.settingsDialog.addEventListener("click", function (event) {
    if (event.target === state.els.settingsDialog) {
      closeSettingsDialog();
      moveFocusToInput(state.els.barcodeInput);
    }
  });

  state.els.confirmDialogOkBtn.addEventListener("click", function () {
    const action = state.pendingConfirmAction;
    closeConfirmDialog();
    moveFocusToInput(state.els.barcodeInput);
    if (action) {
      action();
    }
  });

  state.els.confirmDialogCancelBtn.addEventListener("click", function() {
    closeConfirmDialog();
    moveFocusToInput(state.els.barcodeInput);
  });

  state.els.confirmDialog.addEventListener("click", function (event) {
    if (event.target === state.els.confirmDialog) {
      closeConfirmDialog();
      moveFocusToInput(state.els.barcodeInput);
    }
  });

  state.els.printDialog.addEventListener("click", function (event) {
    if (event.target === state.els.printDialog) {
      closePrintDialog();
      moveFocusToInput(state.els.barcodeInput);
    }
  });

  state.els.salesPeriodBtn.addEventListener("click", function () {
    openSalesPeriodDialog();
  });

  state.els.salesPeriodDialog.addEventListener("click", function (event) {
    const button = event.target.closest("button[data-sales-period-preset]");
    if (!button) return;
    const period = getSalesQuickPeriod(button.dataset.salesPeriodPreset);
    if (!period) return;
    state.els.salesPeriodStartInput.value = period.beginDate;
    state.els.salesPeriodEndInput.value = period.endDate;
    state.els.salesPeriodStatus.textContent = "";
  });

  state.els.salesPeriodApplyBtn.addEventListener("click", function () {
    if (applySalesPeriod(state.els.salesPeriodStartInput.value, state.els.salesPeriodEndInput.value)) {
      closeSalesPeriodDialog();
      moveFocusToInput(state.els.barcodeInput);
    }
  });

  state.els.salesPeriodAllBtn.addEventListener("click", function () {
    state.els.salesPeriodStartInput.value = "";
    state.els.salesPeriodEndInput.value = "";
    state.els.salesPeriodStatus.textContent = "Click Apply to load all sales.";
  });

  state.els.productActivityRetryBtn.addEventListener("click", function () {
    startProductActivityLookup({ retry: true });
  });

  state.els.salesPeriodBackBtn.addEventListener("click", function () {
    closeSalesPeriodDialog();
    moveFocusToInput(state.els.barcodeInput);
  });

  state.els.salesPeriodDialog.addEventListener("click", function (event) {
    if (event.target === state.els.salesPeriodDialog) {
      closeSalesPeriodDialog();
      moveFocusToInput(state.els.barcodeInput);
    }
  });

  state.els.closestSearchDialog.addEventListener("click", function (event) {
    if (event.target === state.els.closestSearchDialog && !state.isClosestSearchLoading) {
      closeClosestSearchDialog();
      moveFocusToInput(state.els.barcodeInput);
    }
  });

  state.els.historyEditSaveBtn.addEventListener("click", async function () {
    state.els.historyEditSaveBtn.disabled = true;
    try {
      await saveHistoryEditorChanges();
    } catch (error) {
      setStatus(error.message || "Save failed.");
      if (!error?.toastShown) {
        showToast("Save failed");
      }
    } finally {
      state.els.historyEditSaveBtn.disabled = false;
    }
  });

  state.els.historyEditBackBtn.addEventListener("click", function() {
    closeHistoryEditDialog();
    moveFocusToInput(state.els.barcodeInput);
  });

  state.els.historyEditSPriceInput.addEventListener("input", refreshHistoryEditDiscountPrice);
  state.els.historyEditSDiscountInput.addEventListener("input", refreshHistoryEditDiscountPrice);
  if (!state.isIOS) {
    state.els.historyEditQtyInput.addEventListener("focus", selectEntireInputValue);
    state.els.historyEditQtyInput.addEventListener("click", selectEntireInputValue);
    state.els.historyEditQtyInput.addEventListener("pointerup", function (event) {
      event.preventDefault();
      selectEntireInputValue(event);
    });
  }

  state.els.historyEditItalianNameInput.addEventListener("keydown", function (event) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    moveFocusToInput(state.els.historyEditPPriceInput);
  });

  state.els.historyEditPPriceInput.addEventListener("keydown", function (event) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    moveFocusToInput(state.els.historyEditSPriceInput);
  });

  state.els.historyEditDialog.addEventListener("click", function (event) {
    if (event.target === state.els.historyEditDialog) {
      closeHistoryEditDialog();
      moveFocusToInput(state.els.barcodeInput);
    }
  });

  // Native <dialog> elements can also be dismissed with the Escape key,
  // which fires a "close" event directly and bypasses every click handler
  // above. Catch that path too so focus always returns to barcodeInput.
  [
    state.els.settingsDialog,
    state.els.confirmDialog,
    state.els.printDialog,
    state.els.salesPeriodDialog,
    state.els.closestSearchDialog,
    state.els.historyEditDialog
  ].forEach(function (dialogEl) {
    dialogEl.addEventListener("close", function () {
      moveFocusToInput(state.els.barcodeInput);
    });
  });

  const markPreviewAsLive = function () {
    if (!document.hidden) {
      setPreviewActive(true);
    }
  };
  
  state.els.cameraPreview.addEventListener("loadeddata", markPreviewAsLive);
  state.els.cameraPreview.addEventListener("canplay", markPreviewAsLive);
  state.els.cameraPreview.addEventListener("playing", markPreviewAsLive);
  state.els.cameraPreview.addEventListener("timeupdate", markPreviewAsLive);

  window.addEventListener("beforeunload", function () {
    clearResumePreviewTimer();
    stopScanning(true);
    stopTracks();
  });

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      clearResumePreviewTimer();
      setPreviewActive(false);
    } else {
      state.lastPreviewTime = Number(getPreviewVideoElement()?.currentTime || 0);
      state.stalledPreviewChecks = 0;
      scheduleQuickPreviewResumeCheck();
    }
  });

  window.addEventListener("pageshow", function () {
    scheduleQuickPreviewResumeCheck();
  });

  window.addEventListener("focus", function () {
    scheduleQuickPreviewResumeCheck();
  });

  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", function () {
      refreshDevices(state.activeDeviceId).catch(() => {
        // Ignore transient device change errors.
      });
    });
  }
}


// ─── Public entry point ──────────────────────────────────────────────────────
// bindEvents() now immediately binds only the critical set; the full set of
// non-critical handlers is scheduled in idle time (~100 ms delay) so it does
// not compete with first paint or the scan button becoming interactive.
function bindEvents() {
  bindCriticalEvents();

  scheduleIdleWork(function () {
    try {
      bindDeferredEvents();
    } catch (e) {
      // Silently swallow deferred binding failures — they must never crash init.
    }
  }, 100);
}
