"use strict";

// One worker and one transferred frame at a time; decoding never blocks the UI.
(() => {
  let readyPromise = null;
  let worker = null;
  let pending = null;
  let sequence = 0;
  const workerUrl = new URL("zxing-worker.js?v=126", document.currentScript.src);

  window.ensureZXingLoaded = function () {
    if (readyPromise) return readyPromise;
    readyPromise = new Promise((resolve, reject) => {
      let initialized = false;
      let timer;
      const fail = (error) => {
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
          initialized = true;
          clearTimeout(timer);
          resolve({
            detect(image, formats, options = {}) {
              if (!worker) return Promise.reject(new Error("Scanner stopped. Please retry."));
              if (pending) return Promise.reject(new Error("A frame is already being decoded"));
              return new Promise((resolveFrame, rejectFrame) => {
                const id = ++sequence;
                pending = { id, resolve: resolveFrame, reject: rejectFrame,
                  timer: setTimeout(() => fail(new Error("Scanner read timed out. Please retry.")), 10000) };
                try {
                  worker.postMessage({ id, buffer: image.data.buffer, width: image.width,
                    height: image.height, formats, thorough: options.thorough !== false,
                    enhance: options.enhance !== false }, [image.data.buffer]);
                } catch (error) {
                  fail(error);
                }
              });
            }
          });
        } else if (!initialized && data.type === "error") {
          fail(new Error(data.error));
        } else if (pending && data.id === pending.id) {
          const request = pending;
          pending = null;
          clearTimeout(request.timer);
          if (data.error) request.reject(new Error(data.error));
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
