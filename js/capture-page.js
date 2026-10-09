"use strict";

// A separate capture route in the same document preserves the product/list and
// returns immediately without another page load or waiting for the ERP.
let captureEnginePromise = null;
let captureEngineLoaded = false;

function loadCaptureEngine() {
  if (captureEnginePromise) return captureEnginePromise;
  captureEnginePromise = new Promise(function (resolve, reject) {
    const script = document.createElement("script");
    script.src = "js/capture.bundle.js?v=117";
    script.onload = function () {
      captureEngineLoaded = true;
      initRoiResize();
      initPreviewFocus();
      resolve();
    };
    script.onerror = function () {
      script.remove();
      captureEnginePromise = null;
      reject(new Error("Could not load capture. Check your connection and try again."));
    };
    document.head.appendChild(script);
  });
  return captureEnginePromise;
}

async function openCapturePage() {
  if (state.inputMode === "scanner" || state.capturePageOpen) return;
  state.capturePageOpen = true;
  const generation = ++state.captureGeneration;
  state.captureReturnFocus = document.activeElement;
  state.captureMainUrl = location.pathname + location.search + location.hash;
  history.pushState({ webscannerCapture: true }, "", "#capture");
  state.els.capturePage.hidden = false;
  document.querySelector("main").inert = true;
  document.body.classList.add("is-capturing");
  state.els.captureBackBtn.focus({ preventScroll: true });
  state.els.captureRetryBtn.hidden = true;
  state.els.previewPlaceholder.textContent = "Opening camera…";
  setStatus("Opening camera…");
  try {
    await loadCaptureEngine();
    if (!state.capturePageOpen || generation !== state.captureGeneration) return;
    loadRoiState();
    applyRoiBoxStyle();
    await startScanning();
  } catch (error) {
    if (!state.capturePageOpen || generation !== state.captureGeneration || error.name === "AbortError") return;
    await stopTracks();
    setPreviewActive(false);
    state.els.previewPlaceholder.textContent = isCameraPermissionError(error)
      ? "Allow camera access in your browser, then tap Try again."
      : error.message || "Could not start the camera.";
    state.els.captureRetryBtn.hidden = false;
    setStatus(error.message || "Could not start capture.");
  }
}

function closeCapturePage(options) {
  if (!state.capturePageOpen) return;
  state.capturePageOpen = false;
  state.captureGeneration += 1;
  if (captureEngineLoaded) {
    disarmFirstGestureCameraStart();
    clearResumePreviewTimer();
    // stopTracks releases every track synchronously before its promise resolves.
    stopTracks();
    setPreviewActive(false);
  }
  state.els.capturePage.hidden = true;
  document.querySelector("main").inert = false;
  document.body.classList.remove("is-capturing");
  if (location.hash === "#capture") {
    history.replaceState(null, "", state.captureMainUrl || location.pathname + location.search);
  }
  if (!options?.captured) setStatus("Ready to capture");
  const focus = state.captureReturnFocus;
  if (focus?.isConnected && !focus.disabled) focus.focus({ preventScroll: true });
  else state.els.scanBtn.focus({ preventScroll: true });
}

function initCapturePage() {
  // A restored/deep-linked route still needs an explicit capture tap.
  if (location.hash === "#capture") history.replaceState(null, "", location.pathname + location.search);
  state.els.captureBackBtn.addEventListener("click", function () { closeCapturePage(); });
  state.els.captureRetryBtn.addEventListener("click", async function () {
    state.els.captureRetryBtn.disabled = true;
    closeCapturePage();
    await openCapturePage();
    state.els.captureRetryBtn.disabled = false;
  });
  window.addEventListener("popstate", function () { closeCapturePage(); });
  window.addEventListener("hashchange", function () {
    if (location.hash !== "#capture") closeCapturePage();
  });
  window.addEventListener("pagehide", function () { closeCapturePage(); });
  document.addEventListener("keydown", function (event) {
    if (!state.capturePageOpen) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeCapturePage();
    } else if (event.key === "Tab") {
      const buttons = Array.from(state.els.capturePage.querySelectorAll("button:not(:disabled)"))
        .filter(function (button) { return !button.hidden; });
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    }
  });
}
