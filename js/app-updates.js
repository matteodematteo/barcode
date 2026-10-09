"use strict";

// Keep saved login, settings and scan history intact when installing updates.
(function () {
  const pageVersion = document.querySelector('meta[name="webscanner-version"]')?.content;
  const notice = document.getElementById("appUpdateNotice");
  const button = document.getElementById("appUpdateBtn");
  const draftKey = "webscanner_update_draft";

  // The app initializes its inputs at DOMContentLoaded. Restore after that.
  const restoreDraft = function () {
    setTimeout(function () {
      try {
        const draft = JSON.parse(sessionStorage.getItem(draftKey) || "null");
        sessionStorage.removeItem(draftKey);
        if (!draft) return;
        for (const id of ["barcodeInput", "quantityInput"]) {
          const input = document.getElementById(id);
          if (input && typeof draft[id] === "string") input.value = draft[id];
        }
      } catch (_) {}
    }, 0);
  };
  // Deferred scripts run while readyState is "interactive", before the other
  // app scripts have necessarily downloaded or initialized their inputs.
  if (document.readyState !== "complete") {
    document.addEventListener("DOMContentLoaded", restoreDraft, { once: true });
  } else {
    restoreDraft();
  }

  button?.addEventListener("click", function () {
    try {
      sessionStorage.setItem(draftKey, JSON.stringify({
        barcodeInput: document.getElementById("barcodeInput")?.value || "",
        quantityInput: document.getElementById("quantityInput")?.value || ""
      }));
    } catch (_) {}
    location.reload();
  });

  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  const requestVersion = function () {
    navigator.serviceWorker.controller?.postMessage({ type: "GET_APP_VERSION" });
  };
  navigator.serviceWorker.addEventListener("message", function (event) {
    if (event.data?.type === "APP_VERSION" && pageVersion && notice) {
      const workerVersion = Number(event.data.version);
      // Fresh HTML may arrive before its new worker finishes installing.
      notice.hidden = !Number.isFinite(workerVersion) || workerVersion <= Number(pageVersion);
    }
  });
  navigator.serviceWorker.addEventListener("controllerchange", requestVersion);
  const registerWorker = function () {
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(function (registration) {
    requestVersion();
    let lastCheck = Date.now();
    const checkForUpdate = function () {
      if (navigator.onLine === false || document.visibilityState !== "visible" ||
          Date.now() - lastCheck < 60000) return;
      lastCheck = Date.now();
      registration.update().catch(function () {});
    };
    window.addEventListener("focus", checkForUpdate);
    document.addEventListener("visibilitychange", checkForUpdate);
    setInterval(checkForUpdate, 5 * 60 * 1000);
  }).catch(function () {});
  };
  const registerAfterPaint = function () {
    scheduleIdleWork(registerWorker, 1000);
  };
  if (document.readyState === "complete") registerAfterPaint();
  else window.addEventListener("load", registerAfterPaint, { once: true });
})();
