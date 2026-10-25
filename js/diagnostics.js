"use strict";

// Bounded, local-only traces. Never retain pixels, decoded text, credentials,
// device IDs, request bodies, or arbitrary error messages.
const captureDiagnostics = (() => {
  const storageKey = "webscanner_capture_diagnostics_v1";
  const limits = { captures: 60, framesPerCapture: 360, eventsPerCapture: 200,
    systemEvents: 200, persistentBytes: 24 * 1024 * 1024 };
  const controls = ["width", "height", "frameRate", "aspectRatio", "facingMode",
    "focusMode", "focusDistance", "pointsOfInterest", "zoom", "torch", "exposureMode",
    "exposureTime", "exposureCompensation", "iso", "brightness", "sharpness"];
  let sessions = [], systemEvents = [], current = null, counter = 0, initialized = false;
  let saveTimer = 0, heartbeat = 0;
  let database = null, storageReady = Promise.resolve(), pendingSave = Promise.resolve();
  const dirty = new Set(), records = new Map();
  const storageState = { backend: "localStorage", error: null, storedCaptures: 0, storedBytes: 0 };
  const sessionKey = session => `${session.pageClock?.pageSessionId || session.startedAt}:${session.id}`;
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
    dirty.add(session);
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
      else boundedPush(systemEvents, entry, limits.systemEvents);
      if (session) dirty.add(session);
      if (!current) saveLater();
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
      dirty.add(session);
    } catch (failure) { error("camera-settings", failure, session); }
  }
  function persistFallback() {
    try {
      const encode = value => JSON.stringify(value, (key, item) => key.startsWith("_") ? undefined : item);
      const prefix = encode({ schemaVersion: 1, counter, systemEvents }).slice(0, -1) + ',"sessions":[';
      const saved = sessions.map(session => ({ session, json: encode(session) }));
      let size = prefix.length + 2 + saved.reduce((total, item) => total + item.json.length + 1, 0);
      // Preserve capture summaries even when IndexedDB is unavailable. Drop
      // older frame detail first, keeping account/history storage independent.
      for (const item of saved) {
        if (size <= 1000000) break;
        const json = encode({ ...item.session, frames: [], events: item.session.events.slice(-20),
          storageTrimmedFrames: (item.session.storageTrimmedFrames || 0) + item.session.frames.length });
        size += json.length - item.json.length;
        item.json = json;
      }
      while (size > 1000000 && saved.length > 1) {
        size -= saved.shift().json.length + 1;
      }
      const json = prefix + saved.map(item => item.json).join(",") + "]}";
      localStorage.setItem(storageKey, json);
      storageState.storedCaptures = saved.length;
      storageState.storedBytes = json.length * 2;
    }
    catch (error) { storageState.error = error?.name || "StorageError"; }
  }
  function readSavedSessions(saved) {
    return (Array.isArray(saved) ? saved : [])
      .filter(item => item && typeof item.startedAt === "string" && Array.isArray(item.frames) && item.metrics && item.marks)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id - b.id).slice(-limits.captures)
      .map(item => {
        item.frames = item.frames.slice(-limits.framesPerCapture);
        item.events = (item.events || []).slice(-limits.eventsPerCapture);
        if (item.status === "recording") {
          item.status = "interrupted";
          item.durationMs = item.frames.at(-1)?.atMs || item.events.at(-1)?.atMs || 0;
        }
        return item;
      });
  }
  function openStorage() {
    if (typeof indexedDB === "undefined") return Promise.resolve();
    return new Promise(resolve => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
      const timer = setTimeout(finish, 1500);
      let request;
      try { request = indexedDB.open("webscanner-capture-diagnostics", 1); }
      catch (error) { storageState.error = error?.name; finish(); return; }
      request.onupgradeneeded = () => request.result.createObjectStore("traces");
      request.onerror = () => { storageState.error = request.error?.name; finish(); };
      request.onblocked = finish;
      request.onsuccess = () => {
        const db = request.result;
        if (settled) { db.close(); return; }
        const transaction = db.transaction("traces", "readonly");
        const read = transaction.objectStore("traces").getAll();
        transaction.onabort = () => { db.close(); finish(); };
        transaction.onerror = () => { db.close(); finish(); };
        transaction.oncomplete = () => {
          if (settled) { db.close(); return; }
          try {
            const loaded = [], savedEvents = [];
            for (const entry of read.result || []) {
              if (entry.key === "meta") {
                counter = Math.max(counter, Number(entry.counter) || 0);
                savedEvents.push(...(entry.systemEvents || []));
              } else {
                loaded.push(JSON.parse(entry.json));
                records.set(entry.key, entry.json);
              }
            }
            // A scan can start before storage opens. Live objects win on merge.
            const merged = new Map(readSavedSessions(loaded).map(item => [sessionKey(item), item]));
            sessions.forEach(item => merged.set(sessionKey(item), item));
            sessions = [...merged.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id - b.id).slice(-limits.captures);
            const events = new Map([...savedEvents, ...systemEvents].map(item => [JSON.stringify(item), item]));
            systemEvents = [...events.values()].slice(-limits.systemEvents);
            database = db;
            db.onversionchange = () => { db.close(); database = null; storageState.backend = "localStorage"; };
            storageState.backend = "IndexedDB";
            storageState.storedCaptures = records.size;
            storageState.storedBytes = [...records.values()].reduce((total, json) => total + json.length * 2, 0);
            sessions.forEach(item => { if (!records.has(sessionKey(item))) dirty.add(item); });
          } catch (error) { storageState.error = error?.name; db.close(); }
          finish();
        };
      };
    });
  }
  function persist() {
    if (current && !document.hidden) return Promise.resolve();
    if (!database) { persistFallback(); return storageReady.then(() => database ? persist() : undefined); }
    pendingSave = pendingSave.catch(() => {}).then(async () => {
      if (current && !document.hidden) return;
      if (!database) return persistFallback();
      const activeKeys = new Set(sessions.map(sessionKey));
      const writes = new Map(), removed = [];
      const nextRecords = new Map(records);
      for (const key of nextRecords.keys()) if (!activeKeys.has(key)) { nextRecords.delete(key); removed.push(key); }
      for (const session of dirty) {
        dirty.delete(session);
        if (!activeKeys.has(sessionKey(session))) continue;
        const json = JSON.stringify(session, (key, item) => key.startsWith("_") ? undefined : item);
        nextRecords.set(sessionKey(session), json); writes.set(sessionKey(session), json);
      }
      let bytes = [...nextRecords.values()].reduce((total, json) => total + json.length * 2, 0);
      for (const session of sessions) {
        if (bytes <= limits.persistentBytes) break;
        const key = sessionKey(session), original = nextRecords.get(key);
        if (!original) continue;
        const stored = JSON.parse(original);
        stored.storageTrimmedFrames = (stored.storageTrimmedFrames || 0) + stored.frames.length;
        stored.frames = [];
        const json = JSON.stringify(stored);
        bytes += (json.length - original.length) * 2;
        nextRecords.set(key, json); writes.set(key, json);
      }
      try {
        await new Promise((resolve, reject) => {
          const transaction = database.transaction("traces", "readwrite");
          const objectStore = transaction.objectStore("traces");
          removed.forEach(key => objectStore.delete(key));
          writes.forEach((json, key) => objectStore.put({ key, json }, key));
          objectStore.put({ key: "meta", counter, systemEvents }, "meta");
          transaction.oncomplete = resolve;
          transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error("StorageError"));
        });
        records.clear();
        nextRecords.forEach((json, key) => records.set(key, json));
        storageState.storedBytes = bytes;
        storageState.storedCaptures = records.size;
        try { localStorage.removeItem(storageKey); } catch (_) { /* IndexedDB is still durable. */ }
      } catch (error) {
        storageState.error = error?.name || "StorageError";
        sessions.forEach(item => dirty.add(item));
        persistFallback();
      }
    });
    return pendingSave;
  }
  function saveLater() {
    clearTimeout(saveTimer);
    // A rapid next capture takes priority over serializing the previous trace.
    saveTimer = setTimeout(function () { if (!current) persist(); }, 500);
  }
  function start(details) {
    if (current) end("replaced");
    const started = now();
    const session = { id: ++counter, appVersion: document.querySelector('meta[name="webscanner-version"]')?.content,
      startedAt: new Date().toISOString(), _started: started, status: "recording", ...details,
      pageClock: { ...pageClock, captureStartedAtMs: round(started) },
      marks: {}, metrics: {}, events: [], frames: [], frameCount: 0, trimmedFrames: 0 };
    if (sessions.length >= limits.captures) dirty.delete(sessions[0]);
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
    if (session.events.some(item => item.type === "focus.modeIgnored")) hints.push("The camera reported a different focus mode after a single-shot request; the fallback attempted to restart autofocus.");
    if (session.events.some(item => item.type === "focus.restart" && item.manualModeReported)) hints.push("A manual-to-continuous focus restart was applied. Later focus.observed events and frame quality samples can be compared with the tap time.");
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
        sessions = readSavedSessions(saved.sessions);
        sessions.forEach(item => dirty.add(item));
        counter = Number(saved.counter) || 0;
        systemEvents = Array.isArray(saved.systemEvents) ? saved.systemEvents.slice(-limits.systemEvents) : [];
      }
    } catch (_) {}
    storageReady = openStorage();
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
    await storageReady;
    if (!current) await persist();
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
      exportedAt: new Date().toISOString(), timeUnits: "milliseconds", limits, pageClock, storage: { ...storageState },
      decoder: { name: "ZXing WASM", version: "3.1.5", formats: CONFIG.detectorFormats, confirmationFrames: 2 },
      measurementNotes: ["Focus-command completion is not physical lens convergence; the browser does not expose a reliable autofocus-complete signal.",
        "Image contrast and Laplacian variance are sampled scene-dependent estimates, not proof of focus or barcode legibility.",
        "Decoder budgets limit retries, not an already-running WASM read. Capture atMs values are relative to captureStartedAtMs in that capture's pageClock.",
        "System event atMs and pageAtMs values use their page's performance clock; recordedAt is UTC. Different pageSessionId values must not share a relative timeline.",
        "Legacy captures/events without pageClock, pageSessionId or recordedAt have unknown clock metadata; the exporting page's clock must not be inferred for them.",
        "Worker framePreparation timings run off the interface thread; decodeMs includes preparation and worker round-trip time.",
        "Up to 60 captures and 360 frames each are retained. IndexedDB writes changed captures after scanning; storageTrimmedFrames counts older detail removed to fit the storage budget. localStorage is a smaller fallback.",
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
    if (element) element.textContent = `${sessions.length} / ${limits.captures} recent captures · up to ${limits.framesPerCapture} frame records each.`;
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
