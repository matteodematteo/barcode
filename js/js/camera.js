"use strict";

/* Camera preview, scanning, ROI, and torch */

async function waitForHtml5QrReady(timeoutMs) {
  if (typeof window.ensureHtml5QrLoaded !== "function") {
    return;
  }

  // Kicks off the (idempotent) lazy load if it hasn't started yet, then
  // waits for it up to timeoutMs.
  const readyPromise = window.ensureHtml5QrLoaded();

  await Promise.race([
    readyPromise.catch(function () {
      // Ignore lazy scanner bootstrap failures here.
    }),
    new Promise(function (resolve) {
      window.setTimeout(resolve, timeoutMs);
    })
  ]);
}


function setActivePreviewEngine(engine) {
  if (state.els?.cameraPreview) {
    state.els.cameraPreview.hidden = false;
    state.els.cameraPreview.style.display = "block";
  }
  if (state.els?.cameraPreviewQuagga) {
    state.els.cameraPreviewQuagga.hidden = true;
    state.els.cameraPreviewQuagga.style.display = "none";
  }
}


function getPreviewVideoElement() {
  if (!state.els) {
    return null;
  }
  return state.els.cameraPreview instanceof HTMLVideoElement
    ? state.els.cameraPreview
    : state.els.cameraPreview?.querySelector("video") || null;
}


function getActiveStreamTrackFromPreview() {
  const video = getPreviewVideoElement();
  const stream = video?.srcObject;
  if (!stream?.getVideoTracks) {
    return null;
  }
  return stream.getVideoTracks()[0] || null;
}


const HTML5_QR_FORMAT_MAP = {
  ean_13: "EAN_13",
  ean_8: "EAN_8",
  upc_a: "UPC_A",
  upc_e: "UPC_E",
  code_128: "CODE_128",
  code_39: "CODE_39",
  codabar: "CODABAR",
  itf: "ITF"
};


function getHtml5QrFormats() {
  const SupportedFormats = window.Html5QrcodeSupportedFormats;
  if (!SupportedFormats) {
    return [];
  }
  return CONFIG.detectorFormats
    .map(function (format) {
      const enumKey = HTML5_QR_FORMAT_MAP[format];
      return enumKey && SupportedFormats[enumKey] !== undefined ? SupportedFormats[enumKey] : null;
    })
    .filter(function (value) {
      return value !== null;
    });
}


async function createDetector() {
  if (state.detector) return state.detector;

  try {
    if (!window.Html5Qrcode) {
      await waitForHtml5QrReady(1500);
    }
    if (!window.Html5Qrcode) {
      return null;
    }

    const formats = getHtml5QrFormats();
    state.detector = new window.Html5Qrcode("html5QrScanHost", {
      verbose: false,
      formatsToSupport: formats.length ? formats : undefined,
      useBarCodeDetectorIfSupported: true
    });
    return state.detector;
  } catch {
    return null;
  }
}


function supportsConfiguredScannerEngine() {
  return Boolean(window.Html5Qrcode);
}

/** Camera preview only: HTTPS + getUserMedia. Does not require BarcodeDetector (Safari needs a polyfill). */

function getCameraHardwareIssue() {
  if (!window.isSecureContext) {
    return 'Camera access needs a secure page, like "https://" or "http://localhost".';
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return "This browser does not support camera access.";
  }
  return "";
}


function getCameraSupportIssue() {
  const hardwareIssue = getCameraHardwareIssue();
  if (hardwareIssue) {
    return hardwareIssue;
  }
  if (!supportsConfiguredScannerEngine()) {
    return isIOSDevice()
      ? "The iPhone barcode scanner library did not load."
      : "The Android barcode scanner library did not load.";
  }
  return "";
}


function setPreviewActive(active) {
  state.els.previewPlaceholder.hidden = active;
  state.els.previewPlaceholder.style.display = active ? "none" : "grid";
  state.els.cameraBadge.textContent = active ? "" : "Preview off";
  state.els.cameraBadge.hidden = active;
}


function updateScanButton() {
  if (!state.isCameraRunning) {
    state.els.scanBtn.textContent = "Start Scanning";
    state.els.scanBtn.dataset.mode = "start";
    return;
  }
  if (state.isScanning) {
    state.els.scanBtn.textContent = "Stop Scanning";
    state.els.scanBtn.dataset.mode = "stop";
    return;
  }
  state.els.scanBtn.textContent = "Start Scanning";
  state.els.scanBtn.dataset.mode = "start";
}


function updateModePill() {
  state.els.previewFrame.classList.toggle("is-scanning", state.isScanning);
}


function cleanupScanTimer() {
  if (state.scanTimer) {
    window.clearTimeout(state.scanTimer);
    state.scanTimer = 0;
  }
  if (state.scanAnimationFrame && typeof window.cancelAnimationFrame === "function") {
    window.cancelAnimationFrame(state.scanAnimationFrame);
    state.scanAnimationFrame = 0;
  }
  state.isScanLoopScheduled = false;
  state.isScanInFlight = false;
}


function clearFocusRefreshTimers() {
  if (!Array.isArray(state.focusRefreshTimers)) {
    state.focusRefreshTimers = [];
    return;
  }
  for (let index = 0; index < state.focusRefreshTimers.length; index += 1) {
    window.clearTimeout(state.focusRefreshTimers[index]);
  }
  state.focusRefreshTimers = [];
}


function stopPreviewWatchdog() {
  if (state.previewWatchdogTimer) {
    window.clearInterval(state.previewWatchdogTimer);
    state.previewWatchdogTimer = 0;
  }
  state.stalledPreviewChecks = 0;
  state.lastPreviewTime = 0;
}


function clearResumePreviewTimer() {
  if (state.resumePreviewTimer) {
    window.clearTimeout(state.resumePreviewTimer);
    state.resumePreviewTimer = 0;
  }
}


function scheduleQuickPreviewResumeCheck() {
  clearResumePreviewTimer();
  if (document.hidden) {
    return;
  }

  state.resumePreviewTimer = window.setTimeout(function () {
    state.resumePreviewTimer = 0;
    ensurePreviewReadyAfterForeground().catch(() => {
      // Ignore foreground-recovery noise.
    });
  }, 280);
}


async function ensurePreviewReadyAfterForeground() {
  if (document.hidden || state.isRecoveringPreview) {
    return;
  }

  if (!state.isCameraRunning) {
    await startCamera(state.activeDeviceId);
    return;
  }

  const video = getPreviewVideoElement();
  if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.paused || video.ended) {
    await recoverPreviewFromFreeze();
    return;
  }

  // Stream is already healthy after foreground resume; ensure placeholder is hidden.
  setPreviewActive(true);

  const previousTime = Number(video.currentTime || 0);
  await new Promise(function (resolve) {
    window.setTimeout(resolve, 320);
  });

  if (document.hidden || state.isRecoveringPreview) {
    return;
  }

  const currentVideo = getPreviewVideoElement();
  const currentTime = Number(currentVideo?.currentTime || 0);
  if (!currentVideo || Math.abs(currentTime - previousTime) < 0.01) {
    await recoverPreviewFromFreeze();
  } else {
    setPreviewActive(true);
  }
}


async function recoverPreviewFromFreeze() {
  if (state.isRecoveringPreview || !state.isCameraRunning) {
    return;
  }

  state.isRecoveringPreview = true;
  const shouldResumeScanning = state.isScanning;
  const selectedDeviceId = state.activeDeviceId || state.els.cameraSelect.value;
  stopScanning(true);
  setStatus("Camera preview paused, reconnecting...");

  try {
    await startCamera(selectedDeviceId);
    if (shouldResumeScanning) {
      await startScanning();
    } else {
      setStatus("Camera preview restored");
    }
  } catch (error) {
    setStatus(error.message || "Camera preview recovery failed");
  } finally {
    state.isRecoveringPreview = false;
  }
}


function startPreviewWatchdog() {
  stopPreviewWatchdog();
  if (!state.isCameraRunning) {
    return;
  }

  state.lastPreviewTime = Number(getPreviewVideoElement()?.currentTime || 0);
  state.previewWatchdogTimer = window.setInterval(function () {
    if (!state.isCameraRunning || state.isRecoveringPreview || document.hidden) {
      return;
    }

    const video = getPreviewVideoElement();
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      return;
    }

    const currentTime = Number(video.currentTime || 0);
    if (Math.abs(currentTime - state.lastPreviewTime) < 0.01) {
      state.stalledPreviewChecks += 1;
    } else {
      state.lastPreviewTime = currentTime;
      state.stalledPreviewChecks = 0;
    }

    if (state.stalledPreviewChecks >= CONFIG.previewStallThreshold) {
      state.stalledPreviewChecks = 0;
      recoverPreviewFromFreeze().catch(() => {
        // Ignore watchdog recovery noise.
      });
    }
  }, CONFIG.previewWatchIntervalMs);
}


async function stopTracks() {
  stopPreviewWatchdog();
  clearFocusRefreshTimers();
  state.isCameraRunning = false;
  state.torchOn = false;
  updateTorchUi(false, false);
  const scanner = state.scanner;
  const currentStream = state.stream;
  state.scanner = null;
  state.scannerEngine = "";

  state.stream = null;
  state.track = null;
  state.detector = null;
  setActivePreviewEngine("");

  if (scanner?.stream?.getTracks) {
    const scannerTracks = scanner.stream.getTracks();
    for (let index = 0; index < scannerTracks.length; index += 1) {
      try {
        scannerTracks[index].stop();
      } catch {
        // Ignore cleanup issues from stale tracks.
      }
    }
  }

  if (currentStream?.getTracks) {
    const tracks = currentStream.getTracks();
    for (let index = 0; index < tracks.length; index += 1) {
      try {
        tracks[index].stop();
      } catch {
        // Ignore stream teardown issues.
      }
    }
  }

  if (state.els.cameraPreview instanceof HTMLVideoElement) {
    try {
      state.els.cameraPreview.pause();
    } catch {
      // Ignore pause issues on detached previews.
    }
    try {
      state.els.cameraPreview.srcObject = null;
    } catch {
      // Ignore srcObject cleanup issues.
    }
    state.els.cameraPreview.removeAttribute("src");
    try {
      state.els.cameraPreview.load();
    } catch {
      // Ignore load reset issues.
    }
  }

  if (state.els.cameraPreviewQuagga) {
    state.els.cameraPreviewQuagga.innerHTML = "";
  }
}


function updateResolutionBadge() {
  const liveTrack = state.track || getActiveStreamTrackFromPreview();
  if (!liveTrack?.getSettings) {
    state.els.resolutionBadge.textContent = "0 x 0";
    return;
  }

  const settings = liveTrack.getSettings();
  const video = getPreviewVideoElement();
  const width = settings.width || video?.videoWidth || 0;
  const height = settings.height || video?.videoHeight || 0;
  state.els.resolutionBadge.textContent = `${width} x ${height}`;
}


function buildDeviceLabel(device, index) {
  return device.label || `Camera ${index + 1}`;
}


function isLikelyProblematicIOSCameraLabel(label) {
  return /tele|triple|long.?focus|0\.5x|2x|3x|continuity|desk|front|true.?depth|facetime|前置|长焦|三镜头/i.test(label || "");
}


function scoreVideoDevice(device, index) {
  const label = String(device?.label || "");
  let score = 0;

  if (isIOSDevice()) {
    if (/超广角|ultra.?wide/i.test(label)) {
      score += 260;
    }
    if (/双广角|dual.?wide/i.test(label)) {
      score += 220;
    }
    if (/后置相机|back camera|rear camera/i.test(label)) {
      score += 180;
    }
    if (/后置双镜头|dual camera/i.test(label)) {
      score += 120;
    }
    if (/三镜头|triple/i.test(label)) {
      score -= 140;
    }
    if (/长焦|tele/i.test(label)) {
      score -= 220;
    }
    if (/前置|front|user|true.?depth|facetime/i.test(label)) {
      score -= 260;
    }
    if (!label && index === 0) {
      score -= 30;
    }
    return score;
  }

  if (/back camera|rear camera/i.test(label)) {
    score += 140;
  }
  if (/back|rear|environment/i.test(label)) {
    score += 90;
  }
  if (/\bwide\b|main|1x/i.test(label)) {
    score += 40;
  }
  if (/front|user|true.?depth|facetime/i.test(label)) {
    score -= 140;
  }
  if (/ultra|tele|macro|0\.5x|2x|3x|continuity|desk/i.test(label)) {
    score -= 80;
  }
  if (!label && index === 0) {
    score += 5;
  }
  if (isIOSDevice() && !label) {
    score += Math.max(0, 10 - index);
  }

  return score;
}


function chooseBestDefaultDevice(devices) {
  if (!devices || devices.length === 0) return "";

  const rankedDevices = devices
    .map(function (device, index) {
      return {
        device: device,
        score: scoreVideoDevice(device, index),
        index: index
      };
    })
    .sort(function (left, right) {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.index - right.index;
    });

  return rankedDevices[0]?.device?.deviceId || devices[0].deviceId;
}


function resolvePreferredDeviceId(devices, preferredDeviceId) {
  if (!devices || devices.length === 0) {
    return "";
  }

  const preferredDevice = devices.find(function (device) {
    return device.deviceId === preferredDeviceId;
  });

  if (
    isIOSDevice() &&
    preferredDevice &&
    isLikelyProblematicIOSCameraLabel(preferredDevice.label)
  ) {
    return chooseBestDefaultDevice(devices);
  }

  return preferredDevice?.deviceId || chooseBestDefaultDevice(devices);
}


async function refreshDevices(preferredDeviceId) {
  const mediaDevices = await navigator.mediaDevices.enumerateDevices();
  const devices = mediaDevices.filter((device) => device.kind === "videoinput");

  state.devices = devices;
  const savedCameraId = readSavedCameraId();
  const requestedId = preferredDeviceId || state.activeDeviceId || savedCameraId || "";
  const fallbackId = resolvePreferredDeviceId(state.devices, requestedId);
  const hasMatch = state.devices.some((device) => device.deviceId === fallbackId);
  const currentId = hasMatch ? fallbackId : chooseBestDefaultDevice(state.devices);
  state.activeDeviceId = currentId;
  state.els.cameraSelect.innerHTML = "";

  for (let index = 0; index < state.devices.length; index += 1) {
    const device = state.devices[index];
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = buildDeviceLabel(device, index);
    option.selected = device.deviceId === currentId;
    state.els.cameraSelect.appendChild(option);
  }

  state.els.cameraSelect.disabled = state.devices.length === 0;
  if (currentId) {
    saveCameraId(currentId);
  }
}


async function handleDetectedCode(detectedText) {
  const code = String(detectedText || "").trim();
  if (!state.isScanning || !code) {
    return;
  }

  if (state.els.barcodeInput.value !== code) {
    state.els.barcodeInput.value = code;
  }
  playCaptureSound();
  stopScanning(true);

  try {
    if (state.isQuantityEntryUnlocked) {
      await fetchProductInfo(code, {
        allowClosestSearch: false,
        addToHistoryBeforeLookup: false,
        persistToHistory: false
      });
      state.els.quantityInput.value = sanitizeEditableQuantity(state.els.quantityInput.value);

      if (state.isIOS) {
        window.setTimeout(function () {
          moveFocusToInput(state.els.quantityInput);
          selectEntireInputValue({ target: state.els.quantityInput });
        }, 80);
      } else {
        moveFocusToInput(state.els.quantityInput);
      }
      return;
    }
    await fetchProductInfo(code);
  } catch (error) {
    state.lastDetectedBarcode = "";
    state.lastDetectedAt = 0;
    setStatus(error.message || "Barcode was captured, but info request failed");
  }
}


function getSquareCropSize(video) {
  const preferredSquareSize = state.isMobileUi ? CONFIG.mobilePreferredSquareSize : CONFIG.preferredSquareSize;
  const width = video.videoWidth || preferredSquareSize;
  const height = video.videoHeight || preferredSquareSize;
  return Math.max(1, Math.min(width, height));
}


function getDetectionCropModes() {
  return ["expanded", "visible"];
}


function getScanLoopIntervalMs() {
  if (state.isIOS) {
    return CONFIG.iosScanIntervalMs;
  }
  if (state.isMobileUi) {
    return CONFIG.mobileScanIntervalMs;
  }
  return CONFIG.scanIntervalMs;
}


function getCoverSourceRect(videoWidth, videoHeight, containerWidth, containerHeight) {
  const videoRatio = videoWidth / videoHeight;
  const containerRatio = containerWidth / containerHeight;
  let visibleWidth = videoWidth;
  let visibleHeight = videoHeight;
  let offsetX = 0;
  let offsetY = 0;

  if (videoRatio > containerRatio) {
    visibleHeight = videoHeight;
    visibleWidth = videoHeight * containerRatio;
    offsetX = (videoWidth - visibleWidth) / 2;
  } else {
    visibleWidth = videoWidth;
    visibleHeight = videoWidth / containerRatio;
    offsetY = (videoHeight - visibleHeight) / 2;
  }

  return { offsetX: offsetX, offsetY: offsetY, visibleWidth: visibleWidth, visibleHeight: visibleHeight };
}


function getRoiRect() {
  const width = state.roi.width;
  const height = state.roi.height;
  return {
    left: (1 - width) / 2,
    top: (1 - height) / 2,
    width: width,
    height: height
  };
}


function getRoiCropRect(videoWidth, videoHeight) {
  const container = state.els.previewFrame;
  const containerWidth = (container && container.clientWidth) || videoWidth;
  const containerHeight = (container && container.clientHeight) || videoHeight;
  const cover = getCoverSourceRect(videoWidth, videoHeight, containerWidth, containerHeight);
  const roi = getRoiRect();

  const sx = cover.offsetX + roi.left * cover.visibleWidth;
  const sy = cover.offsetY + roi.top * cover.visibleHeight;
  const sw = roi.width * cover.visibleWidth;
  const sh = roi.height * cover.visibleHeight;

  return {
    sx: Math.max(0, Math.round(sx)),
    sy: Math.max(0, Math.round(sy)),
    sw: Math.max(1, Math.round(Math.min(sw, videoWidth))),
    sh: Math.max(1, Math.round(Math.min(sh, videoHeight)))
  };
}


function drawDetectionFrame(mode, maxOutputSize = 1920) {
  const video = state.els.cameraPreview;
  const canvas = state.els.captureCanvas;
  const context = state.captureContext || canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  const videoWidth = video.videoWidth || (state.isMobileUi ? CONFIG.mobilePreferredSquareSize : CONFIG.preferredSquareSize);
  const videoHeight = video.videoHeight || (state.isMobileUi ? CONFIG.mobilePreferredSquareSize : CONFIG.preferredSquareSize);
  let sx = 0;
  let sy = 0;
  let sw = videoWidth;
  let sh = videoHeight;
  const isiOS = state.isIOS;

  if (mode === "expanded" || mode === "visible") {
    const container = state.els.previewFrame;
    const cover = getCoverSourceRect(videoWidth, videoHeight,
      container?.clientWidth || videoWidth, container?.clientHeight || videoHeight);
    // The box is an aiming guide, never a hard clipping boundary.
    const widthRatio = mode === "visible" ? 1 : Math.min(1, Math.max(0.85, state.roi.width * 1.5));
    const heightRatio = mode === "visible" ? 1 : Math.min(1, Math.max(0.5, state.roi.height * 1.5));
    sw = cover.visibleWidth * widthRatio;
    sh = cover.visibleHeight * heightRatio;
    sx = cover.offsetX + (cover.visibleWidth - sw) / 2;
    sy = cover.offsetY + (cover.visibleHeight - sh) / 2;
  } else if (mode === "roi") {
    const roiRect = getRoiCropRect(videoWidth, videoHeight);
    sx = roiRect.sx;
    sy = roiRect.sy;
    sw = roiRect.sw;
    sh = roiRect.sh;
  } else if (mode === "wide") {
    sw = Math.max(1, Math.floor(videoWidth * (isiOS ? 0.98 : 0.94)));
    sh = Math.max(1, Math.floor(videoHeight * (isiOS ? 0.52 : 0.38)));
    sx = Math.max(0, Math.floor((videoWidth - sw) / 2));
    sy = Math.max(0, Math.floor((videoHeight - sh) / 2));
  } else if (mode === "square") {
    const squareSize = getSquareCropSize(video);
    const cropScale = isiOS ? 0.92 : 1;
    sw = Math.max(1, Math.floor(squareSize * cropScale));
    sh = Math.max(1, Math.floor(squareSize * cropScale));
    sx = Math.max(0, Math.floor((videoWidth - squareSize) / 2));
    sy = Math.max(0, Math.floor((videoHeight - squareSize) / 2));
    if (cropScale !== 1) {
      sx = Math.max(0, Math.floor((videoWidth - sw) / 2));
      sy = Math.max(0, Math.floor((videoHeight - sh) / 2));
    }
  }

  const scale = Math.min(1, maxOutputSize / Math.max(sw, sh));
  const outputWidth = Math.max(1, Math.round(sw * scale));
  const outputHeight = Math.max(1, Math.round(sh * scale));

  if (canvas.width !== outputWidth) {
    canvas.width = outputWidth;
  }
  if (canvas.height !== outputHeight) {
    canvas.height = outputHeight;
  }

  context.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}


const ROI_MIN_RATIO = 0.12;

const ROI_MAX_RATIO = 1;


function loadRoiState() {
  try {
    const raw = localStorage.getItem(CONFIG.roiStorageKey);
    if (!raw) {
      return;
    }
    const parsed = JSON.parse(raw);
    const width = Number(parsed?.width);
    const height = Number(parsed?.height);
    if (Number.isFinite(width) && width >= ROI_MIN_RATIO && width <= ROI_MAX_RATIO) {
      state.roi.width = width;
    }
    if (Number.isFinite(height) && height >= ROI_MIN_RATIO && height <= ROI_MAX_RATIO) {
      state.roi.height = height;
    }
  } catch {
    // Ignore corrupt/missing saved ROI size and keep the default.
  }
}


function saveRoiState() {
  try {
    localStorage.setItem(CONFIG.roiStorageKey, JSON.stringify({
      width: state.roi.width,
      height: state.roi.height
    }));
  } catch {
    // Ignore storage failures (e.g. private browsing quota).
  }
}


function applyRoiBoxStyle() {
  const roiBox = state.els.roiBox;
  if (!roiBox) {
    return;
  }
  const roi = getRoiRect();
  roiBox.style.left = `${roi.left * 100}%`;
  roiBox.style.top = `${roi.top * 100}%`;
  roiBox.style.width = `${roi.width * 100}%`;
  roiBox.style.height = `${roi.height * 100}%`;
}


function initRoiResize() {
  const handle = state.els.roiResizeHandle;
  const container = state.els.previewFrame;
  if (!handle || !container) {
    return;
  }

  handle.addEventListener("pointerdown", function (event) {
    event.preventDefault();
    event.stopPropagation();

    const rect = container.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }

    state.roiDrag = {
      pointerId: event.pointerId,
      startWidth: state.roi.width,
      startHeight: state.roi.height
    };

    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // Ignore browsers that do not support pointer capture here.
    }
  });

  handle.addEventListener("pointermove", function (event) {
    const drag = state.roiDrag;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    const rect = container.getBoundingClientRect();
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;

    // The handle sits at the box's bottom-right corner. Since the box is
    // always centered, distance from the container center to the pointer
    // is the box's half-width/half-height — resizing grows/shrinks the
    // box symmetrically in all directions, keeping it centered live.
    let widthRatio = ((pointerX - centerX) / rect.width) * 2;
    let heightRatio = ((pointerY - centerY) / rect.height) * 2;

    widthRatio = Math.min(ROI_MAX_RATIO, Math.max(ROI_MIN_RATIO, widthRatio));
    heightRatio = Math.min(ROI_MAX_RATIO, Math.max(ROI_MIN_RATIO, heightRatio));

    state.roi.width = widthRatio;
    state.roi.height = heightRatio;
    applyRoiBoxStyle();
  });

  function endDrag(event) {
    const drag = state.roiDrag;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    state.roiDrag = null;

    const sizeChanged =
      Math.abs(state.roi.width - drag.startWidth) > 0.005 ||
      Math.abs(state.roi.height - drag.startHeight) > 0.005;

    if (sizeChanged) {
      saveRoiState();
      restartCameraForRoiResize();
    }
  }

  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);
}


async function restartCameraForRoiResize() {
  if (!state.isCameraRunning) {
    return;
  }

  const deviceId = state.activeDeviceId;
  const wasScanning = state.isScanning;

  setStatus("Adjusting scan area...");
  stopScanning(true);
  await startCamera(deviceId);

  if (wasScanning) {
    await startScanning();
  }
}


function normalizeDetectedText(result) {
  return String(
    result?.rawValue ||
    result?.rawValueString ||
    result?.decodedText ||
    result?.codeResult?.code ||
    result?.value ||
    result ||
    ""
  ).trim();
}


function canvasToImageFile(canvas) {
  return new Promise(function (resolve, reject) {
    canvas.toBlob(function (blob) {
      if (!blob) {
        reject(new Error("Canvas produced no image data"));
        return;
      }
      resolve(new File([blob], "frame.jpg", { type: "image/jpeg" }));
    }, "image/jpeg", 0.85);
  });
}


async function detectBarcodeInFrame() {
  const session = state.scanSession;
  const detector = await createDetector();
  const attempt = state.detectionAttempt || 0;
  // Quick center/full-preview passes, then high-resolution difficult-label passes.
  const confirming = Boolean(state.pendingConfirmCode && state.lastDetectionPass);
  const pass = confirming ? state.lastDetectionPass : {
    mode: getDetectionCropModes()[attempt % 2],
    thorough: attempt % 4 >= 2
  };
  const canvas = drawDetectionFrame(pass.mode, pass.thorough ? 1920 : 1280);
  const context = state.captureContext || canvas.getContext("2d", { willReadFrequently: true });
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const text = await detector.detect(image,
    CONFIG.detectorFormats.map((format) => ZXING_FORMAT_MAP[format]).filter(Boolean),
    { thorough: pass.thorough });
  if (session === state.scanSession) {
    state.detectionAttempt = attempt + 1;
    if (text) state.lastDetectionPass = pass;
  }
  return text;
}


function waitForFreshVideoFrame(video) {
  if (!video) {
    return Promise.resolve();
  }

  if (typeof video.requestVideoFrameCallback === "function") {
    return new Promise(function (resolve) {
      let settled = false;
      const timerId = window.setTimeout(function () {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      }, state.isIOS ? 55 : 35);

      video.requestVideoFrameCallback(function () {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timerId);
        resolve();
      });
    });
  }

  return new Promise(function (resolve) {
    window.setTimeout(resolve, state.isIOS ? 24 : 16);
  });
}


function wasRecentlyDetected(detectedText) {
  const code = String(detectedText || "").trim();
  if (!code) {
    return false;
  }

  const now = Date.now();
  if (state.lastDetectedBarcode === code && (now - state.lastDetectedAt) < CONFIG.duplicateScanCooldownMs) {
    return true;
  }

  state.lastDetectedBarcode = code;
  state.lastDetectedAt = now;
  return false;
}


function confirmAcrossFrames(detectedText) {
  const code = String(detectedText || "").trim();
  if (!code) {
    state.pendingConfirmCode = "";
    state.pendingConfirmCount = 0;
    return false;
  }

  if (state.pendingConfirmCode === code) {
    state.pendingConfirmCount += 1;
  } else {
    state.pendingConfirmCode = code;
    state.pendingConfirmCount = 1;
  }

  if (state.pendingConfirmCount >= 2) {
    state.pendingConfirmCode = "";
    state.pendingConfirmCount = 0;
    return true;
  }

  return false;
}


async function captureAttempt() {
  const video = state.els.cameraPreview;
  if (!state.isCameraRunning || !state.track || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    return false;
  }

  await waitForFreshVideoFrame(video);
  const detectedText = await detectBarcodeInFrame();

  if (!detectedText) {
    confirmAcrossFrames("");
    setStatus("Scanning... aim at the barcode; no exact box alignment needed");
    return false;
  }

  if (!confirmAcrossFrames(detectedText)) {
    setStatus("Confirming barcode...");
    return false;
  }

  if (wasRecentlyDetected(detectedText)) {
    return false;
  }

  await handleDetectedCode(detectedText);
  return true;
}


function scheduleScanCallback(callback, delayMs) {
  state.scanTimer = window.setTimeout(function () {
    state.scanTimer = 0;
    if (typeof window.requestAnimationFrame === "function") {
      state.scanAnimationFrame = window.requestAnimationFrame(function () {
        state.scanAnimationFrame = 0;
        callback();
      });
      return;
    }

    callback();
  }, delayMs);
}


async function runScanLoop() {
  if (!state.isScanning || state.isScanLoopScheduled) {
    return;
  }

  state.isScanLoopScheduled = true;
  scheduleScanCallback(function () {
    state.isScanLoopScheduled = false;
    if (!state.isScanning || state.isScanInFlight) {
      if (state.isScanning) {
        runScanLoop().catch(() => {
          // Ignore transient reschedule issues.
        });
      }
      return;
    }

    (async function () {
      state.isScanInFlight = true;
      try {
        const detected = await captureAttempt();
        if (!detected && state.isScanning) {
          runScanLoop().catch(() => {
            // Ignore transient reschedule issues.
          });
        }
      } catch {
        setStatus("Scanning had a temporary read error");
        if (state.isScanning) {
          runScanLoop().catch(() => {
            // Ignore transient reschedule issues.
          });
        }
      } finally {
        state.isScanInFlight = false;
      }
    }()).catch(() => {
      // Ignore transient async scan loop issues.
    });
  }, getScanLoopIntervalMs());
}


async function startCameraWithPonyfillDetector(preferredCameraId, activeVideoConfig) {
  setActivePreviewEngine("ponyfill");

  const constraints = {
    audio: false,
    video: {}
  };
  const requestedVideo = activeVideoConfig?.video || {};

  if (requestedVideo.width) {
    constraints.video.width = {
      ideal: requestedVideo.width.ideal,
      max: requestedVideo.width.max
    };
  }
  if (requestedVideo.height) {
    constraints.video.height = {
      ideal: requestedVideo.height.ideal,
      max: requestedVideo.height.max
    };
  }
  if (requestedVideo.aspectRatio) {
    constraints.video.aspectRatio = { ideal: requestedVideo.aspectRatio.ideal };
  }
  if (requestedVideo.frameRate) {
    constraints.video.frameRate = {
      ideal: requestedVideo.frameRate.ideal,
      max: requestedVideo.frameRate.max
    };
  }
  if (requestedVideo.resizeMode) {
    constraints.video.resizeMode = requestedVideo.resizeMode;
  }

  if (preferredCameraId) {
    constraints.video.deviceId = { exact: preferredCameraId };
  } else {
    constraints.video.facingMode = { ideal: requestedVideo?.facingMode?.ideal || "environment" };
  }

  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const track = stream.getVideoTracks()[0] || null;

  state.stream = stream;
  state.track = track;
  state.scanner = { stream: stream };
  state.scannerEngine = "ponyfill";
  state.activeDeviceId = track?.getSettings?.().deviceId || preferredCameraId || state.activeDeviceId;
  saveCameraId(state.activeDeviceId);

  state.els.cameraPreview.srcObject = stream;
  await waitForVideoReadiness(state.els.cameraPreview);
  await state.els.cameraPreview.play();
  await applyTrackEnhancements(track, activeVideoConfig);
  scheduleFocusRefresh(track);
  await refreshDevices(state.activeDeviceId);
}


function waitForVideoReadiness(video) {
  if (!video) {
    return Promise.resolve();
  }

  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
    return Promise.resolve();
  }

  return new Promise(function (resolve) {
    let settled = false;
    function finish() {
      if (settled) {
        return;
      }
      settled = true;
      video.removeEventListener("loadedmetadata", finish);
      video.removeEventListener("loadeddata", finish);
      resolve();
    }

    video.addEventListener("loadedmetadata", finish, { once: true });
    video.addEventListener("loadeddata", finish, { once: true });
    window.setTimeout(finish, isIOSDevice() ? 900 : 400);
  });
}


async function requestFocusRefresh(track) {
  if (!track?.getCapabilities || !track.applyConstraints || track.readyState === "ended") {
    return;
  }

  const capabilities = track.getCapabilities();
  const advanced = [];

  if (Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes("continuous")) {
    advanced.push({ focusMode: "continuous" });
  } else if (Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes("single-shot")) {
    advanced.push({ focusMode: "single-shot" });
  }

  if (!isIOSDevice() && capabilities.zoom && typeof capabilities.zoom.max === "number") {
    const minZoom = typeof capabilities.zoom.min === "number" ? capabilities.zoom.min : 1;
    const desiredZoom = capabilities.zoom.max >= 1.4 ? Math.max(minZoom, 1.1) : minZoom;
    if (desiredZoom > minZoom) {
      advanced.push({ zoom: desiredZoom });
    }
  }

  if (advanced.length === 0) {
    return;
  }

  try {
    await track.applyConstraints({ advanced: advanced });
  } catch {
    // Device-specific camera focus controls can fail transiently.
  }
}


function scheduleFocusRefresh(track) {
  clearFocusRefreshTimers();
  const delays = isIOSDevice() ? [150, 700, 1600] : [120, 500, 1200];
  for (let index = 0; index < delays.length; index += 1) {
    const timerId = window.setTimeout(function () {
      requestFocusRefresh(track).catch(() => {
        // Ignore autofocus refresh noise.
      });
    }, delays[index]);
    state.focusRefreshTimers.push(timerId);
  }
}


async function applyTrackEnhancements(track, activeVideoConfig) {
  if (!track?.getCapabilities || !track.applyConstraints) return;
  if (isIOSDevice()) {
    await requestFocusRefresh(track);
    return;
  }

  const baseVideoConfig = activeVideoConfig?.video || getActiveVideoConfig().video;
  const baseConstraints = {};

  if (baseVideoConfig?.width) {
    baseConstraints.width = baseVideoConfig.width;
  }
  if (baseVideoConfig?.height) {
    baseConstraints.height = baseVideoConfig.height;
  }
  if (baseVideoConfig?.aspectRatio) {
    baseConstraints.aspectRatio = baseVideoConfig.aspectRatio;
  }
  if (baseVideoConfig?.frameRate) {
    baseConstraints.frameRate = baseVideoConfig.frameRate;
  }
  if (baseVideoConfig?.resizeMode) {
    baseConstraints.resizeMode = baseVideoConfig.resizeMode;
  }

  if (Object.keys(baseConstraints).length > 0) {
    try {
      await track.applyConstraints(baseConstraints);
    } catch {
      // Ignore base resolution requests that are not supported by this device.
    }
  }

  const capabilities = track.getCapabilities();
  if (!capabilities) return;
  await requestFocusRefresh(track);
}


function getTorchTrack() {
  return state.track || getActiveStreamTrackFromPreview() || null;
}


function readTorchStateFromTrack(track) {
  if (!track?.getSettings) {
    return state.torchOn;
  }

  try {
    const settings = track.getSettings();
    if (typeof settings.torch === "boolean") {
      return settings.torch;
    }
  } catch {
    // Ignore unsupported settings reads.
  }

  return state.torchOn;
}


function updateTorchUi(supported, enabled) {
  if (!state.els?.torchBtn) {
    return;
  }

  const isEnabled = Boolean(enabled);
  state.els.torchBtn.disabled = !state.isCameraRunning;
  state.els.torchBtn.classList.toggle("is-on", isEnabled);
  state.els.torchBtn.classList.toggle("torch-on", isEnabled);
  state.els.torchBtn.setAttribute(
    "aria-label",
    state.isCameraRunning ? (isEnabled ? "Torch on" : "Torch off") : "Torch unavailable"
  );
  state.els.torchBtn.title = state.isCameraRunning ? (isEnabled ? "Torch on" : "Torch off") : "Torch unavailable";
}


async function syncTorchSupport() {
  const liveTrack = getTorchTrack();
  if (!liveTrack?.getCapabilities) {
    state.torchOn = false;
    updateTorchUi(false, false);
    return;
  }

  const capabilities = liveTrack.getCapabilities();
  const supported = !!capabilities.torch;
  if (!supported) {
    state.torchOn = readTorchStateFromTrack(liveTrack);
  } else {
    state.torchOn = readTorchStateFromTrack(liveTrack);
  }
  updateTorchUi(true, state.torchOn);
}


async function toggleTorch() {
  const liveTrack = getTorchTrack();
  if (!liveTrack?.applyConstraints || !liveTrack.getCapabilities) {
    setStatus("Torch is not available because the camera is not ready");
    updateTorchUi(false, false);
    return;
  }

  const capabilities = liveTrack.getCapabilities();
  const nextTorchState = !readTorchStateFromTrack(liveTrack);
  try {
    await liveTrack.applyConstraints({ advanced: [{ torch: nextTorchState }] });
    state.torchOn = readTorchStateFromTrack(liveTrack);
    if (state.torchOn !== nextTorchState) {
      state.torchOn = nextTorchState;
    }
    updateTorchUi(true, state.torchOn);
    setStatus(state.torchOn ? "Torch enabled" : "Torch disabled");
  } catch (error) {
    state.torchOn = false;
    updateTorchUi(false, false);
    setStatus(error?.message || (capabilities.torch ? "Torch control failed on this device" : "Torch is not supported on this camera"));
  }
}


async function startCamera(deviceId) {
  if (state.cameraStartPromise) {
    await state.cameraStartPromise;
    if (state.isCameraRunning && (!deviceId || deviceId === state.activeDeviceId)) {
      return;
    }
  }

  const startPromise = (async function () {
    const hardwareIssue = getCameraHardwareIssue();
    if (hardwareIssue) throw new Error(hardwareIssue);

    cleanupScanTimer();
    await stopTracks();

    const activeVideoConfig = getActiveVideoConfig();
    await refreshDevices(deviceId || state.activeDeviceId || readSavedCameraId());
    const preferredCameraId = deviceId || state.activeDeviceId || chooseBestDefaultDevice(state.devices);
    await startCameraWithPonyfillDetector(preferredCameraId, activeVideoConfig);

    if (isIOSDevice() && !state.iosWarmRestartDone) {
      state.iosWarmRestartDone = true;
      const restartDeviceId = state.activeDeviceId || preferredCameraId;
      await new Promise(function (resolve) {
        window.setTimeout(resolve, 220);
      });
      await stopTracks();
      await startCameraWithPonyfillDetector(restartDeviceId, activeVideoConfig);
    }

    state.isCameraRunning = true;
    state.isScanning = false;
    await syncTorchSupport();
    setPreviewActive(true);
    updateResolutionBadge();
    updateScanButton();
    updateModePill();
    startPreviewWatchdog();
    setStatus("Camera ready");
  }());

  state.cameraStartPromise = startPromise;
  try {
    await startPromise;
  } finally {
    if (state.cameraStartPromise === startPromise) {
      state.cameraStartPromise = null;
    }
  }
}


function schedulePreviewWarmStart() {
  window.setTimeout(function () {
    startCamera(state.activeDeviceId).catch((error) => {
      setStatus(error.message || "Camera preview could not start automatically");
    });
  }, 0);
}


function clearScanTimeoutTimer() {
  if (state.scanTimeoutTimer) {
    window.clearTimeout(state.scanTimeoutTimer);
    state.scanTimeoutTimer = 0;
  }
}


function startScanTimeoutTimer() {
  clearScanTimeoutTimer();
  state.scanTimeoutTimer = window.setTimeout(function () {
    if (state.isScanning) {
      stopScanning();
      setStatus("Scanning auto-stopped (10s timeout)");
      showToast("Scan auto-stopped after 10s");
    }
  }, 10000);
}


async function startScanning() {
  // Camera preview works fully offline (getUserMedia needs no network).
  if (!state.isCameraRunning) {
    await startCamera(state.activeDeviceId);
  }

  if (state.isScanning) return;

  await waitForHtml5QrReady(isIOSDevice() ? 2000 : 1000);
  if (!(await createDetector())) {
    // Keep preview live; only barcode decode needs the library file.
    setStatus("Camera on. Scanner library missing — add js/html5-qrcode.min.js");
    showToast("Scanner library not loaded");
    updateScanButton();
    return;
  }

  scheduleFocusRefresh(state.track);
  state.detectionAttempt = 0;
  state.lastDetectionPass = null;
  state.isScanning = true;
  startScanTimeoutTimer();
  updateScanButton();
  updateModePill();
  setStatus("Scanning started");
  if (await captureAttempt()) {
    return;
  }
  cleanupScanTimer();
  await runScanLoop();
}

function stopScanning(keepStatusMessage) {
  clearScanTimeoutTimer();
  cleanupScanTimer();
  state.isScanning = false;
  state.pendingConfirmCode = "";
  state.pendingConfirmCount = 0;
  updateScanButton();
  updateModePill();
  if (!keepStatusMessage) {
    setStatus(state.isCameraRunning ? "Scanning stopped, preview still live" : "Camera stopped");
  }
}


async function handleMainButton() {
  if (!state.isCameraRunning) {
    await startCamera(state.activeDeviceId);
  }

  if (state.isScanning) {
    stopScanning();
    return;
  }

  await startScanning();
}


async function handleSelectChange() {
  const selectedId = state.els.cameraSelect.value;
  if (!selectedId || selectedId === state.activeDeviceId) return;

  const shouldResumeScanning = state.isScanning;
  saveCameraId(selectedId);
  stopScanning(true);
  await startCamera(selectedId);
  if (shouldResumeScanning) {
    await startScanning();
  }
}


async function handleBarcodeLookup(options) {
  const nextOptions = {
    ...options
  };
  try {
    return await fetchProductInfo(state.els.barcodeInput.value, nextOptions);
  } catch (error) {
    setStatus(error.message || "Could not load product info");
    return "error";
  }
}
