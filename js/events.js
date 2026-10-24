"use strict";

/* Bind all visible controls before declaring the app ready. */

// ─── Critical: bound immediately on init ────────────────────────────────────
// These are the interactions a user could trigger within the first 200 ms:
// tapping Capture, typing a barcode, or pressing Enter on barcodeInput.
function bindCriticalEvents() {
  state.els.barcodeInput.addEventListener("input", updateQuantityPadAvailability);
  state.els.historyDetailsSwitch.addEventListener("click", function () {
    setHistoryDetailsVisible(!state.showHistoryDetails);
  });

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
        openQuantityCapture(state.els.barcodeInput.value);
      }
    } finally {
      state.els.searchBarcodeBtn.disabled = false;
      state.els.searchBarcodeBtn.removeAttribute("aria-busy");
    }
  });

  // Finish code/decoder preparation while the user approaches or presses
  // Capture. Hardware permission still starts only in the click handler.
  state.els.scanBtn.addEventListener("pointerdown", warmCaptureEngine, { passive: true });
  state.els.scanBtn.addEventListener("focus", warmCaptureEngine);
  state.els.scanBtn.addEventListener("click", async function () {
    state.els.scanBtn.disabled = true;
    try {
      await openCapturePage();
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
      openQuantityCapture(state.els.barcodeInput.value);
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
    updateQuantityPadAvailability();
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
    updateQuantityPadAvailability();
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
    openConfirmDialog("Save a copy in Recent print requests, then clear all records from the list?", clearAllHistory);
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
      state.els.sendTxtBtn.disabled = state.history.length === 0;
    }
  });

  state.els.printBtn.addEventListener("click", function () {
    if (state.history.length === 0 && state.printRequests.length === 0) {
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

  state.els.quantityCancelBtn.addEventListener("click", cancelQuantityCapture);
  state.els.quantityPadCard.addEventListener("keydown", function (event) {
    if (!state.quantityCaptureOpen || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "Tab") {
      const buttons = Array.from(state.els.quantityPadCard.querySelectorAll("button:not(:disabled)"));
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus({ preventScroll: true });
      }
      event.stopPropagation();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); cancelQuantityCapture(); return;
    }
    const key = /^\d$/.test(event.key) ? event.key : event.key === "Enter" ? "enter" :
      event.key === "Backspace" || event.key === "Delete" ? "backspace" : event.key.toLowerCase() === "c" ? "clear" : "";
    if (!key) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === "Enter" && event.target === state.els.quantityCancelBtn) cancelQuantityCapture();
    else handleQuantityPadInput(key).catch(error => setStatus(error.message || "Could not add barcode"));
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
    try { await handleQuantityPadInput(key); }
    catch (error) { setStatus(error.message || "Could not add barcode"); }
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
      const cookie = await loginAndRefreshCookie(values);
      if (cookie && state.els.settingsDialog.classList.contains("is-open")) {
        closeSettingsDialog();
        moveFocusToInput(state.els.barcodeInput);
      }
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
  state.els.printTunnelSelect.addEventListener("change", function () {
    savePrintTunnelPreference(state.els.printTunnelSelect.value);
  });
  state.els.printRequestTunnelSelect.addEventListener("change", function () {
    savePrintTunnelPreference(state.els.printRequestTunnelSelect.value);
  });

  state.els.printRequestHistoryList.addEventListener("click", function (event) {
    const button = event.target.closest("[data-print-request-id]");
    if (button) openPrintRequestDetail(button.dataset.printRequestId);
  });

  state.els.printRequestCancelBtn.addEventListener("click", function () {
    closePrintRequestDetail();
  });
  state.els.printRequestDetailDialog.addEventListener("click", function (event) {
    if (event.target === state.els.printRequestDetailDialog) closePrintRequestDetail();
  });
  state.els.printRequestTxtBtn.addEventListener("click", function () { sendSavedPrintRequest("TXT"); });
  state.els.printRequestBigBtn.addEventListener("click", function () { sendSavedPrintRequest("60*38"); });
  state.els.printRequestStickerBtn.addEventListener("click", function () { sendSavedPrintRequest("40*25"); });
  state.els.printRequestDetailDialog.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && !state.isPrintRequestSending && !state.els.confirmDialog.classList.contains("is-open")) {
      event.preventDefault();
      closePrintRequestDetail();
    }
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
    state.els.salesPeriodStatus.textContent = "Dates cleared. Click Apply to load all sales.";
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
  state.els.historyEditDialog.addEventListener("input", function () { state.historyEditDirty = true; });
  state.els.historyEditSDiscountInput.addEventListener("input", refreshHistoryEditDiscountPrice);
  state.els.historyEditDiscountPriceInput.addEventListener("input", refreshHistoryEditDiscountPercent);
  if (!state.isIOS) {
    const selectQuantity = function () {
      try { state.els.historyEditQtyInput.select(); } catch (_) {}
    };
    state.els.historyEditQtyInput.addEventListener("focus", selectQuantity);
    state.els.historyEditQtyInput.addEventListener("click", selectQuantity);
    state.els.historyEditQtyInput.addEventListener("pointerup", function (event) {
      event.preventDefault();
      selectQuantity();
    });
  }

  state.els.historyEditDialog.addEventListener("keydown", function (event) {
    const fields = [state.els.historyEditPPriceInput, state.els.historyEditItalianNameInput,
      state.els.historyEditSPriceInput, state.els.historyEditSDiscountInput,
      state.els.historyEditDiscountPriceInput, state.els.historyEditQtyInput];
    if (event.key === "Escape") {
      event.preventDefault(); closeHistoryEditDialog(); return;
    }
    if (event.key === "Tab") {
      // Mobile browsers may otherwise skip text fields when a hardware Tab
      // key is used. Follow the visual order explicitly on every platform.
      const sequence = [...fields, state.els.historyEditSaveBtn, state.els.historyEditBackBtn].filter(field => !field.disabled);
      const index = sequence.indexOf(document.activeElement);
      const next = sequence[(index + (event.shiftKey ? -1 : 1) + sequence.length) % sequence.length];
      event.preventDefault();
      next.focus({ preventScroll: true });
      return;
    }
    const index = fields.indexOf(event.target);
    if (event.key !== "Enter" || event.isComposing || index < 0) return;
    event.preventDefault();
    const next = fields[index + (event.shiftKey ? -1 : 1)] || (event.shiftKey ? fields[0] : state.els.historyEditSaveBtn);
    next.focus({ preventScroll: true });
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
    if (!document.hidden && state.capturePageOpen) {
      state.els.previewPlaceholder.hidden = true;
      state.els.previewPlaceholder.style.display = "none";
      if (captureEngineLoaded) setPreviewActive(true);
      if (!state.captureFirstFrameMarked) {
        state.captureFirstFrameMarked = true;
        performance.mark("webscanner-camera-frame");
      }
    }
  };
  
  state.els.cameraPreview.addEventListener("loadeddata", markPreviewAsLive);
  state.els.cameraPreview.addEventListener("canplay", markPreviewAsLive);
  state.els.cameraPreview.addEventListener("playing", markPreviewAsLive);
  state.els.cameraPreview.addEventListener("timeupdate", markPreviewAsLive);

  window.addEventListener("beforeunload", function () {
    closeCapturePage();
    releaseCaptureHardware();
  });

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      // Release even the camera retained behind the product screen.
      releaseCaptureHardware();
    } else if (state.capturePageOpen && !state.quantityCaptureOpen && captureEngineLoaded) {
      scheduleQuickPreviewResumeCheck();
    }
  });
  window.addEventListener("focus", function () {
    if (state.capturePageOpen && !state.quantityCaptureOpen && captureEngineLoaded) scheduleQuickPreviewResumeCheck();
  });
  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", function () {
      if (state.capturePageOpen && captureEngineLoaded) {
        refreshDevices(state.activeDeviceId).catch(function () {});
      }
    });
  }
}


// ─── Public entry point ──────────────────────────────────────────────────────
// Keep initialization failures visible instead of swallowing binding errors.
function bindEvents() {
  bindCriticalEvents();
  // All visible controls are usable immediately, including Settings and Clear.
  bindDeferredEvents();
}
