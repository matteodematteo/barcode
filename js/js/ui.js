"use strict";

/* Status, toast, dialogs, and scroll UI */

function setStatus(message) {
  const nextMessage = String(message || "");
  if (state.lastStatusMessage === nextMessage) {
    return;
  }
  state.lastStatusMessage = nextMessage;
  state.els.statusText.textContent = nextMessage;
}


function showToast(message) {
  const text = String(message || "").trim();
  if (!text || !state.els.toast) {
    return;
  }

  state.els.toast.textContent = text;
  state.els.toast.classList.add("is-visible");
  if (state.toastTimer) {
    window.clearTimeout(state.toastTimer);
  }
  state.toastTimer = window.setTimeout(function () {
    state.els.toast.classList.remove("is-visible");
    state.toastTimer = 0;
  }, 2200);
}


function playCaptureSound() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      return;
    }

    if (!state.audioContext) {
      state.audioContext = new AudioContextClass();
    }

    const context = state.audioContext;
    if (context.state === "suspended") {
      context.resume().catch(() => {
        // Ignore resume errors triggered by browser policies.
      });
    }

    const now = context.currentTime;
    const oscillator = context.createOscillator();
    const gainNode = context.createGain();

    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(880, now);
    oscillator.frequency.exponentialRampToValueAtTime(1320, now + 0.08);

    gainNode.gain.setValueAtTime(0.0001, now);
    gainNode.gain.exponentialRampToValueAtTime(0.14, now + 0.02);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);

    oscillator.connect(gainNode);
    gainNode.connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.16);
  } catch {
    // Audio is optional.
  }
}


function isAnyDialogOpen() {
  const els = state.els;
  return Boolean(
    els?.settingsDialog?.classList.contains("is-open") ||
    els?.confirmDialog?.classList.contains("is-open") ||
    els?.printDialog?.classList.contains("is-open") ||
    els?.salesPeriodDialog?.classList.contains("is-open") ||
    els?.closestSearchDialog?.classList.contains("is-open") ||
    els?.historyEditDialog?.classList.contains("is-open")
  );
}


function openSettingsDialog() {
  fillSettingsForm(readSavedSettings());
  state.els.settingsSaveNote.textContent = "";
  state.els.settingsDialog.classList.add("is-open");
  state.els.settingsDialog.setAttribute("aria-hidden", "false");
}


function closeSettingsDialog() {
  state.els.settingsDialog.classList.remove("is-open");
  state.els.settingsDialog.setAttribute("aria-hidden", "true");
}


function lockPageScroll() {
  if (state.manualScrollLocked || document.body.classList.contains("is-dialog-open")) {
    return;
  }

  state.lockedScrollY = window.scrollY || window.pageYOffset || 0;
  document.body.classList.add("is-dialog-open");
  document.body.style.top = `-${state.lockedScrollY}px`;
}


function unlockPageScroll() {
  if (state.manualScrollLocked) {
    return;
  }
  if (!document.body.classList.contains("is-dialog-open")) {
    return;
  }

  document.body.classList.remove("is-dialog-open");
  document.body.style.top = "";
  const restoreY = state.lockedScrollY || 0;
  state.lockedScrollY = 0;
  window.scrollTo(0, restoreY);
}


function updateLockScreenScrollButton() {
  const btn = state.els?.lockScreenScrollBtn;
  if (!btn) {
    return;
  }
  btn.classList.toggle("is-on", state.manualScrollLocked);
  btn.setAttribute("aria-pressed", state.manualScrollLocked ? "true" : "false");
  btn.title = state.manualScrollLocked ? "Unlock screen scroll" : "Lock screen scroll";

  const historyList = state.els?.historyList;
  if (historyList) {
    historyList.classList.toggle("is-locked-scroll", state.manualScrollLocked);
  }
}


function isInsideScrollableWhileLocked(target) {
  if (!(target instanceof Element)) {
    return false;
  }
  return Boolean(target.closest(
    ".is-locked-scroll, .closest-search-results, #salesPeriodDialog .dialog-card, #closestSearchDialog .dialog-card, #historyEditDialog .dialog-card, .pi-slider"
  ));
}


function preventScrollWhileLocked(event) {
  if (!state.manualScrollLocked) {
    return;
  }
  if (isInsideScrollableWhileLocked(event.target)) {
    return;
  }
  event.preventDefault();
}


function toggleScreenScrollLock() {
  if (state.manualScrollLocked) {
    state.manualScrollLocked = false;
    document.body.classList.remove("is-scroll-locked");
    document.body.style.top = "";
    state.manualScrollLockY = 0;
    saveScrollLockState(false, 0);
  } else {
    window.scrollTo(0, 0);
    state.manualScrollLockY = 0;
    document.body.style.top = "0px";
    document.body.classList.add("is-scroll-locked");
    state.manualScrollLocked = true;
    saveScrollLockState(true, 0);
  }
  updateLockScreenScrollButton();
}

function showApiLoader() {
  state.pendingApiRequests += 1;
  const loader = state.els?.apiLoader;
  if (loader) {
    loader.classList.add("is-visible");
  }
}


function hideApiLoader() {
  state.pendingApiRequests = Math.max(0, state.pendingApiRequests - 1);
  if (state.pendingApiRequests > 0) {
    return;
  }
  const loader = state.els?.apiLoader;
  if (loader) {
    loader.classList.remove("is-visible");
  }
}


function openConfirmDialog(message, onConfirm) {
  state.pendingConfirmAction = typeof onConfirm === "function" ? onConfirm : null;
  state.els.confirmDialogText.textContent = message;
  state.els.confirmDialog.classList.add("is-open");
  state.els.confirmDialog.setAttribute("aria-hidden", "false");
}


function closeConfirmDialog() {
  state.pendingConfirmAction = null;
  state.els.confirmDialog.classList.remove("is-open");
  state.els.confirmDialog.setAttribute("aria-hidden", "true");
}


function openPrintDialog() {
  state.els.printTimestampCheckbox.checked = true;
  state.els.printDialog.classList.add("is-open");
  state.els.printDialog.setAttribute("aria-hidden", "false");
}


function closePrintDialog() {
  state.els.printDialog.classList.remove("is-open");
  state.els.printDialog.setAttribute("aria-hidden", "true");
}


function selectEntireInputValue(event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) {
    return;
  }

  window.setTimeout(function () {
    try {
      target.focus({ preventScroll: true });
    } catch {
      target.focus();
    }
    try {
      target.setSelectionRange(0, target.value.length);
    } catch {
      target.select();
    }
  }, 0);
}


function moveFocusToInput(input, options) {
  if (!(input instanceof HTMLInputElement) && !(input instanceof HTMLTextAreaElement)) {
    return;
  }

  const shouldOpenKeyboard = Boolean(options?.openKeyboard);
  const isIOSFocus = Boolean(state.isIOS);

  if (!shouldOpenKeyboard) {
    // Programmatic focus (dialog close, mode switch, etc.) must never pop
    // the on-screen keyboard. Force inputmode="none" right before focusing
    // so any stale value left on the attribute - e.g. setInputMode() in
    // input-mode.js sets inputMode to "numeric" for phone mode - can't
    // cause the keyboard to appear here. A real user tap on the input
    // (pointerdown, see events.js) removes this attribute again, which is
    // what restores normal keyboard behavior for actual typing.
    try {
      input.setAttribute("inputmode", "none");
    } catch {
      // Ignore attribute errors.
    }
  }

  if (isIOSFocus) {
    try {
      input.focus();
    } catch {
      // Ignore focus errors.
    }
    if (shouldOpenKeyboard) {
      try {
        input.click();
      } catch {
        // Ignore click errors.
      }
    }
    return;
  }

  try {
    input.focus({ preventScroll: true });
  } catch {
    input.focus();
  }
}
