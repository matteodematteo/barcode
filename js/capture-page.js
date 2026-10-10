"use strict";

// A separate capture route in the same document preserves the product/list and
// returns immediately without another page load or waiting for the ERP.
let captureEnginePromise = null;
let captureEngineLoaded = false;

function warmCaptureEngine() {
  // Compile in the worker after first paint, without opening camera hardware.
  loadCaptureEngine().then(function () { return ensureZXingLoaded(); }).catch(function () {});
}

function requestCaptureStream(deviceId) {
  const request = { generation: state.captureGeneration, stream: null, playback: null, promise: null };
  state.captureRequest = request;
  const video = { ...CONFIG.cameraStartupVideo };
  if (deviceId) {
    delete video.facingMode;
    video.deviceId = { exact: deviceId };
  }
  request.videoConstraints = video;
  // Request permission synchronously in the original click, including on iOS.
  let camera;
  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("Camera access requires HTTPS or localhost and a supported browser.");
    }
    camera = navigator.mediaDevices.getUserMedia({ audio: false, video: video });
  } catch (error) {
    camera = Promise.reject(error);
  }
  request.promise = camera.catch(function (error) {
    if (!state.capturePageOpen || request.generation !== state.captureGeneration || document.hidden) throw error;
    if (!["OverconstrainedError", "NotFoundError"].includes(error.name)) throw error;
    // Retry an unavailable saved camera without changing the requested quality.
    request.videoConstraints = { ...CONFIG.cameraStartupVideo };
    return navigator.mediaDevices.getUserMedia({ audio: false, video: request.videoConstraints });
  }).then(function (stream) {
    if (!state.capturePageOpen || state.captureRequest !== request || request.generation !== state.captureGeneration || document.hidden) {
      stream.getTracks().forEach(function (track) { track.stop(); });
      return { error: new DOMException("Capture closed", "AbortError") };
    }
    request.stream = stream;
    const preview = state.els.cameraPreview;
    preview.muted = true;
    preview.playsInline = true;
    preview.srcObject = stream;
    // Show video independently of loading/compiling the decoder.
    request.playback = preview.play().then(function () { return null; }, function (error) { return error; });
    return { stream: stream };
  }, function (error) { return { error: error }; });
  return request;
}

function releaseCaptureHardware() {
  const request = state.captureRequest;
  state.captureRequest = null;
  request?.stream?.getTracks().forEach(function (track) { track.stop(); });
  if (captureEngineLoaded) {
    clearResumePreviewTimer();
    stopTracks();
    setPreviewActive(false);
  } else {
    state.els.cameraPreview.pause();
    state.els.cameraPreview.srcObject = null;
  }
}

function loadCaptureEngine() {
  if (captureEnginePromise) return captureEnginePromise;
  captureEnginePromise = new Promise(function (resolve, reject) {
    const script = document.createElement("script");
    script.src = "js/capture.bundle.js?v=126";
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
  if (state.capturePageOpen) return;
  state.capturePageOpen = true;
  state.captureFirstFrameMarked = false;
  const generation = ++state.captureGeneration;
  // Begin the hardware request before focus/layout work in the capture route.
  performance.mark("webscanner-capture-request");
  requestCaptureStream(state.activeDeviceId);
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
    releaseCaptureHardware();
    state.els.previewPlaceholder.hidden = false;
    state.els.previewPlaceholder.style.display = "grid";
    state.els.previewPlaceholder.textContent = ["NotAllowedError", "SecurityError"].includes(error.name)
      ? "Allow camera access in your browser, then tap Try again."
      : error.message || "Could not start the camera.";
    state.els.captureRetryBtn.hidden = false;
    setStatus(error.message || "Could not start capture.",
      ["NotAllowedError", "SecurityError"].includes(error.name) ? "Camera access needed" : "Camera unavailable");
  }
}

function closeCapturePage(options) {
  if (!state.capturePageOpen) return;
  state.capturePageOpen = false;
  state.captureGeneration += 1;
  releaseCaptureHardware();
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
