"use strict";

/* Camera preview, scanning, autofocus, and torch */

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


const ZXING_FORMAT_MAP = {
  ean_13: "EAN13", ean_8: "EAN8", upc_a: "UPCA", upc_e: "UPCE",
  code_128: "Code128", code_39: "Code39", codabar: "Codabar", itf_14: "ITF14",
  code_93: "Code93", data_bar: "DataBar", data_bar_expanded: "DataBarExpanded"
};

async function createDetector() {
  return window.ensureZXingLoaded();
}

function supportsConfiguredScannerEngine() {
  return typeof window.ensureZXingLoaded === "function";
}

/** Camera preview only: HTTPS + getUserMedia. ZXing WASM handles decoding on both Android and iOS. */

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


function isCameraPermissionError(error) {
  return ["NotAllowedError", "SecurityError", "PermissionDeniedError"].includes(error?.name);
}

function disarmFirstGestureCameraStart() {
  // Capture is started only by its explicit button.
}

function setPreviewActive(active) {
  state.els.previewPlaceholder.hidden = active;
  state.els.previewPlaceholder.style.display = active ? "none" : "grid";
  state.els.cameraBadge.textContent = active ? "" : "Preview off";
  state.els.cameraBadge.hidden = active;
}


function updateScanButton() {
  state.els.scanBtn.textContent = "Capture barcode";
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
}


function clearFocusRefreshTimers() {
  const focus = state.track && cameraFocusStates.get(state.track);
  if (focus) {
    focus.manualRequest += 1;
    focus.manualPoint = false;
    focus.scanPoint = null;
  }
  if (state.els?.focusTarget) state.els.focusTarget.hidden = true;
  window.clearTimeout(previewFocusFeedbackTimer);
  if (state.els?.focusHint) state.els.focusHint.textContent = "Tap preview to focus";
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
  if (!state.capturePageOpen || document.hidden || state.cameraStartPromise) {
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
  if (!state.capturePageOpen || document.hidden || state.cameraStartPromise || state.isRecoveringPreview) {
    return;
  }

  if (!state.isCameraRunning) {
    // Resume only the capture screen that is still open.
    try {
      await startScanning();
    } catch {
      state.els.captureRetryBtn.hidden = false;
    }
    return;
  }

  const video = getPreviewVideoElement();
  if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.paused || video.ended) {
    await recoverPreviewFromFreeze();
    return;
  }

  // Stream is already healthy after foreground resume; ensure placeholder is hidden.
  setPreviewActive(true);
  scheduleFocusRefresh(state.track);

  const previousTime = Number(video.currentTime || 0);
  await new Promise(function (resolve) {
    window.setTimeout(resolve, 320);
  });

  if (!state.capturePageOpen || document.hidden || state.isRecoveringPreview) {
    return;
  }

  const currentVideo = getPreviewVideoElement();
  const currentTime = Number(currentVideo?.currentTime || 0);
  if (!currentVideo || Math.abs(currentTime - previousTime) < 0.01) {
    await recoverPreviewFromFreeze();
  } else {
    setPreviewActive(true);
    await ensureScanningAfterForegroundResume();
  }
}


async function ensureScanningAfterForegroundResume() {
  if (!state.capturePageOpen || document.hidden || state.cameraStartPromise || state.isRecoveringPreview) {
    return;
  }
  if (state.isScanning || !state.isCameraRunning) {
    return;
  }
  try {
    await startScanning();
    disarmFirstGestureCameraStart();
  } catch (error) {
    if (error?.name === "AbortError") {
      return;
    }
    if (isCameraPermissionError(error) || !state.isCameraRunning) {
      state.els.captureRetryBtn.hidden = false;
    }
    setStatus(error.message || "Tap Capture to enable the camera", "Camera unavailable");
  }
}


async function recoverPreviewFromFreeze() {
  if (!state.capturePageOpen || state.isRecoveringPreview || !state.isCameraRunning) {
    return;
  }

  state.isRecoveringPreview = true;
  const selectedDeviceId = state.activeDeviceId || state.els.cameraSelect.value;
  stopScanning(true);
  setStatus("Reconnecting camera…");

  try {
    await startCamera(selectedDeviceId);
    // Resume the interrupted capture session.
    await startScanning();
    disarmFirstGestureCameraStart();
  } catch (error) {
    if (isCameraPermissionError(error)) {
      state.els.captureRetryBtn.hidden = false;
    }
    setStatus(error.message || "Camera preview recovery failed", "Camera unavailable");
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
    if (!state.capturePageOpen || !state.isCameraRunning || state.isRecoveringPreview || document.hidden) {
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
  stopScanning(true);
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

  return preferredDevice?.deviceId || chooseBestDefaultDevice(devices);
}


async function refreshDevices(preferredDeviceId, expectedStream) {
  const mediaDevices = await navigator.mediaDevices.enumerateDevices();
  if (expectedStream && state.stream !== expectedStream) return;
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

  captureDiagnostics.mark("barcode.confirmed");

  if (state.els.barcodeInput.value !== code) {
    state.els.barcodeInput.value = code;
  }
  updateQuantityPadAvailability();
  playCaptureSound();
  stopScanning(true);
  if (state.isQuantityEntryUnlocked) {
    openQuantityCapture(code);
    return;
  }
  closeCapturePage({ captured: true });
  setStatus("Barcode captured");

  try {
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
  return ["expanded", "visible", "visible", "visible"];
}


function getScanLoopIntervalMs() {
  // The video callback already paces reads at the camera's frame rate.
  // Avoid an extra timer + animation frame between each pair of reads.
  if (document.hidden || state.isScanInFlight) return 100;
  if (typeof state.els?.cameraPreview?.requestVideoFrameCallback === "function") return 0;
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


function getDetectionFrameGeometry(mode, maxOutputSize = 1920) {
  const video = state.els.cameraPreview;
  const videoWidth = video.videoWidth || (state.isMobileUi ? CONFIG.mobilePreferredSquareSize : CONFIG.preferredSquareSize);
  const videoHeight = video.videoHeight || (state.isMobileUi ? CONFIG.mobilePreferredSquareSize : CONFIG.preferredSquareSize);
  let sx = 0;
  let sy = 0;
  let sw = videoWidth;
  let sh = videoHeight;
  const isiOS = state.isIOS;

  const confirmedRegion = mode === "confirm" && state.lastBarcodeRegion;
  if (confirmedRegion) {
    // Keep quiet zones and room for hand movement, at native sensor resolution.
    // A missed confirmation returns to the whole-preview search next frame.
    const px = Math.max(32, confirmedRegion.width * 0.35);
    const py = Math.max(32, confirmedRegion.width * 0.22, confirmedRegion.height * 0.85);
    sx = Math.max(0, Math.floor(confirmedRegion.x - px));
    sy = Math.max(0, Math.floor(confirmedRegion.y - py));
    sw = Math.min(videoWidth, Math.ceil(confirmedRegion.x + confirmedRegion.width + px)) - sx;
    sh = Math.min(videoHeight, Math.ceil(confirmedRegion.y + confirmedRegion.height + py)) - sy;
  } else if (mode === "target" && cameraFocusStates.get(state.track)?.scanPoint) {
    // A tap also tells the decoder where to look. Keep native pixels and
    // generous quiet zones, alternating with the full preview after a miss.
    const point = cameraFocusStates.get(state.track).scanPoint;
    sw = Math.min(videoWidth, Math.max(640, videoWidth * 0.72));
    sh = Math.min(videoHeight, Math.max(420, videoHeight * 0.36));
    sx = Math.max(0, Math.min(videoWidth - sw, point.x * videoWidth - sw / 2));
    sy = Math.max(0, Math.min(videoHeight - sh, point.y * videoHeight - sh / 2));
  } else if (mode === "expanded" || mode === "detail" || mode === "visible") {
    const container = state.els.previewFrame;
    const cover = getCoverSourceRect(videoWidth, videoHeight,
      container?.clientWidth || videoWidth, container?.clientHeight || videoHeight);
    // Search the center first without spending every pass on the whole preview.
    // The following full-preview pass still finds labels outside this band.
    const widthRatio = mode === "visible" ? 1 : 0.85;
    const heightRatio = mode === "visible" ? 1 : 0.65;
    sw = cover.visibleWidth * widthRatio;
    sh = cover.visibleHeight * heightRatio;
    if (mode === "detail") {
      // Enlarge the central band without changing the 1080p camera stream.
      // Bound each source dimension so enlargement stays within 1920px.
      sw = Math.min(sw, 960);
      sh = Math.min(sh, 960);
    }
    sx = cover.offsetX + (cover.visibleWidth - sw) / 2;
    sy = cover.offsetY + (cover.visibleHeight - sh) / 2;
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

  // Fractional source rectangles blur narrow bars even at native output size.
  // Align the crop to sensor pixels before any intentional enlargement.
  sx = Math.max(0, Math.min(videoWidth - 1, Math.round(sx)));
  sy = Math.max(0, Math.min(videoHeight - 1, Math.round(sy)));
  sw = Math.max(1, Math.min(videoWidth - sx, Math.round(sw)));
  sh = Math.max(1, Math.min(videoHeight - sy, Math.round(sh)));
  const scale = Math.min(mode === "detail" ? 2 : 1, maxOutputSize / Math.max(sw, sh));
  const outputWidth = Math.max(1, Math.round(sw * scale));
  const outputHeight = Math.max(1, Math.round(sh * scale));

  return { sx, sy, sw, sh, outputWidth, outputHeight, videoWidth, videoHeight,
    imageSmoothingEnabled: mode === "detail" };
}


function drawDetectionFrame(mode, maxOutputSize = 1920) {
  const video = state.els.cameraPreview;
  const canvas = state.els.captureCanvas;
  const context = state.captureContext || canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  const geometry = getDetectionFrameGeometry(mode, maxOutputSize);
  const { sx, sy, sw, sh, outputWidth, outputHeight } = geometry;

  if (canvas.width !== outputWidth) {
    canvas.width = outputWidth;
  }
  if (canvas.height !== outputHeight) {
    canvas.height = outputHeight;
  }

  context.imageSmoothingEnabled = mode === "detail";
  context.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  state.captureFrameGeometry = geometry;
  return canvas;
}


// Display only the valid barcode's decoded corners from the worker. Text and
// packaging edges stay invisible; drawing feedback never controls the search.
let barcodeTrackingTimer = 0;

function resetBarcodeTracking() {
  clearTimeout(barcodeTrackingTimer);
  barcodeTrackingTimer = 0;
  if (state.els.barcodeTracker) state.els.barcodeTracker.hidden = true;
}

function getBarcodeTrackingRect(region, frame, width, height) {
  if (!region || !frame || !width || !height) return null;
  const cover = getCoverSourceRect(frame.videoWidth, frame.videoHeight, width, height);
  const scaleX = width / cover.visibleWidth, scaleY = height / cover.visibleHeight;
  const x = (frame.sx + region.x * frame.sw / frame.outputWidth - cover.offsetX) * scaleX;
  const y = (frame.sy + region.y * frame.sh / frame.outputHeight - cover.offsetY) * scaleY;
  const right = x + region.width * frame.sw / frame.outputWidth * scaleX;
  const bottom = y + region.height * frame.sh / frame.outputHeight * scaleY;
  if (![x, y, right, bottom].every(Number.isFinite) || right <= 0 || bottom <= 0 || x >= width || y >= height) return null;
  const left = Math.max(0, x - 4), top = Math.max(0, y - 4);
  return { x: left, y: top, width: Math.min(width, right + 4) - left,
    height: Math.min(height, bottom + 4) - top };
}

function updateBarcodeTracking(region, frame, session) {
  // Late worker replies from a closed/replaced camera must never revive it.
  if (session !== state.scanSession || !state.isScanning || !state.capturePageOpen || document.hidden) return;
  const box = state.els.barcodeTracker, preview = state.els.previewFrame;
  if (!box || !preview) return;
  const rect = getBarcodeTrackingRect(region, frame, preview.clientWidth, preview.clientHeight);
  if (!rect) return;
  const wasHidden = box.hidden;
  // Place the first outline directly; only subsequent positions animate.
  box.style.transition = wasHidden ? "none" : "";
  box.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
  box.style.width = `${rect.width}px`;
  box.style.height = `${rect.height}px`;
  box.hidden = false;
  clearTimeout(barcodeTrackingTimer);
  barcodeTrackingTimer = setTimeout(resetBarcodeTracking, 350);
}


async function detectBarcodeInFrame(frameTiming = {}) {
  const diagnostic = captureDiagnostics.current;
  const started = performance.now();
  const session = state.scanSession;
  const focusRevision = state.focusTargetRevision || 0;
  const detector = await createDetector();
  const attempt = state.detectionAttempt || 0;
  // Keep the successful crop for confirmation on the next fresh camera frame.
  const confirming = Boolean(state.pendingConfirmCode && state.lastDetectionPass);
  const pass = confirming ? state.lastDetectionPass : makeDetectionPass(attempt);
  const focusTarget = cameraFocusStates.get(state.track)?.scanPoint;
  const cropMode = confirming && state.lastBarcodeRegion ? "confirm" :
    focusTarget && attempt % 2 === 0 ? "target" : pass.mode;
  const drawStarted = performance.now();
  let image = null, videoFrame = null, frameGeometry;
  if (detector.videoFrames && !state.workerFrameTransferUnavailable && typeof VideoFrame === "function") {
    try {
      frameGeometry = getDetectionFrameGeometry(cropMode);
      videoFrame = new VideoFrame(state.els.cameraPreview);
      // Geometry is in displayed video coordinates. Rotation metadata can make
      // copyTo's coded coordinates differ; keep those cameras on canvas.
      if (videoFrame.rotation || videoFrame.flip || videoFrame.displayWidth !== frameGeometry.videoWidth ||
          videoFrame.displayHeight !== frameGeometry.videoHeight) {
        videoFrame.close(); videoFrame = null;
      }
    } catch (error) {
      videoFrame?.close(); videoFrame = null;
      state.workerFrameTransferUnavailable = true;
      captureDiagnostics.error("camera.frameTransfer", error, diagnostic);
    }
  }
  let context = null, canvas = null;
  if (!videoFrame) {
    canvas = drawDetectionFrame(cropMode);
    frameGeometry = state.captureFrameGeometry;
    context = state.captureContext || canvas.getContext("2d", { willReadFrequently: true });
  }
  const readStarted = performance.now();
  if (!videoFrame) image = context.getImageData(0, 0, canvas.width, canvas.height);
  const diagnosticsStarted = performance.now();
  let quality = null, videoState = null, sampleQuality = false;
  try {
    if (videoFrame) sampleQuality = captureDiagnostics.reserveImageSample(diagnostic);
    else quality = captureDiagnostics.sampleImage(image, diagnostic);
    videoState = captureDiagnostics.frameState(state.els.cameraPreview, diagnostic);
  } catch (error) { captureDiagnostics.error("diagnostics.imageSample", error, diagnostic); }
  const diagnosticsMs = performance.now() - diagnosticsStarted;
  const decodeStarted = performance.now();
  let worker = null, text = "";
  try {
    text = await detector.detect(videoFrame ? { videoFrame, geometry: frameGeometry, sampleQuality } : image,
    CONFIG.detectorFormats.map((format) => ZXING_FORMAT_MAP[format]).filter(Boolean),
    { thorough: pass.thorough, enhance: pass.enhance, orientation: pass.orientation,
      downscale: pass.mode === "visible", minLineCount: 2,
      focused: pass.focused, budgetMs: confirming ? 240 : pass.budgetMs, binarizer: pass.binarizer,
      regionOffset: pass.regionOffset,
      onDiagnostics: (details) => { worker = details; quality ||= details?.framePreparation?.quality; },
      preferredRegion: confirming && state.lastBarcodeRegion ? {
        x: (state.lastBarcodeRegion.x - frameGeometry.sx) * frameGeometry.outputWidth / frameGeometry.sw,
        y: (state.lastBarcodeRegion.y - frameGeometry.sy) * frameGeometry.outputHeight / frameGeometry.sh,
        width: state.lastBarcodeRegion.width * frameGeometry.outputWidth / frameGeometry.sw,
        height: state.lastBarcodeRegion.height * frameGeometry.outputHeight / frameGeometry.sh
      } : null,
      onFocus: (region) => {
        captureDiagnostics.event("barcode.candidateRegion", { region }, diagnostic);
        assistSmallBarcode(region, frameGeometry, session);
      },
      onRegion: (region) => {
        if (session !== state.scanSession || focusRevision !== (state.focusTargetRevision || 0)) return;
        state.lastBarcodeRegion = {
          x: frameGeometry.sx + region.x * frameGeometry.sw / frameGeometry.outputWidth,
          y: frameGeometry.sy + region.y * frameGeometry.sh / frameGeometry.outputHeight,
          width: region.width * frameGeometry.sw / frameGeometry.outputWidth,
          height: region.height * frameGeometry.sh / frameGeometry.outputHeight
        };
        updateBarcodeTracking(region, frameGeometry, session);
      } });
  } catch (error) {
    if (!videoFrame || !["FramePreparationError", "FrameTransferError"].includes(error.name)) throw error;
    // Unsupported frame transfer/copy is a recoverable capability fallback.
    // Keep this worker and use the canvas route on the next fresh frame.
    state.workerFrameTransferUnavailable = true;
    captureDiagnostics.error("camera.frameTransfer", error, diagnostic);
  } finally {
    videoFrame?.close();
    captureDiagnostics.frame({ ...frameTiming, attempt, pass: { ...pass, confirming },
      drawMs: readStarted - drawStarted, readbackMs: diagnosticsStarted - readStarted,
      decodeMs: performance.now() - decodeStarted, totalMs: performance.now() - started + (frameTiming.waitMs || 0),
      diagnosticsMs, transport: videoFrame ? "video-frame" : "main-canvas", cropMode,
      geometry: frameGeometry, decoded: Boolean(text), worker, quality, videoState,
      targetChanged: focusRevision !== (state.focusTargetRevision || 0) }, diagnostic);
  }
  if (focusRevision !== (state.focusTargetRevision || 0)) return "";
  if (session === state.scanSession) {
    state.detectionAttempt = attempt + 1;
    state.lastDetectionPass = text ? pass : null;
  }
  return text;
}


function makeDetectionPass(attempt) {
  const phase = attempt % 4;
  return {
    mode: getDetectionCropModes()[phase],
    // Keep dense crop reads for short/distant labels; expensive contrast
    // retries only run every fourth pass.
    thorough: true,
    enhance: phase === 3,
    // Prefer another camera frame after a short attempt; every fourth pass
    // gets more time for angled, faint or distant labels. Confirmation reuses
    // the successful crop and gets time to verify it on the next fresh frame.
    budgetMs: phase === 3 ? 240 : 60,
    // Periodic whole-preview reads and rotating candidate priority prevent
    // background text from starving another barcode region.
    // Dedicated whole-preview passes also try fixed angles, independent of
    // clutter that could dominate a crop's measured orientation.
    focused: phase < 2,
    regionOffset: attempt,
    binarizer: phase === 1 ? "FixedThreshold" : "LocalAverage",
    orientation: phase === 3
      ? [45, 15, -15, 30, -30][Math.floor(attempt / 4) % 5] : "auto"
  };
}


function readVideoFrameSample(video, metadata) {
  let decodedFrames = null;
  try {
    const count = video.getVideoPlaybackQuality?.().totalVideoFrames;
    if (Number.isFinite(count) && count > 0) decodedFrames = count;
  } catch (_) { /* Some live streams do not expose playback quality. */ }
  if (decodedFrames === null && Number.isFinite(video.webkitDecodedFrameCount) && video.webkitDecodedFrameCount > 0) {
    decodedFrames = video.webkitDecodedFrameCount;
  }
  return {
    presentedFrames: Number.isFinite(metadata?.presentedFrames) && metadata.presentedFrames > 0 ? metadata.presentedFrames : null,
    decodedFrames,
    mediaTime: Number.isFinite(metadata?.mediaTime) && metadata.mediaTime >= 0 ? metadata.mediaTime : null,
    currentTime: Number.isFinite(video.currentTime) && video.currentTime >= 0 ? video.currentTime : null
  };
}


function hasVideoFrameAdvanced(next, previous) {
  if (!next) return false;
  if (!previous) return true;
  // Live camera callbacks may report mediaTime = 0 for every frame.
  // Prefer counters, including when switching between callbacks and fallback.
  for (const key of ["presentedFrames", "decodedFrames"]) {
    if (next[key] !== null && previous[key] !== null) return next[key] > previous[key];
  }
  if (next.mediaTime !== null && previous.mediaTime !== null && (next.mediaTime > 0 || previous.mediaTime > 0)) {
    return next.mediaTime > previous.mediaTime;
  }
  return next.currentTime !== null && previous.currentTime !== null && next.currentTime > previous.currentTime;
}


function waitForFreshVideoFrame(video) {
  if (!video || video.paused || video.ended) {
    return Promise.resolve(null);
  }

  if (typeof video.requestVideoFrameCallback === "function") {
    return new Promise(function (resolve) {
      const initialFrame = readVideoFrameSample(video);
      let settled = false;
      let callbackId = null;
      let timerId;
      function finish(frame) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timerId);
        resolve(video.paused || video.ended ? null : frame);
      }
      function fallback() {
        if (settled) return;
        const frame = readVideoFrameSample(video);
        // Recover missed callbacks only when the live stream actually advanced.
        finish(hasVideoFrameAdvanced(frame, initialFrame) ? frame : null);
        try {
          if (callbackId !== null) video.cancelVideoFrameCallback?.(callbackId);
        } catch (_) { /* A failed cancellation must not block the fallback. */ }
      }
      // Healthy streams resolve immediately on the next frame. Give slow iOS
      // callbacks time to arrive instead of repeatedly canceling them at 55ms.
      // Android callbacks are reliable: use a short fallback so a missed
      // callback cannot stall capture for 250ms on every attempt. The
      // fallback still decodes only when the stream actually advanced, and
      // the two-fresh-frame confirmation below is untouched.
      timerId = window.setTimeout(fallback, state.isIOS ? 250 : 90);
      try {
        callbackId = video.requestVideoFrameCallback(function (_now, metadata) {
          finish(readVideoFrameSample(video, metadata));
        });
      } catch (_) {
        window.clearTimeout(timerId);
        if (!settled) {
          timerId = window.setTimeout(fallback, state.isIOS ? 24 : 16);
        }
      }
    });
  }

  return new Promise(function (resolve) {
    window.setTimeout(function () {
      resolve(video.paused || video.ended ? null : readVideoFrameSample(video));
    }, state.isIOS ? 24 : 16);
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
    if (state.pendingConfirmCode) captureDiagnostics.event("barcode.confirmationChanged");
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


async function captureAttempt(session) {
  const video = state.els.cameraPreview;
  if (session !== state.scanSession || !state.isScanning || document.hidden ||
      !state.isCameraRunning || !state.track || !video || video.paused || video.ended ||
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    return false;
  }

  // Decoding may take longer than a camera frame. Use an already advanced
  // frame immediately, but never confirm twice from the same frozen frame.
  const waitStarted = performance.now();
  const available = readVideoFrameSample(video);
  const comparableCounters = available.decodedFrames !== null &&
    (!state.lastScanFrame || state.lastScanFrame.decodedFrames !== null);
  const canUseAvailable = comparableCounters || typeof video.requestVideoFrameCallback !== "function";
  const frame = canUseAvailable && hasVideoFrameAdvanced(available, state.lastScanFrame)
    ? available : await waitForFreshVideoFrame(video);
  if (session !== state.scanSession || !state.isScanning || document.hidden) return false;
  if (!hasVideoFrameAdvanced(frame, state.lastScanFrame)) {
    captureDiagnostics.metric("staleFrameWaitMs", performance.now() - waitStarted);
    return false;
  }
  state.lastScanFrame = frame;
  if (!state.captureFirstFrameMarked) {
    // A reused video can already be playing and emit no media event until a
    // later timeupdate. Record the readable frame now, before scanning it.
    state.captureFirstFrameMarked = true;
    performance.mark("webscanner-camera-frame");
    captureDiagnostics.mark("camera.firstFrame", { source: "scan-frame" });
  }
  if (!state.detectionAttempt) captureDiagnostics.mark("camera.firstScanFrame");
  const detectedText = await detectBarcodeInFrame({ waitMs: performance.now() - waitStarted, frame });
  if (session !== state.scanSession || !state.isScanning || document.hidden) return false;

  if (!detectedText) {
    captureDiagnostics.metric("missedFrames", 1);
    if (state.pendingConfirmCode) captureDiagnostics.event("barcode.confirmationMiss");
    confirmAcrossFrames("");
    // Single-shot-only cameras otherwise retain focus at the previous distance.
    const focus = cameraFocusStates.get(state.track);
    if (focus?.mode === "single-shot" && !focus.manualPoint && Date.now() - focus.updatedAt >= 2000) {
      requestFocusRefresh(state.track, { force: true }).catch(() => {});
    }
    // Keep scanning fresh 1080p frames with the next crop/detail pass.
    setStatus("Scanning barcode…");
    return false;
  }

  captureDiagnostics.candidate(detectedText);
  if (!confirmAcrossFrames(detectedText)) {
    setStatus("Confirming code…");
    return false;
  }

  if (wasRecentlyDetected(detectedText)) {
    return false;
  }

  // Release the scan loop immediately; a slow ERP request must not delay the
  // next capture. handleDetectedCode closes the page before its first await.
  handleDetectedCode(detectedText).catch(function (error) {
    setStatus(error.message || "Could not load the captured barcode");
  });
  return true;
}


function scheduleScanCallback(callback, delayMs) {
  state.scanTimer = window.setTimeout(function () {
    state.scanTimer = 0;
    callback();
  }, delayMs);
}


async function runScanLoop() {
  if (!state.isScanning || state.isScanLoopScheduled) return;
  const session = state.scanSession;
  state.isScanLoopScheduled = true;
  scheduleScanCallback(async function () {
    if (session !== state.scanSession) return;
    state.isScanLoopScheduled = false;
    if (!state.isScanning) return;
    if (state.isScanInFlight || document.hidden) {
      runScanLoop();
      return;
    }
    state.isScanInFlight = true;
    try {
      await captureAttempt(session);
    } catch (error) {
      if (session === state.scanSession) {
        captureDiagnostics.error("scan.loop", error);
        closeCapturePage();
        setStatus(error.message || "Scanner failed. Tap Capture to retry.", "Scanner unavailable");
      }
    } finally {
      state.isScanInFlight = false;
      if (session === state.scanSession && state.isScanning) runScanLoop();
    }
  }, getScanLoopIntervalMs());
}


async function startCameraStream(preferredCameraId) {
  setActivePreviewEngine("zxing-wasm");
  const session = state.scanSession;
  const generation = state.captureGeneration;

  const request = state.captureRequest || requestCaptureStream(preferredCameraId);
  const result = await request.promise;
  if (result.error) throw result.error;
  const stream = result.stream;
  const playback = request.playback;
  request.stream = null;
  if (state.captureRequest === request) state.captureRequest = null;
  if (!state.capturePageOpen || generation !== state.captureGeneration || session !== state.scanSession) {
    stream.getTracks().forEach((track) => track.stop());
    throw new DOMException("Camera start canceled", "AbortError");
  }
  const track = stream.getVideoTracks()[0] || null;
  if (track) cameraTrackConstraints.set(track, request.videoConstraints || track.getConstraints?.() || {});

  state.stream = stream;
  state.track = track;
  state.scanner = { stream: stream };
  state.scannerEngine = "zxing-wasm";
  state.activeDeviceId = track?.getSettings?.().deviceId || preferredCameraId || state.activeDeviceId;
  saveCameraId(state.activeDeviceId);

  state.els.cameraPreview.muted = true;
  state.els.cameraPreview.setAttribute("playsinline", "");
  state.els.cameraPreview.setAttribute("webkit-playsinline", "");
  state.els.cameraPreview.setAttribute("disablepictureinpicture", "");
  try {
    state.els.cameraPreview.playsInline = true;
  } catch {
    // Older browsers ignore the property; the attributes above suffice.
  }
  if (state.els.cameraPreview.srcObject !== stream) state.els.cameraPreview.srcObject = stream;
  // Let native autofocus produce the first frame before applying any custom
  // constraints. startScanning configures focus once playback is ready.
  // play() resolves when playback starts; no separate metadata timeout needed.
  const playbackError = playback ? await playback : await state.els.cameraPreview.play().then(() => null, (error) => error);
  if (playbackError) throw playbackError;
  if (!state.capturePageOpen || generation !== state.captureGeneration || session !== state.scanSession) {
    stream.getTracks().forEach((track) => track.stop());
    throw new DOMException("Camera start canceled", "AbortError");
  }
  refreshDevices(state.activeDeviceId, stream).catch(() => {
    // Device labels are optional; a working camera must not wait for them.
  });
}


// Track-specific state prevents old camera requests affecting a new stream.
const cameraFocusStates = new WeakMap();
const cameraConstraintQueues = new WeakMap();
const cameraTrackConstraints = new WeakMap();

function isCurrentCameraTrack(track) {
  return Boolean(track && track === state.track && track.readyState !== "ended" &&
    !document.hidden);
}


function applyCameraTrackConstraints(track, changes, session) {
  const diagnostic = captureDiagnostics.current;
  const queuedAt = performance.now();
  captureDiagnostics.event("camera.controlQueued", { changes }, diagnostic);
  // applyConstraints replaces the previous constraints. Keep the current
  // resolution, frame rate and torch, and serialize focus/torch changes.
  const previous = cameraConstraintQueues.get(track) || Promise.resolve();
  const pending = previous.catch(() => {}).then(async function () {
    if (!isCurrentCameraTrack(track) || session !== undefined && session !== state.scanSession) {
      captureDiagnostics.event("camera.controlCancelled", {}, diagnostic); return false;
    }
    const applyStarted = performance.now();
    const queueMs = applyStarted - queuedAt;
    // Some browsers report only image-capture controls from getConstraints()
    // after focus/torch changes. Retain our full request so these operations
    // cannot silently reset the video resolution or frame rate.
    const current = cameraTrackConstraints.get(track) || track.getConstraints?.() || {};
    const next = { ...current };
    const keys = Object.keys(changes);
    if (changes.focusMode && changes.focusMode !== "manual") keys.push("focusDistance");
    keys.forEach((key) => { delete next[key]; });
    const advanced = (current.advanced || []).map(function (entry) {
      const kept = { ...entry };
      keys.forEach((key) => { delete kept[key]; });
      return kept;
    }).filter((entry) => Object.keys(entry).length);
    next.advanced = [...advanced, changes];
    try { await track.applyConstraints(next); }
    catch (error) { captureDiagnostics.error("camera.applyConstraints", error, diagnostic); throw error; }
    const applyMs = performance.now() - applyStarted;
    captureDiagnostics.metric("cameraControlQueueMs", queueMs, diagnostic);
    captureDiagnostics.metric("cameraControlApplyMs", applyMs, diagnostic);
    let actual = {};
    try { actual = track.getSettings?.() || {}; } catch (_) {}
    captureDiagnostics.event("camera.controlApplied", { queueMs, applyMs, changes,
      actual: { focusMode: actual.focusMode, focusDistance: actual.focusDistance, pointsOfInterest: actual.pointsOfInterest,
        width: actual.width, height: actual.height, torch: actual.torch } }, diagnostic);
    if (!isCurrentCameraTrack(track)) return false;
    cameraTrackConstraints.set(track, next);
    return true;
  });
  cameraConstraintQueues.set(track, pending);
  return pending;
}



// Candidates assist the lens only; outline/capture still require valid decoded
// bars. Unsupported camera controls leave normal decoding active.
const cameraBarcodeAssist = new WeakMap();
function assistSmallBarcode(region, frame, session) {
  const track = state.track;
  if (cameraFocusStates.get(track)?.manualPoint) return;
  if (session !== state.scanSession || !state.isScanning || !state.capturePageOpen ||
      !isCurrentCameraTrack(track) || !track.getCapabilities || !track.applyConstraints) return;
  if (![region?.x, region?.y, region?.width, region?.height].every(Number.isFinite) ||
      region.width <= 0 || region.height <= 0 || !frame?.videoWidth || !frame.videoHeight) return;
  const target = {
    x: (frame.sx + (region.x + region.width / 2) * frame.sw / frame.outputWidth) / frame.videoWidth,
    y: (frame.sy + (region.y + region.height / 2) * frame.sh / frame.outputHeight) / frame.videoHeight,
    width: region.width * frame.sw / frame.outputWidth / frame.videoWidth
  };
  if (![target.x, target.y, target.width].every(Number.isFinite) || target.width <= 0 ||
      target.x < 0 || target.x > 1 || target.y < 0 || target.y > 1) return;
  let assist = cameraBarcodeAssist.get(track);
  if (!assist || assist.session !== session) {
    assist = { session, target, count: 1, acted: false };
    cameraBarcodeAssist.set(track, assist);
    return;
  }
  const stable = Math.hypot(target.x - assist.target.x, target.y - assist.target.y) < 0.06 &&
    Math.abs(target.width - assist.target.width) < assist.target.width * 0.3;
  assist.target = target;
  assist.count = stable ? assist.count + 1 : 1;
  if (assist.count < 2 || assist.acted) return;
  assist.acted = true;
  requestFocusRefresh(track, { force: true, point: target, session });
  // Keep magnification stable: automatic zoom changes can restart the lens
  // hunt and move the barcode away from the focus point we just requested.
}


async function requestFocusRefresh(track, options = {}) {
  const diagnostic = captureDiagnostics.current;
  const focusStarted = performance.now();
  captureDiagnostics.event("focus.request", { manual: Boolean(options.manual), point: options.point,
    newScan: Boolean(options.newScan), forced: Boolean(options.force) }, diagnostic);
  if (!state.capturePageOpen || !isCurrentCameraTrack(track) || !track.getCapabilities || !track.applyConstraints) return false;
  let focus = cameraFocusStates.get(track);
  if (!focus) {
    focus = { mode: "", pending: null, updatedAt: 0, lastForcedAt: -Infinity,
      pointRejected: false, singleShotUnavailable: false, manualRequest: 0, manualPoint: false, point: null, scanPoint: null };
    cameraFocusStates.set(track, focus);
  }
  const session = options.session ?? state.scanSession;
  const manualRequest = options.manual ? ++focus.manualRequest : focus.manualRequest;
  if (options.manual) {
    // A user's selected target remains authoritative for this capture. Do not
    // let decoder candidates change it again a few seconds after the tap.
    focus.manualPoint = true;
    if (options.point) focus.scanPoint = { x: options.point.x, y: options.point.y };
    state.focusTargetRevision = (state.focusTargetRevision || 0) + 1;
    state.pendingConfirmCode = "";
    state.pendingConfirmCount = 0;
    state.lastBarcodeRegion = null;
    state.lastDetectionPass = null;
    state.detectionAttempt = 0;
  } else if (focus.manualPoint) {
    captureDiagnostics.event("focus.skipped", { reason: "user-selected-point" }, diagnostic); return false;
  }
  // A tap must wait for startup/torch work, rather than being discarded.
  // When several taps arrive, only the latest waiting target is applied.
  while (focus.pending) {
    await focus.pending;
    if (!options.manual) return false;
    if (manualRequest !== focus.manualRequest) return false;
  }
  if (!state.capturePageOpen || !isCurrentCameraTrack(track) || session !== state.scanSession) return false;

  try {
    // Capability detection also covers iPhones if their browser exposes focus.
    // Otherwise native autofocus continues without sending camera constraints.
    const capabilities = track.getCapabilities();
    const modes = capabilities.focusMode || [];
    let mode = options.manual && !focus.singleShotUnavailable && modes.includes("single-shot") ? "single-shot" :
      modes.includes("continuous") ? "continuous" :
      modes.includes("single-shot") ? "single-shot" : "";
    if (!mode) { captureDiagnostics.event("focus.unavailable", {}, diagnostic); return false; }
    const settings = track.getSettings?.() || {};
    const now = Date.now();
    // A tap actively triggers a sweep when supported, rather than waiting for
    // continuous focus to notice a new target. Keep the result without a timed
    // mode switch, and restore continuous focus on the next capture.
    const resetPoint = options.newScan && focus.point && (focus.point.x !== 0.5 || focus.point.y !== 0.5);
    const force = options.manual || options.force || resetPoint;
    if (!force && (mode === "continuous" && settings.focusMode === mode ||
        focus.mode === mode && (!settings.focusMode || settings.focusMode === mode))) {
      captureDiagnostics.event("focus.alreadyRunning", { mode }, diagnostic); return true;
    }
    if (force && !options.manual && !resetPoint && now - focus.lastForcedAt < 700) return false;
    if (force) focus.lastForcedAt = now;

    let point;
    if (!focus.pointRejected &&
        navigator.mediaDevices?.getSupportedConstraints?.().pointsOfInterest) {
      // Barcodes are aimed at the frame center; default new scans there so
      // the focus hunt targets the label. An explicit tap point still wins.
      const sourcePoint = options.point || (options.newScan ? { x: 0.5, y: 0.5 } : null);
      if (sourcePoint) {
        point = { x: Math.max(0, Math.min(1, sourcePoint.x)),
          y: Math.max(0, Math.min(1, sourcePoint.y)) };
      }
    }
    const changes = { focusMode: mode };
    if (point) changes.pointsOfInterest = [point];

    let restarted = false;
    focus.pending = (async function () {
      let applied;
      // Chrome/Android can advertise single-shot while keeping continuous
      // mode. Reapplying that same mode does not necessarily restart the lens.
      // Briefly release AF through the advertised manual mode, let one preview
      // frame pass, then restore continuous AF at the selected point.
      const restartContinuous = async function () {
        if (!modes.includes("manual") || !modes.includes("continuous")) return;
        if (manualRequest !== focus.manualRequest || session !== state.scanSession) return;
        const reset = { focusMode: "manual" };
        const range = capabilities.focusDistance;
        if (range && Number.isFinite(range.min) && Number.isFinite(range.max) && range.max > range.min) {
          const currentDistance = track.getSettings?.().focusDistance;
          const distance = currentDistance >= range.min && currentDistance <= range.max ? currentDistance : 0.25;
          const step = range.step > 0 ? range.step : 0;
          reset.focusDistance = Math.max(range.min, Math.min(range.max,
            step ? range.min + Math.round((distance - range.min) / step) * step : distance));
        }
        try {
          if (!await applyCameraTrackConstraints(track, reset, session)) return;
          restarted = track.getSettings?.().focusMode === "manual";
          captureDiagnostics.event("focus.restart", { manualModeReported: restarted,
            seedDistance: reset.focusDistance }, diagnostic);
          // Nonblocking: decoding and preview continue during this frame.
          if (restarted) await new Promise(resolve => window.setTimeout(resolve, 65));
        } catch (error) { captureDiagnostics.error("focus.restart", error, diagnostic); }
      };
      // Automatic candidate hints should not interrupt an ongoing native hunt.
      if (mode === "continuous" && options.manual) await restartContinuous();
      try {
        applied = await applyCameraTrackConstraints(track, changes, session);
      } catch (error) {
        if (mode === "single-shot" && modes.includes("continuous") &&
            error.constraint !== "pointsOfInterest" && isCurrentCameraTrack(track)) {
          // Some devices advertise single-shot but reject the command.
          focus.singleShotUnavailable = true;
          mode = changes.focusMode = "continuous";
          await restartContinuous();
          try { applied = await applyCameraTrackConstraints(track, changes, session); }
          catch (fallbackError) { error = fallbackError; }
        }
        if (applied === undefined) {
          if (!point || !isCurrentCameraTrack(track)) throw error;
          // Some browsers recognize pointsOfInterest but the lens rejects it.
          focus.pointRejected = true;
          captureDiagnostics.event("focus.pointRejected", {}, diagnostic);
          applied = await applyCameraTrackConstraints(track, { focusMode: mode }, session);
        }
      }
      if (!applied) return false;
      let actualMode = track.getSettings?.().focusMode;
      if (actualMode && actualMode !== mode && mode === "single-shot" && modes.includes("continuous")) {
        focus.singleShotUnavailable = true;
        captureDiagnostics.event("focus.modeIgnored", { requested: mode, reported: actualMode }, diagnostic);
        mode = changes.focusMode = "continuous";
        await restartContinuous();
        if (!await applyCameraTrackConstraints(track, focus.pointRejected ? { focusMode: mode } : changes, session)) return false;
        actualMode = track.getSettings?.().focusMode;
      }
      if (actualMode && actualMode !== mode) return false;
      focus.mode = mode;
      if (point && !focus.pointRejected) focus.point = point;
      focus.updatedAt = Date.now();
      captureDiagnostics.camera(track, diagnostic);
      captureDiagnostics.mark("focus.commandComplete", { mode, pointRequested: Boolean(point),
        pointRejected: focus.pointRejected, restarted, pointReported: track.getSettings?.().pointsOfInterest,
        requestMs: performance.now() - focusStarted }, diagnostic);
      // Sample later reported settings without another camera command or readback.
      for (const delay of [150, 450, 900]) {
        state.focusRefreshTimers.push(window.setTimeout(function () {
          if (!state.capturePageOpen || !isCurrentCameraTrack(track) || session !== state.scanSession ||
              manualRequest !== focus.manualRequest) return;
          const observed = track.getSettings?.() || {};
          captureDiagnostics.event("focus.observed", { afterMs: delay, focusMode: observed.focusMode,
            focusDistance: observed.focusDistance, pointsOfInterest: observed.pointsOfInterest }, diagnostic);
        }, delay));
      }
      if (options.manual && manualRequest === focus.manualRequest) {
        // The API acknowledges a request; it does not report lens convergence.
        setPreviewFocusFeedback(restarted ? "Autofocus restarted" :
          point && !focus.pointRejected ? "Focus requested" : "Autofocus requested · point focus unavailable");
      }
      return true;
    }()).catch((error) => { captureDiagnostics.error("focus.apply", error, diagnostic); return false; })
      .finally(async function () {
        // Cancellation/new capture during the brief reset must not leave a
        // reused live stream locked in manual focus. Do not touch another track.
        if (restarted && isCurrentCameraTrack(track) && track.getSettings?.().focusMode === "manual") {
          try { await applyCameraTrackConstraints(track, { focusMode: "continuous" }); }
          catch (error) { captureDiagnostics.error("focus.restore", error, diagnostic); }
        }
      });
    return await focus.pending;
  } catch (error) {
    // Focus controls are optional; a failure must never stop the live preview.
    captureDiagnostics.error("focus.setup", error, diagnostic);
    return false;
  } finally {
    focus.pending = null;
  }
}


function scheduleFocusRefresh(track, options = {}) {
  clearFocusRefreshTimers();
  if (!isCurrentCameraTrack(track)) return;
  let ready = false;
  requestFocusRefresh(track, options).then((result) => { ready = result; });
  // Retry only incomplete setup, such as capabilities becoming available
  // with the first frame. Never restart an already-running continuous focus.
  for (const delay of [75, 150, 300, 600, 1000]) {
    const timerId = window.setTimeout(function () {
      if (!ready && isCurrentCameraTrack(track)) {
        requestFocusRefresh(track, options).then((result) => { ready = result; });
      }
    }, delay);
    state.focusRefreshTimers.push(timerId);
  }
}


function getPreviewFocusPoint(clientX, clientY) {
  const video = state.els.cameraPreview;
  const rect = video.getBoundingClientRect();
  if (!rect.width || !rect.height || !video.videoWidth || !video.videoHeight) return null;
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
  const cover = getCoverSourceRect(video.videoWidth, video.videoHeight, rect.width, rect.height);
  const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
  return { x: (cover.offsetX + x * cover.visibleWidth) / video.videoWidth,
    y: (cover.offsetY + y * cover.visibleHeight) / video.videoHeight };
}


let previewFocusFeedbackTimer = 0;
function setPreviewFocusFeedback(message) {
  const hint = state.els.focusHint;
  if (!hint) return;
  window.clearTimeout(previewFocusFeedbackTimer);
  hint.textContent = message;
  previewFocusFeedbackTimer = window.setTimeout(function () {
    if (state.els.focusTarget) state.els.focusTarget.hidden = true;
    hint.textContent = "Tap preview to focus";
  }, 2200);
}


function initPreviewFocus() {
  const preview = state.els.previewFrame;
  let tap = null;
  let focusTap = 0;
  preview.addEventListener("pointerdown", function (event) {
    tap = null;
    if (!event.isPrimary || event.button !== 0 || event.target.closest("button")) return;
    tap = { id: event.pointerId, x: event.clientX, y: event.clientY, time: Date.now() };
  }, { passive: true });
  preview.addEventListener("pointermove", function (event) {
    if (tap && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 12) tap = null;
  }, { passive: true });
  preview.addEventListener("pointercancel", function () { tap = null; }, { passive: true });
  preview.addEventListener("pointerup", function (event) {
    const start = tap;
    tap = null;
    if (!start || start.id !== event.pointerId || Date.now() - start.time > 500 ||
        Math.hypot(event.clientX - start.x, event.clientY - start.y) > 12 ||
        !state.capturePageOpen || !state.isCameraRunning) return;
    const point = getPreviewFocusPoint(event.clientX, event.clientY);
    if (!point) return;
    const rect = preview.getBoundingClientRect();
    const target = state.els.focusTarget;
    if (target) {
      target.style.left = `${event.clientX - rect.left}px`;
      target.style.top = `${event.clientY - rect.top}px`;
      target.hidden = false;
    }
    setPreviewFocusFeedback("Focusing…");
    const currentTap = ++focusTap;
    const track = state.track, session = state.scanSession;
    requestFocusRefresh(track, { manual: true, point, session }).then(function (applied) {
      if (!applied && currentTap === focusTap && state.capturePageOpen && isCurrentCameraTrack(track) && session === state.scanSession &&
          state.els.focusHint?.textContent === "Focusing…" && !cameraFocusStates.get(track)?.pending) {
        setPreviewFocusFeedback("Point focus unavailable · use camera autofocus");
      }
    });
  }, { passive: true });
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
    setStatus("Flashlight unavailable");
    updateTorchUi(false, false);
    return;
  }

  const capabilities = liveTrack.getCapabilities();
  const nextTorchState = !readTorchStateFromTrack(liveTrack);
  try {
    if (!await applyCameraTrackConstraints(liveTrack, { torch: nextTorchState })) return;
    state.torchOn = readTorchStateFromTrack(liveTrack);
    if (state.torchOn !== nextTorchState) {
      state.torchOn = nextTorchState;
    }
    updateTorchUi(true, state.torchOn);
    setStatus(state.torchOn ? "Flashlight enabled" : "Flashlight disabled");
  } catch (error) {
    state.torchOn = false;
    updateTorchUi(false, false);
    setStatus(error?.message || (capabilities.torch ? "Torch control failed on this device" : "Torch is not supported on this camera"), "Flashlight unavailable");
  }
}


async function startCamera(deviceId) {
  if (!state.capturePageOpen || document.hidden) throw new DOMException("Capture closed", "AbortError");
  const generation = state.captureGeneration;
  if (state.cameraStartPromise) {
    try { await state.cameraStartPromise; } catch (error) { if (error.name !== "AbortError") throw error; }
    if (!state.capturePageOpen || generation !== state.captureGeneration) throw new DOMException("Capture closed", "AbortError");
    if (state.isCameraRunning && (!deviceId || deviceId === state.activeDeviceId)) {
      return;
    }
  }

  const startPromise = (async function () {
    const hardwareIssue = getCameraHardwareIssue();
    if (hardwareIssue) throw new Error(hardwareIssue);

    cleanupScanTimer();
    if (state.stream) await stopTracks();
    else stopScanning(true);
    if (!state.capturePageOpen || generation !== state.captureGeneration || document.hidden) throw new DOMException("Capture closed", "AbortError");

    // Use the saved camera directly, or let the browser choose a rear camera.
    // Enumerate labeled devices only after the stream has started.
    const preferredCameraId = deviceId || state.activeDeviceId || readSavedCameraId();
    await startCameraStream(preferredCameraId);

    if (!state.capturePageOpen || generation !== state.captureGeneration || !state.track || state.track.readyState === "ended") {
      throw new DOMException("Camera start canceled", "AbortError");
    }

    state.isCameraRunning = true;
    state.isScanning = false;
    disarmFirstGestureCameraStart();
    await syncTorchSupport();
    if (!state.capturePageOpen || generation !== state.captureGeneration || document.hidden || !state.track) {
      throw new DOMException("Capture closed", "AbortError");
    }
    setPreviewActive(true);
    updateResolutionBadge();
    updateScanButton();
    updateModePill();
    startPreviewWatchdog();
    setStatus("Ready to capture");
  }());

  state.cameraStartPromise = startPromise;
  try {
    await startPromise;
  } catch (error) {
    await stopTracks();
    setPreviewActive(false);
    throw error;
  } finally {
    if (state.cameraStartPromise === startPromise) {
      state.cameraStartPromise = null;
    }
  }
}


async function startScanning() {
  if (!state.capturePageOpen || document.hidden || state.isScanning) return;
  const generation = state.captureGeneration;
  state.captureContext ||= state.els.captureCanvas.getContext("2d", { alpha: false, willReadFrequently: true });
  // Attach the rejection handler immediately while camera permission is pending.
  const diagnostic = captureDiagnostics.current;
  captureDiagnostics.mark("decoder.request", {}, diagnostic);
  const detectorReady = createDetector().then(() => {
    captureDiagnostics.mark("decoder.ready", {}, diagnostic); return null;
  }, (error) => { captureDiagnostics.error("decoder.init", error, diagnostic); return error; });
  // Camera preview works fully offline (getUserMedia needs no network).
  if (!state.isCameraRunning) {
    await startCamera(state.activeDeviceId);
  } else {
    // Offscreen video may have been paused by the browser between captures.
    await state.els.cameraPreview.play();
    captureDiagnostics.mark("camera.playing", { reused: true }, diagnostic);
    startPreviewWatchdog();
  }

  if (!state.capturePageOpen || generation !== state.captureGeneration || document.hidden || state.isScanning) return;

  const session = ++state.scanSession;
  // Start lens control as soon as playback is ready, even if the decoder is
  // still loading. Previously this could leave the preview blurry for seconds.
  scheduleFocusRefresh(state.track, { newScan: true, session });
  setStatus("Loading scanner…");
  try {
    const error = await detectorReady;
    if (error) throw error;
  } catch (error) {
    if (session === state.scanSession) setStatus(error.message || "Scanner unavailable. Tap Capture to retry.", "Scanner unavailable");
    throw error;
  }
  if (!state.capturePageOpen || generation !== state.captureGeneration || session !== state.scanSession) return;

  resetBarcodeTracking();
  state.lastBarcodeRegion = null;
  state.detectionAttempt = 0;
  state.lastDetectionPass = null;
  state.lastScanFrame = null;
  // Each explicit capture is a new item, including the same SKU again.
  state.lastDetectedBarcode = "";
  state.lastDetectedAt = 0;
  state.isScanning = true;
  captureDiagnostics.mark("scanning.started", {}, diagnostic);
  captureDiagnostics.camera(state.track, diagnostic);
  updateScanButton();
  updateModePill();
  setStatus("Scanning barcode…");
  cleanupScanTimer();
  await runScanLoop();
}

function stopScanning(keepStatusMessage) {
  state.scanSession += 1;
  resetBarcodeTracking();
  state.lastBarcodeRegion = null;
  cleanupScanTimer();
  state.isScanning = false;
  state.pendingConfirmCode = "";
  state.pendingConfirmCount = 0;
  updateScanButton();
  updateModePill();
  if (!keepStatusMessage) {
    setStatus(state.isCameraRunning ? "Capture paused" : "Camera stopped");
  }
}


async function handleMainButton() {

  if (state.isScanning) {
    closeCapturePage();
    return;
  }

  await openCapturePage();
}


async function handleSelectChange() {
  const selectedId = state.els.cameraSelect.value;
  if (!selectedId || selectedId === state.activeDeviceId) return;

  const shouldResumeScanning = state.isScanning;
  saveCameraId(selectedId);
  if (!state.capturePageOpen) { state.activeDeviceId = selectedId; return; }
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
