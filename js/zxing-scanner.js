"use strict";

// One worker and one transferred frame at a time; decoding never blocks the UI.
(() => {
  let readyPromise = null;
  let worker = null;
  let pending = null;
  let sequence = 0;
  const workerUrl = new URL("zxing-worker.js?v=162", document.currentScript.src);

  window.ensureZXingLoaded = function () {
    if (readyPromise) return readyPromise;
    readyPromise = new Promise((resolve, reject) => {
      const started = performance.now();
      captureDiagnostics.event("decoder.workerLoading");
      let initialized = false;
      let timer;
      const fail = (error) => {
        captureDiagnostics.error("decoder.worker", error);
        clearTimeout(timer);
        worker?.terminate();
        worker = null;
        readyPromise = null;
        if (pending) {
          clearTimeout(pending.timer);
          pending.reject(error);
          pending = null;
        }
        reject(error);
      };
      timer = setTimeout(() => fail(new Error("Scanner loading timed out. Tap Capture to retry.")), 30000);
      try {
        worker = new Worker(workerUrl);
      } catch (error) {
        clearTimeout(timer);
        reject(error);
        return;
      }
      worker.onerror = () => fail(new Error("Scanner could not load. Check the connection and retry."));
      worker.onmessageerror = () => fail(new Error("Scanner communication failed. Please retry."));
      worker.onmessage = ({ data }) => {
        if (data.type === "ready") {
          captureDiagnostics.event("decoder.workerReady", { initializeMs: data.initializeMs, wallMs: performance.now() - started });
          initialized = true;
          clearTimeout(timer);
          resolve({
            videoFrames: data.videoFrames === true,
            detect(image, formats, options = {}) {
              if (!worker) return Promise.reject(new Error("Scanner stopped. Please retry."));
              if (pending) return Promise.reject(new Error("A frame is already being decoded"));
              return new Promise((resolveFrame, rejectFrame) => {
                const id = ++sequence;
                pending = { id, resolve: resolveFrame, reject: rejectFrame, onRegion: options.onRegion, onFocus: options.onFocus,
                  onDiagnostics: options.onDiagnostics,
                  timer: setTimeout(() => fail(new Error("Scanner read timed out. Please retry.")), 10000) };
                try {
                  worker.postMessage({ id, buffer: image.videoFrame ? undefined : image.data.buffer,
                    videoFrame: image.videoFrame, geometry: image.geometry, sampleQuality: image.sampleQuality,
                    width: image.width,
                    height: image.height, formats, thorough: options.thorough !== false,
                    enhance: options.enhance !== false, orientation: options.orientation || 0,
                    downscale: options.downscale !== false, minLineCount: options.minLineCount || 2,
                    focused: options.focused === true, budgetMs: options.budgetMs || 0,
                    trackRegions: typeof options.onRegion === "function",
                    assistCamera: typeof options.onFocus === "function",
                    diagnostics: typeof options.onDiagnostics === "function",
                    regionOffset: options.regionOffset || 0,
                    preferredRegion: options.preferredRegion || null,
                    binarizer: options.binarizer || "LocalAverage" }, [image.videoFrame || image.data.buffer]);
                } catch (error) {
                  if (image.videoFrame) {
                    clearTimeout(pending.timer); pending = null;
                    const failure = new Error("Camera frame transfer unavailable");
                    failure.name = "FrameTransferError"; rejectFrame(failure);
                  } else fail(error);
                }
              });
            }
          });
        } else if (!initialized && data.type === "error") {
          fail(new Error(data.error));
        } else if (pending && data.id === pending.id && data.type === "region") {
          // Progress keeps the frame pending until its decoded result arrives.
          try { pending.onRegion?.(data.region); } catch (_) { /* Feedback cannot interrupt decoding. */ }
        } else if (pending && data.id === pending.id && data.type === "focus") {
          try { pending.onFocus?.(data.region); } catch (_) { /* Optional camera assistance. */ }
        } else if (pending && data.id === pending.id) {
          const request = pending;
          pending = null;
          clearTimeout(request.timer);
          try { request.onDiagnostics?.(data.diagnostics); } catch (_) { /* Diagnostics must not interrupt decoding. */ }
          if (data.error) {
            const failure = new Error(data.error);
            if (data.framePreparationFailed) failure.name = "FramePreparationError";
            request.reject(failure);
          }
          else request.resolve(data.text);
        }
      };
    }).catch((error) => {
      readyPromise = null;
      throw error;
    });
    return readyPromise;
  };
})();
