"use strict";

/* DOM element queries and field caching — split into critical (on-boot)
   and deferred (lazy-loaded on first access) buckets to avoid paying the
   cost of 70+ getElementById calls before the browser can paint. */

// ─── Critical elements (queried once, immediately on init) ──────────────────
function queryCriticalElements() {
  return {
    barcodeInput:       document.getElementById("barcodeInput"),
    scanBtn:            document.getElementById("scanBtn"),
    previewFrame:       document.getElementById("previewFrame"),
    cameraPreview:      document.getElementById("cameraPreview"),
    cameraPreviewQuagga:document.getElementById("cameraPreviewQuagga"),
    cameraSelect:       document.getElementById("cameraSelect"),
    statusText:         document.getElementById("statusText"),
    torchBtn:           document.getElementById("torchBtn"),
    historyList:        document.getElementById("historyList"),
    historyEmpty:       document.getElementById("historyEmpty"),
    historyCountBadge:  document.getElementById("historyCountBadge"),
    clearAllBtn:        document.getElementById("clearAllBtn"),
    clearSelectedBtn:   document.getElementById("clearSelectedBtn"),
    sendTxtBtn:         document.getElementById("sendTxtBtn"),
    printBtn:           document.getElementById("printBtn"),
    entryModeBtn:       document.getElementById("entryModeBtn"),
    entryModeIcon:      document.getElementById("entryModeIcon"),
    quantityInput:      document.getElementById("quantityInput"),
    quantityPad:        document.getElementById("quantityPad"),
    quantityPadCard:    document.getElementById("quantityPadCard"),
    addBarcodeBtn:      document.getElementById("addBarcodeBtn"),
    searchBarcodeBtn:   document.getElementById("searchBarcodeBtn"),
    clearBarcodeBtn:    document.getElementById("clearBarcodeBtn"),
    captureCanvas:      document.getElementById("captureCanvas"),
    apiLoader:          document.getElementById("apiLoader"),
    toast:              document.getElementById("toast"),
    lockScreenScrollBtn:document.getElementById("lockscreenscroll"),
    inputModeSwitch:    document.getElementById("inputModeSwitch"),
    previewPlaceholder: document.getElementById("previewPlaceholder"),
    cameraBadge:        document.getElementById("cameraBadge"),
    resolutionBadge:    document.getElementById("resolutionBadge"),
    roiBox:             document.getElementById("roiBox"),
    roiResizeHandle:    document.getElementById("roiResizeHandle"),
    productInfoSection: document.getElementById("productInfoSection"),
    productInfoSlider:  document.getElementById("productInfoSlider"),
    productInfoTrack:   document.getElementById("productInfoTrack"),
    productInfoDots:    document.getElementById("productInfoDots"),
    salesQuantityField: document.getElementById("field_sales_quantity"),
    salesQuantityLoader:document.getElementById("salesQuantityLoader"),
    salesPeriodBtn:     document.getElementById("salesPeriodBtn"),
    productActivitySlide: document.getElementById("productActivitySlide"),
    productActivityLoader: document.getElementById("productActivityLoader"),
    productActivityStatus: document.getElementById("productActivityStatus"),
    productActivityRetryBtn: document.getElementById("productActivityRetryBtn"),
  };
}


// ─── Deferred elements (lazy-loaded on first access via getters) ─────────────
var _deferredEls = null;

function getDeferredElements() {
  if (_deferredEls) return _deferredEls;
  _deferredEls = {
    // Dialogs
    settingsDialog:              document.getElementById("settingsDialog"),
    confirmDialog:               document.getElementById("confirmDialog"),
    confirmDialogCancelBtn:      document.getElementById("confirmDialogCancelBtn"),
    confirmDialogOkBtn:          document.getElementById("confirmDialogOkBtn"),
    confirmDialogText:           document.getElementById("confirmDialogText"),
    closestSearchDialog:         document.getElementById("closestSearchDialog"),
    closestSearchList:           document.getElementById("closestSearchList"),
    closestSearchProgress:       document.getElementById("closestSearchProgress"),
    closestSearchStatus:         document.getElementById("closestSearchStatus"),
    closestSearchTitle:          document.getElementById("closestSearchTitle"),
    closestSearchBackBtn:        document.getElementById("closestSearchBackBtn"),
    printDialog:                 document.getElementById("printDialog"),
    printTunnelSelect:          document.getElementById("printTunnelSelect"),
    printTimestampCheckbox:     document.getElementById("printTimestampCheckbox"),
    printBigBtn:                 document.getElementById("printBigBtn"),
    printStickerBtn:             document.getElementById("printStickerBtn"),
    printBackBtn:                document.getElementById("printBackBtn"),
    salesPeriodDialog:           document.getElementById("salesPeriodDialog"),
    salesPeriodStartInput:       document.getElementById("salesPeriodStartInput"),
    salesPeriodEndInput:         document.getElementById("salesPeriodEndInput"),
    salesPeriodApplyBtn:         document.getElementById("salesPeriodApplyBtn"),
    salesPeriodAllBtn:           document.getElementById("salesPeriodAllBtn"),
    salesPeriodBackBtn:          document.getElementById("salesPeriodBackBtn"),
    salesPeriodStatus:           document.getElementById("salesPeriodStatus"),
    historyEditDialog:           document.getElementById("historyEditDialog"),
    historyEditBackBtn:          document.getElementById("historyEditBackBtn"),
    historyEditBarcodeInput:     document.getElementById("historyEditBarcodeInput"),
    historyEditDiscountPriceInput:document.getElementById("historyEditDiscountPriceInput"),
    historyEditIdInput:          document.getElementById("historyEditIdInput"),
    historyEditItalianNameInput: document.getElementById("historyEditItalianNameInput"),
    historyEditPPriceInput:      document.getElementById("historyEditPPriceInput"),
    historyEditQtyInput:         document.getElementById("historyEditQtyInput"),
    historyEditSaveBtn:          document.getElementById("historyEditSaveBtn"),
    historyEditSaveNote:         document.getElementById("historyEditSaveNote"),
    historyEditSDiscountInput:   document.getElementById("historyEditSDiscountInput"),
    historyEditSPriceInput:      document.getElementById("historyEditSPriceInput"),
    historyEditBackBtn:          document.getElementById("historyEditBackBtn"),
    // Settings panel
    settingsBtn:        document.getElementById("settingsBtn"),
    closeSettingsBtn:   document.getElementById("closeSettingsBtn"),
    loginSettingsBtn:   document.getElementById("loginSettingsBtn"),
    loginInput:         document.getElementById("loginInput"),
    passwordInput:      document.getElementById("passwordInput"),
    shopKeyInput:       document.getElementById("shopKeyInput"),
    settingsSaveNote:   document.getElementById("settingsSaveNote"),
    refreshCookieBtn:   document.getElementById("refreshCookieBtn"),
  };
  return _deferredEls;
}


// ─── Proxy that merges critical + deferred transparently ─────────────────────
// All existing code that reads `state.els.someProperty` continues to work
// without changes.  Critical properties are served directly; any unknown key
// falls through to getDeferredElements() so the dialog / settings elements
// are only queried on first real use.
function buildElsProxy(criticalEls) {
  return new Proxy(criticalEls, {
    get: function (target, prop) {
      if (prop in target) {
        return target[prop];
      }
      var deferred = getDeferredElements();
      if (prop in deferred) {
        return deferred[prop];
      }
      return undefined;
    },
    set: function (target, prop, value) {
      if (prop in target) {
        target[prop] = value;
      } else {
        getDeferredElements()[prop] = value;
      }
      return true;
    }
  });
}


// ─── Public API (keeps backward-compat with app.js callers) ─────────────────
function queryElements() {
  var criticalEls = queryCriticalElements();
  return buildElsProxy(criticalEls);
}


function requireElements(els) {
  // Only validate critical elements at startup; deferred ones are optional
  // until actually needed (they will throw naturally when accessed if missing).
  var criticalKeys = Object.keys(queryCriticalElements());
  var missing = criticalKeys.filter(function (key) { return !els[key]; });
  if (missing.length > 0) {
    throw new Error("Missing DOM elements: " + missing.join(", "));
  }
}


function cacheResultFieldElements() {
  state.fieldEls = {};
  for (let index = 0; index < CONFIG.resultFields.length; index += 1) {
    const key = CONFIG.resultFields[index];
    state.fieldEls[key] = document.getElementById(`field_${key}`);
  }
}
