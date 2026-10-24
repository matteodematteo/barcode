"use strict";

// Bounded, local-only traces. Never retain pixels, decoded text, credentials,
// device IDs, request bodies, or arbitrary error messages.
const captureDiagnostics = (() => {
  const storageKey = "webscanner_capture_diagnostics_v1";
  const limits = { captures: 12, framesPerCapture: 180, eventsPerCapture: 120 };
  const controls = ["width", "height", "frameRate", "aspectRatio", "facingMode",
    "focusMode", "focusDistance", "pointsOfInterest", "zoom", "torch", "exposureMode",
    "exposureTime", "exposureCompensation", "iso", "brightness", "sharpness"];
  let sessions = [], systemEvents = [], current = null, counter = 0, initialized = false;
  let saveTimer = 0, heartbeat = 0;
  const tokens = new WeakMap();
  const now = () => performance.now();
  const round = value => Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
  // performance.now() restarts on every navigation. Give each page its own
  // random trace identity so persisted events never appear to share a clock.
  const pageClock = {
    pageSessionId: typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID() : `page-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    timeOriginMs: round(performance.timeOrigin),
    initializedAt: new Date().toISOString()
  };
  const relative = session => round(now() - session._started);
  const boundedPush = (array, value, maximum, keepFirst = 0) => {
    if (array.length >= maximum) array.splice(keepFirst, 1);
    array.push(value);
  };
  const serializable = value => JSON.parse(JSON.stringify(value, (key, item) => key.startsWith("_") ? undefined : item));
  const pick = value => {
    const result = {};
    for (const key of controls) if (value?.[key] !== undefined) result[key] = value[key];
    return serializable(result);
  };
  function metric(name, value, session = current) {
    if (!session || !Number.isFinite(value)) return;
    const item = session.metrics[name] ||= { count: 0, total: 0, min: value, max: value };
    item.count++; item.total += value; item.min = Math.min(item.min, value); item.max = Math.max(item.max, value);
  }
  function event(type, details = {}, session = current) {
    try {
      const timestamp = now();
      const entry = { ...serializable(details), type,
        atMs: session ? round(timestamp - session._started) : round(timestamp),
        recordedAt: new Date().toISOString(), pageSessionId: pageClock.pageSessionId, pageAtMs: round(timestamp) };
      if (session) boundedPush(session.events, entry, limits.eventsPerCapture, 10);
      else boundedPush(systemEvents, entry, 60);
    } catch (_) { /* Recording must never prevent capture. */ }
  }
  function mark(name, details = {}, session = current) {
    if (!session) { event(name, details, null); return; }
    if (session.marks[name] === undefined) session.marks[name] = relative(session);
    event(name, details, session);
  }
  function error(stage, failure, session = current) {
    event("error", { stage, name: String(failure?.name || "Error"),
      constraint: controls.includes(failure?.constraint) ? failure.constraint : undefined }, session);
  }
  function camera(track, session = current) {
    if (!session || !track) return;
    try {
      session.camera = { settings: pick(track.getSettings?.()), capabilities: pick(track.getCapabilities?.()),
        supportedConstraints: pick(navigator.mediaDevices?.getSupportedConstraints?.()) };
    } catch (failure) { error("camera-settings", failure, session); }
  }
  function persist() {
    try {
      const saved = serializable({ schemaVersion: 1, counter, sessions, systemEvents });
      let json = JSON.stringify(saved);
      // Keep persistent storage well below its quota even for difficult scans.
      while (json.length > 800000 && saved.sessions.length > 1) {
        saved.sessions.shift(); json = JSON.stringify(saved);
      }
      localStorage.setItem(storageKey, json);
    }
    catch (_) { /* A full/disabled store must not affect the barcode list. */ }
  }
  function saveLater() {
    clearTimeout(saveTimer);
    // A rapid next capture takes priority over serializing the previous trace.
    saveTimer = setTimeout(function () { if (!current) persist(); }, 0);
  }
  function start(details) {
    if (current) end("replaced");
    const started = now();
    const session = { id: ++counter, appVersion: document.querySelector('meta[name="webscanner-version"]')?.content,
      startedAt: new Date().toISOString(), _started: started, status: "recording", ...details,
      pageClock: { ...pageClock, captureStartedAtMs: round(started) },
      marks: {}, metrics: {}, events: [], frames: [], frameCount: 0, trimmedFrames: 0 };
    boundedPush(sessions, session, limits.captures);
    current = session;
    tokens.set(session, new Map());
    mark("capture.open", {}, session);
    let expected = now() + 250;
    heartbeat = setInterval(() => {
      if (document.hidden || current !== session) { expected = now() + 250; return; }
      const lag = Math.max(0, now() - expected);
      metric("eventLoopLagMs", lag, session);
      if (lag > 50) event("main-thread-delay", { durationMs: round(lag) }, session);
      expected = now() + 250;
    }, 250);
    return session;
  }
  function end(status) {
    if (!current) return;
    const session = current;
    session.status = status;
    session.durationMs = relative(session);
    session._ended = now();
    event("capture.close", { status }, session);
    current = null;
    clearInterval(heartbeat);
    saveLater();
  }
  function candidate(code, session = current) {
    if (!session) return;
    const map = tokens.get(session);
    if (!map.has(code)) map.set(code, `candidate-${map.size + 1}`);
    mark("barcode.firstRead", { candidate: map.get(code), uniqueCandidates: map.size }, session);
  }
  function frame(details, session = current) {
    if (!session || session.status !== "recording") return;
    const recordStarted = now();
    session.frameCount++;
    if (session.frames.length >= limits.framesPerCapture) session.trimmedFrames++;
    boundedPush(session.frames, { atMs: relative(session), ...details }, limits.framesPerCapture, 15);
    for (const key of ["waitMs", "drawMs", "readbackMs", "decodeMs", "totalMs", "diagnosticsMs"])
      metric(key, details[key], session);
    if (details.worker) {
      metric("wasmCalls", details.worker.wasmCalls, session);
      if (details.worker.budgetExceeded) metric("budgetExceededFrames", 1, session);
      metric("workerMs", details.worker.workerMs, session);
      metric("wasmMs", details.worker.wasmMs, session);
      const preparation = details.worker.framePreparation;
      if (preparation) {
        metric("workerPreparationMs", preparation.totalMs, session);
        metric("workerFrameDrawMs", preparation.drawMs, session);
        metric("workerFrameReadbackMs", preparation.readbackMs, session);
        metric("workerDiagnosticsMs", preparation.diagnosticsMs, session);
      }
      metric("workerHandoffMs", Math.max(0, details.decodeMs - details.worker.workerMs - (preparation?.totalMs || 0)), session);
    }
    if (details.quality) metric("sharpnessEstimate", details.quality.laplacianVariance, session);
    metric("traceRecordMs", now() - recordStarted, session);
  }
  function reserveImageSample(session = current) {
    if (!session || now() - (session._qualityAt ?? -Infinity) < 500) return false;
    session._qualityAt = now();
    return true;
  }
  function sampleImage(image, session = current) {
    if (!reserveImageSample(session)) return null;
    const { width, height, data } = image;
    const stepX = Math.max(1, Math.ceil(width / 48)), stepY = Math.max(1, Math.ceil(height / 32));
    let count = 0, sum = 0, sumSq = 0, lapSum = 0, lapSq = 0, dark = 0, bright = 0;
    for (let y = 1; y < height - 1; y += stepY) for (let x = 1; x < width - 1; x += stepX) {
      const i = (y * width + x) * 4;
      const value = (77 * data[i] + 150 * data[i + 1] + 29 * data[i + 2]) / 256;
      const lap = 4 * data[i + 1] - data[i - 3] - data[i + 5] - data[i - width * 4 + 1] - data[i + width * 4 + 1];
      count++; sum += value; sumSq += value * value; lapSum += lap; lapSq += lap * lap;
      if (value < 16) dark++; if (value > 239) bright++;
    }
    if (!count) return null;
    return { sampleCount: count, meanLuminance: round(sum / count),
      contrastStdDev: round(Math.sqrt(Math.max(0, sumSq / count - (sum / count) ** 2))),
      laplacianVariance: round(Math.max(0, lapSq / count - (lapSum / count) ** 2)),
      darkFraction: round(dark / count), brightFraction: round(bright / count) };
  }
  function frameState(video, session = current) {
    if (!session || now() - (session._settingsAt ?? -Infinity) < 500) return null;
    session._settingsAt = now();
    let playback = {};
    try {
      const quality = video.getVideoPlaybackQuality?.();
      playback = { totalFrames: quality?.totalVideoFrames, droppedFrames: quality?.droppedVideoFrames,
        currentTime: round(video.currentTime), readyState: video.readyState, width: video.videoWidth, height: video.videoHeight };
    } catch (_) {}
    try { return { playback, settings: pick(state.track?.getSettings?.()) }; }
    catch (_) { return { playback }; }
  }
  function summarize(session) {
    const timing = {};
    for (const [name, item] of Object.entries(session.metrics)) timing[name] = {
      count: item.count, mean: round(item.total / item.count), min: round(item.min), max: round(item.max), total: round(item.total) };
    const hints = [];
    if ((session.marks["camera.streamReady"] ?? 0) > 1000) hints.push("Camera/permission acquisition exceeded one second.");
    if ((session.marks["decoder.ready"] ?? 0) - (session.marks["camera.playing"] ?? 0) > 500) hints.push("Decoder initialization delayed scanning after preview playback.");
    if (Math.max(timing.drawMs?.max || 0, timing.readbackMs?.max || 0) > 50) hints.push("Copying camera pixels blocked the interface for more than 50 ms.");
    if (timing.wasmMs?.max > 150) hints.push("At least one barcode read required more than 150 ms of WASM decoding.");
    if (timing.eventLoopLagMs?.max > 100 || timing.longTaskMs?.max > 100) hints.push("The main thread stalled for more than 100 ms.");
    if (session.frames.some(item => item.worker?.budgetExceeded)) hints.push("Some decoder attempts exceeded their soft retry budget.");
    if (!session.camera?.capabilities?.focusMode?.length) hints.push("The browser did not expose controllable focus modes for this camera.");
    if (session.frameCount > 10 && session.marks["barcode.confirmed"] === undefined) hints.push("Repeated frames did not produce two matching reads. Review clarity estimates, frame crops and worker retries.");
    return { captureId: session.id, status: session.status, durationMs: session.durationMs,
      milestonesMs: session.marks, framesAttempted: session.frameCount, timing, observations: hints };
  }
  function init() {
    if (initialized) return;
    initialized = true;
    try {
      const raw = localStorage.getItem(storageKey);
      const saved = raw && raw.length < 1200000 ? JSON.parse(raw) : null;
      if (saved?.schemaVersion === 1 && Array.isArray(saved.sessions)) {
        sessions = saved.sessions.slice(-limits.captures).filter(item => item && Array.isArray(item.frames) && item.metrics && item.marks);
        sessions.forEach(item => {
          item.frames = item.frames.slice(-limits.framesPerCapture); item.events = (item.events || []).slice(-limits.eventsPerCapture);
          if (item.status === "recording") {
            item.status = "interrupted";
            item.durationMs = item.frames[item.frames.length - 1]?.atMs || item.events[item.events.length - 1]?.atMs || 0;
          }
        });
        counter = Number(saved.counter) || 0;
        systemEvents = Array.isArray(saved.systemEvents) ? saved.systemEvents.slice(-60) : [];
      }
    } catch (_) {}
    try {
      if (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
        const observer = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) {
            const session = sessions.find(item => item._started !== undefined && entry.startTime >= item._started &&
              entry.startTime <= (item._ended ?? Infinity));
            if (session) { metric("longTaskMs", entry.duration, session); event("long-task", { durationMs: round(entry.duration) }, session); }
          }
        });
        observer.observe({ type: "longtask", buffered: true });
      }
    } catch (_) {}
    window.addEventListener("pagehide", function () { if (current) end("page-left"); persist(); });
    window.addEventListener("error", function (entry) { error("page.runtime", entry.error); });
    window.addEventListener("unhandledrejection", function (entry) { error("page.promise", entry.reason); });
    document.addEventListener("visibilitychange", function () {
      event("visibility", { hidden: document.hidden });
      if (document.hidden) persist();
    });
  }
  async function report() {
    let device = null, timer;
    try {
      if (navigator.userAgentData?.getHighEntropyValues) device = await Promise.race([
        navigator.userAgentData.getHighEntropyValues(["model", "platformVersion", "fullVersionList"]),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), 500); })
      ]);
    } catch (_) {} finally { clearTimeout(timer); }
    const assets = performance.getEntriesByType("resource").filter(item =>
      /\/(?:app\.bundle\.js|capture\.bundle\.js|zxing-worker\.js|reader\.js|zxing_reader\.wasm)(?:\?|$)/.test(item.name))
      .slice(-30).map(item => ({ asset: new URL(item.name).pathname.split("/").pop(), durationMs: round(Math.max(0, item.duration)),
        transferBytes: item.transferSize, encodedBytes: item.encodedBodySize, startMs: round(item.startTime) }));
    const data = { schemaVersion: 1, app: "Web Scanner", appVersion: document.querySelector('meta[name="webscanner-version"]')?.content,
      exportedAt: new Date().toISOString(), timeUnits: "milliseconds", limits, pageClock,
      decoder: { name: "ZXing WASM", version: "3.1.5", formats: CONFIG.detectorFormats, confirmationFrames: 2 },
      measurementNotes: ["Focus-command completion is not physical lens convergence; the browser does not expose a reliable autofocus-complete signal.",
        "Image contrast and Laplacian variance are sampled scene-dependent estimates, not proof of focus or barcode legibility.",
        "Decoder budgets limit retries, not an already-running WASM read. Capture atMs values are relative to captureStartedAtMs in that capture's pageClock.",
        "System event atMs and pageAtMs values use their page's performance clock; recordedAt is UTC. Different pageSessionId values must not share a relative timeline.",
        "Legacy captures/events without pageClock, pageSessionId or recordedAt have unknown clock metadata; the exporting page's clock must not be inferred for them.",
        "Worker framePreparation timings run off the interface thread; decodeMs includes preparation and worker round-trip time.",
        "No pixels, barcode values, cookies, credentials, device IDs, or request bodies are recorded. Nothing is uploaded automatically."],
      environment: { userAgent: navigator.userAgent, device, platform: navigator.platform, language: navigator.language,
        hardwareConcurrency: navigator.hardwareConcurrency, deviceMemoryGB: navigator.deviceMemory,
        viewport: { width: innerWidth, height: innerHeight, pixelRatio: devicePixelRatio },
        screen: { width: screen.width, height: screen.height, orientation: screen.orientation?.type },
        online: navigator.onLine, secureContext: window.isSecureContext,
        connection: navigator.connection ? { effectiveType: navigator.connection.effectiveType, rttMs: navigator.connection.rtt,
          downlinkMbps: navigator.connection.downlink, saveData: navigator.connection.saveData } : null,
        longTasksSupported: typeof PerformanceObserver !== "undefined" && Boolean(PerformanceObserver.supportedEntryTypes?.includes("longtask")),
        memory: performance.memory ? { usedJSHeapBytes: performance.memory.usedJSHeapSize, totalJSHeapBytes: performance.memory.totalJSHeapSize } : null },
      assetLoads: assets, summary: sessions.map(summarize), systemEvents, captures: sessions };
    return serializable(data);
  }
  function status() {
    const element = document.getElementById("captureDiagnosticsStatus");
    if (element) element.textContent = `${sessions.length} recent capture${sessions.length === 1 ? "" : "s"} recorded on this device.`;
  }
  async function download() {
    const button = document.getElementById("downloadDiagnosticsBtn");
    if (button) button.disabled = true;
    try {
      const data = await report();
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = `webscanner-diagnostics-v${data.appVersion}-${data.exportedAt.replace(/[:.]/g, "-")}.json`;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      status();
    } catch (_) { const element = document.getElementById("captureDiagnosticsStatus"); if (element) element.textContent = "Could not download the report. Please try again."; }
    finally { if (button) button.disabled = false; }
  }
  return { init, start, end, mark, event, error, metric, camera, candidate, frame, sampleImage, reserveImageSample, frameState,
    report, download, status, get current() { return current; }, get recent() {
      const last = sessions[sessions.length - 1];
      return last?._started !== undefined && now() - last._started < 120000 ? last : null;
    } };
})();
