"use strict";

// Keep saved login, settings and scan history intact when installing updates.
(function () {
  const pageVersion = Number(document.querySelector('meta[name="webscanner-version"]')?.content);
  const notice = document.getElementById("appUpdateNotice");
  const button = document.getElementById("appUpdateBtn");
  const draftKey = "webscanner_update_draft";
  const appliedKey = "webscanner_auto_applied_version";
  let pendingVersion = 0;
  let applying = false;
  let retryTimer = 0;

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
        updateQuantityPadAvailability();
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

  const saveDraft = function () {
    try {
      sessionStorage.setItem(draftKey, JSON.stringify({
        barcodeInput: document.getElementById("barcodeInput")?.value || "",
        quantityInput: document.getElementById("quantityInput")?.value || ""
      }));
      return true;
    } catch (_) { return false; }
  };

  const canReload = function () {
    if (document.visibilityState !== "visible" || navigator.onLine === false ||
        !state.els || isAnyDialogOpen() || state.pendingApiRequests || state.isWorkerSending) return false;
    return !document.activeElement?.matches("input, textarea, select, [contenteditable='true']");
  };
  const retry = function (delay) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(function () { applyUpdate(false); }, delay);
  };
  const applyUpdate = async function (manual) {
    if (applying || !pendingVersion) return;
    if (!manual && !canReload()) { retry(1000); return; }
    applying = true;
    try {
      // Check the actual HTML before reloading. This prevents reload loops
      // during an incomplete deployment or when the network is unavailable.
      const response = await fetch(new URL("index.html", document.baseURI), { cache: "no-store" });
      if (!response.ok) { retry(15000); return; }
      const html = await response.text();
      const match = html.match(/name=["']webscanner-version["']\s+content=["'](\d+)["']/i);
      const available = Number(match?.[1]);
      if (!Number.isFinite(available) || available < pendingVersion || available <= pageVersion) {
        retry(15000); return;
      }
      if (!manual && !canReload()) { retry(1000); return; }
      const attempt = `${pageVersion}:${available}`;
      try {
        if (!manual && sessionStorage.getItem(appliedKey) === attempt) return;
      } catch (_) { if (!manual) return; }
      if (!saveDraft() && !manual) return;
      try { sessionStorage.setItem(appliedKey, attempt); }
      catch (_) { if (!manual) return; }
      clearTimeout(retryTimer);
      location.reload();
    } catch (_) {
      retry(15000);
    } finally {
      applying = false;
    }
  };
  button?.addEventListener("click", function () { applyUpdate(true); });

  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  const requestVersion = function () {
    navigator.serviceWorker.controller?.postMessage({ type: "GET_APP_VERSION" });
  };
  navigator.serviceWorker.addEventListener("message", function (event) {
    if (event.data?.type === "APP_VERSION" && pageVersion && notice) {
      const workerVersion = Number(event.data.version);
      if (!Number.isFinite(workerVersion) || workerVersion <= pageVersion) return;
      pendingVersion = Math.max(pendingVersion, workerVersion);
      notice.hidden = false;
      applyUpdate(false);
    }
  });
  navigator.serviceWorker.addEventListener("controllerchange", requestVersion);
  const registrationReady = window.webscannerServiceWorkerReady ||
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" });
  registrationReady.then(function (registration) {
    if (!registration) return;
    requestVersion();
    let lastCheck = Date.now();
    const checkForUpdate = function (force) {
      if (navigator.onLine === false || document.visibilityState !== "visible" ||
          !force && Date.now() - lastCheck < 15000) return;
      lastCheck = Date.now();
      registration.update().catch(function () {});
    };
    window.addEventListener("focus", function () { checkForUpdate(false); });
    window.addEventListener("online", function () { checkForUpdate(true); });
    window.addEventListener("pageshow", function (event) { checkForUpdate(event.persisted); });
    document.addEventListener("visibilitychange", function () {
      checkForUpdate(false);
      if (pendingVersion) applyUpdate(false);
    });
    setInterval(function () { checkForUpdate(false); }, 60000);
  }).catch(function () {});
})();
