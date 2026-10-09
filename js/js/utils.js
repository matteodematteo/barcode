"use strict";

/* Device detection and formatting helpers */

// Runs `fn` once the browser is idle (falls back to a short setTimeout on
// browsers without requestIdleCallback, e.g. Safari/iOS). Used to push
// non-essential init work (secondary UI setup, background library warm-up)
// off the critical "first paint / interactive" path.
function scheduleIdleWork(fn, timeout) {
  if (typeof fn !== "function") {
    return;
  }
  const runner = window.requestIdleCallback || function (callback) {
    window.setTimeout(callback, 1);
  };
  try {
    runner(fn, { timeout: timeout || 1500 });
  } catch {
    window.setTimeout(fn, 1);
  }
}


function detectMobileUi() {
  const width = window.innerWidth || screen.width || 0;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "") || width <= 768;
}


function isAndroidDevice() {
  return /Android/i.test(navigator.userAgent || "");
}


function getActiveVideoConfig() {
  if (isIOSDevice()) {
    return CONFIG.iosVideoConstraints;
  }
  if (isAndroidDevice()) {
    return CONFIG.androidVideoConstraints;
  }
  return state.isMobileUi ? CONFIG.mobileVideoConstraints : CONFIG.videoConstraints;
}


function isIOSDevice() {
  const userAgent = navigator.userAgent || "";
  return /iPad|iPhone|iPod/i.test(userAgent) || (/Mac/i.test(userAgent) && "ontouchend" in document);
}


function sanitizeQuantity(value) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Math.max(1, Number.isFinite(parsed) ? parsed : 1);
}


function sanitizeEditableQuantity(value) {
  const digitsOnly = String(value ?? "").replace(/[^\d]/g, "");
  if (!digitsOnly) {
    return "";
  }
  const normalized = digitsOnly.replace(/^0+/, "");
  return normalized || "0";
}


function formatTimestamp() {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const MM = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `${yy}${MM}${dd}${hh}${mm}${ss}`;
}


function formatSessionId() {
  return `session_${formatTimestamp()}`;
}


function numberFromValue(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}


function formatPercent(value) {
  const numeric = numberFromValue(value);
  if (!numeric) return "";
  const percent = numeric < 1 ? numeric * 100 : numeric;
  return `${percent.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}%`;
}


function formatPrice(value) {
  const numeric = numberFromValue(value);
  if (!numeric) return "";
  return numeric.toFixed(2).replace(/\.00$/, "");
}


function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, function (char) {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[char];
  });
}


function sanitizeItalianName(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s.,()&-]+/gu, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}


function normalizeDecimalInput(value) {
  return String(value || "")
    .trim()
    .replace(/,/g, ".");
}


function trimTrailingZeros(value) {
  return numberFromValue(value).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}
